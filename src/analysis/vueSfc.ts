import ts from "typescript";
import type { AnalysisSymbol, AnalysisSymbolKind } from "./types.js";

type VueScriptIndex = { symbols: AnalysisSymbol[]; imports: string[]; warnings: string[] };

const TAG = /<!--[\s\S]*?-->|<\/?([A-Za-z][\w-]*)\b(?:[^>"']|"[^"]*"|'[^']*')*>/g;

export function vueScriptSource(source: string): { code: string; warnings: string[] } {
  let code = source.replace(/[^\r\n]/g, " ");
  const warnings: string[] = [];
  let block: { tag: string; depth: number; start: number; supported: boolean } | undefined;

  for (const match of source.matchAll(TAG)) {
    if (!match[1]) continue; // HTML comment.
    const tag = match[1].toLowerCase();
    const closing = match[0].startsWith("</");
    const selfClosing = /\/\s*>$/.test(match[0]);

    if (!block) {
      if (closing || selfClosing) continue;
      const lang = match[0].match(/\blang\s*=\s*(?:"([^"]+)"|'([^']+)'|([^\s>]+))/i);
      const value = (lang?.[1] ?? lang?.[2] ?? lang?.[3] ?? "js").toLowerCase();
      const supported = tag !== "script" || ["ts", "tsx", "js", "jsx", "javascript", "typescript"].includes(value);
      if (tag === "script" && !supported) warnings.push(`Vue script language '${value}' is not indexed.`);
      if (tag === "script" && /\bsrc\s*=/.test(match[0])) warnings.push("External Vue script sources are not indexed.");
      block = { tag, depth: 1, start: match.index + match[0].length, supported: supported && !/\bsrc\s*=/.test(match[0]) };
      continue;
    }
    if (tag !== block.tag) continue;
    if (!closing && !selfClosing && tag !== "script") block.depth += 1;
    if (closing) block.depth -= 1;
    if (block.depth !== 0) continue;
    if (block.tag === "script" && block.supported) {
      const end = match.index;
      code = code.slice(0, block.start) + source.slice(block.start, end) + code.slice(end);
    }
    block = undefined;
  }
  if (block?.tag === "script") warnings.push("Unclosed Vue script block was not indexed.");
  return { code, warnings };
}

/** Index Vue script blocks only; keep offsets so line numbers refer to the original .vue file. */
export function indexVueScript(filePath: string, source: string): VueScriptIndex {
  const { code, warnings } = vueScriptSource(source);
  const ast = ts.createSourceFile(`${filePath}.ts`, code, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const symbols: AnalysisSymbol[] = [];
  const imports = new Set<string>();

  const addSymbol = (node: ts.Node, name: ts.Identifier | undefined, kind: AnalysisSymbolKind) => {
    if (!name) return;
    const line = ast.getLineAndCharacterOfPosition(name.getStart(ast)).line + 1;
    const modifiers = ts.canHaveModifiers(node) ? ts.getModifiers(node) : undefined;
    symbols.push({
      name: name.text,
      kind,
      path: filePath,
      line,
      exported: Boolean(modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword)),
      confidence: "strong"
    });
  };

  const visit = (node: ts.Node): void => {
    if (ts.isFunctionDeclaration(node)) addSymbol(node, node.name, "function");
    else if (ts.isClassDeclaration(node)) addSymbol(node, node.name, "class");
    else if (ts.isInterfaceDeclaration(node)) addSymbol(node, node.name, "interface");
    else if (ts.isTypeAliasDeclaration(node)) addSymbol(node, node.name, "type");
    else if (ts.isEnumDeclaration(node)) addSymbol(node, node.name, "enum");
    else if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name)) addSymbol(node, node.name, "variable");

    if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) &&
      node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier)) imports.add(node.moduleSpecifier.text);
    if (ts.isCallExpression(node) && node.arguments.length &&
      (node.expression.kind === ts.SyntaxKind.ImportKeyword ||
        (ts.isIdentifier(node.expression) && node.expression.text === "require")) &&
      ts.isStringLiteral(node.arguments[0])) imports.add(node.arguments[0].text);
    ts.forEachChild(node, visit);
  };
  visit(ast);
  return { symbols, imports: [...imports], warnings };
}
