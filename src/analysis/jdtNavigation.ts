import fsp from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { CodexProConfig } from "../config.js";
import type { PathGuard, Workspace } from "../guard.js";

import { findJavaSymbol, findJavaReferences, scanJavaDeclarations } from "./javaNavigation.js";
import { getJdtClient, jdtEnabled, type Location, type DocumentSymbol,
  type TypeItem, type Range } from "./jdtClient.js";

type Options = { symbol: string; path?: string; parameterTypes?: string[];
  includeTests?: boolean; maxResults?: number };
const max = (n?: number) => Math.max(1, Math.min(n ?? 80, 200));
const isTest = (p: string) => /(^|\/)(?:test|tests|__tests__|src\/test)(\/|$)|(?:Test|Tests)\.java$/i.test(p);
function safeLocation(guard: PathGuard, workspace: Workspace, uri: string, range: Range,
  includeTests: boolean) {
  try {
    const file = fileURLToPath(uri);
    const relative = path.relative(workspace.root, file).replaceAll("\\", "/");
    if (relative.startsWith("../") || relative === ".." || path.isAbsolute(relative)) return null;
    const checked = guard.resolve(workspace, relative);
    if (!checked.relPath.toLowerCase().endsWith(".java") || (!includeTests && isTest(checked.relPath))) return null;
    if (!Number.isInteger(range?.start?.line) || !Number.isInteger(range?.start?.character) ||
      range.start.line < 0 || range.start.character < 0) return null;
    return { path: checked.relPath, line: range.start.line + 1, column: range.start.character + 1,
      source: "jdt-lsp" as const, confidence: "resolved" as const };
  } catch { return null; }
}
function flatten(symbols: DocumentSymbol[], parents: string[] = []):
  Array<{ symbol: DocumentSymbol; parents: string[] }> {
  const out: Array<{ symbol: DocumentSymbol; parents: string[] }> = [];
  for (const symbol of symbols) {
    out.push({ symbol, parents });
    if (symbol.children?.length) out.push(...flatten(symbol.children, [...parents, symbol.name]));
  }
  return out;
}
type ResolvedTarget = {
  client: Awaited<ReturnType<typeof getJdtClient>>;
  uri: string;
  selected: { symbol: DocumentSymbol; parents: string[] } | null;
  source: "jdt-document-symbol" | "java-file-lexical" | "none";
  definitions: Array<{ name: string; qualified_name: string; kind: "method" | "type";
    path: string; line: number; column: number; signature?: string;
    parameter_types?: string[]; source: string; confidence: string }>;
  ambiguous: boolean;
  diagnostic: { document_symbol_count: number; document_symbol_format: string;
    file_declaration_count: number; selection_source: string; scan_truncated: boolean;
    server: ReturnType<Awaited<ReturnType<typeof getJdtClient>>["diagnostics"]> };
};
const TYPES = new Set([5, 10, 11, 23]);
function normalizeMethodName(name: string) { return name.replace(/\s*\(.*$/, "").trim(); }
function normalizeType(type: string) { return type.replace(/\s+/g, "").replace(/java\.lang\./g, ""); }
function sameMethodParams(left: string[], right: string[]) {
  return left.length === right.length && left.every((x, i) => normalizeType(x) === normalizeType(right[i]));
}
function asSymbols(raw: unknown, uri: string) {
  const items = Array.isArray(raw) ? raw : [];
  const documentSymbols: DocumentSymbol[] = [];
  let flat = false;
  for (const item of items) {
    if (!item || typeof item !== "object") continue;
    const obj = item as Partial<DocumentSymbol> & { location?: Location };
    if (typeof obj.name !== "string" || typeof obj.kind !== "number") continue;
    if (obj.selectionRange?.start && obj.range?.start) {
      documentSymbols.push(obj as DocumentSymbol);
    } else if (obj.location?.uri === uri && obj.location.range?.start) {
      flat = true;
      documentSymbols.push({ name: obj.name, kind: obj.kind, detail: obj.detail,
        range: obj.location.range, selectionRange: obj.location.range });
    }
  }
  return { symbols: flatten(documentSymbols),
    format: !items.length ? "empty" : flat ? "symbol-information" :
      documentSymbols.length ? "document-symbol" : "unrecognized" };
}
async function target(config: CodexProConfig, guard: PathGuard, workspace: Workspace,
  opts: Options): Promise<ResolvedTarget> {
  if (!opts.path?.toLowerCase().endsWith(".java")) throw new Error("Provide the Java declaration path.");
  const checked = guard.resolve(workspace, opts.path);
  const text = await fsp.readFile(checked.absPath, "utf8");
  if (Buffer.byteLength(text, "utf8") > config.maxReadBytes)
    throw new Error("Java source exceeds read limit.");
  const declarations = scanJavaDeclarations(checked.relPath, text);
  const client = await getJdtClient(workspace);
  const uri = await client.document(checked.absPath, text);
  const symbols = asSymbols(await client.request<unknown>("textDocument/documentSymbol",
    { textDocument: { uri } }), uri);
  const words = opts.symbol.split("."), name = words.at(-1)!;
  const owner = words.length > 1 ? words.at(-2) : undefined;
  const types = declarations.types.filter(d => d.name === name);
  const methods = declarations.methods.filter(d => d.name === name &&
    (!owner || owner === d.owner) &&
    (!opts.parameterTypes || sameMethodParams(d.parameter_types, opts.parameterTypes)));
  // Type names have priority when a bare class/interface name was requested.
  const local = types.length ? types.map(d => ({ ...d, owner: "", parameter_types: [] as string[],
    signature: "", kind: "type" as const })) :
    methods.map(d => ({ ...d, kind: "method" as const }));
  const fromDocument = symbols.symbols.filter(s => {
    const sameName = s.symbol.name === name || normalizeMethodName(s.symbol.name) === name;
    return sameName && (types.length ? TYPES.has(s.symbol.kind) : [6, 9].includes(s.symbol.kind)) &&
      (types.length > 0 || !owner || s.parents.includes(owner) || symbols.format === "symbol-information");
  });
  const exact = local.length === 1 ? fromDocument.find(s =>
    s.symbol.selectionRange?.start.line === local[0].line - 1 &&
    s.symbol.selectionRange.start.character === local[0].column - 1) : undefined;
  // Without an exact cursor match, accept a single server declaration on the same source line.
  const lineMatch = local.length === 1 ? fromDocument.find(s =>
    s.symbol.selectionRange?.start.line === local[0].line - 1) : undefined;
  const ambiguous = local.length > 1 || (!local.length && fromDocument.length > 1);
  const verified = !ambiguous ? exact ?? lineMatch ??
    (fromDocument.length === 1 && (!local.length || types.length) ? fromDocument[0] : undefined) : undefined;
  const lexical = !ambiguous && local.length === 1 ? local[0] : undefined;
  const start = lexical ? { line: lexical.line - 1, character: lexical.column - 1 } : undefined;
  const selected = verified ?? (start ? { symbol: {
    name, kind: lexical!.kind === "type" ? 5 : 6,
    range: { start, end: start }, selectionRange: { start, end: start }
  }, parents: owner ? [owner] : [] } : null);
  const source = verified ? "jdt-document-symbol" :
    selected ? "java-file-lexical" : "none";
  const definitions = local.map(d => ({
    name: d.name, qualified_name: d.kind === "type" ? d.name : d.owner + "." + d.name,
    kind: d.kind, path: checked.relPath, line: d.line, column: d.column,
    ...(d.kind === "method" ? { signature: d.signature, parameter_types: d.parameter_types } : {}),
    source: verified && local.length === 1 ? "jdt-lsp" : "java-source-heuristic",
    confidence: verified && local.length === 1 ? "resolved" : "inferred"
  }));
  if (!local.length && verified) {
    const p = verified.symbol.selectionRange.start;
    definitions.push({ name: verified.symbol.name, qualified_name: opts.symbol,
      kind: TYPES.has(verified.symbol.kind) ? "type" : "method",
      path: checked.relPath, line: p.line + 1, column: p.character + 1,
      source: "jdt-lsp", confidence: "resolved" });
  }
  return { client, uri, selected, source, definitions, ambiguous,
    diagnostic: { document_symbol_count: symbols.symbols.length,
      document_symbol_format: symbols.format,
      file_declaration_count: declarations.types.length + declarations.methods.length,
      selection_source: source, scan_truncated: declarations.truncated,
      server: client.diagnostics() } };
}
function locations(guard: PathGuard, workspace: Workspace, raw: unknown, includeTests: boolean, limit: number) {
  const items = Array.isArray(raw) ? raw : raw ? [raw] : [];
  const seen = new Set<string>(), found: ReturnType<typeof safeLocation>[] = [];
  let omitted = 0;
  for (const input of items) {
    const obj = input as Partial<Location> & { targetUri?: string; targetSelectionRange?: Range };
    const loc = safeLocation(guard, workspace, obj.targetUri ?? obj.uri ?? "",
      obj.targetSelectionRange ?? obj.range!, includeTests);
    if (!loc) { omitted++; continue; }
    const key = loc.path + ":" + loc.line + ":" + loc.column;
    if (seen.has(key)) continue;
    seen.add(key); found.push(loc);
  }
  const ordered = found.filter((x): x is NonNullable<typeof x> => x !== null)
    .sort((a, b) => a.path.localeCompare(b.path) || a.line - b.line || a.column - b.column);
  return { items: ordered.slice(0, limit), total: ordered.length,
    truncated: ordered.length > limit || omitted > 0, omitted };
}
function note(error: unknown) {
  const message = error instanceof Error ? error.message : "";
  if (/ENOENT|ENOTDIR|launcher jar|platform config|directory/i.test(message))
    return "JDT LS installation or platform configuration is missing.";
  if (/timed out/i.test(message)) return "JDT LS initialization or query timed out.";
  if (/exited|closed|startup failed/i.test(message)) return "JDT LS process stopped or failed to launch.";
  return "JDT LS could not resolve this query; inspect the local language-server setup.";
}
export async function jdtSymbol(config: CodexProConfig, guard: PathGuard, workspace: Workspace, opts: Options) {
  if (!jdtEnabled() || !opts.path) return findJavaSymbol(config, guard, workspace, opts);
  try {
    const resolved = await target(config, guard, workspace, opts);
    const confirmed = resolved.source === "jdt-document-symbol" && !resolved.ambiguous;
    const warnings = resolved.ambiguous ?
      ["Multiple declarations match; provide parameter_types to select a single overload."] :
      !resolved.selected ? ["No matching declaration in the selected file or JDT document symbols."] :
      !confirmed ? ["JDT documentSymbol did not confirm this declaration; reporting a file-local lexical position. Project import or indexing may be incomplete."] : [];
    return { symbol: opts.symbol, definitions: resolved.definitions.slice(0, max(opts.maxResults)),
      total: resolved.definitions.length, ambiguous: resolved.ambiguous,
      truncated: resolved.diagnostic.scan_truncated || resolved.definitions.length > max(opts.maxResults),
      warnings, coverage: { truncated: resolved.diagnostic.scan_truncated },
      supported_languages: ["java"], backend: confirmed ? "jdt-lsp" : "java-source-heuristic",
      jdt_diagnostic: resolved.diagnostic };
  } catch (error) {
    const fallback = await findJavaSymbol(config, guard, workspace, opts);
    return { ...fallback, backend: "java-source-heuristic",
      warnings: [...fallback.warnings, "JDT LS unavailable; using heuristic fallback: " + note(error)] };
  }
}
export async function jdtReferences(config: CodexProConfig, guard: PathGuard, workspace: Workspace, opts: Options) {
  if (!jdtEnabled() || !opts.path) return findJavaReferences(config, guard, workspace, opts);
  try {
    const resolved = await target(config, guard, workspace, opts);
    if (!resolved.selected || resolved.ambiguous) return {
      symbol: opts.symbol, ambiguous: resolved.ambiguous,
      definitions: resolved.definitions, references: [], total: 0,
      backend: "java-source-heuristic", truncated: resolved.diagnostic.scan_truncated,
      coverage: { truncated: resolved.diagnostic.scan_truncated },
      supported_languages: ["java"], jdt_diagnostic: resolved.diagnostic,
      warnings: [resolved.ambiguous ? "Select a single overload with parameter_types." :
        "No matching Java declaration found in the requested file."] };
    const raw = await resolved.client.request<Location[] | null>("textDocument/references", {
      textDocument: { uri: resolved.uri }, position: resolved.selected.symbol.selectionRange.start,
      context: { includeDeclaration: true }
    });
    const found = locations(guard, workspace, raw, opts.includeTests !== false, max(opts.maxResults));
    const decl = resolved.definitions;
    return { symbol: opts.symbol, ambiguous: false,
      definitions: decl,
      references: found.items.map(loc => ({ ...loc, text: "",
        role: isTest(loc.path) ? "test" : "source",
        is_definition: decl.some(d => d.path === loc.path && d.line === loc.line && d.column === loc.column) })),
      total: found.total, truncated: found.truncated,
      coverage: { truncated: found.truncated, workspace_index_required: false },
      warnings: [
        ...(found.omitted ? ["Some JDT LS references are outside allowed Java workspace files and were omitted."] : []),
        ...(!found.total ? ["JDT LS returned no references; project import/indexing may be incomplete."] : []),
        ...(resolved.source === "java-file-lexical" ?
          ["Declaration cursor came from a bounded file-local scan because JDT documentSymbol was missing or incomplete."] : [])
      ],
      jdt_diagnostic: resolved.diagnostic,
      supported_languages: ["java"], backend: "jdt-lsp" };
  } catch (error) {
    const fallback = await findJavaReferences(config, guard, workspace, opts);
    return { ...fallback, backend: "java-source-heuristic",
      warnings: [...fallback.warnings, "JDT LS unavailable; using inferred results: " + note(error)] };
  }
}
export async function jdtImplementations(config: CodexProConfig, guard: PathGuard, workspace: Workspace, opts: Options) {
  if (!jdtEnabled()) return { status: "unavailable", reason: "Set CODEXPRO_JDTLS_HOME to enable JDT LS.", implementations: [] };
  try {
    const resolved = await target(config, guard, workspace, opts);
    if (!resolved.selected || resolved.ambiguous) return {
      status: resolved.ambiguous ? "ambiguous" : "unavailable",
      reason: resolved.ambiguous ? "Select one overload using parameter_types." :
        "No matching declaration in the selected Java file; inspect jdt_diagnostic.",
      jdt_diagnostic: resolved.diagnostic, implementations: [] };
    const raw = await resolved.client.request<unknown>("textDocument/implementation", {
      textDocument: { uri: resolved.uri }, position: resolved.selected.symbol.selectionRange.start
    });
    const result = locations(guard, workspace, raw, opts.includeTests !== false, max(opts.maxResults));
    return { status: "ok", backend: "jdt-lsp", implementations: result.items,
      total: result.total, truncated: result.truncated, jdt_diagnostic: resolved.diagnostic,
      warnings: [
        ...(result.omitted ? ["Some implementation locations were excluded by workspace access rules."] : []),
        ...(!result.total ? ["No implementations returned; verify JDT LS indexing is complete."] : [])
      ] };
  } catch (error) { return { status: "unavailable", reason: note(error), implementations: [] }; }
}
export async function jdtHierarchy(config: CodexProConfig, guard: PathGuard, workspace: Workspace,
  opts: Options & { direction?: "both" | "supertypes" | "subtypes" }) {
  if (!jdtEnabled()) return { status: "unavailable", reason: "Set CODEXPRO_JDTLS_HOME to enable JDT LS." };
  try {
    const resolved = await target(config, guard, workspace, opts);
    if (!resolved.selected || !TYPES.has(resolved.selected.symbol.kind))
      return { status: "unavailable", reason: resolved.ambiguous ?
        "Multiple declarations match; select an exact Java type." :
        "Java type declaration was not found in the selected file; inspect jdt_diagnostic.",
        jdt_diagnostic: resolved.diagnostic };
    const prepared = await resolved.client.request<TypeItem[] | null>("textDocument/prepareTypeHierarchy", {
      textDocument: { uri: resolved.uri }, position: resolved.selected.symbol.selectionRange.start
    });
    if (!prepared?.length) return { status: "unavailable", reason: "JDT LS returned no type hierarchy item; project may still be indexing.",
      jdt_diagnostic: resolved.diagnostic };
    const selected = prepared[0];
    const direction = opts.direction ?? "both";
    const fetch = async (method: "typeHierarchy/supertypes" | "typeHierarchy/subtypes") => {
      const data = await resolved.client.request<TypeItem[] | null>(method, { item: selected });
      const result = locations(guard, workspace, (data ?? []).map(x => ({ uri: x.uri, range: x.selectionRange })),
        opts.includeTests !== false, max(opts.maxResults));
      return { nodes: result.items, truncated: result.truncated };
    };
    const superResult = direction === "subtypes" ? null : await fetch("typeHierarchy/supertypes");
    const subResult = direction === "supertypes" ? null : await fetch("typeHierarchy/subtypes");
    return { status: "ok", backend: "jdt-lsp", name: selected.name, direction,
      jdt_diagnostic: resolved.diagnostic,
      supertypes: superResult?.nodes ?? [], subtypes: subResult?.nodes ?? [],
      truncated: Boolean(superResult?.truncated || subResult?.truncated) };
  } catch (error) { return { status: "unavailable", reason: note(error) }; }
}
