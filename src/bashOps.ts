import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { analyse } from "chardet";
import iconv from "iconv-lite";
import type { BashRuntime, CodexProConfig } from "./config.js";
import type { Workspace } from "./guard.js";
import { CodexProError, PathGuard } from "./guard.js";
import { redactSensitiveText } from "./redact.js";

export interface BashProcessInfo {
  pid: number;
  processGroupId?: number;
  startedAt: string;
}

export interface BashOutputEvent {
  stream: "stdout" | "stderr";
  text: string;
  chunkBytes: number;
  observedOutputBytes: number;
  elapsedMs: number;
}

export interface BashRuntimeEvent {
  pid?: number;
  elapsedMs: number;
  observedOutputBytes: number;
  stdoutBytes: number;
  stderrBytes: number;
  lastOutputAt?: string;
  lastOutputAgeMs?: number;
  outputLimitExceeded: boolean;
  timedOut: boolean;
  cancelled: boolean;
  terminationStarted: boolean;
  childExited: boolean;
  childExitElapsedMs?: number;
}

export interface BashRunOptions {
  cwd?: string;
  timeoutMs?: number;
  sessionId?: string;
  signal?: AbortSignal;
  progressIntervalMs?: number;
  onProcessStart?: (process: BashProcessInfo) => void | Promise<void>;
  onProcessExit?: (process: BashProcessInfo) => void | Promise<void>;
  onOutput?: (event: BashOutputEvent) => void | Promise<void>;
  onProgress?: (event: BashRuntimeEvent) => void | Promise<void>;
}

export interface BashResult {
  command: string;
  cwd: string;
  ok: boolean;
  status: "passed" | "failed" | "timed_out" | "cancelled";
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  durationMs: number;
  stdout: string;
  stderr: string;
  truncated: boolean;
  timedOut: boolean;
  cancelled: boolean;
  outputLimitExceeded: boolean;
  observedOutputBytes: number;
  bashRuntime: BashRuntime;
  bashExecutable: string;
  bashSessionId?: string;
}

const SAFE_ALLOWED_PREFIXES = [
  "pwd",
  "ls",
  "find",
  "git status",
  "git diff",
  "git log",
  "git show",
  "git branch",
  "git rev-parse",
  "git ls-files",
  "git --version",
  "node --version",
  "npm --version",
  "npx --version",
  "rg --version",
  "command -v",
  "npm test",
  "npm run test",
  "npm run typecheck",
  "npm run lint",
  "npm run build",
  "npm run check",
  "pnpm test",
  "pnpm run test",
  "pnpm run typecheck",
  "pnpm run lint",
  "pnpm run build",
  "pnpm run check",
  "yarn test",
  "yarn run test",
  "yarn run typecheck",
  "yarn run lint",
  "yarn run build",
  "yarn run check",
  "bun test",
  "bun run test",
  "bun run typecheck",
  "bun run lint",
  "bun run build",
  "pytest",
  "python -m pytest",
  "python3 -m pytest",
  "uv run pytest",
  "go test",
  "cargo test",
  "cargo check",
  "cargo clippy",
  "tsc",
  "npx tsc",
  "eslint",
  "npx eslint",
  "biome check",
  "npx biome check"
];

const SAFE_BLOCKED_PATTERNS = [
  /(^|\s)rm\s+/,
  /(^|\s)mv\s+/,
  /(^|\s)cp\s+/,
  /(^|\s)dd\s+/,
  /(^|\s)sudo\s+/,
  /(^|\s)chmod\s+/,
  /(^|\s)chown\s+/,
  /(^|\s)kill\s+/,
  /(^|\s)pkill\s+/,
  /(^|\s)curl\s+/,
  /(^|\s)wget\s+/,
  /(^|\s)ssh\s+/,
  /(^|\s)scp\s+/,
  /(^|\s)rsync\s+/,
  /(^|\s)docker\s+/,
  /(^|\s)podman\s+/,
  /(^|\s)git\s+push\b/,
  /(^|\s)git\s+reset\b/,
  /(^|\s)git\s+clean\b/,
  /(^|\s)git\s+checkout\b/,
  /(^|\s)git\s+switch\b/,
  /(^|\s)git\s+restore\b/,
  /(^|\s)(npm|pnpm|yarn)\s+publish\b/,
  /(^|\s)--no-index\b/,
  /(^|\s)--fix\b/,
  /(^|\s)(\/|~(?:\/|\s|$))/,
  /(^|\s)\.\.(?:\/|\s|$)/,
  /\$/,
  /(^|[\s:])(?:\.env(?:[./\s:]|$)|\.git(?:[\/\s:]|$)|node_modules(?:[\/\s:]|$)|\.ssh(?:[\/\s:]|$)|id_rsa(?:[.\s:]|$)|id_ed25519(?:[.\s:]|$)|[^\s:]*\.(?:pem|key)(?:[\s:]|$))/,
  /(^|\s)['"]?-exec(?:['"]|\s|$)/,
  /(^|\s)['"]?-execdir(?:['"]|\s|$)/,
  /(^|\s)['"]?-delete(?:['"]|\s|$)/,
  /(^|\s)['"]?-ok(?:['"]|\s|$)/,
  /(^|\s)['"]?-okdir(?:['"]|\s|$)/,
  /(^|\s)['"]?-fprint0?(?:['"]|\s|$)/,
  /(^|\s)['"]?-fprintf(?:['"]|\s|$)/,
  /(^|\s)['"]?-fls(?:['"]|\s|$)/,
  /(^|\s)['"]?--output(?:=|['"]|\s|$)/,
  /(^|\s)(sed|perl)\s+.*(^|\s)-i(\s|$)/,
  /(^|\s)(cat|grep|rg|head|tail|wc)\s+/,
  /[;&|<>`]/,
  /[\r\n]/
];

const SAFE_DIAGNOSTIC_COMMANDS = new Set([
  "node --version",
  "npm --version",
  "npx --version",
  "git --version",
  "rg --version"
]);

function compact(command: string): string {
  return command.trim().replace(/\s+/g, " ");
}

function startsWithAllowedPrefix(command: string): boolean {
  const normalized = compact(command);
  return isAllowedPackageScript(normalized) || SAFE_ALLOWED_PREFIXES.some((prefix) => normalized === prefix || normalized.startsWith(`${prefix} `));
}

function isAllowedPackageScript(command: string): boolean {
  const packageScriptPattern =
    /^(?:npm|pnpm|yarn|bun)\s+run\s+(?:test|typecheck|lint|build|check|smoke|verify)(?::[A-Za-z0-9._-]+)*(?:\s+--\s+[A-Za-z0-9._:= -]+)?$/;
  return packageScriptPattern.test(command);
}

function assertSafeCommand(config: CodexProConfig, command: string): void {
  if (config.bashMode === "off") {
    throw new CodexProError("bash tool is disabled. Start with CODEXPRO_BASH_MODE=safe or CODEXPRO_BASH_MODE=full to enable it.");
  }
  if (config.bashMode === "full") return;

  const raw = command.trim();
  const normalized = compact(command);
  if (SAFE_DIAGNOSTIC_COMMANDS.has(normalized)) return;
  for (const pattern of SAFE_BLOCKED_PATTERNS) {
    if (pattern.test(raw) || pattern.test(normalized)) {
      throw new CodexProError(
        `Command is blocked in CODEXPRO_BASH_MODE=safe: ${normalized}\n` +
          "Use separate read/search/git tools, or restart with CODEXPRO_BASH_MODE=full only for trusted repos."
      );
    }
  }
  if (!startsWithAllowedPrefix(normalized)) {
    throw new CodexProError(
      `Command is not in the safe bash allowlist: ${normalized}\n` +
        "Allowed examples: ls, find, git status, git diff, npm test, npm run typecheck, npm run build:clients, pytest, go test, cargo test. Use read/search tools for file contents. " +
        "Use CODEXPRO_BASH_MODE=full for trusted local automation."
    );
  }
}

function assertBashSession(config: CodexProConfig, sessionId?: string): string | undefined {
  const requested = sessionId?.trim();
  if (!config.bashSessionId) {
    if (config.requireBashSession) {
      throw new CodexProError("bash session guard is enabled but no server bash session id is configured.");
    }
    return undefined;
  }
  if (!requested) {
    if (config.requireBashSession) {
      throw new CodexProError(`bash session id is required. Retry with session_id="${config.bashSessionId}".`);
    }
    return config.bashSessionId;
  }
  if (requested !== config.bashSessionId) {
    throw new CodexProError(`bash session id mismatch. This CodexPro server accepts session_id="${config.bashSessionId}".`);
  }
  return config.bashSessionId;
}

function isUsableAbsoluteDir(candidate: string | undefined): string | undefined {
  if (!candidate) return undefined;
  const trimmed = candidate.trim();
  if (!trimmed) return undefined;
  if (!path.isAbsolute(trimmed) && !path.win32.isAbsolute(trimmed)) return undefined;
  try {
    const resolved = path.resolve(trimmed);
    if (fs.existsSync(resolved) && fs.statSync(resolved).isDirectory()) return resolved;
  } catch {
    // Ignore unreadable candidates and keep searching.
  }
  return undefined;
}

/** Resolve a usable absolute home for restricted child processes. Rejects relative junk like "=". */
export function resolveUsableHomeDir(env: NodeJS.ProcessEnv = process.env): string {
  return (
    isUsableAbsoluteDir(env.USERPROFILE) ??
    isUsableAbsoluteDir(env.HOME) ??
    isUsableAbsoluteDir(os.homedir()) ??
    path.resolve(os.homedir())
  );
}

export function makeRestrictedBashEnv(
  config: CodexProConfig,
  env: NodeJS.ProcessEnv = process.env
): NodeJS.ProcessEnv {
  if (config.inheritEnv) {
    return { ...env, NO_COLOR: "1", CI: env.CI ?? "1" };
  }
  const home = resolveUsableHomeDir(env);
  const restricted: NodeJS.ProcessEnv = {
    PATH: env.PATH ?? "/usr/local/bin:/usr/bin:/bin",
    HOME: home,
    USER: env.USER ?? env.USERNAME ?? "",
    SHELL: env.SHELL ?? "/bin/bash",
    TMPDIR: isUsableAbsoluteDir(env.TMPDIR) ?? isUsableAbsoluteDir(env.TMP) ?? os.tmpdir(),
    TERM: "dumb",
    NO_COLOR: "1",
    CI: "1"
  };
  if (process.platform === "win32") {
    restricted.USERPROFILE = home;
    const appData = isUsableAbsoluteDir(env.APPDATA);
    const localAppData = isUsableAbsoluteDir(env.LOCALAPPDATA);
    if (appData) restricted.APPDATA = appData;
    if (localAppData) restricted.LOCALAPPDATA = localAppData;
    if (env.USERNAME) restricted.USERNAME = env.USERNAME;
    if (env.HOMEDRIVE && env.HOMEPATH && path.win32.isAbsolute(path.win32.join(env.HOMEDRIVE, env.HOMEPATH))) {
      restricted.HOMEDRIVE = env.HOMEDRIVE;
      restricted.HOMEPATH = env.HOMEPATH;
    }
  }
  return restricted;
}

function makeEnv(config: CodexProConfig): NodeJS.ProcessEnv {
  return makeRestrictedBashEnv(config);
}

export interface BashInvocation {
  runtime: BashRuntime;
  executable: string;
  args: (command: string) => string[];
  source: "configured" | "git-for-windows" | "path" | "system";
}

export interface BashRuntimeStatus {
  configured_runtime: BashRuntime;
  selected_runtime?: BashRuntime;
  executable?: string;
  source?: BashInvocation["source"];
  available: boolean;
  reason?: string;
}

type BashResolverOptions = {
  platform?: NodeJS.Platform;
  env?: NodeJS.ProcessEnv;
  exists?: (candidate: string) => boolean;
  pathCommands?: (command: string) => string[];
};

function commandPathCandidates(command: string, env: NodeJS.ProcessEnv, platform: NodeJS.Platform): string[] {
  if (platform !== "win32") return [];
  try {
    const result = spawnSync("where.exe", [command], {
      encoding: "utf8",
      env,
      stdio: ["ignore", "pipe", "ignore"],
      windowsHide: true
    });
    if (result.status !== 0 || typeof result.stdout !== "string") return [];
    return result.stdout.split(/\r?\n/).map((item) => item.trim()).filter(Boolean);
  } catch {
    return [];
  }
}

function isWslLauncher(candidate: string): boolean {
  const normalized = candidate.replaceAll("/", "\\").toLowerCase();
  return normalized.endsWith("\\windows\\system32\\bash.exe") ||
    normalized.endsWith("\\windows\\system32\\wsl.exe") ||
    normalized.endsWith("\\wsl.exe") ||
    normalized === "wsl.exe" ||
    normalized === "bash.exe" && normalized.includes("system32");
}

function windowsGitBashCandidates(env: NodeJS.ProcessEnv): string[] {
  const roots = [env.ProgramW6432, env.ProgramFiles, env["ProgramFiles(x86)"], "C:\\Program Files", "C:\\Program Files (x86)"]
    .filter((value): value is string => Boolean(value));
  const candidates: string[] = [];
  for (const root of roots) {
    candidates.push(path.win32.join(root, "Git", "bin", "bash.exe"));
    candidates.push(path.win32.join(root, "Git", "usr", "bin", "bash.exe"));
  }
  return [...new Set(candidates)];
}

function usableExecutable(candidate: string | undefined, exists: (value: string) => boolean): string | undefined {
  const trimmed = candidate?.trim();
  if (!trimmed) return undefined;
  try {
    return exists(trimmed) ? trimmed : undefined;
  } catch {
    return undefined;
  }
}

export function resolveBashInvocation(config: CodexProConfig, options: BashResolverOptions = {}): BashInvocation {
  const platform = options.platform ?? process.platform;
  const env = options.env ?? process.env;
  const exists = options.exists ?? fs.existsSync;
  const pathCommands = options.pathCommands ?? ((command: string) => commandPathCandidates(command, env, platform));

  if (platform !== "win32") {
    const executable = config.bashExecutable?.trim() || (fs.existsSync("/bin/bash") ? "/bin/bash" : "bash");
    return {
      runtime: config.bashRuntime === "wsl" ? "wsl" : "native-bash",
      executable,
      args: (command) => ["-lc", command],
      source: config.bashExecutable ? "configured" : "system"
    };
  }

  if (config.bashRuntime === "wsl") {
    const configured = usableExecutable(config.bashExecutable, exists);
    const executable = configured ?? pathCommands("wsl.exe")[0] ?? "wsl.exe";
    const wsl = /(?:^|[\\/])wsl(?:\.exe)?$/i.test(executable);
    return {
      runtime: "wsl",
      executable,
      args: (command) => wsl ? ["--exec", "bash", "-lc", command] : ["-lc", command],
      source: configured ? "configured" : "path"
    };
  }

  if (config.bashExecutable && isWslLauncher(config.bashExecutable)) {
    throw new CodexProError(
      "CODEXPRO_BASH_EXECUTABLE points to the Windows WSL launcher. Set CODEXPRO_BASH_RUNTIME=wsl to opt into WSL, or point it to Git for Windows Bash (for example ...\\Git\\bin\\bash.exe)."
    );
  }

  const configured = usableExecutable(config.bashExecutable, exists);
  if (config.bashExecutable && !configured) {
    throw new CodexProError(`Configured Bash executable was not found: ${config.bashExecutable}`);
  }
  if (configured) {
    return { runtime: "native-bash", executable: configured, args: (command) => ["-lc", command], source: "configured" };
  }

  const native = [...windowsGitBashCandidates(env), ...pathCommands("bash.exe")]
    .find((candidate) => !isWslLauncher(candidate) && usableExecutable(candidate, exists));
  if (native) {
    return { runtime: "native-bash", executable: native, args: (command) => ["-lc", command], source: native.includes("\\Git\\") ? "git-for-windows" : "path" };
  }

  throw new CodexProError(
    "No native Bash executable was found on Windows. Install Git for Windows, set CODEXPRO_BASH_EXECUTABLE to its bash.exe, or set CODEXPRO_BASH_RUNTIME=wsl to explicitly use WSL."
  );
}

export function bashRuntimeStatus(config: CodexProConfig, options: BashResolverOptions = {}): BashRuntimeStatus {
  try {
    const invocation = resolveBashInvocation(config, options);
    return {
      configured_runtime: config.bashRuntime,
      selected_runtime: invocation.runtime,
      executable: invocation.executable,
      source: invocation.source,
      available: true
    };
  } catch (error) {
    return {
      configured_runtime: config.bashRuntime,
      available: false,
      reason: error instanceof Error ? error.message : String(error)
    };
  }
}

function trimOutput(value: string, maxBytes: number): { value: string; truncated: boolean } {
  const buffer = Buffer.from(value, "utf8");
  if (buffer.byteLength <= maxBytes) return { value, truncated: false };
  const sliced = buffer.subarray(0, maxBytes).toString("utf8");
  return { value: `${sliced}\n...[output truncated to ${maxBytes} bytes]`, truncated: true };
}

export type BashEncodingCandidate = { name: string; confidence: number };
export type BashEncodingDetector = (input: Buffer) => BashEncodingCandidate[];

function likelyWindowsGbk(bytes: Buffer): boolean {
  let doubleBytePairs = 0;
  for (let i = 0; i + 1 < bytes.length; i += 1) {
    const lead = bytes[i];
    const trail = bytes[i + 1];
    if (lead >= 0x81 && lead <= 0xfe && trail >= 0x40 && trail <= 0xfe && trail !== 0x7f) {
      doubleBytePairs += 1;
      i += 1;
    }
  }
  if (!doubleBytePairs) return false;
  const decoded = iconv.decode(bytes, "gb18030");
  const cjkCharacters = (decoded.match(/[\u3400-\u9fff]/g) ?? []).length;
  return cjkCharacters >= doubleBytePairs && !decoded.includes("�");
}

export function decodeBashOutput(
  bytes: Buffer,
  platform: NodeJS.Platform = process.platform,
  allowTrailingIncompleteUtf8 = false,
  detect: BashEncodingDetector = analyse
): string {
  const utf8Fallback = () => bytes.toString("utf8");
  if (platform !== "win32" || bytes.length === 0) return utf8Fallback();

  if (bytes.length >= 3 && bytes.subarray(0, 3).equals(Buffer.from([0xef, 0xbb, 0xbf]))) {
    return bytes.subarray(3).toString("utf8");
  }
  if (bytes.length >= 2 && bytes.subarray(0, 2).equals(Buffer.from([0xff, 0xfe]))) {
    return iconv.decode(bytes, "utf-16le");
  }
  if (bytes.length >= 2 && bytes.subarray(0, 2).equals(Buffer.from([0xfe, 0xff]))) {
    return iconv.decode(bytes, "utf-16be");
  }

  if (bytes.length >= 4 && bytes.length % 2 === 0) {
    let oddNuls = 0;
    let evenNuls = 0;
    for (let i = 0; i < bytes.length; i += 2) {
      if (bytes[i] === 0) evenNuls += 1;
      if (bytes[i + 1] === 0) oddNuls += 1;
    }
    const threshold = Math.max(2, Math.floor(bytes.length / 8));
    if (oddNuls >= threshold && oddNuls > evenNuls * 2) return iconv.decode(bytes, "utf-16le");
    if (evenNuls >= threshold && evenNuls > oddNuls * 2) return iconv.decode(bytes, "utf-16be");
  }

  try {
    new TextDecoder("utf-8", { fatal: true }).decode(bytes, { stream: allowTrailingIncompleteUtf8 });
    return utf8Fallback();
  } catch {
    // Try a high-confidence legacy encoding only after strict UTF-8 validation fails.
  }

  try {
    const candidate = detect(bytes)[0];
    if (candidate && candidate.confidence >= 80 && iconv.encodingExists(candidate.name)) {
      return iconv.decode(bytes, candidate.name);
    }
    // Short Windows console output is often GBK/CP936 but does not contain enough
    // language data for chardet to reach a useful confidence score.
    if (likelyWindowsGbk(bytes)) return iconv.decode(bytes, "gb18030");
    return utf8Fallback();
  } catch {
    return utf8Fallback();
  }
}

function windowsDescendantPids(rootPid: number): number[] {
  if (process.platform !== "win32" || !Number.isInteger(rootPid) || rootPid <= 0) return [];
  const script = [
    `$root=${rootPid}`,
    "$items=Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId",
    "$pending=@($root)",
    "$seen=@{}",
    "$out=@()",
    "while($pending.Count -gt 0){$p=$pending[0];if($pending.Count -eq 1){$pending=@()}else{$pending=$pending[1..($pending.Count-1)]};foreach($x in $items){if($x.ParentProcessId -eq $p -and -not $seen.ContainsKey([string]$x.ProcessId)){$seen[[string]$x.ProcessId]=$true;$out+=@([int]$x.ProcessId);$pending+=@([int]$x.ProcessId)}}}",
    "$out | ConvertTo-Json -Compress"
  ].join(";");
  try {
    const result = spawnSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 4_000,
      windowsHide: true
    });
    if (result.status !== 0 || typeof result.stdout !== "string" || !result.stdout.trim()) return [];
    const parsed = JSON.parse(result.stdout);
    const values = Array.isArray(parsed) ? parsed : [parsed];
    return values
      .map((value) => Number(value))
      .filter((value) => Number.isInteger(value) && value > 0 && value !== rootPid);
  } catch {
    return [];
  }
}

function terminateProcessTree(child: ChildProcess, signal: NodeJS.Signals): void {
  if (!child.pid) return;
  if (process.platform === "win32") {
    // Snapshot descendants before killing the root. Git Bash/npm can let descendants outlive
    // the shell long enough to keep inherited stdout/stderr pipes open, delaying "close".
    // Kill deepest descendants first, then the root tree.
    const descendants = windowsDescendantPids(child.pid).reverse();
    for (const pid of descendants) {
      spawnSync("taskkill", ["/pid", String(pid), "/t", "/f"], {
        stdio: "ignore",
        windowsHide: true
      });
    }
    const result = spawnSync("taskkill", ["/pid", String(child.pid), "/t", "/f"], {
      stdio: "ignore",
      windowsHide: true
    });
    if (result.status !== 0) child.kill(signal);
    return;
  }
  try {
    process.kill(-child.pid, signal);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ESRCH") child.kill(signal);
  }
}

export async function runBash(
  config: CodexProConfig,
  guard: PathGuard,
  workspace: Workspace,
  command: string,
  options: BashRunOptions = {}
): Promise<BashResult> {
  if (!command?.trim()) throw new CodexProError("command is required.");
  const bashSessionId = assertBashSession(config, options.sessionId);
  assertSafeCommand(config, command);
  const cwdResolved = guard.resolve(workspace, options.cwd ?? ".");
  const cwd = cwdResolved.absPath;
  const invocation = resolveBashInvocation(config);
  const timeoutMs = Math.max(1_000, Math.min(options.timeoutMs ?? 30_000, config.maxBashTimeoutMs));
  const start = Date.now();
  if (options.signal?.aborted) {
    return {
      command,
      cwd: path.relative(workspace.root, cwd) || ".",
      ok: false,
      status: "cancelled",
      exitCode: null,
      signal: null,
      durationMs: 0,
      stdout: "",
      stderr: "[codexpro] Command cancelled before start.",
      truncated: false,
      timedOut: false,
      cancelled: true,
      outputLimitExceeded: false,
      observedOutputBytes: 0,
      bashRuntime: invocation.runtime,
      bashExecutable: invocation.executable,
      ...(bashSessionId ? { bashSessionId } : {})
    };
  }

  return new Promise((resolve, reject) => {
    const child = spawn(invocation.executable, invocation.args(command), {
      cwd,
      env: makeEnv(config),
      stdio: ["ignore", "pipe", "pipe"],
      // Give every verification shell its own process group. This makes crash ownership explicit
      // on every platform while timeout/cancel still terminate the full tree via terminateProcessTree().
      detached: true,
      windowsHide: true
    });

    // Surface the shell PID/process-group to managed checks so restart recovery can distinguish
    // a dead validation from one that is still running after the CodexPro parent disappears.
    const processInfo: BashProcessInfo | undefined = child.pid
      ? {
          pid: child.pid,
          ...(process.platform !== "win32" ? { processGroupId: child.pid } : {}),
          startedAt: new Date().toISOString()
        }
      : undefined;
    if (processInfo) void Promise.resolve(options.onProcessStart?.(processInfo)).catch(() => {});

    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];
    let stdoutPending = Buffer.alloc(0);
    let stderrPending = Buffer.alloc(0);
    let liveOutputBytes = 0;
    let liveOutputSuppressed = false;
    let killedByTimeout = false;
    let killedByAbort = false;
    let outputLimitExceeded = false;
    let closed = false;
    let terminationStarted = false;
    let killTimer: NodeJS.Timeout | undefined;
    let observedOutputBytes = 0;
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let lastOutputAtMs: number | undefined;
    let childExited = false;
    let childExitElapsedMs: number | undefined;
    const retainedOutputBytes = config.maxOutputBytes;

    const terminate = (signal: NodeJS.Signals) => {
      if (closed) return;
      terminationStarted = true;
      terminateProcessTree(child, signal);
    };
    const terminateWithEscalation = () => {
      if (terminationStarted || closed) return;
      terminate("SIGTERM");
      killTimer = setTimeout(() => terminate("SIGKILL"), 1_500);
      killTimer.unref();
    };
    // Output limits bound what MCP retains; they must not terminate a test whose exit code is still needed for diagnosis.
    let retainedBytes = 0;
    const appendBounded = (chunks: Buffer[], chunk: Buffer) => {
      const remaining = retainedOutputBytes - retainedBytes;
      if (remaining <= 0) return;
      const retained = chunk.subarray(0, remaining);
      chunks.push(retained);
      retainedBytes += retained.byteLength;
    };

    const emitLiveLine = (stream: "stdout" | "stderr", line: Buffer) => {
      if (!options.onOutput || liveOutputSuppressed || line.length === 0) return;
      if (liveOutputBytes + line.byteLength > retainedOutputBytes) {
        liveOutputSuppressed = true;
        return;
      }
      liveOutputBytes += line.byteLength;
      const text = redactSensitiveText(decodeBashOutput(line, process.platform, false));
      if (!text) return;
      void Promise.resolve(
        options.onOutput({
          stream,
          text,
          chunkBytes: line.byteLength,
          observedOutputBytes,
          elapsedMs: Date.now() - start
        })
      ).catch(() => {});
    };

    // Keep a whole line until redaction so a token split across stdout chunks is never emitted piecemeal.
    const processLiveChunk = (stream: "stdout" | "stderr", chunk: Buffer, flush = false) => {
      if (!options.onOutput || liveOutputSuppressed) return;
      let pending = Buffer.concat([stream === "stdout" ? stdoutPending : stderrPending, chunk]);
      let offset = 0;
      while (true) {
        const newline = pending.indexOf(0x0a, offset);
        if (newline < 0) break;
        emitLiveLine(stream, pending.subarray(offset, newline + 1));
        offset = newline + 1;
        if (liveOutputSuppressed) break;
      }
      pending = liveOutputSuppressed ? Buffer.alloc(0) : pending.subarray(offset);
      if (flush && pending.length > 0) {
        emitLiveLine(stream, pending);
        pending = Buffer.alloc(0);
      } else if (pending.length > retainedOutputBytes) {
        // An extremely long unterminated line cannot be safely redacted incrementally.
        liveOutputSuppressed = true;
        pending = Buffer.alloc(0);
      }
      if (stream === "stdout") stdoutPending = pending;
      else stderrPending = pending;
    };

    const observeChunk = (stream: "stdout" | "stderr", chunks: Buffer[], chunk: Buffer) => {
      observedOutputBytes += chunk.byteLength;
      if (stream === "stdout") stdoutBytes += chunk.byteLength;
      else stderrBytes += chunk.byteLength;
      lastOutputAtMs = Date.now();
      if (observedOutputBytes > config.maxOutputBytes) outputLimitExceeded = true;
      appendBounded(chunks, chunk);
      processLiveChunk(stream, chunk);
    };

    const emitProgress = () => {
      if (!options.onProgress) return;
      const now = Date.now();
      void Promise.resolve(
        options.onProgress({
          ...(processInfo?.pid ? { pid: processInfo.pid } : {}),
          elapsedMs: now - start,
          observedOutputBytes,
          stdoutBytes,
          stderrBytes,
          ...(lastOutputAtMs
            ? {
                lastOutputAt: new Date(lastOutputAtMs).toISOString(),
                lastOutputAgeMs: Math.max(0, now - lastOutputAtMs)
              }
            : {}),
          outputLimitExceeded,
          timedOut: killedByTimeout,
          cancelled: killedByAbort,
          terminationStarted,
          childExited,
          ...(childExitElapsedMs !== undefined ? { childExitElapsedMs } : {})
        })
      ).catch(() => {});
    };
    const progressIntervalMs = Math.max(1_000, Math.min(options.progressIntervalMs ?? 5_000, 30_000));
    const progressTimer = options.onProgress ? setInterval(emitProgress, progressIntervalMs) : undefined;
    progressTimer?.unref();

    const timer = setTimeout(() => {
      killedByTimeout = true;
      terminateWithEscalation();
      emitProgress();
    }, timeoutMs);
    timer.unref();
    const abort = () => {
      killedByAbort = true;
      terminateWithEscalation();
      emitProgress();
    };
    options.signal?.addEventListener("abort", abort, { once: true });

    child.stdout.on("data", (chunk) => {
      observeChunk("stdout", stdoutChunks, Buffer.from(chunk));
    });
    child.stderr.on("data", (chunk) => {
      observeChunk("stderr", stderrChunks, Buffer.from(chunk));
    });
    child.on("exit", () => {
      childExited = true;
      childExitElapsedMs = Date.now() - start;
      emitProgress();

      if (terminationStarted) {
        // On Windows/Git Bash a terminated shell can exit while a descendant still holds an
        // inherited stdout/stderr handle. Waiting for Node's "close" would then block until that
        // descendant exits naturally. The command is already timed out/cancelled, so flush what
        // we have and close our pipe ends after the process-tree termination attempt.
        processLiveChunk("stdout", Buffer.alloc(0), true);
        processLiveChunk("stderr", Buffer.alloc(0), true);
        child.stdout.destroy();
        child.stderr.destroy();
      }
    });
    child.on("error", (error) => {
      closed = true;
      processLiveChunk("stdout", Buffer.alloc(0), true);
      processLiveChunk("stderr", Buffer.alloc(0), true);
      if (progressTimer) clearInterval(progressTimer);
      if (processInfo) void Promise.resolve(options.onProcessExit?.(processInfo)).catch(() => {});
      options.signal?.removeEventListener("abort", abort);
      clearTimeout(timer);
      if (killTimer) clearTimeout(killTimer);
      reject(error);
    });
    child.on("close", (exitCode, signal) => {
      processLiveChunk("stdout", Buffer.alloc(0), true);
      processLiveChunk("stderr", Buffer.alloc(0), true);
      emitProgress();
      if (progressTimer) clearInterval(progressTimer);
      // Clear persisted process ownership as soon as the controlled shell exits.
      if (processInfo) void Promise.resolve(options.onProcessExit?.(processInfo)).catch(() => {});
      closed = true;
      options.signal?.removeEventListener("abort", abort);
      clearTimeout(timer);
      if (killTimer) clearTimeout(killTimer);
      const allowTrailingIncompleteUtf8 = killedByAbort || killedByTimeout || outputLimitExceeded;
      const stdout = decodeBashOutput(Buffer.concat(stdoutChunks), process.platform, allowTrailingIncompleteUtf8);
      let stderr = decodeBashOutput(Buffer.concat(stderrChunks), process.platform, allowTrailingIncompleteUtf8);
      if (killedByAbort) {
        stderr += "\n[codexpro] Command cancelled.";
      } else if (killedByTimeout) {
        stderr += `\n[codexpro] Command timed out after ${timeoutMs} ms.`;
      }
      const out = trimOutput(redactSensitiveText(stdout), config.maxOutputBytes);
      const err = trimOutput(redactSensitiveText(stderr), config.maxOutputBytes);
      const ok = !killedByAbort && !killedByTimeout && exitCode === 0 && signal === null;
      resolve({
        command,
        cwd: path.relative(workspace.root, cwd) || ".",
        ok,
        status: killedByAbort ? "cancelled" : killedByTimeout ? "timed_out" : ok ? "passed" : "failed",
        exitCode,
        signal,
        durationMs: Date.now() - start,
        stdout: out.value,
        stderr: err.value,
        truncated: outputLimitExceeded || out.truncated || err.truncated,
        timedOut: killedByTimeout,
        cancelled: killedByAbort,
        outputLimitExceeded,
        observedOutputBytes,
        bashRuntime: invocation.runtime,
        bashExecutable: invocation.executable,
        ...(bashSessionId ? { bashSessionId } : {})
      });
    });
  });
}
