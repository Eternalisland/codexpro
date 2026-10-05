import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import type { CodexProConfig } from "./config.js";
import { resolveBashInvocation } from "./bashOps.js";
import type { Workspace } from "./guard.js";
import { CodexProError, isSubpath, normalizeRelPath, PathGuard } from "./guard.js";
import { redactSensitiveText } from "./redact.js";

interface GitContext {
  cwd: string;
  root: string;
  targetPath?: string;
}

interface GitContextDiscovery {
  contexts: GitContext[];
  scannedDirectories: number;
  truncated: boolean;
  warnings: string[];
}

export interface GitRepositoryInfo {
  /** Git 根目录相对于已打开工作区的路径；工作区自身为仓库时固定为 `.`。 */
  path: string;
  branch?: string;
  head?: string;
  dirty: boolean;
}

export interface GitRepositoryInventory {
  repositories: GitRepositoryInfo[];
  scannedDirectories: number;
  truncated: boolean;
  warnings: string[];
}

// 子仓库发现必须有明确上限，避免在超大非 Git 工作区中为一次 diff 遍历整块磁盘。
const MAX_GIT_DISCOVERY_DEPTH = 6;
const MAX_GIT_DISCOVERY_DIRECTORIES = 5_000;
const MAX_GIT_REPOSITORIES = 50;

export interface GitRuntimeStatus {
  executable?: string;
  version?: string;
  source?: "configured" | "git-for-windows" | "path";
  available: boolean;
  reason?: string;
  bash_runtime?: string;
}

function gitExecutableInfo(config: CodexProConfig): { executable: string; source: GitRuntimeStatus["source"] } {
  if (config.gitExecutable) return { executable: config.gitExecutable, source: "configured" };
  if (process.platform === "win32") {
    try {
      const bash = resolveBashInvocation(config);
      if (bash.runtime === "native-bash" && /[\\/]Git[\\/]bin[\\/]bash\.exe$/i.test(bash.executable)) {
        const gitForWindows = path.win32.join(path.win32.dirname(path.win32.dirname(bash.executable)), "cmd", "git.exe");
        if (fs.existsSync(gitForWindows)) return { executable: gitForWindows, source: "git-for-windows" };
      }
    } catch {
      // Preserve the normal PATH lookup so Git diagnostics can report the actual failure.
    }
  }
  return { executable: "git", source: "path" };
}

export function gitRuntimeStatus(config: CodexProConfig): GitRuntimeStatus {
  const info = gitExecutableInfo(config);
  const result = spawnSync(info.executable, ["--version"], {
    encoding: "utf8",
    maxBuffer: config.maxOutputBytes,
    env: { ...process.env, NO_COLOR: "1" },
    windowsHide: true
  });
  if (result.error || result.status !== 0) {
    return {
      executable: info.executable,
      source: info.source,
      available: false,
      reason: result.error?.message ?? String(result.stderr ?? result.stdout ?? `git exited with status ${result.status}`)
    };
  }
  return {
    executable: info.executable,
    source: info.source,
    version: String(result.stdout ?? "").trim().split(/\r?\n/)[0] || undefined,
    available: true
  };
}

function gitExecutable(config: CodexProConfig): string {
  return gitExecutableInfo(config).executable;
}

function defaultGitContext(workspace: Workspace): GitContext {
  return { cwd: workspace.root, root: workspace.root };
}

function gitRootAt(config: CodexProConfig, directory: string): string | undefined {
  const result = spawnSync(gitExecutable(config), ["rev-parse", "--show-toplevel"], {
    cwd: directory,
    encoding: "utf8",
    maxBuffer: config.maxOutputBytes,
    env: { ...process.env, NO_COLOR: "1" },
    windowsHide: true
  });
  if (result.error || result.status !== 0) return undefined;
  const rootText = String(result.stdout ?? "").trim();
  if (!rootText) return undefined;
  try {
    return fs.realpathSync.native(path.resolve(rootText));
  } catch {
    return undefined;
  }
}

function nearestGitContext(config: CodexProConfig, guard: PathGuard, workspace: Workspace, filePath?: string): GitContext {
  if (!filePath?.trim()) return defaultGitContext(workspace);
  const resolved = guard.resolve(workspace, filePath);
  let probe = resolved.absPath;
  try {
    if (!fs.statSync(probe).isDirectory()) probe = path.dirname(probe);
  } catch {
    probe = path.dirname(probe);
  }
  const root = gitRootAt(config, probe);
  if (!root) return { ...defaultGitContext(workspace), targetPath: resolved.relPath };
  if (!config.allowedRoots.some((allowedRoot) => isSubpath(root, allowedRoot)) || !isSubpath(resolved.absPath, root)) {
    return { ...defaultGitContext(workspace), targetPath: resolved.relPath };
  }
  return { cwd: root, root, targetPath: normalizeRelPath(path.relative(root, resolved.absPath)) };
}

function discoverNestedGitContexts(config: CodexProConfig, guard: PathGuard, workspace: Workspace): GitContextDiscovery {
  const contexts: GitContext[] = [];
  const queue: Array<{ directory: string; depth: number }> = [{ directory: workspace.root, depth: 0 }];
  let scannedDirectories = 0;
  let depthLimitReached = false;

  while (queue.length > 0 && scannedDirectories < MAX_GIT_DISCOVERY_DIRECTORIES && contexts.length < MAX_GIT_REPOSITORIES) {
    const current = queue.shift();
    if (!current) break;
    scannedDirectories += 1;

    // .git 既可能是目录，也可能是 worktree 使用的文本文件；找到后不再进入仓库内部扫描。
    if (current.depth > 0 && fs.existsSync(path.join(current.directory, ".git"))) {
      try {
        const root = fs.realpathSync.native(current.directory);
        const allowed = config.allowedRoots.some((allowedRoot) => isSubpath(root, allowedRoot));
        if (allowed && isSubpath(root, workspace.root) && gitRootAt(config, root) === root) {
          contexts.push({ cwd: root, root });
        }
      } catch {
        // 忽略扫描期间消失、无权限或损坏的目录，继续发现其他可用仓库。
      }
      continue;
    }
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(current.directory, { withFileTypes: true });
    } catch {
      continue;
    }
    entries.sort((left, right) => left.name.localeCompare(right.name));
    for (const entry of entries) {
      if (!entry.isDirectory() || entry.isSymbolicLink() || entry.name === ".git") continue;
      const directory = path.join(current.directory, entry.name);
      const relPath = normalizeRelPath(path.relative(workspace.root, directory));
      if (guard.isBlockedRelativePath(relPath)) continue;
      if (current.depth >= MAX_GIT_DISCOVERY_DEPTH) {
        depthLimitReached = true;
        continue;
      }
      queue.push({ directory, depth: current.depth + 1 });
    }
  }

  const warnings: string[] = [];
  if (depthLimitReached) {
    warnings.push(`Git repository discovery reached the maximum depth of ${MAX_GIT_DISCOVERY_DEPTH}; deeper repositories were not scanned.`);
  }
  if (scannedDirectories >= MAX_GIT_DISCOVERY_DIRECTORIES && queue.length > 0) {
    warnings.push(`Git repository discovery reached the ${MAX_GIT_DISCOVERY_DIRECTORIES}-directory limit; results are truncated.`);
  }
  if (contexts.length >= MAX_GIT_REPOSITORIES && queue.length > 0) {
    warnings.push(`Git repository discovery reached the ${MAX_GIT_REPOSITORIES}-repository limit; results are truncated.`);
  }
  return {
    contexts: contexts.sort((left, right) => left.root.localeCompare(right.root)),
    scannedDirectories,
    truncated: warnings.length > 0,
    warnings
  };
}

function gitContexts(config: CodexProConfig, guard: PathGuard, workspace: Workspace, filePath?: string): GitContextDiscovery {
  if (filePath?.trim()) {
    return { contexts: [nearestGitContext(config, guard, workspace, filePath)], scannedDirectories: 0, truncated: false, warnings: [] };
  }
  // 工作区本身属于 Git 仓库时保持原行为；只有宽工作区才聚合其下的独立仓库。
  if (gitRootAt(config, workspace.root)) {
    return { contexts: [defaultGitContext(workspace)], scannedDirectories: 1, truncated: false, warnings: [] };
  }
  const nested = discoverNestedGitContexts(config, guard, workspace);
  return nested.contexts.length > 0
    ? nested
    : { ...nested, contexts: [defaultGitContext(workspace)] };
}

function repositoryLabel(context: GitContext, workspace: Workspace): string {
  return normalizeRelPath(path.relative(workspace.root, context.root));
}

function boundedGitOutput(sections: string[], maxOutputBytes: number): string {
  const output = sections.join("\n\n");
  const encoded = Buffer.from(output, "utf8");
  if (encoded.length <= maxOutputBytes) return output || "(no output)";
  return `${encoded.subarray(0, maxOutputBytes).toString("utf8")}\n...[multi-repository Git output truncated]`;
}

function repositoryError(operation: string, context: GitContext, workspace: Workspace, output: string): string {
  return `error: Git ${operation} failed for repository ${repositoryLabel(context, workspace)}: ${output}`;
}

function appendDiscoveryWarnings(sections: string[], discovery: GitContextDiscovery): string[] {
  if (!discovery.truncated) return sections;
  return [...sections, ...discovery.warnings.map((warning) => `Warning: ${warning}`)];
}

function decodeGitQuotedPath(gitPath: string): string {
  if (!gitPath.startsWith('"') || !gitPath.endsWith('"')) return gitPath;
  const input = gitPath.slice(1, -1);
  let decoded = "";
  let escapedBytes: number[] = [];
  const flushEscapedBytes = () => {
    if (escapedBytes.length === 0) return;
    decoded += Buffer.from(escapedBytes).toString("utf8");
    escapedBytes = [];
  };
  for (let index = 0; index < input.length; index += 1) {
    const char = input[index];
    if (char !== "\\") {
      flushEscapedBytes();
      decoded += char;
      continue;
    }
    index += 1;
    const escaped = input[index];
    if (escaped === undefined) return gitPath;
    if (/[0-7]/.test(escaped)) {
      let octal = escaped;
      for (let count = 0; count < 2 && index + 1 < input.length && /[0-7]/.test(input[index + 1]); count += 1) {
        index += 1;
        octal += input[index];
      }
      escapedBytes.push(Number.parseInt(octal, 8));
      continue;
    }
    flushEscapedBytes();
    decoded += ({ a: "\x07", b: "\b", f: "\f", n: "\n", r: "\r", t: "\t", v: "\v" } as Record<string, string>)[escaped] ?? escaped;
  }
  flushEscapedBytes();
  return decoded;
}

function workspacePathForGitPath(gitRoot: string, workspace: Workspace, gitPath: string): string {
  if (!gitPath || gitPath === "/dev/null") return gitPath;
  // Git 会把空格、非 ASCII 等路径输出成 C-style quoted path，必须先解码再拼接工作区前缀。
  const decodedPath = decodeGitQuotedPath(gitPath);
  const absPath = path.resolve(gitRoot, decodedPath.replace(/^\.[/\\]/, ""));
  if (!isSubpath(absPath, workspace.root)) return gitPath;
  return normalizeRelPath(path.relative(workspace.root, absPath));
}

function rewriteStatusPaths(output: string, context: GitContext, workspace: Workspace): string {
  if (context.root === workspace.root) return output;
  return output.split("\n").map((line) => {
    if (!line || line.startsWith("##")) return line;
    if (line.includes("\t")) {
      const parts = line.split("\t");
      return [parts[0], ...parts.slice(1).map((value) => workspacePathForGitPath(context.root, workspace, value))].join("\t");
    }
    const match = line.match(/^(\s*\S{1,2}\s+)(.+)$/);
    if (!match) return line;
    const pathText = match[2];
    if (pathText.includes(" -> ")) {
      const [from, to] = pathText.split(" -> ", 2);
      return `${match[1]}${workspacePathForGitPath(context.root, workspace, from)} -> ${workspacePathForGitPath(context.root, workspace, to)}`;
    }
    return `${match[1]}${workspacePathForGitPath(context.root, workspace, pathText)}`;
  }).join("\n");
}

function runGit(config: CodexProConfig, workspace: Workspace, args: string[], maxOutputBytes: number, context = defaultGitContext(workspace), rewritePaths = false): string {
  const result = spawnSync(gitExecutable(config), args, {
    cwd: context.cwd,
    encoding: "utf8",
    maxBuffer: maxOutputBytes,
    env: { ...process.env, NO_COLOR: "1" }
  });
  if (result.error) {
    return `git unavailable or failed: ${result.error.message}`;
  }
  if (result.status !== 0) {
    const stderr = result.stderr?.trim() || "";
    const stdout = result.stdout?.trim() || "";
    return stderr || stdout || `git exited with status ${result.status}`;
  }
  const output = result.stdout.trim() || "(no output)";
  return redactSensitiveText(rewritePaths ? rewriteStatusPaths(output, context, workspace) : output);
}

function isGitFailure(output: string): boolean {
  const trimmed = output.trim().toLowerCase();
  return (
    trimmed.startsWith("fatal:") ||
    trimmed.startsWith("error:") ||
    trimmed.startsWith("git unavailable or failed:") ||
    trimmed.startsWith("git exited with status") ||
    trimmed.startsWith("usage: git ") ||
    trimmed.includes("not a git repository")
  );
}

function outputLines(output: string): string[] {
  return output.trim() === "(no output)" ? [] : output.split("\n").map((line) => line.trim()).filter(Boolean);
}

export function gitRepositoryInventory(
  config: CodexProConfig,
  guard: PathGuard,
  workspace: Workspace
): GitRepositoryInventory {
  const discovery = gitContexts(config, guard, workspace);
  const repositories: GitRepositoryInfo[] = [];
  for (const context of discovery.contexts) {
    const root = gitRootAt(config, context.cwd);
    if (!root) continue;
    const branchOutput = runGit(config, workspace, ["rev-parse", "--abbrev-ref", "HEAD"], config.maxOutputBytes, context);
    const headOutput = runGit(config, workspace, ["rev-parse", "--short=12", "HEAD"], config.maxOutputBytes, context);
    const statusOutput = runGit(config, workspace, ["status", "--porcelain"], config.maxOutputBytes, context, true);
    const branch = isGitFailure(branchOutput) || branchOutput === "HEAD" ? undefined : branchOutput;
    const head = isGitFailure(headOutput) ? undefined : headOutput;
    const dirty = !isGitFailure(statusOutput) && outputLines(statusOutput).length > 0;
    repositories.push({
      path: repositoryLabel(context, workspace),
      ...(branch ? { branch } : {}),
      ...(head ? { head } : {}),
      dirty
    });
  }
  return {
    repositories,
    scannedDirectories: discovery.scannedDirectories,
    truncated: discovery.truncated,
    warnings: discovery.warnings
  };
}

export function gitStatus(config: CodexProConfig, workspace: Workspace, guard?: PathGuard, filePath?: string, staged = false): string {
  const args = staged ? ["diff", "--cached", "--name-status"] : ["status", "--short", "--branch"];
  if (!guard && filePath?.trim()) return "path-scoped git status requires a path guard";
  const discovery = guard
    ? gitContexts(config, guard, workspace, filePath)
    : { contexts: [defaultGitContext(workspace)], scannedDirectories: 0, truncated: false, warnings: [] };
  const contexts = discovery.contexts;
  if (filePath?.trim() && guard) {
    const context = contexts[0];
    args.push("--", context.targetPath ?? guard.resolve(workspace, filePath).relPath);
  }
  if (contexts.length === 1) return runGit(config, workspace, args, config.maxOutputBytes, contexts[0], true);
  const sections: string[] = [];
  for (const context of contexts) {
    const output = runGit(config, workspace, args, config.maxOutputBytes, context, true);
    if (isGitFailure(output)) return repositoryError("status", context, workspace, output);
    sections.push(`## Repository: ${repositoryLabel(context, workspace)}\n${output}`);
  }
  return boundedGitOutput(sections, config.maxOutputBytes);
}

export function gitDiff(config: CodexProConfig, guard: PathGuard, workspace: Workspace, filePath?: string, staged = false): string {
  const args = ["diff", "--no-color", "--no-ext-diff", "--no-textconv"];
  const discovery = gitContexts(config, guard, workspace, filePath);
  const contexts = discovery.contexts;
  if (staged) args.push("--staged");
  if (filePath?.trim()) {
    const context = contexts[0];
    args.push("--", context.targetPath ?? guard.resolve(workspace, filePath).relPath);
  }
  if (contexts.length === 1) return runGit(config, workspace, args, config.maxOutputBytes, contexts[0]);
  const sections: string[] = [];
  for (const context of contexts) {
    const output = runGit(config, workspace, args, config.maxOutputBytes, context);
    if (isGitFailure(output)) return repositoryError("diff", context, workspace, output);
    if (output !== "(no output)") sections.push(`### Repository: ${repositoryLabel(context, workspace)}\n${output}`);
  }
  return boundedGitOutput(sections, config.maxOutputBytes);
}

export function gitDiffStats(
  config: CodexProConfig,
  guard: PathGuard,
  workspace: Workspace,
  filePath?: string,
  staged = false
): { additions: number; deletions: number; changed: boolean; error?: string } {
  const args = ["diff", "--numstat", "--no-ext-diff", "--no-textconv"];
  const discovery = gitContexts(config, guard, workspace, filePath);
  const contexts = discovery.contexts;
  if (staged) args.push("--staged");
  if (filePath?.trim()) {
    const context = contexts[0];
    args.push("--", context.targetPath ?? guard.resolve(workspace, filePath).relPath);
  }
  let additions = 0;
  let deletions = 0;
  let changed = false;
  for (const context of contexts) {
    const output = runGit(config, workspace, args, config.maxOutputBytes, context);
    if (isGitFailure(output)) {
      return { additions: 0, deletions: 0, changed: false, error: repositoryError("diff stats", context, workspace, output) };
    }
    const lines = outputLines(output);
    changed ||= lines.length > 0;
    for (const line of lines) {
      const [added, deleted] = line.split("\t", 2);
      if (/^\d+$/.test(added)) additions += Number(added);
      if (/^\d+$/.test(deleted)) deletions += Number(deleted);
    }
  }
  return { additions, deletions, changed };
}

export function gitDiffStatus(config: CodexProConfig, guard: PathGuard, workspace: Workspace, filePath?: string, staged = false): string {
  const args = ["diff", "--name-status"];
  const discovery = gitContexts(config, guard, workspace, filePath);
  const contexts = discovery.contexts;
  if (staged) args.push("--staged");
  const untrackedArgs = ["ls-files", "--others", "--exclude-standard"];
  if (filePath?.trim()) {
    const context = contexts[0];
    args.push("--", context.targetPath ?? guard.resolve(workspace, filePath).relPath);
    untrackedArgs.push("--", context.targetPath ?? guard.resolve(workspace, filePath).relPath);
  }
  const sections: string[] = [];
  for (const context of contexts) {
    const diffStatus = runGit(config, workspace, args, config.maxOutputBytes, context, true);
    if (isGitFailure(diffStatus)) return repositoryError("diff status", context, workspace, diffStatus);
    const lines = outputLines(diffStatus);
    if (!staged) {
      const untracked = runGit(config, workspace, untrackedArgs, config.maxOutputBytes, context);
      if (isGitFailure(untracked)) return repositoryError("untracked status", context, workspace, untracked);
      // ls-files 返回的是裸路径，不带状态码；在添加 ?? 前单独改写为工作区相对路径。
      lines.push(...outputLines(untracked).map((line) => `?? ${workspacePathForGitPath(context.root, workspace, line)}`));
    }
    if (lines.length === 0) continue;
    const body = lines.join("\n");
    sections.push(contexts.length > 1 ? `## Repository: ${repositoryLabel(context, workspace)}\n${body}` : body);
  }
  return boundedGitOutput(sections, config.maxOutputBytes);
}

export function gitLog(config: CodexProConfig, workspace: Workspace, maxCount = 8, guard?: PathGuard): string {
  const count = Math.max(1, Math.min(Math.floor(maxCount), 30));
  if (!guard) {
    return runGit(config, workspace, ["log", `--max-count=${count}`, "--oneline", "--decorate"], config.maxOutputBytes);
  }
  const discovery = gitContexts(config, guard, workspace);
  const sections: string[] = [];
  for (const context of discovery.contexts) {
    const output = runGit(config, workspace, ["log", `--max-count=${count}`, "--oneline", "--decorate"], config.maxOutputBytes, context);
    if (isGitFailure(output)) {
      sections.push(repositoryError("log", context, workspace, output));
      continue;
    }
    sections.push(discovery.contexts.length > 1 ? `## Repository: ${repositoryLabel(context, workspace)}\n${output}` : output);
  }
  return boundedGitOutput(appendDiscoveryWarnings(sections, discovery), config.maxOutputBytes);
}

export function assertGitCleanEnoughForWrite(_workspace: Workspace): void {
  // Reserved for future policy hooks. The first version allows writes and returns diffs.
  return;
}
