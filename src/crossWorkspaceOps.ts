import fsp from "node:fs/promises";
import path from "node:path";
import type { CodexProConfig } from "./config.js";
import { isSubpath, type PathGuard, type Workspace } from "./guard.js";
import { listFiles } from "./fsOps.js";

export interface CrossWorkspaceMatch {
  kind: "npm_dependency" | "npm_import" | "maven_dependency" | "java_import" | "relative_import";
  file: string;
  line: number;
  reference: string;
  target: string;
  confidence: "strong" | "inferred";
}

const SOURCE_EXTENSIONS = /\.(?:java|[cm]?[jt]sx?)$/i;
const MAX_FILE_BYTES = 512 * 1024;
const MAX_SCAN_BYTES = 8 * 1024 * 1024;

function relevantFile(file: string): boolean {
  return SOURCE_EXTENSIONS.test(file) || /(?:^|\/)(?:package\.json|pom\.xml)$/.test(file);
}

function lineNumber(text: string, offset: number): number {
  return text.slice(0, offset).split("\n").length;
}

async function scanFiles(
  config: CodexProConfig,
  guard: PathGuard,
  workspace: Workspace,
  limit: number
): Promise<{ files: Array<{ path: string; text: string }>; discovered: number; truncated: boolean; scannedBytes: number }> {
  const paths = await listFiles(guard, workspace, { maxFiles: limit + 1 });
  const truncated = paths.length > limit;
  const perFileLimit = Math.min(config.maxReadBytes, MAX_FILE_BYTES);
  let skipped = 0;
  const files: Array<{ path: string; text: string }> = [];
  let scannedBytes = 0;
  for (const file of paths.slice(0, limit).filter(relevantFile)) {
    try {
      const resolved = guard.resolve(workspace, file);
      const stat = await fsp.stat(resolved.absPath);
      if (!stat.isFile() || stat.size > perFileLimit || scannedBytes + stat.size > MAX_SCAN_BYTES) { skipped += 1; continue; }
      await guard.assertTextFile(resolved.absPath, perFileLimit);
      const text = await fsp.readFile(resolved.absPath, "utf8");
      files.push({ path: file, text });
      scannedBytes += stat.size;
    } catch {
      // Missing, blocked, binary, or unreadable files are excluded.
      skipped += 1;
    }
  }
  return { files, discovered: paths.length, truncated: truncated || skipped > 0, scannedBytes };
}

function pomCoordinates(text: string): string | undefined {
  const withoutParent = text.replace(/<parent\b[^>]*>[\s\S]*?<\/parent>/g, "");
  const artifact = withoutParent.match(/<artifactId>\s*([^<]+)\s*<\/artifactId>/)?.[1]?.trim();
  const group = (withoutParent.match(/<groupId>\s*([^<]+)\s*<\/groupId>/)?.[1]
    ?? text.match(/<parent\b[^>]*>[\s\S]*?<groupId>\s*([^<]+)\s*<\/groupId>/)?.[1])?.trim();
  return group && artifact && !/[\$\{\}]/.test(group + artifact) ? `${group}:${artifact}` : undefined;
}

export async function analyzeCrossWorkspaceDependencies(
  config: CodexProConfig,
  guard: PathGuard,
  source: Workspace,
  target: Workspace,
  options: { maxFiles?: number; maxMatches?: number } = {}
): Promise<{
  source_workspace_id: string;
  target_workspace_id: string;
  matches: CrossWorkspaceMatch[];
  coverage: { source_files: number; target_files: number; source_scanned: number; target_scanned: number; truncated: boolean };
  warnings: string[];
}> {
  if (source.id === target.id) throw new Error("Source and target workspaces must differ.");
  const maxFiles = Math.max(10, Math.min(options.maxFiles ?? 1000, 2000));
  const maxMatches = Math.max(1, Math.min(options.maxMatches ?? 100, 300));
  const [from, to] = await Promise.all([
    scanFiles(config, guard, source, maxFiles),
    scanFiles(config, guard, target, maxFiles)
  ]);
  const npmNames = new Set<string>();
  const javaClasses = new Set<string>();
  const javaPackages = new Set<string>();
  const mavenNames = new Set<string>();
  const targetPaths = new Set(to.files.map((file) => path.resolve(target.root, file.path)));
  for (const file of to.files) {
    if (file.path.endsWith("package.json")) {
      try {
        const name = (JSON.parse(file.text) as { name?: unknown }).name;
        if (typeof name === "string" && name.trim()) npmNames.add(name.trim());
      } catch { /* Ignore invalid manifests. */ }
    }
    if (file.path.endsWith("pom.xml")) {
      const coordinate = pomCoordinates(file.text);
      if (coordinate) mavenNames.add(coordinate);
    }
    if (file.path.endsWith(".java")) {
      const pkg = file.text.match(/^\s*package\s+([\w.]+)\s*;/m)?.[1];
      if (pkg) {
        javaPackages.add(pkg);
        const typeName = path.basename(file.path, ".java");
        if (/^[A-Za-z_$][\w$]*$/.test(typeName)
          && new RegExp(`\\b(?:class|interface|enum|record)\\s+${typeName}\\b`).test(file.text)) {
          javaClasses.add(`${pkg}.${typeName}`);
        }
      }
    }
  }

  const matches: CrossWorkspaceMatch[] = [];
  let limited = false;
  const add = (match: CrossWorkspaceMatch): void => {
    if (matches.length >= maxMatches) { limited = true; return; }
    matches.push(match);
  };
  for (const file of from.files) {
    if (matches.length >= maxMatches) { limited = true; break; }
    if (file.path.endsWith("package.json")) {
      try {
        const data = JSON.parse(file.text) as Record<string, unknown>;
        for (const section of ["dependencies", "devDependencies", "peerDependencies", "optionalDependencies"]) {
          const deps = data[section];
          if (!deps || typeof deps !== "object" || Array.isArray(deps)) continue;
          for (const name of Object.keys(deps)) {
            if (npmNames.has(name)) {
              const at = file.text.indexOf(JSON.stringify(name));
              add({ kind: "npm_dependency", file: file.path, line: lineNumber(file.text, Math.max(0, at)), reference: name, target: name, confidence: "strong" });
            }
          }
        }
      } catch { /* Ignore invalid manifests. */ }
    }
    if (file.path.endsWith("pom.xml")) {
      const regex = /<dependency\b[^>]*>([\s\S]*?)<\/dependency>/g;
      for (const match of file.text.matchAll(regex)) {
        const group = match[1].match(/<groupId>\s*([^<]+)\s*<\/groupId>/)?.[1]?.trim();
        const artifact = match[1].match(/<artifactId>\s*([^<]+)\s*<\/artifactId>/)?.[1]?.trim();
        const coordinate = `${group}:${artifact}`;
        if (mavenNames.has(coordinate)) {
          add({ kind: "maven_dependency", file: file.path, line: lineNumber(file.text, match.index), reference: coordinate, target: coordinate, confidence: "strong" });
        }
      }
    }
    if (!SOURCE_EXTENSIONS.test(file.path)) continue;
    const lines = file.text.split(/\r?\n/);
    for (let i = 0; i < lines.length; i += 1) {
      if (matches.length >= maxMatches) { limited = true; break; }
      const line = lines[i];
      if (/^\s*(?:\/\/|\/\*|\*)/.test(line)) continue;
      if (file.path.endsWith(".java")) {
        const imported = line.match(/^\s*import\s+(?:static\s+)?([\w.]+)(\.\*)?\s*;/)?.[1];
        if (!imported) continue;
        const javaClass = [...javaClasses].find((name) => imported === name || imported.startsWith(`${name}.`));
        const wildcardPackage = !javaClass && line.includes(".*;") && javaPackages.has(imported);
        if (javaClass || wildcardPackage) {
          add({ kind: "java_import", file: file.path, line: i + 1, reference: imported, target: javaClass ?? imported, confidence: javaClass ? "strong" : "inferred" });
        }
        continue;
      }
      for (const importMatch of line.matchAll(/\b(?:from|import|require)\s*(?:\(\s*)?["']([^"']+)["']/g)) {
        const spec = importMatch[1];
        const npmName = [...npmNames].find((name) => spec === name || spec.startsWith(`${name}/`));
        if (npmName) {
          add({ kind: "npm_import", file: file.path, line: i + 1, reference: spec, target: npmName, confidence: "strong" });
        } else if (spec.startsWith(".")) {
          const abs = path.resolve(source.root, path.dirname(file.path), spec);
          const candidates = [abs, ...[".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", "/index.ts", "/index.js"].map((extension) => abs + extension)];
          if (isSubpath(abs, target.root) && candidates.some((candidate) => targetPaths.has(candidate))) {
            add({ kind: "relative_import", file: file.path, line: i + 1, reference: spec, target: "target workspace file", confidence: "strong" });
          }
        }
      }
    }
  }
  const truncated = limited || from.truncated || to.truncated || from.scannedBytes >= MAX_SCAN_BYTES || to.scannedBytes >= MAX_SCAN_BYTES;
  const warnings = [
    "Static evidence only: imports and declared dependencies do not prove runtime calls; absence of matches does not prove absence of dependencies.",
    ...(truncated ? ["Scan or result limits reached; some dependencies may be omitted."] : [])
  ];
  return {
    source_workspace_id: source.id,
    target_workspace_id: target.id,
    matches,
    coverage: { source_files: from.discovered, target_files: to.discovered, source_scanned: from.files.length, target_scanned: to.files.length, truncated },
    warnings
  };
}
