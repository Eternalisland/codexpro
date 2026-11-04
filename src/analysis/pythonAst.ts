import { spawn } from "node:child_process";
import path from "node:path";

export interface PythonAstResult {
  path: string;
  symbols: Array<{ name: string; kind: "class" | "function"; line: number }>;
  imports: Array<{ module: string; level: number; names: string[] }>;
  error?: string;
}

const MAX_FILES = 100;
const MAX_INPUT_BYTES = 1024 * 1024;
const MAX_OUTPUT_BYTES = 2 * 1024 * 1024;
const TIMEOUT_MS = 5000;

// This helper parses syntax only. It never imports, evaluates or runs project modules.
const PROGRAM = String.raw`
import ast
import json
import sys

data = json.load(sys.stdin)
out = []
for item in data:
    result = {"path": item["path"], "symbols": [], "imports": []}
    try:
        tree = ast.parse(item["text"], filename=item["path"])
        for node in ast.walk(tree):
            if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef)):
                result["symbols"].append({"name": node.name, "kind": "class" if isinstance(node, ast.ClassDef) else "function", "line": node.lineno})
            elif isinstance(node, ast.Import):
                for alias in node.names:
                    result["imports"].append({"module": alias.name, "level": 0, "names": []})
            elif isinstance(node, ast.ImportFrom):
                result["imports"].append({"module": node.module or "", "level": node.level, "names": [alias.name for alias in node.names]})
    except SyntaxError:
        result["error"] = "syntax"
    out.append(result)
json.dump(out, sys.stdout, ensure_ascii=False)
`;

export async function indexPythonAst(files: Array<{ path: string; text: string }>): Promise<{
  results: Map<string, PythonAstResult>; warnings: string[];
}> {
  const results = new Map<string, PythonAstResult>();
  if (files.length === 0 || process.env.CODEXPRO_PYTHON_AST !== "1") return { results, warnings: [] };
  const selected: typeof files = [];
  let bytes = 0;
  for (const file of files) {
    const size = Buffer.byteLength(file.text, "utf8");
    if (selected.length >= MAX_FILES || bytes + size > MAX_INPUT_BYTES) break;
    selected.push(file);
    bytes += size;
  }
  const warnings = selected.length < files.length ? ["Python AST budget reached; some files retain lexical indexing."] : [];
  if (!selected.length) return { results, warnings };
  const interpreter = process.env.CODEXPRO_PYTHON_EXECUTABLE?.trim() ||
    (process.platform === "win32" ? "python" : "python3");

  try {
    const parsed = await new Promise<PythonAstResult[]>((resolve, reject) => {
      const child = spawn(interpreter, ["-I", "-S", "-B", "-c", PROGRAM], { windowsHide: true, shell: false });
      const output: Buffer[] = [];
      let outputBytes = 0;
      let expired = false;
      const timer = setTimeout(() => { expired = true; child.kill(); }, TIMEOUT_MS);
      timer.unref();
      child.stdout.on("data", (chunk: Buffer) => {
        outputBytes += chunk.length;
        if (outputBytes > MAX_OUTPUT_BYTES) { child.kill(); return; }
        output.push(chunk);
      });
      child.stderr.on("data", () => {}); // Never surface arbitrary local interpreter diagnostics.
      child.stdin.on("error", () => {});
      child.on("error", (error) => { clearTimeout(timer); reject(error); });
      child.on("close", (code) => {
        clearTimeout(timer);
        if (expired || outputBytes > MAX_OUTPUT_BYTES || code !== 0) {
          reject(new Error("Python AST parser was unavailable or exceeded its budget."));
          return;
        }
        try { resolve(JSON.parse(Buffer.concat(output).toString("utf8")) as PythonAstResult[]); }
        catch { reject(new Error("Invalid Python AST parser output.")); }
      });
      child.stdin.end(JSON.stringify(selected));
    });
    for (const item of parsed) {
      if (typeof item.path === "string" && selected.some((file) => file.path === item.path) &&
        Array.isArray(item.symbols) && Array.isArray(item.imports)) results.set(item.path, item);
    }
    for (const item of parsed) if (item.error) warnings.push(`${item.path}: Python AST syntax error; using lexical fallback.`);
  } catch {
    warnings.push("Python AST unavailable; using lexical indexing. Check the configured Python 3 interpreter.");
  }
  return { results, warnings };
}

/** Resolve only imports that are backed by files in the bounded workspace inventory. */
export function resolvePythonAstImports(
  fromPath: string,
  references: PythonAstResult["imports"],
  files: Set<string>
): string[] {
  const resolved = new Set<string>();
  for (const reference of references) {
    if (!Number.isInteger(reference.level) || reference.level < 0 ||
      typeof reference.module !== "string" || !Array.isArray(reference.names)) continue;
    let parent = reference.level ? path.posix.dirname(fromPath) : "";
    for (let level = 1; level < reference.level; level += 1) parent = path.posix.dirname(parent);
    const modulePath = reference.module.split(".").filter(Boolean).join("/");
    const base = path.posix.normalize(path.posix.join(parent, modulePath));
    const candidates = modulePath ? [base + ".py", path.posix.join(base, "__init__.py")] : [];
    if (reference.names.length) {
      for (const name of reference.names) {
        if (/^[A-Za-z_]\w*$/.test(name)) {
          candidates.push(path.posix.join(base, name) + ".py", path.posix.join(base, name, "__init__.py"));
        }
      }
    }
    for (const candidate of candidates) {
      if (candidate !== ".." && !candidate.startsWith("../") && !path.posix.isAbsolute(candidate) &&
        files.has(candidate)) resolved.add(candidate);
    }
  }
  return [...resolved];
}
