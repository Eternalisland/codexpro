import path from "node:path";
import fsp from "node:fs/promises";
import ts from "typescript";
import type { CodexProConfig } from "../config.js";
import type { PathGuard, Workspace } from "../guard.js";
import { redactSensitiveText } from "../redact.js";
import { inspectWorkspace } from "./index.js";
import { findJavaSymbol, findJavaReferences } from "./javaNavigation.js";
import { jdtSymbol, jdtReferences } from "./jdtNavigation.js";
import type { AnalysisCoverage, InventoryFile } from "./types.js";

type SymbolLocation = { name: string; qualified_name: string; kind: string; path: string; line: number; column: number; source: "typescript-checker" };
type ReferenceLocation = { path: string; line: number; column: number; text: string; role: string; is_definition: boolean; source: "typescript-checker" };
type NavigationOptions = { symbol: string; path?: string; maxResults?: number; includeTests?: boolean };
type Index = { program: ts.Program; checker: ts.TypeChecker; files: Map<string, InventoryFile>; coverage: AnalysisCoverage; warnings: string[] };
const SUPPORTED = new Set(["typescript", "javascript"]);
const DEFAULT_LIMIT = 80;
const MAX_FILES = 1500;
const MAX_BYTES = 12 * 1024 * 1024;
const DECLARATION = new Set<ts.SyntaxKind>([
  ts.SyntaxKind.FunctionDeclaration, ts.SyntaxKind.ClassDeclaration,
  ts.SyntaxKind.InterfaceDeclaration, ts.SyntaxKind.TypeAliasDeclaration,
  ts.SyntaxKind.EnumDeclaration, ts.SyntaxKind.MethodDeclaration,
  ts.SyntaxKind.MethodSignature, ts.SyntaxKind.PropertyDeclaration,
  ts.SyntaxKind.PropertySignature, ts.SyntaxKind.VariableDeclaration,
  ts.SyntaxKind.GetAccessor, ts.SyntaxKind.SetAccessor,
  ts.SyntaxKind.FunctionExpression
]);
const cache = new Map<string, Index>();
const normalize = (p: string) => ts.sys.useCaseSensitiveFileNames ? path.resolve(p) : path.resolve(p).toLowerCase();
function limit(value?: number): number {
  return Math.max(1, Math.min(value ?? DEFAULT_LIMIT, 200));
}
function isName(node: ts.Node): node is ts.Identifier {
  return ts.isIdentifier(node);
}
function isDeclarationIdentifier(node: ts.Identifier): boolean {
  const parent = node.parent;
  return Boolean(parent && DECLARATION.has(parent.kind) &&
    "name" in parent && (parent as ts.NamedDeclaration).name === node);
}
function qualify(node: ts.Identifier): string {
  const segments = [node.text];
  for (let parent = node.parent?.parent; parent; parent = parent.parent) {
    if ((ts.isClassDeclaration(parent) || ts.isInterfaceDeclaration(parent) ||
      ts.isModuleDeclaration(parent)) && parent.name) segments.unshift(parent.name.text);
  }
  return segments.join(".");
}
function locate(node: ts.Identifier, workspace: Workspace): SymbolLocation {
  const file = node.getSourceFile();
  const point = file.getLineAndCharacterOfPosition(node.getStart(file));
  return {
    name: node.text, qualified_name: qualify(node),
    kind: ts.SyntaxKind[node.parent.kind],
    path: path.relative(workspace.root, file.fileName).replaceAll("\\", "/"),
    line: point.line + 1, column: point.character + 1,
    source: "typescript-checker"
  };
}
function canonical(checker: ts.TypeChecker, node: ts.Identifier): ts.Symbol | undefined {
  let symbol = checker.getSymbolAtLocation(node);
  if (!symbol && ts.isPropertyAccessExpression(node.parent) && node.parent.name === node) {
    const receiverType = checker.getTypeAtLocation(node.parent.expression);
    symbol = checker.getPropertyOfType(receiverType, node.text);
  }
  if (symbol && (symbol.flags & ts.SymbolFlags.Alias)) {
    try { symbol = checker.getAliasedSymbol(symbol); }
    catch { return undefined; }
  }
  return symbol;
}
function sameResolvedDeclaration(a: ts.Symbol | undefined, b: ts.Symbol): boolean {
  if (!a) return false;
  if (a === b) return true;
  return Boolean(a.declarations?.some(decl =>
    b.declarations?.some(other => decl === other ||
      (decl.getSourceFile().fileName === other.getSourceFile().fileName &&
        decl.getStart() === other.getStart() && decl.kind === other.kind))));
}
async function buildIndex(config: CodexProConfig, guard: PathGuard, workspace: Workspace): Promise<Index> {
  const analysis = await inspectWorkspace(config, guard, workspace);
  const key = workspace.id + ":" + analysis.fingerprint;
  const found = cache.get(key);
  if (found && analysis.cache.hit) return found;
  const names = new Map<string, string>();
  const files = new Map<string, InventoryFile>();
  const warnings = [...analysis.coverage.warnings];
  let scannedBytes = 0;
  let excluded = 0;
  const sources = analysis.files.filter(file => SUPPORTED.has(file.language) && !file.generated);
  for (const file of sources) {
    if (names.size >= Math.min(config.analysisLimits.maxAnalyzedFiles, MAX_FILES) ||
      scannedBytes + file.bytes > Math.min(config.analysisLimits.maxScannedBytes, MAX_BYTES)) {
      excluded++;
      continue;
    }
    try {
      const abs = guard.resolve(workspace, file.path).absPath;
      const contents = await fsp.readFile(abs, "utf8");
      const size = Buffer.byteLength(contents, "utf8");
      if (size + scannedBytes > Math.min(config.analysisLimits.maxScannedBytes, MAX_BYTES)) { excluded++; continue; }
      names.set(normalize(abs), contents);
      files.set(normalize(abs), file);
      scannedBytes += size;
    } catch { excluded++; }
  }
  if (excluded) warnings.push(`Semantic index omitted ${excluded} eligible files due to access or budget limits.`);
  const options: ts.CompilerOptions = {
    target: ts.ScriptTarget.ES2022,
    module: ts.ModuleKind.ESNext,
    moduleResolution: ts.ModuleResolutionKind.Node10,
    allowJs: true, checkJs: false,
    skipLibCheck: true, noEmit: true, jsx: ts.JsxEmit.Preserve
  };
  const compilerHost = ts.createCompilerHost(options);
  const shippedLib = normalize(path.dirname(ts.getDefaultLibFilePath(options)));
  const isStandardLib = (fileName: string) => {
    const resolved = normalize(fileName);
    return path.dirname(resolved) === shippedLib && /^lib(?:\.[a-z0-9]+)*\.d\.ts$/.test(path.basename(resolved));
  };
  const originalFileExists = compilerHost.fileExists.bind(compilerHost);
  const originalReadFile = compilerHost.readFile.bind(compilerHost);
  const originalGetSourceFile = compilerHost.getSourceFile.bind(compilerHost);
  compilerHost.getCurrentDirectory = () => workspace.root;
  compilerHost.fileExists = (fileName) => names.has(normalize(fileName)) ||
    (isStandardLib(fileName) && originalFileExists(fileName));
  compilerHost.readFile = (fileName) => names.get(normalize(fileName)) ??
    (isStandardLib(fileName) ? originalReadFile(fileName) : undefined);
  compilerHost.directoryExists = (dirname) => {
    if (normalize(dirname) === shippedLib) return true;
    const prefix = normalize(dirname) + path.sep;
    return [...names.keys()].some((name) => name.startsWith(prefix));
  };
  compilerHost.getDirectories = () => [];
  compilerHost.getSourceFile = (fileName, languageVersion, onError, shouldCreateNewSourceFile) => {
    const source = names.get(normalize(fileName));
    if (source !== undefined) return ts.createSourceFile(fileName, source, languageVersion, true);
    return isStandardLib(fileName) ? originalGetSourceFile(fileName, languageVersion, onError, shouldCreateNewSourceFile) : undefined;
  };
  const program = ts.createProgram([...names.keys()], options, compilerHost);
  const index: Index = { program, checker: program.getTypeChecker(), files,
    coverage: { ...analysis.coverage, truncated: analysis.coverage.truncated || excluded > 0, warnings },
    warnings };
  // Keep only the most recent index per workspace.
  for (const previous of cache.keys()) if (previous.startsWith(workspace.id + ":")) cache.delete(previous);
  cache.set(key, index);
  return index;
}
function definitions(index: Index, workspace: Workspace, symbolName: string, relativePath?: string) {
  const requested = symbolName.split(".");
  const leaf = requested.at(-1);
  const matches: { symbol: ts.Symbol; loc: SymbolLocation; start: number }[] = [];
  for (const source of index.program.getSourceFiles()) {
    if (!index.files.has(normalize(source.fileName))) continue;
    const currentPath = path.relative(workspace.root, source.fileName).replaceAll("\\", "/");
    if (relativePath && currentPath !== relativePath) continue;
    const visit = (node: ts.Node) => {
      if (isName(node) && node.text === leaf && isDeclarationIdentifier(node)) {
        const qualified = qualify(node);
        if (requested.length === 1 || requested.join(".") === qualified) {
          const symbol = canonical(index.checker, node);
          if (symbol) matches.push({ symbol, loc: locate(node, workspace), start: node.getStart(source) });
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(source);
  }
  return matches;
}
export async function findSymbol(config: CodexProConfig, guard: PathGuard, workspace: Workspace, opts: NavigationOptions) {
  const index = await buildIndex(config, guard, workspace);
  const requestedPath = opts.path ? guard.resolve(workspace, opts.path).relPath : undefined;
  const all = definitions(index, workspace, opts.symbol, requestedPath);
  const max = limit(opts.maxResults);
  const filtered = all.filter(item => opts.includeTests !== false ||
    index.files.get(normalize(path.resolve(workspace.root, item.loc.path)))?.role !== "test");
  return {
    symbol: opts.symbol, definitions: filtered.slice(0, max).map(item => item.loc),
    total: filtered.length, truncated: filtered.length > max || index.coverage.truncated,
    coverage: index.coverage, warnings: index.warnings,
    supported_languages: ["typescript", "javascript"],
    ...(filtered.length === 0 ? { notice: "No semantic definition found. Java and other languages are not yet indexed by this resolver." } : {})
  };
}
export async function findReferences(config: CodexProConfig, guard: PathGuard, workspace: Workspace, opts: NavigationOptions) {
  const index = await buildIndex(config, guard, workspace);
  const requestedPath = opts.path ? guard.resolve(workspace, opts.path).relPath : undefined;
  const found = definitions(index, workspace, opts.symbol, requestedPath);
  const unique = [...new Set(found.map(item => item.symbol))];
  const max = limit(opts.maxResults);
  const definitionsResult = found.slice(0, max).map(item => item.loc);
  if (unique.length !== 1) return {
    symbol: opts.symbol, ambiguous: unique.length > 1, definitions: definitionsResult,
    references: [] as ReferenceLocation[], total: 0, truncated: index.coverage.truncated || found.length > max,
    coverage: index.coverage, warnings: [...index.warnings,
      unique.length > 1 ? "Multiple symbols matched. Supply path to choose one definition." :
        "No semantic definition found; references cannot be resolved."],
    supported_languages: ["typescript", "javascript"]
  };
  const target = unique[0];
  const refs: ReferenceLocation[] = [];
  for (const source of index.program.getSourceFiles()) {
    const meta = index.files.get(normalize(source.fileName));
    if (!meta || (opts.includeTests === false && meta.role === "test")) continue;
    const lines = source.text.split(/\r?\n/);
    const visit = (node: ts.Node) => {
      if (isName(node) && sameResolvedDeclaration(canonical(index.checker, node), target)) {
        const point = source.getLineAndCharacterOfPosition(node.getStart(source));
        refs.push({
          path: meta.path, line: point.line + 1, column: point.character + 1,
          text: redactSensitiveText((lines[point.line] ?? "").trim().slice(0, 300)),
          role: meta.role, is_definition: isDeclarationIdentifier(node),
          source: "typescript-checker"
        });
      }
      ts.forEachChild(node, visit);
    };
    visit(source);
  }
  refs.sort((a, b) => a.path.localeCompare(b.path) || a.line - b.line || a.column - b.column);
  return {
    symbol: opts.symbol, ambiguous: false, definitions: definitionsResult,
    references: refs.slice(0, max), total: refs.length,
    truncated: refs.length > max || index.coverage.truncated,
    coverage: index.coverage, warnings: index.warnings,
    supported_languages: ["typescript", "javascript"]
  };
}

// Resolve Java methods through the Java source parser; retain the compiler-backed TS path.
// A symbol with definitions in both languages must be disambiguated explicitly.
type WorkspaceOptions = NavigationOptions & { parameterTypes?: string[] };
const javaPath = (value?: string) => value?.toLowerCase().endsWith(".java") === true;
export async function findWorkspaceSymbol(config: CodexProConfig, guard: PathGuard, workspace: Workspace, opts: WorkspaceOptions) {
  if (javaPath(opts.path)) return jdtSymbol(config, guard, workspace, opts);
  if (opts.path) return findSymbol(config, guard, workspace, opts);
  const [tsResult, javaResult] = await Promise.all([
    findSymbol(config, guard, workspace, opts), findJavaSymbol(config, guard, workspace, opts)
  ]);
  if (!tsResult.total) return javaResult.total === 1 ?
    jdtSymbol(config, guard, workspace, { ...opts, path: javaResult.definitions[0].path }) :
    javaResult.total ? javaResult : tsResult;
  if (!javaResult.total) return tsResult;
  const definitions = [...tsResult.definitions, ...javaResult.definitions].slice(0, Math.min(200, opts.maxResults ?? 80));
  return {
    symbol: opts.symbol, definitions, total: tsResult.total + javaResult.total,
    ambiguous: true, truncated: tsResult.truncated || javaResult.truncated ||
      definitions.length < tsResult.total + javaResult.total,
    coverage: tsResult.coverage, warnings: [...tsResult.warnings, ...javaResult.warnings,
      "The name exists in both Java and TypeScript/JavaScript; supply a declaration path."],
    supported_languages: ["typescript", "javascript", "java"]
  };
}
export async function findWorkspaceReferences(config: CodexProConfig, guard: PathGuard, workspace: Workspace, opts: WorkspaceOptions) {
  if (javaPath(opts.path)) return jdtReferences(config, guard, workspace, opts);
  if (opts.path) return findReferences(config, guard, workspace, opts);
  const [tsResult, javaResult] = await Promise.all([
    findSymbol(config, guard, workspace, opts), findJavaSymbol(config, guard, workspace, opts)
  ]);
  if (!tsResult.total) return javaResult.total === 1 ?
    jdtReferences(config, guard, workspace, { ...opts, path: javaResult.definitions[0].path }) :
    javaResult.total ? findJavaReferences(config, guard, workspace, opts) :
    findReferences(config, guard, workspace, opts);
  if (!javaResult.total) return findReferences(config, guard, workspace, opts);
  const definitions = [...tsResult.definitions, ...javaResult.definitions].slice(0, Math.min(200, opts.maxResults ?? 80));
  return {
    symbol: opts.symbol, ambiguous: true, definitions, references: [], total: 0,
    truncated: tsResult.truncated || javaResult.truncated ||
      definitions.length < tsResult.total + javaResult.total,
    coverage: tsResult.coverage, warnings: [...tsResult.warnings, ...javaResult.warnings,
      "The name exists in both Java and TypeScript/JavaScript; supply a declaration path."],
    supported_languages: ["typescript", "javascript", "java"]
  };
}
