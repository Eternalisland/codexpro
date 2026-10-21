import fsp from "node:fs/promises";
import type { CodexProConfig } from "../config.js";
import type { PathGuard, Workspace } from "../guard.js";
import { inspectWorkspace } from "./index.js";
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
  if (opts.path) guard.resolve(workspace, opts.path);
  const index = await indexed(config, guard, workspace), found = methodsFor(index.methods, opts);
  const max = maxResult(opts.maxResults);
  return { symbol: opts.symbol, definitions: found.slice(0, max).map(definition), total: found.length,
    truncated: found.length > max || index.coverage.truncated,
    coverage: index.coverage, warnings: index.warnings, supported_languages: ["java"] };
}
export async function findJavaReferences(config: CodexProConfig, guard: PathGuard, workspace: Workspace, opts: Options) {
  if (opts.path) guard.resolve(workspace, opts.path);
  const index = await indexed(config, guard, workspace), found = methodsFor(index.methods, opts);
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
