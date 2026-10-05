import fsp from "node:fs/promises";
import path from "node:path";
import type { CodexProConfig } from "../config.js";
import type { PathGuard, Workspace } from "../guard.js";
import { detectRiskSignals } from "./classify.js";
import { inspectWorkspace } from "./index.js";
import type { ChangeAnalysis, AnalysisCommandRecommendation, AnalysisRiskSignal, WorkspaceAnalysis } from "./types.js";

const RISK_LABELS: Record<AnalysisRiskSignal["id"], string> = {
  "public-api": "Public API",
  authentication: "Authentication or sessions",
  storage: "Storage or persistence",
  migration: "Schema or migration",
  build: "Build or dependency configuration",
  configuration: "Runtime configuration"
};

const CHECK_PRIORITY = ["test", "typecheck", "lint", "build", "check", "smoke", "verify"];
const SAFE_SCRIPT = /^[A-Za-z0-9._:-]+$/;
type PackageRunner = "npm" | "pnpm" | "yarn" | "bun";

interface ProjectManifest {
  path: string;
  projectPath: string;
  name: string;
}

const NATIVE_MANIFESTS = new Set(["go.mod", "Cargo.toml", "Package.swift", "pyproject.toml", "pom.xml"]);

function joinProjectPath(projectPath: string, fileName: string): string {
  return projectPath === "." ? fileName : `${projectPath}/${fileName}`;
}

function projectPathForManifest(manifestPath: string): string {
  const directory = path.posix.dirname(manifestPath);
  return directory === "." ? "." : directory;
}

function pathBelongsToProject(filePath: string, projectPath: string): boolean {
  return projectPath === "." || filePath === projectPath || filePath.startsWith(`${projectPath}/`);
}

function projectDepth(projectPath: string): number {
  return projectPath === "." ? 0 : projectPath.split("/").length;
}

function checkForScript(script: string): string | undefined {
  const normalized = script.toLowerCase();
  return CHECK_PRIORITY.find((check) => normalized === check || normalized.startsWith(`${check}:`));
}

function commandRunnable(config: CodexProConfig, safeModeAllowed: boolean): boolean {
  return config.bashMode === "full" || (config.bashMode === "safe" && safeModeAllowed);
}

function declaredPackageRunner(packageJson: Record<string, unknown>): PackageRunner | undefined {
  return typeof packageJson.packageManager === "string"
    ? packageJson.packageManager.match(/^(npm|pnpm|yarn|bun)(?:@|$)/)?.[1] as PackageRunner | undefined
    : undefined;
}

async function readPackageJson(guard: PathGuard, workspace: Workspace, manifestPath: string): Promise<Record<string, unknown> | undefined> {
  try {
    const parsed = JSON.parse(await fsp.readFile(guard.resolve(workspace, manifestPath).absPath, "utf8"));
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as Record<string, unknown> : undefined;
  } catch {
    return undefined;
  }
}

function projectAncestors(projectPath: string): string[] {
  const ancestors: string[] = [];
  let current = projectPath;
  while (true) {
    ancestors.push(current);
    if (current === ".") break;
    const parent = path.posix.dirname(current);
    current = parent === "." ? "." : parent;
  }
  return ancestors;
}

async function packageRunner(
  guard: PathGuard,
  workspace: Workspace,
  projectPath: string,
  packageJson: Record<string, unknown>
): Promise<PackageRunner> {
  const lockfiles: Array<[string, PackageRunner]> = [
    ["pnpm-lock.yaml", "pnpm"],
    ["yarn.lock", "yarn"],
    ["bun.lock", "bun"],
    ["bun.lockb", "bun"],
    ["package-lock.json", "npm"],
    ["npm-shrinkwrap.json", "npm"]
  ];

  // Nested packages commonly inherit the package manager and lockfile from a workspace ancestor.
  for (const ancestor of projectAncestors(projectPath)) {
    const ancestorPackage = ancestor === projectPath
      ? packageJson
      : await readPackageJson(guard, workspace, joinProjectPath(ancestor, "package.json"));
    const declared = ancestorPackage ? declaredPackageRunner(ancestorPackage) : undefined;
    if (declared) return declared;
    for (const [lockfile, runner] of lockfiles) {
      try {
        if ((await fsp.stat(guard.resolve(workspace, joinProjectPath(ancestor, lockfile)).absPath)).isFile()) return runner;
      } catch {
        // Continue to the next package-manager marker or ancestor.
      }
    }
  }
  return "npm";
}

function packageCommand(runner: PackageRunner, script: string): string {
  if (runner === "npm") return script === "test" ? "npm test" : `npm run ${script}`;
  if (runner === "pnpm") return script === "test" ? "pnpm test" : `pnpm run ${script}`;
  return `${runner} run ${script}`;
}

async function packageRecommendations(
  config: CodexProConfig,
  guard: PathGuard,
  workspace: Workspace,
  manifest: ProjectManifest
): Promise<AnalysisCommandRecommendation[]> {
  const parsed = await readPackageJson(guard, workspace, manifest.path);
  if (!parsed) return [];
  const scripts = parsed.scripts && typeof parsed.scripts === "object" && !Array.isArray(parsed.scripts)
    ? parsed.scripts as Record<string, unknown>
    : {};
  const runner = await packageRunner(guard, workspace, manifest.projectPath, parsed);
  return Object.keys(scripts)
    .filter((name) => typeof scripts[name] === "string" && SAFE_SCRIPT.test(name) && Boolean(checkForScript(name)))
    .sort((left, right) => {
      const leftCheck = checkForScript(left) ?? left;
      const rightCheck = checkForScript(right) ?? right;
      return CHECK_PRIORITY.indexOf(leftCheck) - CHECK_PRIORITY.indexOf(rightCheck) || left.localeCompare(right);
    })
    .map((name) => {
      const check = checkForScript(name) ?? name;
      // Safe bash currently accepts package scripts in these categories; other discovered checks remain advisory.
      const safeModeAllowed = ["test", "typecheck", "lint", "build", "check", "smoke", "verify"].includes(check);
      return {
        command: packageCommand(runner, name),
        source: manifest.path,
        reasons: ["existing project script", `${runner} project`, check === "test" ? "related test coverage" : "project verification"],
        check,
        cwd: manifest.projectPath,
        projectPath: manifest.projectPath,
        runner,
        runnable: commandRunnable(config, safeModeAllowed)
      };
    });
}

function nativeRecommendation(config: CodexProConfig, manifest: ProjectManifest): AnalysisCommandRecommendation | undefined {
  const pythonCommand = process.platform === "win32" ? "python -m pytest" : "python3 -m pytest";
  const candidates: Record<string, { command: string; runner: string; check: string; safeModeAllowed: boolean }> = {
    "go.mod": { command: "go test ./...", runner: "go", check: "test", safeModeAllowed: true },
    "Cargo.toml": { command: "cargo test", runner: "cargo", check: "test", safeModeAllowed: true },
    "Package.swift": { command: "swift test", runner: "swift", check: "test", safeModeAllowed: false },
    "pyproject.toml": { command: pythonCommand, runner: "python", check: "test", safeModeAllowed: true },
    "pom.xml": { command: "mvn test", runner: "mvn", check: "test", safeModeAllowed: false }
  };
  const candidate = candidates[manifest.name];
  if (!candidate) return undefined;
  return {
    command: candidate.command,
    source: manifest.path,
    reasons: ["detected project manifest", "native project verification"],
    check: candidate.check,
    cwd: manifest.projectPath,
    projectPath: manifest.projectPath,
    runner: candidate.runner,
    runnable: commandRunnable(config, candidate.safeModeAllowed)
  };
}

function discoveredManifests(analysis: WorkspaceAnalysis): ProjectManifest[] {
  return analysis.files
    .filter((file) => path.posix.basename(file.path) === "package.json" || NATIVE_MANIFESTS.has(path.posix.basename(file.path)))
    .map((file) => ({
      path: file.path,
      projectPath: projectPathForManifest(file.path),
      name: path.posix.basename(file.path)
    }));
}

function relevantProjectPaths(manifests: ProjectManifest[], changedPaths: string[]): Set<string> {
  const allProjectPaths = [...new Set(manifests.map((manifest) => manifest.projectPath))];
  if (changedPaths.length === 0) return new Set(allProjectPaths);

  const selected = new Set<string>();
  for (const changedPath of changedPaths) {
    const containing = allProjectPaths.filter((projectPath) => pathBelongsToProject(changedPath, projectPath));
    const nearestDepth = Math.max(-1, ...containing.map(projectDepth));
    for (const projectPath of containing) {
      if (projectDepth(projectPath) === nearestDepth) selected.add(projectPath);
    }
  }
  return selected;
}

export async function discoverWorkspaceChecks(
  config: CodexProConfig,
  guard: PathGuard,
  workspace: Workspace,
  options: { changedPaths?: string[]; analysis?: WorkspaceAnalysis } = {}
): Promise<AnalysisCommandRecommendation[]> {
  const analysis = options.analysis ?? await inspectWorkspace(config, guard, workspace);
  const manifests = discoveredManifests(analysis);
  const selectedProjects = relevantProjectPaths(manifests, options.changedPaths ?? []);
  const selectedManifests = manifests.filter((manifest) => selectedProjects.has(manifest.projectPath));
  const recommendations: AnalysisCommandRecommendation[] = [];

  for (const manifest of selectedManifests) {
    if (manifest.name === "package.json") {
      recommendations.push(...await packageRecommendations(config, guard, workspace, manifest));
      continue;
    }
    const recommendation = nativeRecommendation(config, manifest);
    if (recommendation) recommendations.push(recommendation);
  }

  // Different manifests can legitimately propose the same command; keep one command per project root.
  const unique = new Map<string, AnalysisCommandRecommendation>();
  for (const recommendation of recommendations) {
    const key = `${recommendation.cwd ?? "."}\0${recommendation.command}`;
    if (!unique.has(key)) unique.set(key, recommendation);
  }
  return [...unique.values()].sort((left, right) =>
    (left.projectPath ?? ".").localeCompare(right.projectPath ?? ".") ||
    CHECK_PRIORITY.indexOf(left.check) - CHECK_PRIORITY.indexOf(right.check) ||
    left.command.localeCompare(right.command)
  );
}

export async function reviewWorkspaceChanges(
  config: CodexProConfig,
  guard: PathGuard,
  workspace: Workspace,
  options: { changedPaths: string[] }
): Promise<ChangeAnalysis> {
  const changedPaths: string[] = [];
  const pathWarnings: string[] = [];
  for (const candidate of options.changedPaths) {
    try {
      const relPath = guard.resolve(workspace, candidate).relPath;
      if (!changedPaths.includes(relPath)) changedPaths.push(relPath);
    } catch {
      pathWarnings.push(`Skipped unsafe or unreadable changed path: ${candidate}`);
    }
  }
  const analysis = await inspectWorkspace(config, guard, workspace);
  const affectedAreas = [...new Set(changedPaths.map((filePath) => filePath.includes("/") ? filePath.split("/")[0] : "."))].sort();
  const changed = new Set(changedPaths);
  const dependents = new Map<string, Set<string>>();
  const tests = new Map<string, Set<string>>();
  for (const relationship of analysis.relationships) {
    if (!changed.has(relationship.to)) continue;
    const target = relationship.kind === "tests" ? tests : dependents;
    const reasons = target.get(relationship.from) ?? new Set<string>();
    reasons.add(`${relationship.kind} ${relationship.to}`);
    target.set(relationship.from, reasons);
  }

  const directTestCandidates = analysis.files.filter((file) => file.role === "test" && changedPaths.some((changedPath) => {
    const base = path.basename(changedPath).replace(/\.[^.]+$/, "").toLowerCase();
    return base.length > 2 && file.path.toLowerCase().includes(base);
  }));
  for (const test of directTestCandidates) {
    const reasons = tests.get(test.path) ?? new Set<string>();
    reasons.add("test filename matches changed source");
    tests.set(test.path, reasons);
  }

  const risks = new Map<AnalysisRiskSignal["id"], Set<string>>();
  for (const changedPath of changedPaths) {
    for (const risk of detectRiskSignals(changedPath) as AnalysisRiskSignal["id"][]) {
      const paths = risks.get(risk) ?? new Set<string>();
      paths.add(changedPath);
      risks.set(risk, paths);
    }
  }
  const riskSignals: AnalysisRiskSignal[] = [...risks.entries()].map(([id, paths]) => ({
    id,
    label: RISK_LABELS[id],
    confidence: "inferred",
    paths: [...paths].sort(),
    reasons: [`path pattern matched ${id}`]
  }));
  const resultLimit = Math.max(1, config.maxSearchResults);
  const dependentFiles = [...dependents.entries()]
    .map(([filePath, reasons]) => ({ path: filePath, confidence: "strong" as const, reasons: [...reasons] }))
    .sort((a, b) => a.path.localeCompare(b.path));
  const relatedTests = [...tests.entries()]
    .map(([filePath, reasons]) => ({ path: filePath, confidence: "strong" as const, reasons: [...reasons] }))
    .sort((a, b) => a.path.localeCompare(b.path));
  const impactLimited = dependentFiles.length > resultLimit || relatedTests.length > resultLimit;

  return {
    schemaVersion: 1,
    changedPaths,
    affectedAreas,
    dependentFiles: dependentFiles.slice(0, resultLimit),
    relatedTests: relatedTests.slice(0, resultLimit),
    riskSignals,
    recommendedCommands: await discoverWorkspaceChecks(config, guard, workspace, { changedPaths, analysis }),
    coverage: analysis.coverage,
    warnings: [
      ...analysis.warnings,
      ...pathWarnings,
      ...(impactLimited ? [`Change-impact output was limited to ${resultLimit} dependent files and ${resultLimit} related tests.`] : [])
    ],
    cache: analysis.cache
  };
}
