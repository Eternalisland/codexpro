import { randomBytes } from "node:crypto";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import type { BashProcessInfo } from "./bashOps.js";
import type { CodexProConfig } from "./config.js";
import { CodexProError, type PathGuard, type Workspace } from "./guard.js";
import { profileIdForRoot, runtimeDir } from "./profileStore.js";
import { ExecutionSupervisor, type RunnerLeaseRecord, type RunnerLeaseView, type RunnerProcessTelemetry } from "./executionSupervisor.js";
import { redactSensitiveText } from "./redact.js";
import type { ProtocolTraceContext, ProtocolTraceManager } from "./protocolTrace.js";
import {
  runWorkspaceChecks,
  workspaceFingerprint,
  type CheckResult,
  type RunChecksOptions,
  type RunChecksPhase,
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

export interface ManagedRuntimeSnapshot {
  state: "running" | "exited";
  check_index: number;
  check: string;
  command: string;
  cwd: string;
  pid?: number;
  started_at?: string;
  elapsed_ms: number;
  output_bytes: number;
  stdout_bytes: number;
  stderr_bytes: number;
  last_output_at?: string;
  last_output_age_ms?: number;
  output_limit_exceeded: boolean;
  timed_out: boolean;
  cancelled: boolean;
  termination_started: boolean;
  child_exited: boolean;
  child_exit_elapsed_ms?: number;
  telemetry_sampled_at?: string;
  cpu_time_ms?: number;
  resident_memory_bytes?: number;
  memory_kind?: "working_set" | "rss";
  child_process_count?: number;
  process_count?: number;
}

interface ManagedActiveProcess {
  pid: number;
  processGroupId?: number;
  startedAt: string;
  checkIndex: number;
}

export interface ManagedCheckView {
  job_id: string;
  request_id?: string;
  workspace_id: string;
  reused?: boolean;
  status: ManagedCheckStatus;
  phase?: RunChecksPhase;
  can_resume: boolean;
  created_at: string;
  started_at: string;
  resumed_at?: string;
  interrupted_at?: string;
  completed_at?: string;
  workspace_fingerprint: string;
  heartbeat_at?: string;
  active_process?: {
    pid: number;
    process_group_id?: number;
    started_at: string;
    check_index: number;
  };
  process_active: boolean;
  runner_lease?: RunnerLeaseView;
  runtime?: ManagedRuntimeSnapshot;
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
  heartbeatAt?: string;
  activeProcess?: ManagedActiveProcess;
  runnerLease?: RunnerLeaseRecord;
  runtime?: ManagedRuntimeSnapshot;
  telemetryLoggedAt?: string;
  traceContext?: ProtocolTraceContext;
  createdAt: string;
  startedAt: string;
  resumedAt?: string;
  interruptedAt?: string;
  completedAt?: string;
  status: ManagedCheckStatus;
  phase?: RunChecksPhase;
  controller: AbortController;
  log: string;
  logTruncated: boolean;
  result?: RunChecksResult;
  persistedResult?: CompactRunChecksResult;
  error?: string;
  persistenceError?: string;
  promise: Promise<void>;
  persistChain: Promise<void>;
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
  heartbeatAt?: string;
  activeProcess?: ManagedActiveProcess;
  runtime?: ManagedRuntimeSnapshot;
  createdAt: string;
  startedAt: string;
  resumedAt?: string;
  interruptedAt?: string;
  completedAt?: string;
  status: ManagedCheckStatus;
  phase?: RunChecksPhase;
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
const HEARTBEAT_INTERVAL_MS = 2_000;
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
  // stdout/stderr are streamed into the managed log while the process runs. Keep the terminal
  // summary compact so completed checks do not duplicate the same output a second time.
  return [
    `## Check ${index + 1}: ${result.check}`,
    `command: ${result.command}`,
    `cwd: ${result.cwd}`,
    `status: ${result.status}`,
    `exit_code: ${result.exit_code ?? "null"}`,
    `duration_ms: ${result.duration_ms}`,
    `output_bytes: ${result.observed_output_bytes}`
  ].join("\n") + "\n";
}

function terminalStatus(result: RunChecksResult, aborted: boolean): ManagedCheckStatus {
  if (aborted || result.results.some((item) => item.status === "cancelled")) return "cancelled";
  return result.ok ? "completed" : "failed";
}

function safeError(error: unknown): string {
  const value = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
  return redactSensitiveText(value);
}

function runtimeTelemetryFields(telemetry: RunnerProcessTelemetry): Partial<ManagedRuntimeSnapshot> {
  return {
    telemetry_sampled_at: telemetry.sampledAt,
    cpu_time_ms: telemetry.cpuTimeMs,
    resident_memory_bytes: telemetry.residentMemoryBytes,
    memory_kind: telemetry.memoryKind,
    child_process_count: telemetry.childProcessCount,
    process_count: telemetry.processCount
  };
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

function activeProcessFromUnknown(value: unknown): ManagedActiveProcess | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  if (!Number.isInteger(record.pid) || Number(record.pid) <= 0) return undefined;
  if (typeof record.startedAt !== "string" || !Number.isInteger(record.checkIndex) || Number(record.checkIndex) < 0) return undefined;
  const processGroupId =
    Number.isInteger(record.processGroupId) && Number(record.processGroupId) > 0
      ? Number(record.processGroupId)
      : undefined;
  return {
    pid: Number(record.pid),
    ...(processGroupId ? { processGroupId } : {}),
    startedAt: record.startedAt,
    checkIndex: Number(record.checkIndex)
  };
}

function processTreeIsAlive(activeProcess: ManagedActiveProcess | undefined): boolean {
  if (!activeProcess) return false;
  const target =
    process.platform === "win32"
      ? activeProcess.pid
      : -(activeProcess.processGroupId ?? activeProcess.pid);
  try {
    process.kill(target, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

function jobDirectory(workspace: Workspace): string {
  // Runtime receipts live outside the repository so recovery metadata never changes git state or validation fingerprints.
  return path.join(runtimeDir(), "check-jobs", profileIdForRoot(workspace.root));
}

function receiptPath(workspace: Workspace, jobId: string): string {
  return path.join(jobDirectory(workspace), `${jobId}.json`);
}

function writeReceiptAtomicSync(filePath: string, receipt: ManagedCheckReceipt): void {
  const dir = path.dirname(filePath);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const temp = path.join(dir, `.${path.basename(filePath)}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`);
  try {
    fs.writeFileSync(temp, JSON.stringify(receipt, null, 2) + "\n", { encoding: "utf8", mode: 0o600 });
    fs.renameSync(temp, filePath);
  } finally {
    try { fs.rmSync(temp, { force: true }); } catch {}
  }
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

function isRunChecksPhase(value: unknown): value is RunChecksPhase {
  return [
    "discovering_checks",
    "fingerprinting_before",
    "fingerprint_before_reused",
    "running_checks",
    "fingerprinting_after",
    "finished"
  ].includes(String(value));
}

function runtimeFromUnknown(value: unknown): ManagedRuntimeSnapshot | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  if (record.state !== "running" && record.state !== "exited") return undefined;
  if (!Number.isInteger(record.check_index) || Number(record.check_index) < 0) return undefined;
  if (typeof record.check !== "string" || typeof record.command !== "string" || typeof record.cwd !== "string") return undefined;
  if (
    typeof record.elapsed_ms !== "number" ||
    typeof record.output_bytes !== "number" ||
    typeof record.stdout_bytes !== "number" ||
    typeof record.stderr_bytes !== "number"
  ) {
    return undefined;
  }
  return {
    state: record.state,
    check_index: Number(record.check_index),
    check: record.check,
    command: redactSensitiveText(record.command),
    cwd: record.cwd,
    ...(Number.isInteger(record.pid) && Number(record.pid) > 0 ? { pid: Number(record.pid) } : {}),
    ...(typeof record.started_at === "string" ? { started_at: record.started_at } : {}),
    elapsed_ms: Math.max(0, Number(record.elapsed_ms)),
    output_bytes: Math.max(0, Number(record.output_bytes)),
    stdout_bytes: Math.max(0, Number(record.stdout_bytes)),
    stderr_bytes: Math.max(0, Number(record.stderr_bytes)),
    ...(typeof record.last_output_at === "string" ? { last_output_at: record.last_output_at } : {}),
    ...(typeof record.last_output_age_ms === "number"
      ? { last_output_age_ms: Math.max(0, Number(record.last_output_age_ms)) }
      : {}),
    output_limit_exceeded: record.output_limit_exceeded === true,
    timed_out: record.timed_out === true,
    cancelled: record.cancelled === true,
    termination_started: record.termination_started === true,
    child_exited: record.child_exited === true,
    ...(typeof record.child_exit_elapsed_ms === "number"
      ? { child_exit_elapsed_ms: Math.max(0, Number(record.child_exit_elapsed_ms)) }
      : {}),
    ...(typeof record.telemetry_sampled_at === "string" ? { telemetry_sampled_at: record.telemetry_sampled_at } : {}),
    ...(typeof record.cpu_time_ms === "number" && Number(record.cpu_time_ms) >= 0
      ? { cpu_time_ms: Number(record.cpu_time_ms) }
      : {}),
    ...(typeof record.resident_memory_bytes === "number" && Number(record.resident_memory_bytes) >= 0
      ? { resident_memory_bytes: Number(record.resident_memory_bytes) }
      : {}),
    ...(record.memory_kind === "working_set" || record.memory_kind === "rss"
      ? { memory_kind: record.memory_kind }
      : {}),
    ...(Number.isInteger(record.child_process_count) && Number(record.child_process_count) >= 0
      ? { child_process_count: Number(record.child_process_count) }
      : {}),
    ...(Number.isInteger(record.process_count) && Number(record.process_count) >= 1
      ? { process_count: Number(record.process_count) }
      : {})
  };
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
    ...(typeof record.heartbeatAt === "string" ? { heartbeatAt: record.heartbeatAt } : {}),
    ...(activeProcessFromUnknown(record.activeProcess) ? { activeProcess: activeProcessFromUnknown(record.activeProcess)! } : {}),
    ...(runtimeFromUnknown(record.runtime) ? { runtime: runtimeFromUnknown(record.runtime)! } : {}),
    createdAt: record.createdAt,
    startedAt: record.startedAt,
    ...(typeof record.resumedAt === "string" ? { resumedAt: record.resumedAt } : {}),
    ...(typeof record.interruptedAt === "string" ? { interruptedAt: record.interruptedAt } : {}),
    ...(typeof record.completedAt === "string" ? { completedAt: record.completedAt } : {}),
    status: record.status,
    ...(isRunChecksPhase(record.phase) ? { phase: record.phase } : {}),
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
    heartbeatAt: receipt.heartbeatAt,
    activeProcess: receipt.activeProcess,
    runtime: receipt.runtime,
    createdAt: receipt.createdAt,
    startedAt: receipt.startedAt,
    resumedAt: receipt.resumedAt,
    interruptedAt: receipt.interruptedAt,
    completedAt: receipt.completedAt,
    status: receipt.status,
    phase: receipt.phase,
    controller: new AbortController(),
    log: receipt.log,
    logTruncated: receipt.logTruncated,
    persistedResult: receipt.result,
    error: receipt.error,
    promise: Promise.resolve(),
    persistChain: Promise.resolve()
  };
}

// Keep background verification process-scoped and memory-bounded. Durable receipts make transport/process recovery explicit.
export class ManagedCheckManager {
  private readonly supervisor = new ExecutionSupervisor();
  private readonly jobs = new Map<string, ManagedCheckJob>();
  // request_id is scoped by workspace so a dropped start_check response can be retried without duplicating execution.
  private readonly requestIndex = new Map<string, string>();
  private readonly loadedWorkspaces = new Set<string>();

  constructor(private readonly protocolTrace?: ProtocolTraceManager) {}

  private traceExecution(
    job: ManagedCheckJob,
    kind: "start" | "output" | "runtime" | "end",
    details: Record<string, unknown>
  ): Promise<void> {
    if (!this.protocolTrace || !job.traceContext) return Promise.resolve();
    // Preserve the originating MCP trace across detached child-process callbacks. Tracing is
    // diagnostic only: disk/rotation errors must never cancel or change validation outcomes.
    return this.protocolTrace
      .recordExecution(kind, job.id, {
        workspace_id: job.workspaceId,
        ...(job.requestId ? { check_request_id: job.requestId } : {}),
        ...details
      }, job.traceContext)
      .catch(() => {});
  }

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
      ...(job.heartbeatAt ? { heartbeatAt: job.heartbeatAt } : {}),
      ...(job.activeProcess ? { activeProcess: job.activeProcess } : {}),
      ...(job.runtime ? { runtime: job.runtime } : {}),
      createdAt: job.createdAt,
      startedAt: job.startedAt,
      ...(job.resumedAt ? { resumedAt: job.resumedAt } : {}),
      ...(job.interruptedAt ? { interruptedAt: job.interruptedAt } : {}),
      ...(job.completedAt ? { completedAt: job.completedAt } : {}),
      status: job.status,
      ...(job.phase ? { phase: job.phase } : {}),
      log: job.log,
      logTruncated: job.logTruncated,
      ...(job.result ? { result: compactResult(job.result) } : job.persistedResult ? { result: job.persistedResult } : {}),
      ...(job.error ? { error: job.error } : {})
    };
  }

  private persistJobSync(workspace: Workspace, job: ManagedCheckJob): void {
    try {
      writeReceiptAtomicSync(receiptPath(workspace, job.id), this.receipt(job));
      job.persistenceError = undefined;
    } catch (error) {
      job.persistenceError = safeError(error);
      throw error;
    }
  }

  private async persistJob(workspace: Workspace, job: ManagedCheckJob): Promise<void> {
    // Heartbeats and terminal writes can race; serialize them so an older heartbeat can never
    // overwrite a newer completed/cancelled receipt after the check settles.
    const task = job.persistChain
      .catch(() => {})
      .then(() => writeReceiptAtomic(receiptPath(workspace, job.id), this.receipt(job)));
    job.persistChain = task;
    try {
      await task;
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
      job.runnerLease = await this.supervisor.inspect(workspace, job.id);
      if (job.status === "running") {
        const leaseView = this.supervisor.view(job.runnerLease);
        job.status = "interrupted";
        job.interruptedAt = new Date().toISOString();
        if (leaseView?.active && !leaseView.owned_by_current_process) {
          // Another CodexPro still owns this runner. Observe it read-only: never overwrite the
          // live owner's receipt with an interrupted state from this secondary process.
        } else {
          this.appendLog(job, "\nstatus: interrupted\nreason: CodexPro process ended before the check reached a terminal state.\n");
          interrupted.push(job);
        }
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

  private async refreshObservedJob(workspace: Workspace, job: ManagedCheckJob): Promise<void> {
    job.runnerLease = await this.supervisor.inspect(workspace, job.id);
    const leaseView = this.supervisor.view(job.runnerLease);
    if (leaseView?.owned_by_current_process) return;

    try {
      const parsed = JSON.parse(await fsp.readFile(receiptPath(workspace, job.id), "utf8"));
      const receipt = receiptFromUnknown(parsed, workspace);
      if (!receipt) return;

      if (receipt.status === "running") {
        // Foreign observers may refresh live diagnostics from the owner's durable receipt,
        // but they do not mutate the observed execution state or claim ownership.
        job.heartbeatAt = receipt.heartbeatAt;
        job.activeProcess = receipt.activeProcess;
        job.runtime = receipt.runtime;
        job.phase = receipt.phase;
        job.log = receipt.log;
        job.logTruncated = receipt.logTruncated;
        return;
      }

      // Secondary CodexPro processes only adopt durable terminal state. They never rewrite or
      // interfere with the live owner's in-memory job while its receipt still says running.
      job.status = receipt.status;
      job.heartbeatAt = receipt.heartbeatAt;
      job.activeProcess = receipt.activeProcess;
      job.runtime = receipt.runtime;
      job.phase = receipt.phase;
      job.createdAt = receipt.createdAt;
      job.startedAt = receipt.startedAt;
      job.resumedAt = receipt.resumedAt;
      job.interruptedAt = receipt.interruptedAt;
      job.completedAt = receipt.completedAt;
      job.log = receipt.log;
      job.logTruncated = receipt.logTruncated;
      job.persistedResult = receipt.result;
      job.result = undefined;
      job.error = receipt.error;
    } catch (error) {
      if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") return;
      if (error instanceof SyntaxError) return;
      throw error;
    }
  }

  private view(job: ManagedCheckJob, options: ManagedCheckPageOptions = {}): ManagedCheckView {
    const cursor = clampInt(options.cursor, 0, 0, job.log.length);
    const maxChars = clampInt(options.maxChars, DEFAULT_PAGE_CHARS, 100, MAX_PAGE_CHARS);
    const nextCursor = Math.min(job.log.length, cursor + maxChars);
    const runnerLease = this.supervisor.view(job.runnerLease);
    const processActive = runnerLease?.process_active ?? processTreeIsAlive(job.activeProcess);
    const leaseBlocksResume = runnerLease ? !runnerLease.acquirable : processActive;
    const runtime =
      job.runtime && job.runnerLease?.telemetry
        ? { ...job.runtime, ...runtimeTelemetryFields(job.runnerLease.telemetry) }
        : job.runtime;
    return {
      job_id: job.id,
      ...(job.requestId ? { request_id: job.requestId } : {}),
      workspace_id: job.workspaceId,
      status: job.status,
      ...(job.phase ? { phase: job.phase } : {}),
      can_resume: job.status === "interrupted" && !leaseBlocksResume && !processActive,
      created_at: job.createdAt,
      started_at: job.startedAt,
      ...(job.resumedAt ? { resumed_at: job.resumedAt } : {}),
      ...(job.interruptedAt ? { interrupted_at: job.interruptedAt } : {}),
      ...(job.completedAt ? { completed_at: job.completedAt } : {}),
      workspace_fingerprint: job.workspaceFingerprint,
      ...(job.heartbeatAt ? { heartbeat_at: job.heartbeatAt } : {}),
      ...(job.activeProcess
        ? {
            active_process: {
              pid: job.activeProcess.pid,
              ...(job.activeProcess.processGroupId ? { process_group_id: job.activeProcess.processGroupId } : {}),
              started_at: job.activeProcess.startedAt,
              check_index: job.activeProcess.checkIndex
            }
          }
        : {}),
      process_active: processActive,
      ...(runnerLease ? { runner_lease: runnerLease } : {}),
      ...(runtime ? { runtime } : {}),
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
      initialWorkspaceFingerprint: job.workspaceFingerprint,
      onPhase: (event) => {
        job.phase = event.phase;
        void this.traceExecution(job, "runtime", { event: "phase", phase: event.phase, elapsed_ms: event.elapsedMs });
        this.appendLog(job, `[runtime] event=phase phase=${event.phase} elapsed_ms=${event.elapsedMs}\n`);
      },
      onResult: (result, index) => this.appendLog(job, checkLog(result, index)),
      progressIntervalMs: 2_000,
      onProcessStart: (processInfo: BashProcessInfo, index: number, recommendation) => {
        void this.traceExecution(job, "runtime", {
          event: "process_start",
          check: recommendation.check,
          check_index: index,
          command: redactSensitiveText(recommendation.command),
          cwd: recommendation.cwd ?? ".",
          pid: processInfo.pid
        });
        job.activeProcess = {
          pid: processInfo.pid,
          ...(processInfo.processGroupId ? { processGroupId: processInfo.processGroupId } : {}),
          startedAt: processInfo.startedAt,
          checkIndex: index
        };
        job.heartbeatAt = new Date().toISOString();
        job.runtime = {
          state: "running",
          check_index: index,
          check: recommendation.check,
          command: redactSensitiveText(recommendation.command),
          cwd: recommendation.cwd ?? ".",
          pid: processInfo.pid,
          started_at: processInfo.startedAt,
          elapsed_ms: 0,
          output_bytes: 0,
          stdout_bytes: 0,
          stderr_bytes: 0,
          output_limit_exceeded: false,
          timed_out: false,
          cancelled: false,
          termination_started: false,
          child_exited: false
        };
        this.appendLog(
          job,
          redactSensitiveText(
            `[runtime] event=process_start check_index=${index} check=${recommendation.check} command=${JSON.stringify(recommendation.command)} cwd=${recommendation.cwd ?? "."} pid=${processInfo.pid} elapsed_ms=0 output_bytes=0\n`
          )
        );
        // The receipt remains a compatibility fallback, while the supervisor lease is the
        // authoritative multi-process owner of the runner and its active child process.
        this.persistJobSync(workspace, job);
        if (job.runnerLease) {
          void this.supervisor
            .attachProcess(workspace, job.id, job.runnerLease.leaseId, processInfo, index)
            .then((lease) => {
              job.runnerLease = lease;
            })
            .catch((error) => {
              job.persistenceError = safeError(error);
              this.appendLog(
                job,
                `[runtime] event=lease_error phase=attach_process error=${JSON.stringify(job.persistenceError)}\n`
              );
              job.controller.abort();
            });
        }
      },
      onOutput: (event, index, recommendation) => {
        const previewText = redactSensitiveText(event.text);
        // Capture only a bounded, redacted preview; avoid duplicating full check transcripts.
        void this.traceExecution(job, "output", {
          check: recommendation.check,
          check_index: index,
          stream: event.stream,
          chunk_bytes: event.chunkBytes,
          output_bytes: event.observedOutputBytes,
          preview: previewText.slice(0, 256),
          preview_truncated: previewText.length > 256
        });
        const prefix = event.stream === "stdout" ? "[stdout]" : "[stderr]";
        const text = redactSensitiveText(event.text);
        this.appendLog(job, `${prefix} ${text}${text.endsWith("\n") ? "" : "\n"}`);
      },
      onProgress: (event, index, recommendation) => {
        void this.traceExecution(job, "runtime", { event: "progress", check_index: index, check: recommendation.check, elapsed_ms: event.elapsedMs, output_bytes: event.observedOutputBytes, pid: event.pid });
        job.runtime = {
          state: "running",
          check_index: index,
          check: recommendation.check,
          command: redactSensitiveText(recommendation.command),
          cwd: recommendation.cwd ?? ".",
          ...(event.pid ? { pid: event.pid } : {}),
          ...(job.runtime?.started_at ? { started_at: job.runtime.started_at } : {}),
          elapsed_ms: event.elapsedMs,
          output_bytes: event.observedOutputBytes,
          stdout_bytes: event.stdoutBytes,
          stderr_bytes: event.stderrBytes,
          ...(event.lastOutputAt ? { last_output_at: event.lastOutputAt } : {}),
          ...(event.lastOutputAgeMs !== undefined ? { last_output_age_ms: event.lastOutputAgeMs } : {}),
          output_limit_exceeded: event.outputLimitExceeded,
          timed_out: event.timedOut,
          cancelled: event.cancelled,
          termination_started: event.terminationStarted,
          child_exited: event.childExited,
          ...(event.childExitElapsedMs !== undefined ? { child_exit_elapsed_ms: event.childExitElapsedMs } : {})
        };
        this.appendLog(
          job,
          redactSensitiveText(
            `[runtime] event=progress check_index=${index} check=${recommendation.check} elapsed_ms=${event.elapsedMs} pid=${event.pid ?? "unknown"} output_bytes=${event.observedOutputBytes} stdout_bytes=${event.stdoutBytes} stderr_bytes=${event.stderrBytes} last_output_age_ms=${event.lastOutputAgeMs ?? "none"} output_limit_exceeded=${event.outputLimitExceeded} timed_out=${event.timedOut} cancelled=${event.cancelled} terminating=${event.terminationStarted} child_exited=${event.childExited} child_exit_elapsed_ms=${event.childExitElapsedMs ?? "none"}\n`
          )
        );
      },
      onProcessExit: async (processInfo: BashProcessInfo, index: number, recommendation) => {
        if (job.activeProcess?.pid === processInfo.pid) job.activeProcess = undefined;
        job.heartbeatAt = new Date().toISOString();
        if (job.runtime?.check_index === index) job.runtime = { ...job.runtime, state: "exited" };
        this.appendLog(
          job,
          `[runtime] event=process_exit check_index=${index} check=${recommendation.check} pid=${processInfo.pid}\n`
        );
        if (job.runnerLease) {
          job.runnerLease = await this.supervisor.detachProcess(
            workspace,
            job.id,
            job.runnerLease.leaseId,
            processInfo
          );
        }
        await this.persistJob(workspace, job);
      }
    };

    job.heartbeatAt = new Date().toISOString();
    const heartbeatTimer = setInterval(() => {
      if (job.status !== "running") return;
      job.heartbeatAt = new Date().toISOString();
      void this.persistJob(workspace, job).catch(() => {});
      if (job.runnerLease) {
        void this.supervisor
          .renew(workspace, job.id, job.runnerLease.leaseId)
          .then((lease) => {
            job.runnerLease = lease;
            if (lease.telemetry && lease.telemetry.sampledAt !== job.telemetryLoggedAt) {
              job.telemetryLoggedAt = lease.telemetry.sampledAt;
              void this.traceExecution(job, "runtime", {
                event: "telemetry",
                sampled_at: lease.telemetry.sampledAt,
                cpu_time_ms: lease.telemetry.cpuTimeMs,
                resident_memory_bytes: lease.telemetry.residentMemoryBytes,
                memory_kind: lease.telemetry.memoryKind,
                child_process_count: lease.telemetry.childProcessCount,
                process_count: lease.telemetry.processCount
              });
              if (job.runtime) {
                job.runtime = { ...job.runtime, ...runtimeTelemetryFields(lease.telemetry) };
              }
              this.appendLog(
                job,
                `[runtime] event=telemetry sampled_at=${lease.telemetry.sampledAt} cpu_time_ms=${lease.telemetry.cpuTimeMs} resident_memory_bytes=${lease.telemetry.residentMemoryBytes} memory_kind=${lease.telemetry.memoryKind} child_process_count=${lease.telemetry.childProcessCount} process_count=${lease.telemetry.processCount}\n`
              );
            }
          })
          .catch((error) => {
            // Losing a runner lease is a safety failure: stop local execution rather than risk
            // two CodexPro processes continuing the same validation concurrently.
            job.persistenceError = safeError(error);
            this.appendLog(
              job,
              `[runtime] event=lease_error phase=heartbeat error=${JSON.stringify(job.persistenceError)}\n`
            );
            job.controller.abort();
          });
      }
    }, HEARTBEAT_INTERVAL_MS);
    heartbeatTimer.unref();

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
        clearInterval(heartbeatTimer);
        job.heartbeatAt = new Date().toISOString();
        job.completedAt = new Date().toISOString();
        // Publish a terminal receipt only after releasing the runner lease. Otherwise another
        // CodexPro can briefly observe "completed" while the durable runner still looks active.
        if (job.runnerLease) {
          await this.supervisor
            .release(workspace, job.id, job.runnerLease.leaseId)
            .then((lease) => {
              job.runnerLease = lease;
            })
            .catch((error) => {
              job.persistenceError = safeError(error);
            });
        }
        await this.persistJob(workspace, job).catch((error) => {
          this.appendLog(job, `\npersistence_error: ${safeError(error)}\n`);
        });
        await this.pruneReceipts(workspace).catch(() => {});
        await this.traceExecution(job, "end", { status: job.status, error: job.error, duration_ms: Date.now() - Date.parse(job.startedAt) });
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
        await this.refreshObservedJob(workspace, existing);
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
    const runnerLease = await this.supervisor.acquire(workspace, id);
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
      heartbeatAt: createdAt,
      runnerLease,
      traceContext: this.protocolTrace?.current(),
      createdAt,
      startedAt: createdAt,
      status: "running",
      controller,
      log: "",
      logTruncated: false,
      promise: Promise.resolve(),
      persistChain: Promise.resolve()
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
      await this.supervisor.release(workspace, id, runnerLease.leaseId).catch(() => {});
      throw new CodexProError(`Unable to persist managed check receipt: ${safeError(error)}`);
    }
    await this.traceExecution(job, "start", { checks: job.checks, status: job.status, lease_id: job.runnerLease?.leaseId });
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

    job.runnerLease = await this.supervisor.inspect(workspace, job.id);
    const currentLeaseView = this.supervisor.view(job.runnerLease);
    if (currentLeaseView?.active) {
      throw new CodexProError(
        `Runner lease for check job ${job.id} is still active under pid ${currentLeaseView.owner_pid}; wait for the owner/process to exit before resuming.`
      );
    }

    if (processTreeIsAlive(job.activeProcess)) {
      throw new CodexProError(
        `Check job ${job.id} cannot be resumed because its original validation process is still active (pid ${job.activeProcess!.pid}). Wait for it to exit or terminate it before resuming.`
      );
    }
    if (job.activeProcess) {
      // The old owner is gone; clear stale process ownership before creating a replacement process.
      job.activeProcess = undefined;
      job.heartbeatAt = new Date().toISOString();
      await this.persistJob(workspace, job);
    }

    const currentFingerprint = await workspaceFingerprint(config, guard, workspace);
    if (currentFingerprint !== job.workspaceFingerprint) {
      throw new CodexProError(
        `Workspace changed since check ${job.id} started. Start a new check instead of resuming the interrupted job.`
      );
    }

    job.runnerLease = await this.supervisor.acquire(workspace, job.id);
    job.controller = new AbortController();
    job.traceContext = this.protocolTrace?.current();
    job.status = "running";
    job.resumedAt = new Date().toISOString();
    job.completedAt = undefined;
    job.error = undefined;
    job.result = undefined;
    job.persistedResult = undefined;
    this.appendLog(job, `\nstatus: running\nresumed_at: ${job.resumedAt}\n`);
    try {
      await this.persistJob(workspace, job);
    } catch (error) {
      const lease = job.runnerLease;
      job.status = "interrupted";
      job.error = safeError(error);
      if (lease) {
        await this.supervisor.release(workspace, job.id, lease.leaseId).catch(() => {});
        job.runnerLease = await this.supervisor.inspect(workspace, job.id);
      }
      throw new CodexProError(`Unable to persist resumed check state: ${safeError(error)}`);
    }
    await this.traceExecution(job, "start", { status: "running", resumed: true, lease_id: job.runnerLease?.leaseId });
    this.launch(config, guard, workspace, job, options.sessionId);
    return this.view(job, { cursor: 0, maxChars: DEFAULT_PAGE_CHARS });
  }

  async getViewByJob(
    workspace: Workspace,
    jobId: string,
    options: ManagedCheckPageOptions = {}
  ): Promise<ManagedCheckView> {
    await this.loadWorkspace(workspace);
    const job = this.getScoped(workspace, jobId);
    await this.refreshObservedJob(workspace, job);
    return this.view(job, options);
  }

  async getViewByRequest(
    workspace: Workspace,
    requestId: string,
    options: ManagedCheckPageOptions = {}
  ): Promise<ManagedCheckView> {
    await this.loadWorkspace(workspace);
    const job = this.byRequest(workspace, requestId);
    await this.refreshObservedJob(workspace, job);
    return this.view(job, options);
  }

  async list(
    workspace: Workspace,
    options: { status?: ManagedCheckStatus[]; limit?: number } = {}
  ): Promise<Array<Record<string, unknown>>> {
    await this.loadWorkspace(workspace);
    const workspaceJobs = [...this.jobs.values()].filter((job) => job.workspaceId === workspace.id);
    for (const job of workspaceJobs) await this.refreshObservedJob(workspace, job);

    const statuses = options.status?.length ? new Set(options.status) : undefined;
    const limit = clampInt(options.limit, 20, 1, MAX_RETAINED_JOBS);
    return workspaceJobs
      .filter((job) => !statuses || statuses.has(job.status))
      .sort((left, right) => right.createdAt.localeCompare(left.createdAt))
      .slice(0, limit)
      .map((job) => {
        const runnerLease = this.supervisor.view(job.runnerLease);
        const processActive = runnerLease?.process_active ?? processTreeIsAlive(job.activeProcess);
        const leaseBlocksResume = runnerLease ? !runnerLease.acquirable : processActive;
        return {
          job_id: job.id,
          ...(job.requestId ? { request_id: job.requestId } : {}),
          workspace_id: job.workspaceId,
          status: job.status,
          ...(job.phase ? { phase: job.phase } : {}),
          can_resume: job.status === "interrupted" && !leaseBlocksResume && !processActive,
          checks: [...job.checks],
          target_paths: [...job.targetPaths],
          ...(job.projectPath ? { project_path: job.projectPath } : {}),
          created_at: job.createdAt,
          started_at: job.startedAt,
          ...(job.resumedAt ? { resumed_at: job.resumedAt } : {}),
          ...(job.interruptedAt ? { interrupted_at: job.interruptedAt } : {}),
          ...(job.completedAt ? { completed_at: job.completedAt } : {}),
          workspace_fingerprint: job.workspaceFingerprint,
          process_active: processActive,
          ...(runnerLease ? { runner_lease: runnerLease } : {}),
          ...(job.runtime ? { runtime: job.runtime } : {}),
          ...(job.heartbeatAt ? { heartbeat_at: job.heartbeatAt } : {}),
          log_chars: job.log.length,
          log_truncated: job.logTruncated
        };
      });
  }

  async wait(
    workspace: Workspace,
    jobId: string,
    options: ManagedCheckPageOptions = {}
  ): Promise<ManagedCheckView> {
    await this.loadWorkspace(workspace);
    const job = this.getScoped(workspace, jobId);
    await this.refreshObservedJob(workspace, job);
    const waitMs = clampInt(options.waitMs, 0, 0, MAX_WAIT_MS);
    if (job.status === "running" && waitMs > 0) {
      await Promise.race([job.promise, delay(waitMs)]);
    }
    // A local job can set its terminal status just before durable finalization completes.
    // Once terminal is visible, wait for lease release + receipt persistence before returning it.
    if (job.status !== "running") await job.promise;
    return this.view(job, options);
  }

  async stop(
    workspace: Workspace,
    jobId: string,
    options: ManagedCheckPageOptions = {}
  ): Promise<ManagedCheckView> {
    await this.loadWorkspace(workspace);
    const job = this.getScoped(workspace, jobId);
    await this.refreshObservedJob(workspace, job);
    if (job.status === "running") {
      job.controller.abort();
      await job.promise;
    }
    return this.view(job, options);
  }

  async shutdown(waitMs = 5_000): Promise<{ cancelled: number; settled: boolean }> {
    const running = [...this.jobs.values()].filter((job) => job.status === "running");
    if (running.length === 0) return { cancelled: 0, settled: true };

    // Normal CodexPro shutdown owns these controllers, so aborting them lets runBash terminate
    // the detached process groups before the parent exits. Persisted interrupted jobs are not touched.
    for (const job of running) job.controller.abort();

    let timedOut = false;
    const limit = clampInt(waitMs, 5_000, 500, 30_000);
    await Promise.race([
      Promise.allSettled(running.map((job) => job.promise)),
      delay(limit).then(() => {
        timedOut = true;
      })
    ]);
    return { cancelled: running.length, settled: !timedOut };
  }
}
