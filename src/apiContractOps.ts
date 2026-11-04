import fsp from "node:fs/promises";
import ts from "typescript";
import type { CodexProConfig } from "./config.js";
import type { PathGuard, Workspace } from "./guard.js";
import { listFiles } from "./fsOps.js";
import { vueScriptSource } from "./analysis/vueSfc.js";

export type HttpMethod = "GET" | "POST" | "PUT" | "PATCH" | "DELETE" | "ANY";
export interface ApiEvidence {
  workspace_id: string;
  file: string;
  line: number;
  method: HttpMethod;
  path: string;
  protocol: "http" | "sse";
  kind: "caller" | "endpoint";
  source: "fetch" | "axios-like" | "eventsource" | "spring" | "webclient" | "fastapi";
  confidence: "strong" | "inferred";
}
export interface ApiLink {
  caller: ApiEvidence;
  endpoint: ApiEvidence;
  confidence: "inferred";
  reasons: string[];
}
interface Scan {
  records: ApiEvidence[];
  coverage: { workspace_id: string; discovered_files: number; scanned_files: number; scanned_bytes: number; truncated: boolean };
}
const METHODS = ["GET", "POST", "PUT", "PATCH", "DELETE"] as const;
const MAX_FILE_BYTES = 256 * 1024;
const MAX_SCAN_BYTES = 8 * 1024 * 1024;
const MAX_RECORDS = 1000;

function staticPath(raw: string | undefined): string | undefined {
  if (!raw) return undefined;
  const candidate = raw.split("?")[0].trim();
  if (!candidate.startsWith("/") || candidate.startsWith("//") || /[{}:*#\u0024]/.test(candidate)) return undefined;
  return candidate.length > 1 ? candidate.replace(/\/+$/, "") : candidate;
}
function fullPath(prefix: string, value: string): string | undefined {
  return staticPath(prefix.replace(/\/+$/, "") + "/" + value.replace(/^\/+/, ""));
}
function lineAt(text: string, offset: number): number {
  return (text.slice(0, offset).match(/\n/g)?.length ?? 0) + 1;
}
function jsLiteral(node?: ts.Node): string | undefined {
  return node && (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) ? node.text : undefined;
}
function jsRequests(workspace: Workspace, file: string, original: string): ApiEvidence[] {
  const source = file.endsWith(".vue") ? vueScriptSource(original).code : original;
  const ast = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true,
    /\.tsx$/i.test(file) ? ts.ScriptKind.TSX : /\.jsx$/i.test(file) ? ts.ScriptKind.JSX :
    /\.(js|mjs|cjs)$/i.test(file) ? ts.ScriptKind.JS : ts.ScriptKind.TS);
  const records: ApiEvidence[] = [];
  function add(node: ts.Node, method: HttpMethod, value: string | undefined,
    origin: ApiEvidence["source"], protocol: ApiEvidence["protocol"] = "http", confidence: ApiEvidence["confidence"] = "strong") {
    const route = staticPath(value);
    if (!route) return;
    records.push({ workspace_id: workspace.id, file,
      line: ast.getLineAndCharacterOfPosition(node.getStart(ast)).line + 1,
      method, path: route, protocol, kind: "caller", source: origin, confidence });
  }
  function visit(node: ts.Node): void {
    if (ts.isNewExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === "EventSource")
      add(node, "GET", jsLiteral(node.arguments?.[0]), "eventsource", "sse");
    if (ts.isCallExpression(node)) {
      if (ts.isIdentifier(node.expression) && node.expression.text === "fetch") {
        let method: HttpMethod = "GET";
        if (node.arguments.length > 1) {
          const opts = node.arguments[1];
          if (!ts.isObjectLiteralExpression(opts)) method = "ANY";
          else {
            const p = opts.properties.find((item) => ts.isPropertyAssignment(item) &&
              item.name.getText(ast).replace(/['"]/g, "") === "method");
            if (p && ts.isPropertyAssignment(p)) {
              const value = jsLiteral(p.initializer)?.toUpperCase();
              method = METHODS.find((item) => item === value) ?? "ANY";
            }
          }
        }
        if (method !== "ANY") add(node, method, jsLiteral(node.arguments[0]), "fetch");
      } else if (ts.isPropertyAccessExpression(node.expression)) {
        const access = node.expression;
        const method = METHODS.find((item) => item.toLowerCase() === access.name.text.toLowerCase());
        const receiver = access.expression.getText(ast);
        if (method && /^(axios|api|http|client|httpClient|apiClient|request)$/i.test(receiver))
          add(node, method, jsLiteral(node.arguments[0]), "axios-like", "http",
            receiver === "axios" ? "strong" : "inferred");
      }
    }
    ts.forEachChild(node, visit);
  }
  visit(ast);
  return records;
}
function javaSource(text: string): string {
  return text.replace(/\/\*[\s\S]*?\*\//g, (s) => s.replace(/[^\r\n]/g, " "))
    .replace(/^\s*\/\/[^\n]*/gm, (s) => s.replace(/[^\r\n]/g, " "));
}
function mappingPath(args: string): string | undefined {
  if (/[{}]/.test(args)) return undefined;
  return staticPath(args.match(/(?:value|path)\s*=\s*["'](\/[^"']+)["']/)?.[1] ??
    args.match(/^\s*["'](\/[^"']+)["']/)?.[1]);
}
function javaContracts(ws: Workspace, file: string, text: string): ApiEvidence[] {
  const source = javaSource(text);
  const records: ApiEvidence[] = [];
  const classIndex = /\bclass\s+[A-Za-z_$][\w$]*/.exec(source)?.index ?? -1;
  const annotation = /@(RequestMapping|GetMapping|PostMapping|PutMapping|PatchMapping|DeleteMapping)\s*\(([^)]*)\)/g;
  let prefix = "";
  if (classIndex >= 0) for (const m of source.matchAll(annotation)) {
    if (m.index < classIndex && m[1] === "RequestMapping") prefix = mappingPath(m[2]) ?? prefix;
  }
  if (classIndex >= 0) for (const m of source.matchAll(annotation)) {
    if (m.index <= classIndex) continue;
    const own = mappingPath(m[2]);
    if (!own) continue;
    const route = prefix ? fullPath(prefix, own) : own;
    if (!route) continue;
    const explicit = m[2].match(/RequestMethod\.(GET|POST|PUT|PATCH|DELETE)/)?.[1];
    const name = m[1].replace("Mapping", "").toUpperCase();
    const method = (explicit ?? (METHODS.includes(name as typeof METHODS[number]) ? name : "ANY")) as HttpMethod;
    records.push({ workspace_id: ws.id, file, line: lineAt(source, m.index),
      method, path: route, kind: "endpoint", source: "spring",
      protocol: /TEXT_EVENT_STREAM_VALUE|text\/event-stream/.test(m[2]) ? "sse" : "http",
      confidence: method === "ANY" ? "inferred" : "strong" });
  }
  // Tight method().uri("literal") chains; this is not a resolved WebClient call graph.
  for (const m of source.matchAll(/\.(get|post|put|patch|delete)\s*\(\s*\)\s*\.uri\s*\(\s*"([^"]+)"/gi)) {
    const route = staticPath(m[2]);
    if (route) records.push({ workspace_id: ws.id, file, line: lineAt(source, m.index),
      method: m[1].toUpperCase() as HttpMethod, path: route, kind: "caller", source: "webclient",
      protocol: "http", confidence: "inferred" });
  }
  return records;
}
function pythonEndpoints(ws: Workspace, file: string, text: string): ApiEvidence[] {
  const records: ApiEvidence[] = [];
  const prefixes = new Map<string, string>();
  for (const m of text.matchAll(/^[ \t]*([A-Za-z_]\w*)\s*=\s*APIRouter\s*\(\s*prefix\s*=\s*["'](\/[^"']+)["']/gm)) {
    const prefix = staticPath(m[2]);
    if (prefix) prefixes.set(m[1], prefix);
  }
  // Single-line literal decorators only. Python AST / dynamic router registration is out of scope.
  for (const m of text.matchAll(/^[ \t]*@([A-Za-z_]\w*)\.(get|post|put|patch|delete)\s*\(\s*(["'])(\/[^"'\n]+)\3/gim)) {
    const own = staticPath(m[4]);
    if (!own) continue;
    const prefix = prefixes.get(m[1]);
    const route = prefix ? fullPath(prefix, own) : own;
    if (route) records.push({ workspace_id: ws.id, file, line: lineAt(text, m.index),
      method: m[2].toUpperCase() as HttpMethod, path: route, kind: "endpoint",
      protocol: "http", source: "fastapi", confidence: "inferred" });
  }
  return records;
}
async function scan(config: CodexProConfig, guard: PathGuard, ws: Workspace,
  role: "frontend" | "backend" | "python", maxFiles: number): Promise<Scan> {
  const discovered = await listFiles(guard, ws, { maxFiles: maxFiles + 1 });
  const records: ApiEvidence[] = [];
  let scanned = 0;
  let scannedBytes = 0;
  let skipped = 0;
  let recordsTruncated = false;
  const pattern = role === "frontend" ? /\.(vue|tsx?|jsx?|mjs|cjs)$/i :
    role === "backend" ? /\.java$/i : /\.py$/i;
  for (const name of discovered.slice(0, maxFiles)) {
    if (!pattern.test(name)) continue;
    try {
      const resolved = guard.resolve(ws, name);
      const stat = await fsp.stat(resolved.absPath);
      const perFile = Math.min(config.maxReadBytes, MAX_FILE_BYTES);
      if (!stat.isFile() || stat.size > perFile || stat.size + scannedBytes > MAX_SCAN_BYTES) { skipped++; continue; }
      await guard.assertTextFile(resolved.absPath, perFile);
      const source = await fsp.readFile(resolved.absPath, "utf8");
      scannedBytes += Buffer.byteLength(source, "utf8");
      scanned++;
      const extracted = role === "frontend" ? jsRequests(ws, name, source) :
        role === "backend" ? javaContracts(ws, name, source) : pythonEndpoints(ws, name, source);
      const remaining = Math.max(0, MAX_RECORDS - records.length);
      if (extracted.length > remaining) recordsTruncated = true;
      records.push(...extracted.slice(0, remaining));
    } catch { skipped++; }
  }
  return { records, coverage: {
    workspace_id: ws.id, discovered_files: discovered.length, scanned_files: scanned,
    scanned_bytes: scannedBytes, truncated: discovered.length > maxFiles || skipped > 0 || recordsTruncated || scannedBytes >= MAX_SCAN_BYTES
  } };
}
function matchApi(callers: ApiEvidence[], endpoints: ApiEvidence[], maxMatches: number): {
  links: ApiLink[]; unmatched: ApiEvidence[]; truncated: boolean
} {
  const links: ApiLink[] = [];
  const unmatched: ApiEvidence[] = [];
  let truncated = false;
  for (const caller of callers) {
    const matches = endpoints.filter((endpoint) => endpoint.path === caller.path &&
      (endpoint.method === caller.method || endpoint.method === "ANY"));
    if (!matches.length) { unmatched.push(caller); continue; }
    for (const endpoint of matches) {
      if (links.length >= maxMatches) { truncated = true; break; }
      links.push({ caller, endpoint, confidence: "inferred", reasons: [
        "same static HTTP path", endpoint.method === "ANY" ? "endpoint method unknown" : "same HTTP method",
        "service base URL and runtime connectivity not verified",
        ...(caller.protocol === "sse" || endpoint.protocol === "sse" ? ["streaming/SSE compatibility not verified"] : []),
        ...(matches.length > 1 ? ["ambiguous: multiple endpoints match"] : [])
      ] });
    }
  }
  return { links, unmatched, truncated };
}

export async function analyzeApiContracts(
  config: CodexProConfig, guard: PathGuard, frontend: Workspace, backend: Workspace,
  python?: Workspace, options: { maxFiles?: number; maxMatches?: number } = {}
) {
  const ids = [frontend.id, backend.id, ...(python ? [python.id] : [])];
  if (new Set(ids).size !== ids.length) throw new Error("API analysis requires distinct workspaces.");
  const maxFiles = Math.max(10, Math.min(options.maxFiles ?? 800, 2000));
  const maxMatches = Math.max(1, Math.min(options.maxMatches ?? 100, 300));
  const [fe, be, py] = await Promise.all([
    scan(config, guard, frontend, "frontend", maxFiles),
    scan(config, guard, backend, "backend", maxFiles),
    python ? scan(config, guard, python, "python", maxFiles) : Promise.resolve(undefined)
  ]);
  const first = matchApi(fe.records.filter((item) => item.kind === "caller"),
    be.records.filter((item) => item.kind === "endpoint"), maxMatches);
  const second = py ? matchApi(be.records.filter((item) => item.kind === "caller"),
    py.records.filter((item) => item.kind === "endpoint"), maxMatches) : undefined;
  const coverage = [fe.coverage, be.coverage, ...(py ? [py.coverage] : [])];
  const unmatched = [...first.unmatched, ...(second?.unmatched ?? [])];
  return {
    schema_version: 1,
    frontend_workspace_id: frontend.id, backend_workspace_id: backend.id,
    ...(python ? { python_workspace_id: python.id } : {}),
    frontend_to_backend: first.links,
    backend_to_python: second?.links ?? [],
    unmatched_callers: unmatched.slice(0, maxMatches),
    coverage,
    warnings: [
      "Static API candidates only. Matching method/path never proves runtime connectivity, ownership, authentication or payload compatibility.",
      "Dynamic URLs, client aliases/base URLs, Python router registration and complex Spring annotations are not resolved.",
      ...(coverage.some((item) => item.truncated) || first.truncated || second?.truncated || unmatched.length > maxMatches ?
        ["File, byte or match budget reached; results have partial coverage."] : [])
    ]
  };
}
