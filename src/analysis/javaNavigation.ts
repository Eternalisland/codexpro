import fsp from "node:fs/promises";
import path from "node:path";
import { spawn } from "node:child_process";
import { StringDecoder } from "node:string_decoder";
import type { CodexProConfig } from "../config.js";
import type { PathGuard, Workspace } from "../guard.js";
import { inspectWorkspace } from "./index.js";
import { classifyFileRole } from "./classify.js";
import { textScanByteLimit } from "../fsOps.js";
import { redactSensitiveText } from "../redact.js";
import type { InventoryFile, AnalysisCoverage } from "./types.js";

type Token = { v: string; line: number; col: number };
type Method = { name: string; owner: string; path: string; role: string; line: number; column: number;
  parameter_types: string[]; signature: string; index: number; isStatic: boolean;
  bodyStart?: number; bodyEnd?: number };
type Scope = { name: string; kind: string; line: number; column: number; open: number; close: number; depth: number };
type Source = { tokens: Token[]; methods: Method[]; scopes: Scope[]; role: string; path: string;
  lines: string[]; parentheses: Map<number, number> };
type Options = { symbol: string; path?: string; parameterTypes?: string[]; includeTests?: boolean; maxResults?: number };
type JavaIndex = { sources: Source[]; methods: Method[]; coverage: AnalysisCoverage; warnings: string[] };
const WARN = "Java navigation uses conservative source heuristics, not compiler type resolution. Inheritance, overloads, reflection, dependency classes and dynamic dispatch may be incomplete.";
const MAX_FILES = 1500, MAX_BYTES = 12 * 1024 * 1024, MAX_TOKENS = 250000;
const javaCache = new Map<string, JavaIndex>();
const isId = (v: string) => /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(v);
const v = (t: Token[], i: number) => t[i]?.v ?? "";
const maxResult = (n?: number) => Math.min(200, Math.max(1, n ?? 80));

function tokenize(text: string): { tokens: Token[]; partial: boolean } {
  const tokens: Token[] = [];
  let i = 0, line = 1, col = 1;
  const take = (to: number) => {
    while (i < to) {
      if (text[i] === "\r" && text[i + 1] === "\n") { i += 2; line++; col = 1; }
      else if (text[i] === "\n" || text[i] === "\r") { i++; line++; col = 1; }
      else { i++; col++; }
    }
  };
  while (i < text.length && tokens.length < MAX_TOKENS) {
    if (/\s/.test(text[i])) { take(i + 1); continue; }
    if (text.startsWith("//", i)) {
      const end = text.indexOf("\n", i + 2);
      take(end < 0 ? text.length : end); continue;
    }
    if (text.startsWith("/*", i)) {
      const end = text.indexOf("*/", i + 2);
      take(end < 0 ? text.length : end + 2); continue;
    }
    if (text[i] === "'" || text[i] === '"') {
      const quote = text[i], block = text.startsWith('"""', i);
      let j = i + (block ? 3 : 1);
      while (j < text.length) {
        if (text[j] === "\\") { j += 2; continue; }
        if (block && text.startsWith('"""', j)) { j += 3; break; }
        if (!block && text[j] === quote) { j++; break; }
        j++;
      }
      tokens.push({ v: quote === "'" ? "<char>" : "<string>", line, col });
      take(Math.min(j, text.length)); continue;
    }
    const match = /^[A-Za-z_$][A-Za-z0-9_$]*|^[0-9]+(?:\.[0-9]+)?|^\.\.\.|^::|^->/.exec(text.slice(i));
    const val = match?.[0] ?? text[i];
    tokens.push({ v: val, line, col }); take(i + val.length);
  }
  return { tokens, partial: i < text.length };
}
function matching(t: Token[], left: string, right: string) {
  const stack: number[] = [], result = new Map<number, number>();
  for (let i = 0; i < t.length; i++) {
    if (t[i].v === left) stack.push(i);
    else if (t[i].v === right && stack.length) {
      const start = stack.pop()!;
      result.set(start, i); result.set(i, start);
    }
  }
  return result;
}
function parts(t: Token[], start: number, end: number, declaration: boolean): string[][] {
  if (start >= end) return [];
  const out: string[][] = []; let segment: string[] = [];
  let angle = 0, paren = 0, square = 0, curly = 0;
  for (let i = start; i < end; i++) {
    const value = t[i].v;
    if (value === "," && !angle && !paren && !square && !curly) {
      out.push(segment); segment = []; continue;
    }
    if (declaration) {
      if (value === "<") angle++;
      else if (value === ">") angle = Math.max(0, angle - 1);
    }
    if (value === "(") paren++;
    else if (value === ")") paren--;
    if (value === "[") square++;
    else if (value === "]") square--;
    if (value === "{") curly++;
    else if (value === "}") curly--;
    segment.push(value);
  }
  out.push(segment);
  return out;
}
function paramType(values: string[]): string {
  const cleaned: string[] = [];
  for (let i = 0; i < values.length; i++) {
    if (values[i] === "@") {
      i++;
      while (values[i + 1] === "." && values[i + 2]) i += 2;
      if (values[i + 1] === "(") {
        let d = 0;
        do { i++; if (values[i] === "(") d++; if (values[i] === ")") d--; }
        while (i + 1 < values.length && d > 0);
      }
      continue;
    }
    if (values[i] === "final") continue;
    cleaned.push(values[i]);
  }
  let variable = -1;
  for (let i = cleaned.length - 1; i >= 0; i--) {
    if (isId(cleaned[i])) { variable = i; break; }
  }
  return variable < 0 ? cleaned.join("") :
    cleaned.slice(0, variable).join("") + cleaned.slice(variable + 1).join("");
}
function parse(file: Pick<InventoryFile, "path" | "role">, text: string) {
  const lexed = tokenize(text), t = lexed.tokens;
  const braces = matching(t, "{", "}"), parentheses = matching(t, "(", ")");
  const depths = new Int32Array(t.length);
  let depth = 0;
  for (let i = 0; i < t.length; i++) {
    depths[i] = depth;
    if (v(t, i) === "{") depth++;
    else if (v(t, i) === "}") depth--;
  }
  const scopes: Scope[] = [];
  for (let i = 0; i + 2 < t.length; i++) {
    if (!["class", "interface", "enum", "record"].includes(v(t, i)) ||
      !isId(v(t, i + 1)) || v(t, i - 1) === ".") continue;
    let j = i + 2, angle = 0, paren = 0;
    while (j < t.length) {
      const word = v(t, j);
      if (word === "<") angle++;
      else if (word === ">") angle = Math.max(0, angle - 1);
      else if (word === "(") paren++;
      else if (word === ")") paren--;
      if (word === "{" && angle === 0 && paren === 0) break;
      if (word === ";" && angle === 0 && paren === 0) break;
      j++;
    }
    if (v(t, j) === "{" && braces.has(j))
      scopes.push({ name: v(t, i + 1), kind: v(t, i), line: t[i + 1].line, column: t[i + 1].col,
        open: j, close: braces.get(j)!, depth: depths[j] + 1 });
  }
  const methods: Method[] = [];
  for (let i = 1; i + 1 < t.length; i++) {
    const name = v(t, i);
    if (!isId(name) || ["if", "for", "while", "catch", "switch", "new", "return"].includes(name) ||
      v(t, i + 1) !== "(" || v(t, i - 1) === "." || !parentheses.has(i + 1)) continue;
    const scope = scopes.find(c => c.open < i && i < c.close && c.depth === depths[i]);
    if (!scope) continue;
    const close = parentheses.get(i + 1)!;
    let next = close + 1;
    if (v(t, next) === "throws") {
      next++; while (next < t.length && !["{", ";"].includes(v(t, next))) next++;
    }
    if (!["{", ";"].includes(v(t, next))) continue;
    let boundary = i - 1;
    while (boundary > scope.open && !["{", "}", ";"].includes(v(t, boundary))) boundary--;
    const before = t.slice(boundary + 1, i).map(x => x.v);
    if (!before.length || before.includes("=") || before.includes("new") ||
      before.includes("->")) continue;
    const constructor = name === scope.name;
    if (!constructor && before.every(x =>
      ["public", "private", "protected", "static", "final", "abstract",
        "synchronized", "native", "default"].includes(x))) continue;
    const types = parts(t, i + 2, close, true).map(paramType);
    methods.push({ name, owner: scope.name, path: file.path, role: file.role,
      line: t[i].line, column: t[i].col, parameter_types: types,
      signature: scope.name + "." + name + "(" + types.join(",") + ")",
      index: i, isStatic: before.includes("static"),
      bodyStart: v(t, next) === "{" ? next : undefined,
      bodyEnd: v(t, next) === "{" ? braces.get(next) : undefined });
  }
  return { source: { tokens: t, methods, scopes, parentheses, path: file.path, role: file.role,
    lines: text.split(/\r?\n/) } as Source, partial: lexed.partial };
}
// Parse only the selected file for JDT cursor positions; do not depend on the bounded workspace index.
export function scanJavaDeclarations(filePath: string, text: string) {
  const parsed = parse({ path: filePath, role: "source" }, text);
  return { types: parsed.source.scopes.map(({ name, kind, line, column }) =>
    ({ name, kind, line, column })),
    methods: parsed.source.methods.map(({ name, owner, line, column, parameter_types, signature }) =>
      ({ name, owner, line, column, parameter_types, signature })),
    truncated: parsed.partial };
}

async function buildJavaIndex(config: CodexProConfig, guard: PathGuard, workspace: Workspace): Promise<JavaIndex> {
  const info = await inspectWorkspace(config, guard, workspace);
  const key = workspace.id + ":" + info.fingerprint + ":" + JSON.stringify(config.analysisLimits);
  const existing = javaCache.get(key);
  if (existing && info.cache.hit) return existing;
  const sources: Source[] = [], warnings = [...info.warnings, WARN];
  let bytes = 0, tokens = 0, partial = false;
  for (const file of info.files.filter(f => f.language === "java" && !f.generated)) {
    if (sources.length >= Math.min(MAX_FILES, config.analysisLimits.maxAnalyzedFiles) ||
      tokens >= MAX_TOKENS ||
      bytes + file.bytes > Math.min(MAX_BYTES, config.analysisLimits.maxScannedBytes)) {
      partial = true; continue;
    }
    try {
      const text = await fsp.readFile(guard.resolve(workspace, file.path).absPath, "utf8");
      const size = Buffer.byteLength(text, "utf8");
      if (bytes + size > Math.min(MAX_BYTES, config.analysisLimits.maxScannedBytes)) {
        partial = true; continue;
      }
      const result = parse(file, text);
      if (tokens + result.source.tokens.length > MAX_TOKENS) { partial = true; continue; }
      sources.push(result.source);
      bytes += size; tokens += result.source.tokens.length;
      if (result.partial) partial = true;
    } catch { partial = true; }
  }
  if (partial) warnings.push("Java indexing incomplete: file, byte or token budget, or an unreadable source file.");
  const coverage = { ...info.coverage, truncated: info.coverage.truncated || partial, warnings };
  const result = { sources, methods: sources.flatMap(s => s.methods), coverage, warnings };
  for (const entry of javaCache.keys()) if (entry.startsWith(workspace.id + ":")) javaCache.delete(entry);
  javaCache.set(key, result);
  return result;
}
const indexed = buildJavaIndex;

// Use ripgrep only to nominate source files. The Java lexer still decides whether a
// match is a declaration or a call; no textual hit is reported as a resolved reference.
async function javaReferenceCandidates(config: CodexProConfig, workspace: Workspace, name: string):
  Promise<{ paths: string[]; truncated: boolean; warnings: string[] } | null> {
  const args = ["--files-with-matches", "--null", "--hidden", "--no-ignore",
    "--fixed-strings", "--no-messages", "--max-filesize", String(textScanByteLimit(config)),
    "-g", "*.java"];
  for (const glob of config.blockedGlobs) args.push("-g", "!" + glob);
  args.push("-e", name, "--", workspace.root);
  return new Promise((resolve, reject) => {
    const child = spawn("rg", args, { cwd: workspace.root, shell: false, windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"] });
    const paths: string[] = [];
    const decoder = new StringDecoder("utf8");
    let buffer = "", error = "", truncated = false, settled = false;
    const finish = (value: { paths: string[]; truncated: boolean; warnings: string[] } | null, failure?: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      if (failure) reject(failure);
      else resolve(value);
    };
    const timeout = setTimeout(() => { truncated = true; child.kill(); }, 30_000);
    child.stdout.on("data", (chunk: Buffer) => {
      if (truncated) return;
      buffer += decoder.write(chunk);
      let end: number;
      while ((end = buffer.indexOf("\0")) !== -1) {
        const candidate = buffer.slice(0, end);
        buffer = buffer.slice(end + 1);
        if (paths.length >= MAX_FILES) { truncated = true; child.kill(); break; }
        paths.push(candidate);
      }
    });
    child.stderr.on("data", (chunk: Buffer) => { error = (error + String(chunk)).slice(-2000); });
    child.on("error", (err: NodeJS.ErrnoException) => {
      if (err.code === "ENOENT") finish(null);
      else finish(null, err);
    });
    child.on("close", code => {
      if (settled) return;
      if (!truncated && code !== 0 && code !== 1) {
        finish(null, new Error("ripgrep candidate search failed: " + (error.trim() || "exit " + code)));
        return;
      }
      finish({ paths, truncated, warnings: truncated ?
        ["Java candidate search stopped at its file or time limit; references may be incomplete."] : [] });
    });
  });
}

async function referenceIndex(config: CodexProConfig, guard: PathGuard, workspace: Workspace, opts: Options):
  Promise<JavaIndex> {
  const name = opts.symbol.split(".").at(-1) ?? "";
  const candidates = await javaReferenceCandidates(config, workspace, name);
  if (!candidates) {
    const fallback = await indexed(config, guard, workspace);
    const notice = "ripgrep unavailable; Java references use the bounded workspace index.";
    const warnings = [...fallback.warnings, notice];
    return { ...fallback, warnings, coverage: { ...fallback.coverage, warnings } };
  }
  const ordered = new Set<string>();
  if (opts.path && opts.path.toLowerCase().endsWith(".java"))
    ordered.add(guard.resolve(workspace, opts.path).relPath);
  for (const file of candidates.paths) {
    const rel = path.relative(workspace.root, path.resolve(file)).replaceAll("\\", "/");
    if (rel === ".." || rel.startsWith("../") || path.isAbsolute(rel) ||
        !rel.toLowerCase().endsWith(".java") || guard.isBlockedRelativePath(rel)) continue;
    if (opts.includeTests === false && classifyFileRole(rel, "java") === "test") continue;
    ordered.add(rel);
  }
  const sources: Source[] = [], warnings = [...candidates.warnings, WARN];
  let bytes = 0, tokens = 0, partial = candidates.truncated;
  for (const rel of ordered) {
    if (sources.length >= Math.min(MAX_FILES, config.analysisLimits.maxAnalyzedFiles) ||
        tokens >= MAX_TOKENS) { partial = true; break; }
    try {
      const checked = guard.resolve(workspace, rel);
      await guard.assertTextFile(checked.absPath, textScanByteLimit(config));
      const text = await fsp.readFile(checked.absPath, "utf8");
      const size = Buffer.byteLength(text, "utf8");
      if (bytes + size > Math.min(MAX_BYTES, config.analysisLimits.maxScannedBytes)) {
        partial = true; continue;
      }
      const parsed = parse({ path: checked.relPath, role: classifyFileRole(checked.relPath, "java") }, text);
      if (tokens + parsed.source.tokens.length > MAX_TOKENS) { partial = true; continue; }
      sources.push(parsed.source);
      bytes += size;
      tokens += parsed.source.tokens.length;
      if (parsed.partial) partial = true;
    } catch { partial = true; }
  }
  if (partial) warnings.push("Java reference candidates are only partially analyzed; results may be incomplete.");
  return { sources, methods: sources.flatMap(s => s.methods),
    coverage: { inventoryFiles: ordered.size, analyzedFiles: sources.length,
      scannedBytes: bytes, symbolCount: sources.reduce((sum, s) => sum + s.scopes.length + s.methods.length, 0),
      relationshipCount: 0, truncated: partial, warnings }, warnings };
}
function methodsFor(all: Method[], options: Options) {
  const words = options.symbol.split("."), name = words.at(-1);
  const owner = words.length >= 2 ? words.at(-2) : undefined;
  return all.filter(m => m.name === name && (!owner || m.owner === owner) &&
    (!options.path || options.path === m.path) &&
    (options.includeTests !== false || m.role !== "test") &&
    (!options.parameterTypes || m.parameter_types.join(",") === options.parameterTypes.join(",")));
}
const definition = (m: Method) => ({
  name: m.name, qualified_name: m.owner + "." + m.name, kind: "method",
  path: m.path, line: m.line, column: m.column, signature: m.signature,
  parameter_types: m.parameter_types, confidence: "inferred", source: "java-source-heuristic"
});
function typesFor(sources: Source[], options: Options) {
  const parts = options.symbol.split(".");
  const name = parts.at(-1);
  return sources.flatMap(source => {
    if ((options.path && source.path !== options.path) ||
        (options.includeTests === false && source.role === "test")) return [];
    return source.scopes.filter(scope => scope.name === name).flatMap(scope => {
      const owners = source.scopes.filter(parent => parent.open < scope.open && parent.close > scope.close)
        .sort((a, b) => a.open - b.open).map(parent => parent.name);
      const qualified = [...owners, scope.name].join(".");
      if (parts.length > 1 && qualified !== options.symbol &&
          !qualified.endsWith("." + options.symbol)) return [];
      return [{
        name: scope.name, qualified_name: qualified, kind: "type", declaration_kind: scope.kind,
        path: source.path, line: scope.line, column: scope.column,
        confidence: "inferred" as const, source: "java-source-heuristic" as const
      }];
    });
  });
}
function symbolDefinitions(sources: Source[], methods: Method[], options: Options) {
  const types = typesFor(sources, options);
  return types.length ? types : methodsFor(methods, options).map(definition);
}
function ownerAt(source: Source, idx: number) {
  return source.scopes.filter(c => c.open < idx && c.close > idx)
    .sort((a, b) => b.open - a.open)[0]?.name;
}
function receiver(source: Source, idx: number, classNames: Set<string>): string | undefined {
  const t = source.tokens;
  if (v(t, idx - 1) !== ".") return ownerAt(source, idx);
  const name = v(t, idx - 2);
  if (name === "this") return ownerAt(source, idx);
  if (name === ")") {
    const opening = source.parentheses.get(idx - 2);
    if (opening !== undefined && v(t, opening - 2) === "new" &&
      classNames.has(v(t, opening - 1))) return v(t, opening - 1);
    return undefined;
  }
  if (classNames.has(name)) return name;
  // Recognize only receivers preceded by an explicit local/parameter/field type.
  let type: string | undefined;
  const enclosing = source.methods.filter(m => m.bodyStart !== undefined && m.bodyEnd !== undefined &&
    m.bodyStart < idx && m.bodyEnd > idx).sort((a, b) => b.bodyStart! - a.bodyStart!)[0];
  // Do not inherit a variable declaration from a previous, unrelated method.
  const lower = enclosing?.index ?? idx;
  for (let j = lower; j < idx - 2; j++) {
    if (v(t, j) !== name || !classNames.has(v(t, j - 1))) continue;
    if (["=", ";", ")", ",", "["].includes(v(t, j + 1))) type = v(t, j - 1);
  }
  return type;
}
export async function findJavaSymbol(config: CodexProConfig, guard: PathGuard, workspace: Workspace, opts: Options) {
  const max = maxResult(opts.maxResults);
  if (opts.path) {
    const checked = guard.resolve(workspace, opts.path);
    if (!checked.relPath.toLowerCase().endsWith(".java"))
      return { symbol: opts.symbol, definitions: [], total: 0, truncated: false,
        coverage: { inventoryFiles: 0, analyzedFiles: 0, scannedBytes: 0, symbolCount: 0,
          relationshipCount: 0, truncated: false, warnings: [WARN] },
        warnings: [WARN], supported_languages: ["java"] };
    await guard.assertTextFile(checked.absPath, textScanByteLimit(config));
    const text = await fsp.readFile(checked.absPath, "utf8");
    const source = parse({ path: checked.relPath, role: classifyFileRole(checked.relPath, "java") }, text);
    const found = symbolDefinitions([source.source], source.source.methods,
      { ...opts, path: checked.relPath });
    const warnings = [...(source.partial ? ["Java file token budget reached; results may be incomplete."] : []), WARN];
    const coverage: AnalysisCoverage = { inventoryFiles: 1, analyzedFiles: 1,
      scannedBytes: Buffer.byteLength(text, "utf8"),
      symbolCount: source.source.scopes.length + source.source.methods.length,
      relationshipCount: 0, truncated: source.partial, warnings };
    return { symbol: opts.symbol, definitions: found.slice(0, max), total: found.length,
      truncated: found.length > max || source.partial,
      coverage, warnings, supported_languages: ["java"] };
  }
  const index = await indexed(config, guard, workspace);
  const found = symbolDefinitions(index.sources, index.methods, opts);
  return { symbol: opts.symbol, definitions: found.slice(0, max), total: found.length,
    truncated: found.length > max || index.coverage.truncated,
    coverage: index.coverage, warnings: index.warnings, supported_languages: ["java"] };
}
export async function findJavaReferences(config: CodexProConfig, guard: PathGuard, workspace: Workspace, opts: Options) {
  if (opts.path) guard.resolve(workspace, opts.path);
  const index = await referenceIndex(config, guard, workspace, opts), found = methodsFor(index.methods, opts);
  const max = maxResult(opts.maxResults);
  if (found.length !== 1) return {
    symbol: opts.symbol, definitions: found.slice(0, max).map(definition),
    references: [], total: 0, ambiguous: found.length > 1,
    truncated: found.length > max || index.coverage.truncated,
    coverage: index.coverage, warnings: [...index.warnings, found.length ?
      "Multiple matching Java methods; select an overload with path and parameter_types." :
      "No matching Java method declaration."], supported_languages: ["java"]
  };
  const target = found[0], refs: Array<{ path: string; line: number; column: number;
    text: string; role: string; is_definition: boolean; confidence: "inferred"; source: "java-source-heuristic" }> = [];
  const classNames = new Set(index.sources.flatMap(s => s.scopes.map(c => c.name)));
  const declaringPaths = new Set(index.sources.filter(s =>
    s.scopes.some(c => c.name === target.owner)).map(s => s.path));
  const duplicateOwner = declaringPaths.size > 1;
  let unresolved = 0;
  for (const source of index.sources) {
    if (!opts.includeTests && source.role === "test") continue;
    const t = source.tokens, definitions = new Map(source.methods.map(m => [m.index, m]));
    for (let i = 0; i + 1 < t.length; i++) {
      if (v(t, i) !== target.name || v(t, i + 1) !== "(" ||
        !source.parentheses.has(i + 1)) continue;
      const decl = definitions.get(i);
      if (decl) {
        if (decl.path !== target.path || decl.signature !== target.signature) continue;
      } else {
        const owner = receiver(source, i, classNames);
        if (!owner || owner !== target.owner) { if (!owner) unresolved++; continue; }
        // A class simple name from two different files needs package/import resolution.
        if (duplicateOwner && source.path !== target.path) { unresolved++; continue; }
        const arity = parts(t, i + 2, source.parentheses.get(i + 1)!, false).length;
        if (arity !== target.parameter_types.length) continue;
        const possible = index.methods.filter(m => m.owner === owner && m.name === target.name &&
          m.parameter_types.length === arity);
        if (possible.length !== 1 || possible[0].signature !== target.signature) {
          unresolved++; continue;
        }
      }
      refs.push({ path: source.path, line: t[i].line, column: t[i].col,
        text: redactSensitiveText((source.lines[t[i].line - 1] ?? "").trim().slice(0, 300)),
        role: source.role, is_definition: Boolean(decl),
        confidence: "inferred", source: "java-source-heuristic" });
    }
  }
  refs.sort((a, b) => a.path.localeCompare(b.path) || a.line - b.line || a.column - b.column);
  return { symbol: opts.symbol, definitions: found.map(definition),
    references: refs.slice(0, max), total: refs.length, ambiguous: false,
    truncated: refs.length > max || index.coverage.truncated || unresolved > 0,
    coverage: index.coverage, warnings: [...index.warnings,
      ...(duplicateOwner ? ["Multiple Java classes share the selected owner name; cross-file callers were excluded."] : []),
      ...(unresolved ? ["Skipped " + unresolved + " unresolved receiver or overload calls."] : [])],
    supported_languages: ["java"] };
}
