import { randomBytes } from "node:crypto";
import fsp from "node:fs/promises";
import path from "node:path";
import type { CodexProConfig } from "./config.js";
import { CodexProError, type PathGuard, type Workspace } from "./guard.js";
import { workspaceFingerprint } from "./checkOps.js";
import { profileIdForRoot, runtimeDir } from "./profileStore.js";
import { redactSensitiveText } from "./redact.js";

export type TaskStatus = "in_progress" | "blocked" | "completed";
export type TaskStepStatus = "pending" | "in_progress" | "blocked" | "completed";
export interface TaskStep { id: string; title: string; status: TaskStepStatus; }
export interface TaskFile { workspace_id: string; path: string; }
export interface TaskWorkspace { workspace_id: string; root: string; fingerprint: string; }
export interface TaskCheckpoint {
  version: 1;
  task_id: string;
  workspace_id: string;
  revision: number;
  title: string;
  status: TaskStatus;
  steps: TaskStep[];
  next_step_id?: string;
  related_workspaces: TaskWorkspace[];
  primary_workspace: TaskWorkspace;
  changed_files: TaskFile[];
  check_job_ids: string[];
  note: string;
  created_at: string;
  updated_at: string;
}
export interface SaveTaskInput {
  taskId: string; title: string; status: TaskStatus; steps: TaskStep[];
  nextStepId?: string; changedFiles: TaskFile[]; checkJobIds: string[];
  note?: string; expectedRevision: number;
}
const TASK_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;
const STEP_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;
const REVISION_FILE = /^r([1-9][0-9]{0,3})\.json$/;
const MAX_TASKS = 40;
const MAX_REVISIONS = 256;
const MAX_RECEIPT_BYTES = 64 * 1024;

function fail(message: string): never { throw new CodexProError(message); }
function validId(id: string): string {
  if (!TASK_ID.test(id)) fail("Invalid task_id: use 1-64 ASCII letters, numbers, hyphens or underscores.");
  return id;
}
function taskDir(ws: Workspace, taskId: string): string {
  return path.join(runtimeDir(), "task-checkpoints", profileIdForRoot(ws.root), validId(taskId));
}
function cleanText(value: string, max: number, field: string): string {
  if (typeof value !== "string" || !value.trim() || value.length > max)
    fail("Invalid " + field + ": required, max " + max + " characters.");
  return redactSensitiveText(value.trim());
}
function normalizeInput(input: SaveTaskInput, scopes: Workspace[], guard: PathGuard): SaveTaskInput {
  validId(input.taskId);
  if (!Array.isArray(input.steps) || input.steps.length < 1 || input.steps.length > 40)
    fail("Checkpoint requires 1-40 task steps.");
  if (!["in_progress", "blocked", "completed"].includes(input.status)) fail("Invalid task status.");
  if (new Set(scopes.map((scope) => scope.id)).size !== scopes.length || scopes.length > 5)
    fail("Task workspaces must be distinct (max 5).");
  const ids = new Set<string>();
  const steps = input.steps.map((step) => {
    if (!STEP_ID.test(step.id) || ids.has(step.id)) fail("Invalid or duplicate step ID.");
    ids.add(step.id);
    if (!["pending", "in_progress", "blocked", "completed"].includes(step.status))
      fail("Invalid step status.");
    return { id: step.id, title: cleanText(step.title, 200, "step title"), status: step.status };
  });
  if (steps.filter((step) => step.status === "in_progress").length > 1)
    fail("Only one step may be in progress.");
  if (input.status === "completed" && steps.some((step) => step.status !== "completed"))
    fail("A completed task must have all steps completed.");
  if (input.status === "completed" && input.nextStepId) fail("A completed task cannot have a next step.");
  if (input.nextStepId && (!ids.has(input.nextStepId) ||
    steps.some((step) => step.id === input.nextStepId && step.status === "completed")))
    fail("next_step_id must reference an unfinished step.");

  const changed = input.changedFiles ?? [];
  if (!Array.isArray(changed) || changed.length > 80) fail("changed_files must have at most 80 items.");
  const files: TaskFile[] = [];
  const seen = new Set<string>();
  for (const item of changed) {
    const scope = scopes.find((candidate) => candidate.id === item.workspace_id);
    if (!scope || typeof item.path !== "string" || item.path.length > 1024)
      fail("changed_files entry has an invalid workspace or path.");
    const normalized = guard.resolve(scope, item.path).relPath;
    if (normalized === "." || !normalized) fail("changed_files must refer to specific files.");
    const key = scope.id + ":" + normalized;
    if (!seen.has(key)) { files.push({ workspace_id: scope.id, path: normalized }); seen.add(key); }
  }
  const checks = input.checkJobIds ?? [];
  if (!Array.isArray(checks) || checks.length > 20 ||
    !checks.every((id) => /^check_[a-f0-9]{16}$/.test(id)))
    fail("check_job_ids must contain at most 20 valid check IDs.");
  if (!Number.isInteger(input.expectedRevision) || input.expectedRevision < 0 ||
    input.expectedRevision > MAX_REVISIONS) fail("Invalid expected_revision.");
  const note = input.note?.trim() ? cleanText(input.note, 2000, "note") : "";
  return {
    taskId: input.taskId, title: cleanText(input.title, 240, "title"),
    status: input.status, steps, nextStepId: input.nextStepId,
    changedFiles: files, checkJobIds: [...new Set(checks)],
    note, expectedRevision: input.expectedRevision
  };
}
function isCheckpoint(value: unknown, ws: Workspace, id: string, revision: number): value is TaskCheckpoint {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const x = value as Partial<TaskCheckpoint>;
  return x.version === 1 && x.workspace_id === ws.id && x.task_id === id && x.revision === revision &&
    typeof x.title === "string" && ["in_progress", "blocked", "completed"].includes(x.status ?? "") &&
    Array.isArray(x.steps) && x.steps.every((step) => STEP_ID.test(step.id) &&
      typeof step.title === "string" && ["pending", "in_progress", "blocked", "completed"].includes(step.status)) &&
    Array.isArray(x.related_workspaces) && Boolean(x.primary_workspace) &&
    Array.isArray(x.changed_files) && Array.isArray(x.check_job_ids) &&
    typeof x.created_at === "string" && typeof x.updated_at === "string";
}
async function readLatest(ws: Workspace, taskId: string): Promise<TaskCheckpoint | undefined> {
  const folder = taskDir(ws, taskId);
  const names = await fsp.readdir(folder).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return [] as string[];
    throw error;
  });
  const versions = names.map((name) => REVISION_FILE.exec(name)?.[1])
    .filter((item): item is string => Boolean(item)).map(Number)
    .filter((n) => n <= MAX_REVISIONS).sort((a, b) => b - a);
  if (!versions.length) return undefined;
  const revision = versions[0];
  const filename = path.join(folder, "r" + revision + ".json");
  const stat = await fsp.lstat(filename);
  if (!stat.isFile() || stat.size > MAX_RECEIPT_BYTES)
    fail("Corrupt or oversized task checkpoint " + taskId + ".");
  let decoded: unknown;
  try { decoded = JSON.parse(await fsp.readFile(filename, "utf8")); }
  catch { return fail("Corrupt task checkpoint " + taskId + "; prior revisions were preserved."); }
  if (!isCheckpoint(decoded, ws, taskId, revision))
    fail("Invalid task checkpoint " + taskId + ".");
  return decoded;
}
function equivalent(old: TaskCheckpoint, input: SaveTaskInput, scopes: Workspace[]): boolean {
  return old.title === input.title && old.status === input.status &&
    (old.next_step_id ?? "") === (input.nextStepId ?? "") && old.note === input.note &&
    JSON.stringify(old.steps) === JSON.stringify(input.steps) &&
    JSON.stringify(old.changed_files) === JSON.stringify(input.changedFiles) &&
    JSON.stringify(old.check_job_ids) === JSON.stringify(input.checkJobIds) &&
    JSON.stringify([old.primary_workspace, ...old.related_workspaces].map((w) => w.workspace_id)) ===
      JSON.stringify(scopes.map((w) => w.id));
}
async function atomicCreate(file: string, value: TaskCheckpoint): Promise<void> {
  const buffer = Buffer.from(JSON.stringify(value, null, 2) + "\n", "utf8");
  if (buffer.length > MAX_RECEIPT_BYTES) fail("Task checkpoint exceeds storage budget.");
  const temp = file + "." + process.pid + "-" + randomBytes(6).toString("hex") + ".tmp";
  const handle = await fsp.open(temp, "wx", 0o600);
  try { await handle.writeFile(buffer); await handle.sync(); }
  finally { await handle.close(); }
  try {
    // Atomic no-overwrite publication; a conflicting writer cannot overwrite this revision.
    await fsp.link(temp, file);
  } finally {
    await fsp.unlink(temp).catch(() => {});
  }
}
export async function saveTaskCheckpoint(config: CodexProConfig, guard: PathGuard,
  primary: Workspace, related: Workspace[], raw: SaveTaskInput
): Promise<{ checkpoint: TaskCheckpoint; reused: boolean }> {
  const scopes = [primary, ...related];
  const input = normalizeInput(raw, scopes, guard);
  const folder = taskDir(primary, input.taskId);
  const existing = await readLatest(primary, input.taskId);
  if (existing?.revision !== undefined && existing.revision !== input.expectedRevision) {
    if (existing.revision === input.expectedRevision + 1 && equivalent(existing, input, scopes))
      return { checkpoint: existing, reused: true };
    fail("Task checkpoint revision conflict: expected " + input.expectedRevision +
      ", found " + existing.revision + ". Read the latest checkpoint before updating.");
  }
  if (!existing && input.expectedRevision !== 0)
    fail("Task checkpoint does not exist; expected_revision must be 0 for creation.");
  if (existing?.revision === MAX_REVISIONS) fail("Task checkpoint revision budget reached; create a new task.");
  if (!existing) {
    const base = path.dirname(folder);
    const count = (await fsp.readdir(base).catch((e: NodeJS.ErrnoException) => {
      if (e.code === "ENOENT") return [] as string[];
      throw e;
    })).filter((id) => TASK_ID.test(id)).length;
    if (count >= MAX_TASKS) fail("Task checkpoint workspace limit reached.");
  }
  const fingerprints = await Promise.all(scopes.map(async (ws) => ({
    workspace_id: ws.id, root: ws.root, fingerprint: await workspaceFingerprint(config, guard, ws)
  })));
  const revision = input.expectedRevision + 1;
  const now = new Date().toISOString();
  const checkpoint: TaskCheckpoint = {
    version: 1, task_id: input.taskId, workspace_id: primary.id, revision,
    title: input.title, status: input.status, steps: input.steps,
    ...(input.nextStepId ? { next_step_id: input.nextStepId } : {}),
    primary_workspace: fingerprints[0], related_workspaces: fingerprints.slice(1),
    changed_files: input.changedFiles, check_job_ids: input.checkJobIds,
    note: input.note ?? "", created_at: existing?.created_at ?? now, updated_at: now
  };
  await fsp.mkdir(folder, { recursive: true, mode: 0o700 });
  try { await atomicCreate(path.join(folder, "r" + revision + ".json"), checkpoint); }
  catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "EEXIST")
      fail("Concurrent checkpoint update detected. Read the latest revision before retrying.");
    throw error;
  }
  return { checkpoint, reused: false };
}
export async function getTaskCheckpoint(primary: Workspace, taskId: string): Promise<TaskCheckpoint> {
  const found = await readLatest(primary, taskId);
  if (!found) fail("Unknown task checkpoint: " + taskId + ".");
  return found;
}
export async function listTaskCheckpoints(primary: Workspace, limit = 10) {
  const base = path.dirname(taskDir(primary, "placeholder"));
  const folders = await fsp.readdir(base, { withFileTypes: true }).catch((e: NodeJS.ErrnoException) => {
    if (e.code === "ENOENT") return [] as import("node:fs").Dirent[];
    throw e;
  });
  const warnings: string[] = [];
  const tasks: TaskCheckpoint[] = [];
  for (const item of folders.slice(0, MAX_TASKS + 1)) {
    if (!item.isDirectory() || !TASK_ID.test(item.name)) continue;
    try {
      const checkpoint = await readLatest(primary, item.name);
      if (checkpoint) tasks.push(checkpoint);
    } catch { warnings.push("Task " + item.name + " has unreadable checkpoint data."); }
  }
  if (folders.length > MAX_TASKS) warnings.push("Task directory listing exceeded recovery budget.");
  tasks.sort((a, b) => b.updated_at.localeCompare(a.updated_at));
  return {
    tasks: tasks.slice(0, Math.max(1, Math.min(limit, 40))).map((task) => ({
      task_id: task.task_id, title: task.title, status: task.status, revision: task.revision,
      updated_at: task.updated_at, ...(task.next_step_id ? { next_step_id: task.next_step_id } : {})
    })),
    warnings
  };
}
export async function buildTaskRecoveryPlan(config: CodexProConfig, guard: PathGuard,
  checkpoint: TaskCheckpoint, resolveWorkspace: (id: string, root: string) => Workspace
) {
  const scopes = [checkpoint.primary_workspace, ...checkpoint.related_workspaces];
  const changes = await Promise.all(scopes.map(async (scope) => {
    try {
      const current = resolveWorkspace(scope.workspace_id, scope.root);
      if (current.id !== scope.workspace_id) throw new Error("Workspace identity changed.");
      const currentFingerprint = await workspaceFingerprint(config, guard, current);
      return { workspace_id: scope.workspace_id, changed: currentFingerprint !== scope.fingerprint, accessible: true };
    } catch {
      return { workspace_id: scope.workspace_id, changed: true, accessible: false };
    }
  }));
  const unfinished = checkpoint.steps.filter((step) => step.status !== "completed");
  const next = checkpoint.status === "completed" ? null :
    unfinished.find((step) => step.id === checkpoint.next_step_id) ?? unfinished[0] ?? null;
  const requiresReview = changes.some((scope) => scope.changed);
  return {
    task_id: checkpoint.task_id, revision: checkpoint.revision,
    requires_review: requiresReview, workspace_changes: changes,
    completed_steps: checkpoint.steps.filter((step) => step.status === "completed"),
    remaining_steps: unfinished, next_step: next,
    check_job_ids: checkpoint.check_job_ids,
    advisory: requiresReview
      ? "Workspace changed or a linked workspace is inaccessible. Review changes before continuing; never replay edits blindly."
      : "Checkpoint steps are user/agent-reported, not independently verified. Inspect code and checks before continuing."
  };
}
