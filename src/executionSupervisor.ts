import { execFile } from "node:child_process";
import { randomBytes } from "node:crypto";
import fsp from "node:fs/promises";
import path from "node:path";
import type { BashProcessInfo } from "./bashOps.js";
import { CodexProError, type Workspace } from "./guard.js";
import { profileIdForRoot, runtimeDir } from "./profileStore.js";

export interface RunnerLeaseProcess {
  pid: number;
  processGroupId?: number;
  startedAt: string;
  checkIndex: number;
}

export interface RunnerProcessTelemetry {
  sampledAt: string;
  cpuTimeMs: number;
  residentMemoryBytes: number;
  memoryKind: "working_set" | "rss";
  childProcessCount: number;
  processCount: number;
}

export interface RunnerLeaseRecord {
  version: 1;
  workspaceId: string;
  jobId: string;
  leaseId: string;
  state: "active" | "released";
  ownerPid: number;
  ownerInstanceId: string;
  ownerStartedAt: string;
  acquiredAt: string;
  heartbeatAt: string;
  releasedAt?: string;
  activeProcess?: RunnerLeaseProcess;
  telemetry?: RunnerProcessTelemetry;
}

export interface RunnerLeaseView {
  lease_id: string;
  state: "active" | "released";
  active: boolean;
  acquirable: boolean;
  owner_pid: number;
  owner_alive: boolean;
  owner_started_at: string;
  heartbeat_at: string;
  heartbeat_age_ms: number;
  heartbeat_fresh: boolean;
  owned_by_current_process: boolean;
  released_at?: string;
  process_active: boolean;
  active_process?: {
    pid: number;
    process_group_id?: number;
    started_at: string;
    check_index: number;
  };
  telemetry?: {
    sampled_at: string;
    cpu_time_ms: number;
    resident_memory_bytes: number;
    memory_kind: "working_set" | "rss";
    child_process_count: number;
    process_count: number;
  };
}

const LEASE_VERSION = 1;
const HEARTBEAT_TTL_MS = 5_000;
const TELEMETRY_INTERVAL_MS = 5_000;
const LOCK_STALE_MS = 10_000;
const LOCK_WAIT_MS = 4_000;
const JOB_ID_PATTERN = /^check_[a-f0-9]{16}$/;
const LEASE_ID_PATTERN = /^lease_[a-f0-9]{24}$/;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    timer.unref();
  });
}

function execFileText(executable: string, args: string[]): Promise<string | undefined> {
  return new Promise((resolve) => {
    execFile(
      executable,
      args,
      {
        encoding: "utf8",
        timeout: 4_000,
        maxBuffer: 2 * 1024 * 1024,
        windowsHide: true
      },
      (error, stdout) => {
        if (error || typeof stdout !== "string") {
          resolve(undefined);
          return;
        }
        resolve(stdout);
      }
    );
  });
}

function processIsAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

function processTreeIsAlive(activeProcess: RunnerLeaseProcess | undefined): boolean {
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

function leaseRoot(workspace: Workspace): string {
  return path.join(runtimeDir(), "execution-leases", profileIdForRoot(workspace.root));
}

function leasePath(workspace: Workspace, jobId: string): string {
  return path.join(leaseRoot(workspace), `${jobId}.json`);
}

function lockPath(workspace: Workspace, jobId: string): string {
  return path.join(leaseRoot(workspace), ".locks", `${jobId}.lock`);
}

function processFromUnknown(value: unknown): RunnerLeaseProcess | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  if (!Number.isInteger(record.pid) || Number(record.pid) <= 0) return undefined;
  if (!Number.isInteger(record.checkIndex) || Number(record.checkIndex) < 0) return undefined;
  if (typeof record.startedAt !== "string") return undefined;
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

function telemetryFromUnknown(value: unknown): RunnerProcessTelemetry | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  if (typeof record.sampledAt !== "string") return undefined;
  if (record.memoryKind !== "working_set" && record.memoryKind !== "rss") return undefined;
  const cpuTimeMs = Number(record.cpuTimeMs);
  const residentMemoryBytes = Number(record.residentMemoryBytes);
  const childProcessCount = Number(record.childProcessCount);
  const processCount = Number(record.processCount);
  if (
    !Number.isFinite(cpuTimeMs) ||
    cpuTimeMs < 0 ||
    !Number.isFinite(residentMemoryBytes) ||
    residentMemoryBytes < 0 ||
    !Number.isInteger(childProcessCount) ||
    childProcessCount < 0 ||
    !Number.isInteger(processCount) ||
    processCount < 1 ||
    childProcessCount > processCount - 1
  ) {
    return undefined;
  }
  return {
    sampledAt: record.sampledAt,
    cpuTimeMs,
    residentMemoryBytes,
    memoryKind: record.memoryKind,
    childProcessCount,
    processCount
  };
}

function parsePsCpuTime(value: string): number {
  const match = value.trim().match(/^(?:(\d+)-)?(?:(\d+):)?(\d+):(\d+)$/);
  if (!match) return 0;
  const days = Number(match[1] ?? 0);
  const hours = Number(match[2] ?? 0);
  const minutes = Number(match[3] ?? 0);
  const seconds = Number(match[4] ?? 0);
  return (((days * 24 + hours) * 60 + minutes) * 60 + seconds) * 1_000;
}

type ProcessSampleRow = {
  pid: number;
  parentPid: number;
  cpuTimeMs: number;
  residentMemoryBytes: number;
};

function aggregateProcessRows(
  rootPid: number,
  rows: ProcessSampleRow[],
  memoryKind: RunnerProcessTelemetry["memoryKind"]
): RunnerProcessTelemetry | undefined {
  const byPid = new Map(rows.map((row) => [row.pid, row]));
  if (!byPid.has(rootPid)) return undefined;

  const children = new Map<number, ProcessSampleRow[]>();
  for (const row of rows) {
    const list = children.get(row.parentPid) ?? [];
    list.push(row);
    children.set(row.parentPid, list);
  }

  const selected: ProcessSampleRow[] = [];
  const pending = [rootPid];
  const seen = new Set<number>();
  while (pending.length > 0) {
    const pid = pending.shift()!;
    if (seen.has(pid)) continue;
    seen.add(pid);
    const row = byPid.get(pid);
    if (row) selected.push(row);
    for (const child of children.get(pid) ?? []) pending.push(child.pid);
  }
  if (selected.length === 0) return undefined;

  return {
    sampledAt: new Date().toISOString(),
    cpuTimeMs: Math.max(0, Math.round(selected.reduce((sum, row) => sum + row.cpuTimeMs, 0))),
    residentMemoryBytes: Math.max(
      0,
      Math.round(selected.reduce((sum, row) => sum + row.residentMemoryBytes, 0))
    ),
    memoryKind,
    childProcessCount: Math.max(0, selected.length - 1),
    processCount: selected.length
  };
}

async function sampleWindowsProcessTreeTelemetry(rootPid: number): Promise<RunnerProcessTelemetry | undefined> {
  const script =
    "Get-CimInstance Win32_Process | " +
    "Select-Object ProcessId,ParentProcessId,KernelModeTime,UserModeTime,WorkingSetSize | " +
    "ConvertTo-Json -Compress";
  try {
    const stdout = await execFileText(
      "powershell.exe",
      ["-NoProfile", "-NonInteractive", "-Command", script]
    );
    if (!stdout?.trim()) return undefined;
    const parsed = JSON.parse(stdout);
    const values = Array.isArray(parsed) ? parsed : [parsed];
    const rows: ProcessSampleRow[] = [];
    for (const value of values) {
      if (!value || typeof value !== "object" || Array.isArray(value)) continue;
      const record = value as Record<string, unknown>;
      const pid = Number(record.ProcessId);
      const parentPid = Number(record.ParentProcessId);
      if (!Number.isInteger(pid) || pid <= 0 || !Number.isInteger(parentPid) || parentPid < 0) continue;
      const kernel100ns = Number(record.KernelModeTime ?? 0);
      const user100ns = Number(record.UserModeTime ?? 0);
      const workingSet = Number(record.WorkingSetSize ?? 0);
      rows.push({
        pid,
        parentPid,
        cpuTimeMs:
          (Number.isFinite(kernel100ns) ? kernel100ns : 0) / 10_000 +
          (Number.isFinite(user100ns) ? user100ns : 0) / 10_000,
        residentMemoryBytes: Number.isFinite(workingSet) ? Math.max(0, workingSet) : 0
      });
    }
    return aggregateProcessRows(rootPid, rows, "working_set");
  } catch {
    return undefined;
  }
}

async function sampleUnixProcessTreeTelemetry(rootPid: number): Promise<RunnerProcessTelemetry | undefined> {
  try {
    const stdout = await execFileText("ps", ["-eo", "pid=,ppid=,rss=,time="]);
    if (typeof stdout !== "string") return undefined;
    const rows: ProcessSampleRow[] = [];
    for (const line of stdout.split(/\r?\n/)) {
      const match = line.match(/^\s*(\d+)\s+(\d+)\s+(\d+)\s+(\S+)\s*$/);
      if (!match) continue;
      rows.push({
        pid: Number(match[1]),
        parentPid: Number(match[2]),
        residentMemoryBytes: Number(match[3]) * 1_024,
        cpuTimeMs: parsePsCpuTime(match[4])
      });
    }
    return aggregateProcessRows(rootPid, rows, "rss");
  } catch {
    return undefined;
  }
}

async function sampleProcessTreeTelemetry(
  activeProcess: RunnerLeaseProcess | undefined
): Promise<RunnerProcessTelemetry | undefined> {
  if (!activeProcess?.pid) return undefined;
  return process.platform === "win32"
    ? sampleWindowsProcessTreeTelemetry(activeProcess.pid)
    : sampleUnixProcessTreeTelemetry(activeProcess.pid);
}

function telemetryNeedsRefresh(telemetry: RunnerProcessTelemetry | undefined): boolean {
  if (!telemetry) return true;
  const sampledAt = Date.parse(telemetry.sampledAt);
  return !Number.isFinite(sampledAt) || Date.now() - sampledAt >= TELEMETRY_INTERVAL_MS;
}

function leaseFromUnknown(value: unknown, workspace: Workspace, expectedJobId?: string): RunnerLeaseRecord | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  if (record.version !== LEASE_VERSION) return undefined;
  if (record.workspaceId !== workspace.id) return undefined;
  if (typeof record.jobId !== "string" || !JOB_ID_PATTERN.test(record.jobId)) return undefined;
  if (expectedJobId && record.jobId !== expectedJobId) return undefined;
  if (typeof record.leaseId !== "string" || !LEASE_ID_PATTERN.test(record.leaseId)) return undefined;
  if (record.state !== "active" && record.state !== "released") return undefined;
  if (!Number.isInteger(record.ownerPid) || Number(record.ownerPid) <= 0) return undefined;
  if (typeof record.ownerInstanceId !== "string" || !record.ownerInstanceId) return undefined;
  if (
    typeof record.ownerStartedAt !== "string" ||
    typeof record.acquiredAt !== "string" ||
    typeof record.heartbeatAt !== "string"
  ) {
    return undefined;
  }
  return {
    version: 1,
    workspaceId: workspace.id,
    jobId: record.jobId,
    leaseId: record.leaseId,
    state: record.state,
    ownerPid: Number(record.ownerPid),
    ownerInstanceId: record.ownerInstanceId,
    ownerStartedAt: record.ownerStartedAt,
    acquiredAt: record.acquiredAt,
    heartbeatAt: record.heartbeatAt,
    ...(typeof record.releasedAt === "string" ? { releasedAt: record.releasedAt } : {}),
    ...(processFromUnknown(record.activeProcess) ? { activeProcess: processFromUnknown(record.activeProcess)! } : {}),
    ...(telemetryFromUnknown(record.telemetry) ? { telemetry: telemetryFromUnknown(record.telemetry)! } : {})
  };
}

async function readLease(workspace: Workspace, jobId: string): Promise<RunnerLeaseRecord | undefined> {
  try {
    const parsed = JSON.parse(await fsp.readFile(leasePath(workspace, jobId), "utf8"));
    return leaseFromUnknown(parsed, workspace, jobId);
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") return undefined;
    if (error instanceof SyntaxError) return undefined;
    throw error;
  }
}

async function renameLeaseWithRetry(temp: string, filePath: string): Promise<void> {
  const attempts = process.platform === "win32" ? 12 : 1;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      await fsp.rename(temp, filePath);
      return;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      const retryable =
        process.platform === "win32" &&
        (code === "EPERM" || code === "EACCES" || code === "EBUSY") &&
        attempt + 1 < attempts;
      if (!retryable) throw error;
      // Antivirus/indexing/read handles can transiently block replacement on Windows.
      // Keep the original lease visible and retry the atomic rename; never unlink it as a fallback.
      await sleep(20 * (attempt + 1));
    }
  }
}

async function writeLeaseAtomic(workspace: Workspace, lease: RunnerLeaseRecord): Promise<void> {
  const filePath = leasePath(workspace, lease.jobId);
  const dir = path.dirname(filePath);
  await fsp.mkdir(dir, { recursive: true, mode: 0o700 });
  const temp = path.join(
    dir,
    `.${path.basename(filePath)}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`
  );
  try {
    await fsp.writeFile(temp, JSON.stringify(lease, null, 2) + "\n", { encoding: "utf8", mode: 0o600 });
    await renameLeaseWithRetry(temp, filePath);
  } finally {
    await fsp.rm(temp, { force: true }).catch(() => {});
  }
}

async function acquireLock(workspace: Workspace, jobId: string): Promise<() => Promise<void>> {
  const target = lockPath(workspace, jobId);
  await fsp.mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
  const started = Date.now();

  while (Date.now() - started < LOCK_WAIT_MS) {
    try {
      await fsp.mkdir(target);
      return async () => {
        await fsp.rm(target, { recursive: true, force: true }).catch(() => {});
      };
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== "EEXIST") throw error;
      try {
        const stat = await fsp.stat(target);
        if (Date.now() - stat.mtimeMs > LOCK_STALE_MS) {
          await fsp.rm(target, { recursive: true, force: true }).catch(() => {});
          continue;
        }
      } catch {}
      await sleep(25);
    }
  }
  throw new CodexProError(`Timed out waiting for execution lease lock for ${jobId}.`);
}

function ownerStartedAt(): string {
  return new Date(Date.now() - Math.max(0, Math.round(process.uptime() * 1_000))).toISOString();
}

export class ExecutionSupervisor {
  readonly instanceId = `runner_${randomBytes(12).toString("hex")}`;
  readonly ownerStartedAt = ownerStartedAt();
  private readonly telemetryInFlight = new Map<string, Promise<void>>();
  private readonly telemetryNextAttemptAt = new Map<string, number>();

  private scheduleTelemetryRefresh(
    workspace: Workspace,
    jobId: string,
    leaseId: string,
    activeProcess: RunnerLeaseProcess | undefined,
    currentTelemetry: RunnerProcessTelemetry | undefined
  ): void {
    if (!activeProcess || !telemetryNeedsRefresh(currentTelemetry)) return;
    const jobKey = `${workspace.id}:${jobId}`;
    if (Date.now() < (this.telemetryNextAttemptAt.get(jobKey) ?? 0)) return;
    const sampleKey = `${jobKey}:${activeProcess.pid}`;
    if (this.telemetryInFlight.has(sampleKey)) return;

    this.telemetryNextAttemptAt.set(jobKey, Date.now() + TELEMETRY_INTERVAL_MS);
    const task = (async () => {
      const telemetry = await sampleProcessTreeTelemetry(activeProcess);
      if (!telemetry) return;
      await this.updateOwned(workspace, jobId, leaseId, (lease) =>
        lease.activeProcess?.pid === activeProcess.pid
          ? { ...lease, telemetry }
          : lease
      );
    })()
      .catch(() => {})
      .finally(() => {
        this.telemetryInFlight.delete(sampleKey);
      });
    this.telemetryInFlight.set(sampleKey, task);
  }

  view(lease: RunnerLeaseRecord | undefined): RunnerLeaseView | undefined {
    if (!lease) return undefined;
    const now = Date.now();
    const heartbeatAt = Date.parse(lease.heartbeatAt);
    const heartbeatAgeMs = Number.isFinite(heartbeatAt) ? Math.max(0, now - heartbeatAt) : Number.MAX_SAFE_INTEGER;
    const heartbeatFresh = heartbeatAgeMs <= HEARTBEAT_TTL_MS;
    const ownerAlive = processIsAlive(lease.ownerPid);
    const processActive = processTreeIsAlive(lease.activeProcess);
    const ownedByCurrentProcess =
      lease.ownerPid === process.pid && lease.ownerInstanceId === this.instanceId;
    // Heartbeat is diagnostic evidence, not ownership by itself. Once both the lease owner
    // and the supervised process tree are gone, takeover can proceed immediately.
    const active =
      lease.state === "active" &&
      (ownedByCurrentProcess || ownerAlive || processActive);

    return {
      lease_id: lease.leaseId,
      state: lease.state,
      active,
      acquirable: lease.state === "released" || !active,
      owner_pid: lease.ownerPid,
      owner_alive: ownerAlive,
      owner_started_at: lease.ownerStartedAt,
      heartbeat_at: lease.heartbeatAt,
      heartbeat_age_ms: heartbeatAgeMs,
      heartbeat_fresh: heartbeatFresh,
      owned_by_current_process: ownedByCurrentProcess,
      ...(lease.releasedAt ? { released_at: lease.releasedAt } : {}),
      process_active: processActive,
      ...(lease.activeProcess
        ? {
            active_process: {
              pid: lease.activeProcess.pid,
              ...(lease.activeProcess.processGroupId
                ? { process_group_id: lease.activeProcess.processGroupId }
                : {}),
              started_at: lease.activeProcess.startedAt,
              check_index: lease.activeProcess.checkIndex
            }
          }
        : {}),
      ...(lease.telemetry
        ? {
            telemetry: {
              sampled_at: lease.telemetry.sampledAt,
              cpu_time_ms: lease.telemetry.cpuTimeMs,
              resident_memory_bytes: lease.telemetry.residentMemoryBytes,
              memory_kind: lease.telemetry.memoryKind,
              child_process_count: lease.telemetry.childProcessCount,
              process_count: lease.telemetry.processCount
            }
          }
        : {})
    };
  }

  async inspect(workspace: Workspace, jobId: string): Promise<RunnerLeaseRecord | undefined> {
    return readLease(workspace, jobId);
  }

  async acquire(workspace: Workspace, jobId: string): Promise<RunnerLeaseRecord> {
    const releaseLock = await acquireLock(workspace, jobId);
    try {
      const existing = await readLease(workspace, jobId);
      const existingView = this.view(existing);
      if (existing && existingView?.active) {
        if (existingView.owned_by_current_process) return existing;
        throw new CodexProError(
          `Runner lease for check job ${jobId} is still active under pid ${existing.ownerPid}; wait for the owner/process to exit before retrying.`
        );
      }

      const now = new Date().toISOString();
      const lease: RunnerLeaseRecord = {
        version: 1,
        workspaceId: workspace.id,
        jobId,
        leaseId: `lease_${randomBytes(12).toString("hex")}`,
        state: "active",
        ownerPid: process.pid,
        ownerInstanceId: this.instanceId,
        ownerStartedAt: this.ownerStartedAt,
        acquiredAt: now,
        heartbeatAt: now
      };
      await writeLeaseAtomic(workspace, lease);
      return lease;
    } finally {
      await releaseLock();
    }
  }

  async renew(workspace: Workspace, jobId: string, leaseId: string): Promise<RunnerLeaseRecord> {
    const observed = await readLease(workspace, jobId);
    this.scheduleTelemetryRefresh(
      workspace,
      jobId,
      leaseId,
      observed?.activeProcess,
      observed?.telemetry
    );
    return this.updateOwned(workspace, jobId, leaseId, (lease) => ({
      ...lease,
      heartbeatAt: new Date().toISOString()
    }));
  }

  async attachProcess(
    workspace: Workspace,
    jobId: string,
    leaseId: string,
    processInfo: BashProcessInfo,
    checkIndex: number
  ): Promise<RunnerLeaseRecord> {
    this.telemetryNextAttemptAt.delete(`${workspace.id}:${jobId}`);
    return this.updateOwned(workspace, jobId, leaseId, (lease) => ({
      ...lease,
      heartbeatAt: new Date().toISOString(),
      telemetry: undefined,
      activeProcess: {
        pid: processInfo.pid,
        ...(processInfo.processGroupId ? { processGroupId: processInfo.processGroupId } : {}),
        startedAt: processInfo.startedAt,
        checkIndex
      }
    }));
  }

  async detachProcess(
    workspace: Workspace,
    jobId: string,
    leaseId: string,
    processInfo: BashProcessInfo
  ): Promise<RunnerLeaseRecord> {
    return this.updateOwned(workspace, jobId, leaseId, (lease) => ({
      ...lease,
      heartbeatAt: new Date().toISOString(),
      ...(lease.activeProcess?.pid === processInfo.pid ? { activeProcess: undefined } : {})
    }));
  }

  async release(workspace: Workspace, jobId: string, leaseId: string): Promise<RunnerLeaseRecord> {
    this.telemetryNextAttemptAt.delete(`${workspace.id}:${jobId}`);
    return this.updateOwned(workspace, jobId, leaseId, (lease) => ({
      ...lease,
      state: "released",
      heartbeatAt: new Date().toISOString(),
      releasedAt: new Date().toISOString(),
      activeProcess: undefined
    }));
  }

  private async updateOwned(
    workspace: Workspace,
    jobId: string,
    leaseId: string,
    update: (lease: RunnerLeaseRecord) => RunnerLeaseRecord
  ): Promise<RunnerLeaseRecord> {
    const releaseLock = await acquireLock(workspace, jobId);
    try {
      const current = await readLease(workspace, jobId);
      if (!current) throw new CodexProError(`Runner lease for check job ${jobId} was not found.`);
      if (current.leaseId !== leaseId) {
        throw new CodexProError(`Runner lease for check job ${jobId} changed ownership.`);
      }
      if (current.ownerPid !== process.pid || current.ownerInstanceId !== this.instanceId) {
        throw new CodexProError(`Runner lease for check job ${jobId} is owned by another CodexPro process.`);
      }
      if (current.state !== "active" && update !== undefined) {
        throw new CodexProError(`Runner lease for check job ${jobId} is already released.`);
      }

      const next = update(current);
      await writeLeaseAtomic(workspace, next);
      return next;
    } finally {
      await releaseLock();
    }
  }
}
