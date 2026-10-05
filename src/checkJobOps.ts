import { randomBytes } from "node:crypto";
import fsp from "node:fs/promises";
import path from "node:path";
import type { CodexProConfig } from "./config.js";
import { CodexProError, type PathGuard, type Workspace } from "./guard.js";
import { profileIdForRoot, runtimeDir } from "./profileStore.js";
import { redactSensitiveText } from "./redact.js";
import {
  runWorkspaceChecks,
  workspaceFingerprint,
  type CheckResult,
  type RunChecksOptions,
  type RunChecksResult
} from "./checkOps.js";

export type ManagedCheckStatus = "running" | "completed" | "failed" | "cancelled" | "interrupted";

export interface ManagedCheckStartOptions {
  requestId?: string;
  projectPath?: string;
  checks: string[];
  targetPaths?: string[];
  timeoutMs?: number;
  sessionId?: string;
  stopOnFailure?: boolean;
}

export interface ManagedCheckResumeOptions {
  jobId?: string;
  requestId?: string;
  sessionId?: string;
}

export interface ManagedCheckPageOptions {
  cursor?: number;
  maxChars?: number;
  waitMs?: number;
}

type CompactRunChecksResult = ReturnType<typeof compactResult>;

export interface ManagedCheckView {
  job_id: string;
  request_id?: string;
  workspace_id: string;
  reused?: boolean;
  status: ManagedCheckStatus;
  can_resume: boolean;
  created_at: string;
  started_at: string;
  resumed_at?: string;
  interrupted_at?: string;
  completed_at?: string;
  workspace_fingerprint: string;
  log: string;
  cursor: number;
  next_cursor: number;
  has_more: boolean;
  log_chars: number;
  log_truncated: boolean;
  error?: string;
  persistence_error?: string;
  result?: CompactRunChecksResult;
}

interface ManagedCheckJob {
  id: string;
  requestId?: string;
  requestSignature?: string;
  workspaceId: string;
  checks: string[];
  targetPaths: string[];
  projectPath?: string;
  timeoutMs?: number;
  stopOnFailure: boolean;
  workspaceFingerprint: string;
  createdAt: string;
  startedAt: string;
  resumedAt?: string;
  interruptedAt?: string;
  completedAt?: string;
  status: ManagedCheckStatus;
  controller: AbortController;
  log: string;
  logTruncated: boolean;
  result?: RunChecksResult;
  persistedResult?: CompactRunChecksResult;
  error?: string;
  persistenceError?: string;
  promise: Promise<void>;
}

interface ManagedCheckReceipt {
  version: 1;
  id: string;
  requestId?: string;
  workspaceId: string;
  checks: string[];
  targetPaths: string[];
  projectPath?: string;
  timeoutMs?: number;
  stopOnFailure: boolean;
  workspaceFingerprint: string;
  createdAt: string;
  startedAt: string;
  resumedAt?: string;
  interruptedAt?: string;
  completedAt?: string;
  status: ManagedCheckStatus;
  log: string;
  logTruncated: boolean;
  result?: CompactRunChecksResult;
  error?: string;
}

const MAX_RUNNING_JOBS = 4;
const MAX_RETAINED_JOBS = 32;
const MAX_RECEIPT_SCAN = 128;
const MAX_LOG_CHARS = 1_000_000;
const DEFAULT_PAGE_CHARS = 20_000;
const MAX_PAGE_CHARS = 100_000;
const MAX_WAIT_MS = 30_000;
const JOB_ID_PATTERN = /^check_[a-f0-9]{16}$/;
const RECEIPT_VERSION = 1;

function compactResult(result: RunChecksResult) {
  // Managed logs are paginated separately, so do not duplicate potentially large stdout/stderr in the durable result.
  return {
    ...result,
    results: result.results.map(({ stdout: _stdout, stderr: _stderr, ...item }) => item)
  };
}

function checkLog(result: CheckResult, index: number): string {
  const parts = [
    `## Check ${index + 1}: ${result.check}`,
    `command: ${result.command}`,
    `cwd: ${result.cwd}`,
    `status: ${result.status}`,
    `exit_code: ${result.exit_code ?? "null"}`
  ];
  if (result.stdout) parts.push("", "### stdout", result.stdout);
  if (result.stderr) parts.push("", "### stderr", result.stderr);
  return parts.join("\n") + "\n";
}

function terminalStatus(result: RunChecksResult, aborted: boolean): ManagedCheckStatus {
  if (aborted || result.results.some((item) => item.status === "cancelled")) return "cancelled";
  return result.ok ? "completed" : "failed";
}

function safeError(error: unknown): string {
  const value = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
  return redactSensitiveText(value);
}

function clampInt(value: number | undefined, fallback: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return fallback;
  return Math.max(min, Math.min(max, Math.floor(value as number)));
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    timer.unref();
  });
}

function normalizedRequestId(requestId: string | undefined): string | undefined {
  const value = requestId?.trim();
  return value || undefined;
}

function requestKey(workspaceId: string, requestId: string): string {
  return `${workspaceId}\0${requestId}`;
}

function requestSignature(workspaceId: string, options: ManagedCheckStartOptions): string {
  return JSON.stringify({
    workspaceId,
    projectPath: options.projectPath?.trim() || null,
    checks: options.checks.map((check) => check.trim()).filter(Boolean),
    targetPaths: (options.targetPaths ?? []).map((targetPath) => targetPath.trim()).filter(Boolean),
    timeoutMs: options.timeoutMs ?? 30_000,
    stopOnFailure: options.stopOnFailure === true
  });
}

function jobDirectory(workspace: Workspace): string {
  // Runtime receipts live outside the repository so recovery metadata never changes git state or validation fingerprints.
  return path.join(runtimeDir(), "check-jobs", profileIdForRoot(workspace.root));
}

function receiptPath(workspace: Workspace, jobId: string): string {
  return path.join(jobDirectory(workspace), `${jobId}.json`);
}

async function writeReceiptAtomic(filePath: string, receipt: ManagedCheckReceipt): Promise<void> {
  const dir = path.dirname(filePath);
  await fsp.mkdir(dir, { recursive: true, mode: 0o700 });
  const temp = path.join(dir, `.${path.basename(filePath)}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`);
  try {
    await fsp.writeFile(temp, JSON.stringify(receipt, null, 2) + "\n", { encoding: "utf8", mode: 0o600 });
    await fsp.rename(temp, filePath);
  } finally {
    await fsp.rm(temp, { force: true }).catch(() => {});
  }
}

function isManagedStatus(value: unknown): value is ManagedCheckStatus {
  return ["running", "completed", "failed", "cancelled", "interrupted"].includes(String(value));
}

function receiptFromUnknown(value: unknown, workspace: Workspace): ManagedCheckReceipt | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  if (record.version !== RECEIPT_VERSION) return undefined;
  if (typeof record.id !== "string" || !JOB_ID_PATTERN.test(record.id)) return undefined;
  if (record.workspaceId !== workspace.id) return undefined;
  if (!Array.isArray(record.checks) || !record.checks.every((item) => typeof item === "string")) return undefined;
  if (!Array.isArray(record.targetPaths) || !record.targetPaths.every((item) => typeof item === "string")) return undefined;
  if (typeof record.workspaceFingerprint !== "string" || !/^[a-f0-9]{64}$/.test(record.workspaceFingerprint)) return undefined;
  if (typeof record.createdAt !== "string" || typeof record.startedAt !== "string" || !isManagedStatus(record.status)) return undefined;

  return {
    version: 1,
    id: record.id,
    ...(typeof record.requestId === "string" ? { requestId: record.requestId } : {}),
    workspaceId: workspace.id,
    checks: record.checks.slice(0, 20) as string[],
    targetPaths: record.targetPaths.slice(0, 100) as string[],
    ...(typeof record.projectPath === "string" ? { projectPath: record.projectPath } : {}),
    ...(typeof record.timeoutMs === "number" && Number.isFinite(record.timeoutMs) ? { timeoutMs: record.timeoutMs } : {}),
    stopOnFailure: record.stopOnFailure === true,
    workspaceFingerprint: record.workspaceFingerprint,
    createdAt: record.createdAt,
    startedAt: record.startedAt,
    ...(typeof record.resumedAt === "string" ? { resumedAt: record.resumedAt } : {}),
    ...(typeof record.interruptedAt === "string" ? { interruptedAt: record.interruptedAt } : {}),
    ...(typeof record.completedAt === "string" ? { completedAt: record.completedAt } : {}),
    status: record.status,
    log: typeof record.log === "string" ? record.log.slice(0, MAX_LOG_CHARS) : "",
    logTruncated: record.logTruncated === true || (typeof record.log === "string" && record.log.length > MAX_LOG_CHARS),
    ...(record.result && typeof record.result === "object" ? { result: record.result as CompactRunChecksResult } : {}),
    ...(typeof record.error === "string" ? { error: redactSensitiveText(record.error).slice(0, 4_000) } : {})
  };
}

function jobFromReceipt(receipt: ManagedCheckReceipt): ManagedCheckJob {
  const options: ManagedCheckStartOptions = {
    requestId: receipt.requestId,
    projectPath: receipt.projectPath,
    checks: receipt.checks,
    targetPaths: receipt.targetPaths,
    timeoutMs: receipt.timeoutMs,
    stopOnFailure: receipt.stopOnFailure
  };
  return {
    id: receipt.id,
    requestId: receipt.requestId,
    requestSignature: receipt.requestId ? requestSignature(receipt.workspaceId, options) : undefined,
    workspaceId: receipt.workspaceId,
    checks: [...receipt.checks],
    targetPaths: [...receipt.targetPaths],
    projectPath: receipt.projectPath,
    timeoutMs: receipt.timeoutMs,
    stopOnFailure: receipt.stopOnFailure,
    workspaceFingerprint: receipt.workspaceFingerprint,
    createdAt: receipt.createdAt,
    startedAt: receipt.startedAt,
    resumedAt: receipt.resumedAt,
    interruptedAt: receipt.interruptedAt,
    completedAt: receipt.completedAt,
    status: receipt.status,
    controller: new AbortController(),
    log: receipt.log,
    logTruncated: receipt.logTruncated,
    persistedResult: receipt.result,
    error: receipt.error,
    promise: Promise.resolve()
  };
}

// Keep background verification process-scoped and memory-bounded. Durable receipts make transport/process recovery explicit.
export class ManagedCheckManager {
  private readonly jobs = new Map<string, ManagedCheckJob>();
  // request_id is scoped by workspace so a dropped start_check response can be retried without duplicating execution.
  private readonly requestIndex = new Map<string, string>();
  private readonly loadedWorkspaces = new Set<string>();

  private appendLog(job: ManagedCheckJob, text: string): void {
    if (!text || job.log.length >= MAX_LOG_CHARS) {
      if (text) job.logTruncated = true;
      return;
    }
    const remaining = MAX_LOG_CHARS - job.log.length;
    if (text.length > remaining) {
      job.log += text.slice(0, remaining);
      job.logTruncated = true;
      return;
    }
    job.log += text;
  }

  private receipt(job: ManagedCheckJob): ManagedCheckReceipt {
    return {
      version: 1,
      id: job.id,
      ...(job.requestId ? { requestId: job.requestId } : {}),
      workspaceId: job.workspaceId,
      checks: [...job.checks],
      targetPaths: [...job.targetPaths],
      ...(job.projectPath ? { projectPath: job.projectPath } : {}),
      ...(job.timeoutMs !== undefined ? { timeoutMs: job.timeoutMs } : {}),
      stopOnFailure: job.stopOnFailure,
      workspaceFingerprint: job.workspaceFingerprint,
      createdAt: job.createdAt,
      startedAt: job.startedAt,
      ...(job.resumedAt ? { resumedAt: job.resumedAt } : {}),
      ...(job.interruptedAt ? { interruptedAt: job.interruptedAt } : {}),
      ...(job.completedAt ? { completedAt: job.completedAt } : {}),
      status: job.status,
      log: job.log,
      logTruncated: job.logTruncated,
      ...(job.result ? { result: compactResult(job.result) } : job.persistedResult ? { result: job.persistedResult } : {}),
      ...(job.error ? { error: job.error } : {})
    };
  }

  private async persistJob(workspace: Workspace, job: ManagedCheckJob): Promise<void> {
    try {
      await writeReceiptAtomic(receiptPath(workspace, job.id), this.receipt(job));
      job.persistenceError = undefined;
    } catch (error) {
      job.persistenceError = safeError(error);
      throw error;
    }
  }

  private async pruneReceipts(workspace: Workspace): Promise<void> {
    const dir = jobDirectory(workspace);
    let names: string[];
    try {
      names = (await fsp.readdir(dir)).filter((name) => /^check_[a-f0-9]{16}\.json$/.test(name));
    } catch (error) {
      if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") return;
      throw error;
    }
    if (names.length <= MAX_RETAINED_JOBS) return;

    const candidates: Array<{ name: string; createdAt: string; status?: ManagedCheckStatus }> = [];
    for (const name of names.slice(0, MAX_RECEIPT_SCAN)) {
      try {
        const parsed = JSON.parse(await fsp.readFile(path.join(dir, name), "utf8")) as Record<string, unknown>;
        candidates.push({
          name,
          createdAt: typeof parsed.createdAt === "string" ? parsed.createdAt : "",
          status: isManagedStatus(parsed.status) ? parsed.status : undefined
        });
      } catch {
        candidates.push({ name, createdAt: "" });
      }
    }

    const removable = candidates
      .filter((item) => item.status !== "running")
      .sort((left, right) => left.createdAt.localeCompare(right.createdAt));
    let excess = Math.max(0, names.length - MAX_RETAINED_JOBS);
    for (const item of removable) {
      if (excess <= 0) break;
      await fsp.rm(path.join(dir, item.name), { force: true }).catch(() => {});
      excess -= 1;
    }
  }

  async loadWorkspace(workspace: Workspace): Promise<void> {
    if (this.loadedWorkspaces.has(workspace.id)) return;
    const dir = jobDirectory(workspace);
    let names: string[];
    try {
      names = (await fsp.readdir(dir))
        .filter((name) => /^check_[a-f0-9]{16}\.json$/.test(name))
        .slice(0, MAX_RECEIPT_SCAN);
    } catch (error) {
      if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") {
        this.loadedWorkspaces.add(workspace.id);
        return;
      }
      throw error;
    }

    const recovered: ManagedCheckJob[] = [];
    for (const name of names) {
      try {
        const receipt = receiptFromUnknown(JSON.parse(await fsp.readFile(path.join(dir, name), "utf8")), workspace);
        if (!receipt) continue;
        recovered.push(jobFromReceipt(receipt));
      } catch {
        // A torn/corrupt receipt is ignored rather than becoming an executable recovery instruction.
      }
    }

    recovered.sort((left, right) => right.createdAt.localeCompare(left.createdAt));
    const interrupted: ManagedCheckJob[] = [];
    for (const job of recovered.slice(0, MAX_RETAINED_JOBS)) {
      if (this.jobs.has(job.id)) continue;
      if (job.status === "running") {
        job.status = "interrupted";
        job.interruptedAt = new Date().toISOString();
        this.appendLog(job, "\nstatus: interrupted\nreason: CodexPro process ended before the check reached a terminal state.\n");
        interrupted.push(job);
      }
      this.jobs.set(job.id, job);
      if (job.requestId) this.requestIndex.set(requestKey(job.workspaceId, job.requestId), job.id);
    }
    this.loadedWorkspaces.add(workspace.id);

    for (const job of interrupted) {
      await this.persistJob(workspace, job).catch(() => {});
    }
    await this.pruneReceipts(workspace).catch(() => {});
  }

  private pruneMemory(): void {
    if (this.jobs.size < MAX_RETAINED_JOBS) return;
    const terminal = [...this.jobs.values()]
      .filter((job) => job.status !== "running")
      .sort((left, right) => left.createdAt.localeCompare(right.createdAt));
    while (this.jobs.size >= MAX_RETAINED_JOBS && terminal.length > 0) {
      const job = terminal.shift();
      if (job) {
        this.jobs.delete(job.id);
        if (job.requestId) this.requestIndex.delete(requestKey(job.workspaceId, job.requestId));
      }
    }
  }

  private getScoped(workspace: Workspace, jobId: string): ManagedCheckJob {
    const job = this.jobs.get(jobId);
    if (!job || job.workspaceId !== workspace.id) throw new CodexProError(`Unknown check job: ${jobId}`);
    return job;
  }

  private byRequest(workspace: Workspace, requestId: string): ManagedCheckJob {
    const normalized = normalizedRequestId(requestId);
    if (!normalized) throw new CodexProError("request_id is required.");
    const jobId = this.requestIndex.get(requestKey(workspace.id, normalized));
    if (!jobId) throw new CodexProError(`Unknown check request_id: ${normalized}`);
    return this.getScoped(workspace, jobId);
  }

  private view(job: ManagedCheckJob, options: ManagedCheckPageOptions = {}): ManagedCheckView {
    const cursor = clampInt(options.cursor, 0, 0, job.log.length);
    const maxChars = clampInt(options.maxChars, DEFAULT_PAGE_CHARS, 100, MAX_PAGE_CHARS);
    const nextCursor = Math.min(job.log.length, cursor + maxChars);
    return {
      job_id: job.id,
      ...(job.requestId ? { request_id: job.requestId } : {}),
      workspace_id: job.workspaceId,
      status: job.status,
      can_resume: job.status === "interrupted",
      created_at: job.createdAt,
      started_at: job.startedAt,
      ...(job.resumedAt ? { resumed_at: job.resumedAt } : {}),
      ...(job.interruptedAt ? { interrupted_at: job.interruptedAt } : {}),
      ...(job.completedAt ? { completed_at: job.completedAt } : {}),
      workspace_fingerprint: job.workspaceFingerprint,
      log: job.log.slice(cursor, nextCursor),
      cursor,
      next_cursor: nextCursor,
      has_more: nextCursor < job.log.length,
      log_chars: job.log.length,
      log_truncated: job.logTruncated,
      ...(job.error ? { error: job.error } : {}),
      ...(job.persistenceError ? { persistence_error: job.persistenceError } : {}),
      ...(job.result ? { result: compactResult(job.result) } : job.persistedResult ? { result: job.persistedResult } : {})
    };
  }

  private launch(
    config: CodexProConfig,
    guard: PathGuard,
    workspace: Workspace,
    job: ManagedCheckJob,
    sessionId?: string
  ): void {
    const runOptions: RunChecksOptions = {
      projectPath: job.projectPath,
      checks: job.checks,
      targetPaths: job.targetPaths,
      timeoutMs: job.timeoutMs,
      sessionId,
      stopOnFailure: job.stopOnFailure,
      signal: job.controller.signal,
      onResult: (result, index) => this.appendLog(job, checkLog(result, index))
    };

    job.promise = (async () => {
      try {
        const result = await runWorkspaceChecks(config, guard, workspace, runOptions);
        job.result = result;
        job.persistedResult = undefined;
        job.status = terminalStatus(result, job.controller.signal.aborted);
        this.appendLog(job, `\nstatus: ${job.status}\nstale: ${result.stale}\n`);
      } catch (error) {
        job.status = job.controller.signal.aborted ? "cancelled" : "failed";
        job.error = safeError(error);
        this.appendLog(job, `\nstatus: ${job.status}\nerror: ${job.error}\n`);
      } finally {
        job.completedAt = new Date().toISOString();
        await this.persistJob(workspace, job).catch((error) => {
          this.appendLog(job, `\npersistence_error: ${safeError(error)}\n`);
        });
        await this.pruneReceipts(workspace).catch(() => {});
      }
    })();
  }

  async start(
    config: CodexProConfig,
    guard: PathGuard,
    workspace: Workspace,
    options: ManagedCheckStartOptions
  ): Promise<ManagedCheckView> {
    await this.loadWorkspace(workspace);
    this.pruneMemory();

    const requestId = normalizedRequestId(options.requestId);
    const signature = requestId ? requestSignature(workspace.id, options) : undefined;
    if (requestId && signature) {
      const key = requestKey(workspace.id, requestId);
      const existingId = this.requestIndex.get(key);
      const existing = existingId ? this.jobs.get(existingId) : undefined;
      if (existing) {
        // A transport retry must return the original job; changing parameters under the same key is a caller error.
        if (existing.requestSignature !== signature) {
          throw new CodexProError(`request_id ${requestId} was already used for a different check request.`);
        }
        return { ...this.view(existing, { cursor: 0, maxChars: DEFAULT_PAGE_CHARS }), reused: true };
      }
      if (existingId) this.requestIndex.delete(key);
    }

    const running = [...this.jobs.values()].filter((job) => job.status === "running").length;
    if (running >= MAX_RUNNING_JOBS) {
      throw new CodexProError(`Too many running checks (${running}). Stop or wait for an existing job before starting another.`);
    }
    if (this.jobs.size >= MAX_RETAINED_JOBS) {
      throw new CodexProError(`Managed check history is full (${MAX_RETAINED_JOBS} jobs). Wait for or stop existing jobs before starting another.`);
    }

    const checks = [...new Set(options.checks.map((check) => check.trim()).filter(Boolean))];
    if (checks.length === 0) throw new CodexProError("At least one check is required.");
    const targetPaths = [...new Set((options.targetPaths ?? []).map((targetPath) => targetPath.trim()).filter(Boolean))];
    const id = `check_${randomBytes(8).toString("hex")}`;
    const createdAt = new Date().toISOString();
    const controller = new AbortController();
    const fingerprint = await workspaceFingerprint(config, guard, workspace);
    const job: ManagedCheckJob = {
      id,
      ...(requestId ? { requestId, requestSignature: signature } : {}),
      workspaceId: workspace.id,
      checks,
      targetPaths,
      ...(options.projectPath?.trim() ? { projectPath: options.projectPath.trim() } : {}),
      ...(options.timeoutMs !== undefined ? { timeoutMs: options.timeoutMs } : {}),
      stopOnFailure: options.stopOnFailure === true,
      workspaceFingerprint: fingerprint,
      createdAt,
      startedAt: createdAt,
      status: "running",
      controller,
      log: "",
      logTruncated: false,
      promise: Promise.resolve()
    };
    this.jobs.set(id, job);
    if (requestId) this.requestIndex.set(requestKey(workspace.id, requestId), id);
    this.appendLog(job, `# Managed check ${id}\nstatus: running\nworkspace: ${workspace.id}\n\n`);

    // Persist before spawning so a lost response or process crash always leaves a recoverable receipt.
    try {
      await this.persistJob(workspace, job);
    } catch (error) {
      this.jobs.delete(id);
      if (requestId) this.requestIndex.delete(requestKey(workspace.id, requestId));
      throw new CodexProError(`Unable to persist managed check receipt: ${safeError(error)}`);
    }
    this.launch(config, guard, workspace, job, options.sessionId);
    return { ...this.view(job, { cursor: 0, maxChars: DEFAULT_PAGE_CHARS }), reused: false };
  }

  async resume(
    config: CodexProConfig,
    guard: PathGuard,
    workspace: Workspace,
    options: ManagedCheckResumeOptions
  ): Promise<ManagedCheckView> {
    await this.loadWorkspace(workspace);
    if (!options.jobId && !options.requestId) throw new CodexProError("resume_check requires job_id or request_id.");
    if (options.jobId && options.requestId) throw new CodexProError("resume_check accepts either job_id or request_id, not both.");
    const job = options.jobId ? this.getScoped(workspace, options.jobId) : this.byRequest(workspace, options.requestId!);
    if (job.status !== "interrupted") {
      throw new CodexProError(`Check job ${job.id} is ${job.status}; only interrupted jobs can be resumed.`);
    }

    const currentFingerprint = await workspaceFingerprint(config, guard, workspace);
    if (currentFingerprint !== job.workspaceFingerprint) {
      throw new CodexProError(
        `Workspace changed since check ${job.id} started. Start a new check instead of resuming the interrupted job.`
      );
    }

    job.controller = new AbortController();
    job.status = "running";
    job.resumedAt = new Date().toISOString();
    job.completedAt = undefined;
    job.error = undefined;
    job.result = undefined;
    job.persistedResult = undefined;
    this.appendLog(job, `\nstatus: running\nresumed_at: ${job.resumedAt}\n`);
    await this.persistJob(workspace, job);
    this.launch(config, guard, workspace, job, options.sessionId);
    return this.view(job, { cursor: 0, maxChars: DEFAULT_PAGE_CHARS });
  }

  async getViewByJob(
    workspace: Workspace,
    jobId: string,
    options: ManagedCheckPageOptions = {}
  ): Promise<ManagedCheckView> {
    await this.loadWorkspace(workspace);
    return this.view(this.getScoped(workspace, jobId), options);
  }

  async getViewByRequest(
    workspace: Workspace,
    requestId: string,
    options: ManagedCheckPageOptions = {}
  ): Promise<ManagedCheckView> {
    await this.loadWorkspace(workspace);
    return this.view(this.byRequest(workspace, requestId), options);
  }

  async list(
    workspace: Workspace,
    options: { status?: ManagedCheckStatus[]; limit?: number } = {}
  ): Promise<Array<Record<string, unknown>>> {
    await this.loadWorkspace(workspace);
    const statuses = options.status?.length ? new Set(options.status) : undefined;
    const limit = clampInt(options.limit, 20, 1, MAX_RETAINED_JOBS);
    return [...this.jobs.values()]
      .filter((job) => job.workspaceId === workspace.id && (!statuses || statuses.has(job.status)))
      .sort((left, right) => right.createdAt.localeCompare(left.createdAt))
      .slice(0, limit)
      .map((job) => ({
        job_id: job.id,
        ...(job.requestId ? { request_id: job.requestId } : {}),
        workspace_id: job.workspaceId,
        status: job.status,
        can_resume: job.status === "interrupted",
        checks: [...job.checks],
        target_paths: [...job.targetPaths],
        ...(job.projectPath ? { project_path: job.projectPath } : {}),
        created_at: job.createdAt,
        started_at: job.startedAt,
        ...(job.resumedAt ? { resumed_at: job.resumedAt } : {}),
        ...(job.interruptedAt ? { interrupted_at: job.interruptedAt } : {}),
        ...(job.completedAt ? { completed_at: job.completedAt } : {}),
        workspace_fingerprint: job.workspaceFingerprint,
        log_chars: job.log.length,
        log_truncated: job.logTruncated
      }));
  }

  async wait(
    workspace: Workspace,
    jobId: string,
    options: ManagedCheckPageOptions = {}
  ): Promise<ManagedCheckView> {
    await this.loadWorkspace(workspace);
    const job = this.getScoped(workspace, jobId);
    const waitMs = clampInt(options.waitMs, 0, 0, MAX_WAIT_MS);
    if (job.status === "running" && waitMs > 0) {
      await Promise.race([job.promise, delay(waitMs)]);
    }
    return this.view(job, options);
  }

  async stop(
    workspace: Workspace,
    jobId: string,
    options: ManagedCheckPageOptions = {}
  ): Promise<ManagedCheckView> {
    await this.loadWorkspace(workspace);
    const job = this.getScoped(workspace, jobId);
    if (job.status === "running") {
      job.controller.abort();
      await job.promise;
    }
    return this.view(job, options);
  }
}
