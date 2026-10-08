import { AsyncLocalStorage } from "node:async_hooks";

/**
 * Human-readable console diagnostics are intentionally separate from Protocol Trace JSONL.
 * They must not echo arbitrary tool parameters, commands, stdout or credentials. Only known
 * package-script names and numeric process counters can appear in stderr diagnostics.
 */
interface ToolConsoleState {
  name: string;
  startedAtMs: number;
  requestId?: string;
  task: string;
  pid?: number;
  outputBytes?: number;
  lastOutputAgeMs?: number;
  phase?: string;
}

export interface ToolConsoleProgress {
  pid?: number;
  outputBytes?: number;
  lastOutputAgeMs?: number;
  phase?: string;
}

const consoleRequestContext = new AsyncLocalStorage<{ requestId: string }>();
const toolContext = new AsyncLocalStorage<ToolConsoleState>();

/**
 * Format a console timestamp using the CodexPro host's local UTC offset.
 * Unlike a fixed UTC+8 adjustment, Date.getTimezoneOffset() reflects the local
 * time zone (including daylight saving transitions) at the event's instant.
 * The explicit offset parameter also makes boundary tests deterministic.
 * Protocol Trace JSONL deliberately keeps UTC ISO timestamps independently.
 */
export function formatConsoleTimestamp(
  date: Date = new Date(),
  utcOffsetMinutes: number = -date.getTimezoneOffset()
): string {
  const local = new Date(date.getTime() + utcOffsetMinutes * 60_000);
  const pad = (value: number, width = 2) => String(value).padStart(width, "0");
  const absoluteOffset = Math.abs(utcOffsetMinutes);
  const sign = utcOffsetMinutes >= 0 ? "+" : "-";

  return `${local.getUTCFullYear()}-${pad(local.getUTCMonth() + 1)}-${pad(local.getUTCDate())} ` +
    `${pad(local.getUTCHours())}:${pad(local.getUTCMinutes())}:${pad(local.getUTCSeconds())}.${pad(local.getUTCMilliseconds(), 3)} ` +
    `${sign}${pad(Math.floor(absoluteOffset / 60))}:${pad(absoluteOffset % 60)}`;
}

export function logConsoleDiagnostic(message: string): void {
  console.error(`[${formatConsoleTimestamp()}] ${message}`);
}

export function consoleHeartbeatMs(env: NodeJS.ProcessEnv = process.env): number {
  const requested = Number(env.CODEXPRO_LOG_HEARTBEAT_MS);
  return Number.isFinite(requested) && requested >= 1_000
    ? Math.max(1_000, Math.min(60_000, Math.floor(requested)))
    : 10_000;
}

export function withConsoleRequest<T>(requestId: string, fn: () => T): T {
  return consoleRequestContext.run({ requestId }, fn);
}

export function currentConsoleRequestId(): string | undefined {
  return consoleRequestContext.getStore()?.requestId;
}

function safeId(value: unknown): string | undefined {
  return typeof value === "string" && /^[A-Za-z0-9_.:-]{1,96}$/.test(value)
    ? value
    : undefined;
}

export function safeToolTask(name: string, args: unknown): string {
  if (!args || typeof args !== "object" || Array.isArray(args)) return "none";
  const input = args as Record<string, unknown>;
  if (name === "bash") {
    if (typeof input.command !== "string") return "unknown";
    const command = input.command.trim();
    // Match a whole command; never log shell fragments, extra flags, inline scripts or paths.
    const script = command.match(/^(npm|pnpm|yarn|bun)\s+(?:run\s+)?([A-Za-z0-9_.:-]{1,80})$/i);
    if (script && /^(?:test|typecheck|lint|build|check|smoke|verify)(?::[A-Za-z0-9_.:-]+)?$/i.test(script[2])) {
      return `${script[1]} run ${script[2]}`;
    }
    return "custom-command";
  }
  if (["run_checks", "start_check", "resume_check"].includes(name)) {
    const checks = input.checks;
    if (Array.isArray(checks)) {
      const safe = checks
        .filter((entry): entry is string =>
          typeof entry === "string" && /^(?:test|typecheck|lint|build|check|smoke|verify)(?::[A-Za-z0-9_.:-]+)?$/.test(entry))
        .slice(0, 5);
      return safe.length === checks.length ? safe.join(",") : "project-checks";
    }
    return "project-checks";
  }
  if (["wait_check", "get_check", "stop_check"].includes(name)) {
    return safeId(input.job_id) ? `job=${input.job_id}` : "job";
  }
  return "none";
}

export function reportCurrentToolProgress(progress: ToolConsoleProgress): void {
  const state = toolContext.getStore();
  if (!state) return;
  if (Number.isInteger(progress.pid) && (progress.pid ?? 0) > 0) state.pid = progress.pid;
  if (typeof progress.outputBytes === "number" && Number.isFinite(progress.outputBytes)) {
    state.outputBytes = progress.outputBytes;
  }
  if (typeof progress.lastOutputAgeMs === "number" && Number.isFinite(progress.lastOutputAgeMs)) {
    state.lastOutputAgeMs = progress.lastOutputAgeMs;
  }
  if (typeof progress.phase === "string" && /^[a-z_]{1,40}$/.test(progress.phase)) {
    state.phase = progress.phase;
  }
}

export function createConsoleToolReporter(
  name: string,
  args: unknown,
  startedAtMs: number,
  requestId?: string,
  env: NodeJS.ProcessEnv = process.env
): {
  run<T>(handler: () => Promise<T> | T): Promise<T>;
  finish(status: "ok" | "error"): void;
} {
  const enabled = env.CODEXPRO_LOG_TOOL_CALLS === "1" || env.CODEXPRO_LOG_REQUESTS === "1";
  if (!enabled) {
    return {
      run: async (handler) => await handler(),
      finish: () => {}
    };
  }

  const state: ToolConsoleState = {
    name,
    startedAtMs,
    requestId: requestId ?? currentConsoleRequestId(),
    task: safeToolTask(name, args)
  };
  const id = `request_id=${state.requestId ?? "unknown"}`;
  logConsoleDiagnostic(`[CodexProTool] ${name} start ${id} task=${state.task}`);
  const timer = setInterval(() => {
    const elapsed = Date.now() - startedAtMs;
    logConsoleDiagnostic(
      `[CodexProTool] ${name} running elapsed_ms=${elapsed} ${id} task=${state.task}` +
      ` phase=${state.phase ?? "executing"} pid=${state.pid ?? "unknown"}` +
      ` output_bytes=${state.outputBytes ?? "unknown"} last_output_age_ms=${state.lastOutputAgeMs ?? "unknown"}`
    );
  }, consoleHeartbeatMs(env));
  timer.unref();

  let finished = false;
  return {
    run: async (handler) => await toolContext.run(state, handler),
    finish: (status) => {
      if (finished) return;
      finished = true;
      clearInterval(timer);
      // Preserve historical "bash ok 1234ms" / "bash error" shape for terminal filters.
      logConsoleDiagnostic(
        `[CodexProTool] ${name} ${status} ${Date.now() - startedAtMs}ms ${id} task=${state.task}` +
        ` pid=${state.pid ?? "unknown"} output_bytes=${state.outputBytes ?? "unknown"}`
      );
    }
  };
}
