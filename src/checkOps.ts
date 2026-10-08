import { createHash } from "node:crypto";
import fsp from "node:fs/promises";
import path from "node:path";
import type { CodexProConfig } from "./config.js";
import type { PathGuard, Workspace } from "./guard.js";
import { discoverWorkspaceChecks } from "./analysis/index.js";
import type { AnalysisCommandRecommendation } from "./analysis/types.js";
import { runBash, type BashOutputEvent, type BashProcessInfo, type BashRuntimeEvent } from "./bashOps.js";
import { gitDiff, gitDiffStatus } from "./gitOps.js";

export type RunChecksPhase =
  | "discovering_checks"
  | "fingerprinting_before"
  | "fingerprint_before_reused"
  | "running_checks"
  | "fingerprinting_after"
  | "finished";

export interface RunChecksPhaseEvent {
  phase: RunChecksPhase;
  elapsedMs: number;
}

export interface RunChecksOptions {
  projectPath?: string;
  checks: string[];
  targetPaths?: string[];
  timeoutMs?: number;
  sessionId?: string;
  stopOnFailure?: boolean;
  signal?: AbortSignal;
  initialWorkspaceFingerprint?: string;
  onPhase?: (event: RunChecksPhaseEvent) => void | Promise<void>;
  onResult?: (result: CheckResult, index: number) => void;
  progressIntervalMs?: number;
  onProcessStart?: (process: BashProcessInfo, index: number, recommendation: AnalysisCommandRecommendation) => void | Promise<void>;
  onProcessExit?: (process: BashProcessInfo, index: number, recommendation: AnalysisCommandRecommendation) => void | Promise<void>;
  onOutput?: (event: BashOutputEvent, index: number, recommendation: AnalysisCommandRecommendation) => void | Promise<void>;
  onProgress?: (event: BashRuntimeEvent, index: number, recommendation: AnalysisCommandRecommendation) => void | Promise<void>;
}

export interface CheckFailure {
  path?: string;
  line?: number;
  column?: number;
  message: string;
}

export interface CheckResult {
  check: string;
  command: string;
  cwd: string;
  project_path: string;
  runner?: string;
  source: string;
  ok: boolean;
  status: "passed" | "failed" | "timed_out" | "cancelled";
  exit_code: number | null;
  signal: NodeJS.Signals | null;
  duration_ms: number;
  timed_out: boolean;
  cancelled: boolean;
  output_truncated: boolean;
  output_limit_exceeded: boolean;
  observed_output_bytes: number;
  stdout: string;
  stderr: string;
  failures: CheckFailure[];
  failed_tests: string[];
}

export interface RunChecksResult {
  ok: boolean;
  workspace_fingerprint: string;
  workspace_fingerprint_after: string;
  stale: boolean;
  project_path?: string;
  requested_checks: string[];
  target_paths: string[];
  selected_checks: Array<{
    check: string;
    command: string;
    cwd: string;
    project_path: string;
    runner?: string;
    source: string;
  }>;
  unavailable_checks: string[];
  results: CheckResult[];
}

function normalizedProjectPath(guard: PathGuard, workspace: Workspace, value: string | undefined): string | undefined {
  if (!value?.trim()) return undefined;
  return guard.resolve(workspace, value).relPath;
}

function normalizedTargetPaths(guard: PathGuard, workspace: Workspace, values: string[] | undefined): string[] {
  const out: string[] = [];
  for (const value of values ?? []) {
    const relPath = guard.resolve(workspace, value).relPath;
    if (!out.includes(relPath)) out.push(relPath);
  }
  return out;
}

function packageScriptName(command: string): string | undefined {
  return command.match(/^(?:npm|pnpm|yarn|bun)\s+run\s+([^\s]+)(?:\s|$)/)?.[1];
}

function projectKey(recommendation: AnalysisCommandRecommendation): string {
  return recommendation.projectPath ?? recommendation.cwd ?? ".";
}

function selectRecommendations(
  recommendations: AnalysisCommandRecommendation[],
  requestedChecks: string[]
): { selected: AnalysisCommandRecommendation[]; unavailable: string[] } {
  const selected: AnalysisCommandRecommendation[] = [];
  const unavailable: string[] = [];
  const projects = [...new Set(recommendations.map(projectKey))].sort();

  for (const requested of requestedChecks) {
    let matched = false;
    for (const project of projects) {
      const projectRecommendations = recommendations.filter((recommendation) => projectKey(recommendation) === project);
      const exact = projectRecommendations.find((recommendation) => packageScriptName(recommendation.command) === requested);
      const category = projectRecommendations.filter((recommendation) => recommendation.check === requested);
      const candidate = exact ?? category[0];
      if (!candidate || candidate.runnable === false) continue;
      matched = true;
      if (!selected.some((item) => item.command === candidate.command && (item.cwd ?? ".") === (candidate.cwd ?? "."))) {
        selected.push(candidate);
      }
    }
    if (!matched) unavailable.push(requested);
  }

  return { selected, unavailable };
}

function looksLikeGitError(value: string): boolean {
  const lower = value.trim().toLowerCase();
  return (
    lower.startsWith("fatal:") ||
    lower.startsWith("error:") ||
    lower.startsWith("git unavailable or failed:") ||
    lower.startsWith("git exited with status") ||
    lower.includes("not a git repository")
  );
}

export async function workspaceFingerprint(
  config: CodexProConfig,
  guard: PathGuard,
  workspace: Workspace
): Promise<string> {
  const status = gitDiffStatus(config, guard, workspace);
  const diff = gitDiff(config, guard, workspace);
  const hash = createHash("sha256");
  hash.update(status).update("\0").update(diff).update("\0");

  if (!looksLikeGitError(status)) {
    for (const line of status.split(/\r?\n/)) {
      const match = line.trim().match(/^\?\?\s+(.+)$/);
      if (!match) continue;
      const relPath = match[1];
      hash.update(relPath).update("\0");
      try {
        const resolved = guard.resolve(workspace, relPath);
        const stat = await fsp.stat(resolved.absPath);
        hash.update(String(stat.size)).update("\0").update(String(Math.floor(stat.mtimeMs))).update("\0");
        if (stat.isFile() && stat.size <= config.maxReadBytes) hash.update(await fsp.readFile(resolved.absPath));
      } catch (error) {
        hash.update(error instanceof Error ? error.message : String(error));
      }
      hash.update("\0");
    }
  }

  return hash.digest("hex");
}

function failurePath(
  guard: PathGuard,
  workspace: Workspace,
  cwd: string,
  rawPath: string
): string {
  const cleaned = rawPath.trim().replace(/^["']|["']$/g, "");
  const unix = cleaned.replaceAll("\\", "/");
  try {
    if (path.isAbsolute(cleaned)) return guard.resolve(workspace, cleaned).relPath;
    const joined = cwd === "." ? unix : path.posix.join(cwd.replaceAll("\\", "/"), unix);
    return guard.resolve(workspace, joined).relPath;
  } catch {
    return unix;
  }
}

function parseFailures(
  guard: PathGuard,
  workspace: Workspace,
  cwd: string,
  output: string
): CheckFailure[] {
  const failures: CheckFailure[] = [];
  const seen = new Set<string>();
  let pythonFrame: { path: string; line: number } | undefined;

  const add = (failure: CheckFailure) => {
    const key = `${failure.path ?? ""}\0${failure.line ?? ""}\0${failure.column ?? ""}\0${failure.message}`;
    if (seen.has(key) || failures.length >= 100) return;
    seen.add(key);
    failures.push(failure);
  };

  for (const rawLine of output.replace(/\r\n/g, "\n").split("\n")) {
    const line = rawLine.trimEnd();
    if (/^\s*>\s/.test(line)) continue;
    const python = line.match(/^\s*File\s+"([^"]+)",\s+line\s+(\d+)/);
    if (python) {
      pythonFrame = {
        path: failurePath(guard, workspace, cwd, python[1]),
        line: Number(python[2])
      };
      continue;
    }
    if (pythonFrame && /^\s*(?:E\s+|AssertionError|Error:|Exception:)/.test(line)) {
      add({ ...pythonFrame, message: line.trim().slice(0, 1_000) });
      pythonFrame = undefined;
      continue;
    }

    const typescript = line.match(/^(.+?)\((\d+),(\d+)\):\s*(?:error|warning)\s+[^:]+:\s*(.+)$/i);
    if (typescript) {
      add({
        path: failurePath(guard, workspace, cwd, typescript[1]),
        line: Number(typescript[2]),
        column: Number(typescript[3]),
        message: typescript[4].trim().slice(0, 1_000)
      });
      continue;
    }

    const colon = line.match(/^(.+?\.[A-Za-z0-9]+):(\d+)(?::(\d+))?\s*(?:[-:]\s*)?(.+)$/);
    if (colon && /(?:error|fail|assert|expected|received|exception)/i.test(colon[4])) {
      add({
        path: failurePath(guard, workspace, cwd, colon[1]),
        line: Number(colon[2]),
        ...(colon[3] ? { column: Number(colon[3]) } : {}),
        message: colon[4].trim().slice(0, 1_000)
      });
    }
  }

  return failures;
}

function parseFailedTests(output: string): string[] {
  const failed = new Set<string>();
  for (const rawLine of output.replace(/\r\n/g, "\n").split("\n")) {
    const line = rawLine.trim();
    const jest = line.match(/^FAIL\s+(.+)$/);
    if (jest) {
      failed.add(jest[1].trim());
      continue;
    }
    const pytest = line.match(/^FAILED\s+(.+?)(?:\s+-\s+.*)?$/);
    if (pytest) failed.add(pytest[1].trim());
  }
  return [...failed].slice(0, 100);
}

export async function runWorkspaceChecks(
  config: CodexProConfig,
  guard: PathGuard,
  workspace: Workspace,
  options: RunChecksOptions
): Promise<RunChecksResult> {
  const startedAt = Date.now();
  const emitPhase = async (phase: RunChecksPhase) => {
    await Promise.resolve(options.onPhase?.({ phase, elapsedMs: Date.now() - startedAt }));
  };
  const requestedChecks = [...new Set(options.checks.map((check) => check.trim()).filter(Boolean))];
  const projectPath = normalizedProjectPath(guard, workspace, options.projectPath);
  const targetPaths = normalizedTargetPaths(guard, workspace, options.targetPaths);
  await emitPhase("discovering_checks");
  const recommendations = await discoverWorkspaceChecks(config, guard, workspace, { changedPaths: targetPaths });
  const scoped = projectPath
    ? recommendations.filter((recommendation) => projectKey(recommendation) === projectPath)
    : recommendations;
  const { selected, unavailable } = selectRecommendations(scoped, requestedChecks);

  let before: string;
  if (options.initialWorkspaceFingerprint) {
    await emitPhase("fingerprint_before_reused");
    before = options.initialWorkspaceFingerprint;
  } else {
    await emitPhase("fingerprinting_before");
    before = await workspaceFingerprint(config, guard, workspace);
  }
  await emitPhase("running_checks");
  const results: CheckResult[] = [];
  for (const recommendation of selected) {
    const resultIndex = results.length;
    const result = await runBash(config, guard, workspace, recommendation.command, {
      cwd: recommendation.cwd ?? ".",
      timeoutMs: options.timeoutMs,
      sessionId: options.sessionId,
      signal: options.signal,
      progressIntervalMs: options.progressIntervalMs,
      onProcessStart: (process) => options.onProcessStart?.(process, resultIndex, recommendation),
      onProcessExit: (process) => options.onProcessExit?.(process, resultIndex, recommendation),
      onOutput: (event) => options.onOutput?.(event, resultIndex, recommendation),
      onProgress: (event) => options.onProgress?.(event, resultIndex, recommendation)
    });
    const combinedOutput = `${result.stdout}\n${result.stderr}`;
    const checkResult: CheckResult = {
      check: recommendation.check,
      command: recommendation.command,
      cwd: recommendation.cwd ?? ".",
      project_path: recommendation.projectPath ?? recommendation.cwd ?? ".",
      runner: recommendation.runner,
      source: recommendation.source,
      ok: result.ok,
      status: result.status,
      exit_code: result.exitCode,
      signal: result.signal,
      duration_ms: result.durationMs,
      timed_out: result.timedOut,
      cancelled: result.cancelled,
      output_truncated: result.truncated,
      output_limit_exceeded: result.outputLimitExceeded,
      observed_output_bytes: result.observedOutputBytes,
      stdout: result.stdout,
      stderr: result.stderr,
      failures: parseFailures(guard, workspace, recommendation.cwd ?? ".", combinedOutput),
      failed_tests: parseFailedTests(combinedOutput)
    };
    results.push(checkResult);
    options.onResult?.(checkResult, results.length - 1);
    if (result.cancelled || (!result.ok && options.stopOnFailure)) break;
  }
  await emitPhase("fingerprinting_after");
  const after = await workspaceFingerprint(config, guard, workspace);
  await emitPhase("finished");

  return {
    ok: selected.length > 0 && unavailable.length === 0 && results.every((result) => result.ok),
    workspace_fingerprint: before,
    workspace_fingerprint_after: after,
    stale: before !== after,
    ...(projectPath ? { project_path: projectPath } : {}),
    requested_checks: requestedChecks,
    target_paths: targetPaths,
    selected_checks: selected.map((recommendation) => ({
      check: recommendation.check,
      command: recommendation.command,
      cwd: recommendation.cwd ?? ".",
      project_path: recommendation.projectPath ?? recommendation.cwd ?? ".",
      runner: recommendation.runner,
      source: recommendation.source
    })),
    unavailable_checks: unavailable,
    results
  };
}
