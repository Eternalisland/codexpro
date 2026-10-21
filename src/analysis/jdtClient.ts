import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import type { Workspace } from "../guard.js";

export type Position = { line: number; character: number };
export type Range = { start: Position; end: Position };
export type Location = { uri: string; range: Range };
export type DocumentSymbol = { name: string; kind: number; detail?: string; range: Range; selectionRange: Range; children?: DocumentSymbol[] };
export type TypeItem = { name: string; kind: number; uri: string; range: Range; selectionRange: Range; data?: unknown };
export type Launch = { command: string; args: string[]; timeoutMs?: number };
const MAX_MESSAGE = 8 * 1024 * 1024, IDLE_MS = 300_000;
type Pending = { resolve: (v: unknown) => void; reject: (e: Error) => void; timer: ReturnType<typeof setTimeout> };
const clients = new Map<string, Promise<LspClient>>();
const running = new Set<LspClient>();
export const jdtEnabled = () => Boolean(process.env.CODEXPRO_JDTLS_HOME?.trim());

export function jdtLaunch(workspace: Workspace): Launch {
  const home = path.resolve(process.env.CODEXPRO_JDTLS_HOME!.trim());
  const jars = fs.readdirSync(path.join(home, "plugins")).filter(n => /^org\.eclipse\.equinox\.launcher_[\w.-]+\.jar$/.test(n));
  if (jars.length !== 1) throw new Error("JDT LS needs exactly one launcher jar in plugins.");
  const platform = process.platform === "win32" ? "win" : process.platform === "darwin" ? "mac" : "linux";
  const config = path.join(home, "config_" + platform);
  if (!fs.statSync(config).isDirectory()) throw new Error("JDT LS platform config missing.");
  const data = path.join(os.tmpdir(), "codexpro-jdtls-" + createHash("sha256").update(workspace.root).digest("hex").slice(0, 20));
  return { command: process.env.CODEXPRO_JDTLS_JAVA?.trim() || "java",
    args: ["-Declipse.application=org.eclipse.jdt.ls.core.id1", "-Dosgi.bundles.defaultStartLevel=4",
      "-Declipse.product=org.eclipse.jdt.ls.core.product", "-Dlog.level=WARNING", "-Xmx1G",
      "--add-modules=ALL-SYSTEM", "--add-opens", "java.base/java.util=ALL-UNNAMED",
      "--add-opens", "java.base/java.lang=ALL-UNNAMED", "-jar", path.join(home,"plugins",jars[0]),
      "-configuration",config,"-data",data], timeoutMs: 25000 };
}

export class LspClient {
  private child: ChildProcessWithoutNullStreams;
  private next = 1;
  private pending = new Map<number, Pending>();
  private buffer = Buffer.alloc(0);
  private closed = false;
  private idle?: ReturnType<typeof setTimeout>;
  private openFiles = new Map<string, { text: string; version: number }>();
  private serverStatusCode: number | null = null;
  private statusNotifications = 0;
  private readonly activeProgress = new Set<string>();
  private progressNotifications = 0;
  private readonly exited: Promise<void>;
  private constructor(private workspace: Workspace, launch: Launch) {
    this.child = spawn(launch.command, launch.args, { cwd: workspace.root, shell: false, windowsHide: true,
      stdio: ["pipe", "pipe", "pipe"] });
    this.exited = new Promise(resolve => {
      this.child.once("exit", () => resolve());
      this.child.once("error", () => resolve());
    });
    this.child.stdout.on("data", (part: Buffer) => this.receive(part));
    this.child.stderr.on("data", () => {}); // Do not expose arbitrary JVM diagnostics or credentials.
    this.child.on("error", err => this.close(new Error("JDT LS startup failed: " + err.message)));
    this.child.on("exit", code => this.close(new Error("JDT LS exited (" + code + ").")));
    running.add(this);
  }
  static async start(workspace: Workspace, launch: Launch): Promise<LspClient> {
    const client = new LspClient(workspace, launch);
    try {
      await client.request("initialize", {
        processId: process.pid, rootUri: pathToFileURL(workspace.root).href,
        workspaceFolders: [{ uri: pathToFileURL(workspace.root).href, name: path.basename(workspace.root) }],
        capabilities: { workspace: { workspaceFolders: true, configuration: true },
          textDocument: { documentSymbol: { hierarchicalDocumentSymbolSupport: true },
            references: {}, definition: {}, implementation: {}, typeHierarchy: {} } },
        // Eclipse JDT LS also reads workspaceFolders from initializationOptions
        // (the standard InitializeParams workspaceFolders field alone is insufficient).
        initializationOptions: { bundles: [],
          workspaceFolders: [pathToFileURL(workspace.root).href],
          settings: { java: { import: { maven: { enabled: true } } } } }
      }, launch.timeoutMs ?? 25000);
      client.notify("initialized", {});
      return client;
    } catch (error) { client.close(); throw error; }
  }
  isClosed() { return this.closed; }
  diagnostics() {
    // Expose only bounded protocol metadata, never server log messages or source contents.
    return { service_status_code: this.serverStatusCode,
      service_status_notifications: this.statusNotifications,
      progress_notifications: this.progressNotifications,
      active_progress_tokens: this.activeProgress.size };
  }
  private touch() {
    if (this.idle) clearTimeout(this.idle);
    this.idle = setTimeout(() => this.close(), IDLE_MS);
    this.idle.unref();
  }
  private send(payload: unknown) {
    if (this.closed) throw new Error("JDT LS connection closed.");
    const body = Buffer.from(JSON.stringify(payload), "utf8");
    if (body.length > MAX_MESSAGE) throw new Error("LSP outbound message limit exceeded.");
    this.child.stdin.write(Buffer.concat([Buffer.from("Content-Length: " + body.length + "\r\n\r\n"), body]));
    this.touch();
  }
  notify(method: string, params: unknown) { this.send({ jsonrpc: "2.0", method, params }); }
  request<T>(method: string, params: unknown, timeoutMs = 15000): Promise<T> {
    const id = this.next++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        try { this.notify("$/cancelRequest", { id }); } catch { /* closed */ }
        reject(new Error("JDT LS timed out: " + method));
      }, timeoutMs);
      this.pending.set(id, { resolve: value => resolve(value as T), reject, timer });
      try { this.send({ jsonrpc: "2.0", id, method, params }); }
      catch (err) { clearTimeout(timer); this.pending.delete(id); reject(err instanceof Error ? err : new Error(String(err))); }
    });
  }
  private receive(chunk: Buffer) {
    if (this.closed) return;
    this.buffer = Buffer.concat([this.buffer, chunk]);
    if (this.buffer.length > MAX_MESSAGE + 8192) { this.close(new Error("LSP input limit exceeded.")); return; }
    while (true) {
      const split = this.buffer.indexOf("\r\n\r\n");
      if (split < 0) return;
      if (split > 8192) { this.close(new Error("Invalid LSP header.")); return; }
      const match = /(?:^|\r\n)Content-Length:\s*(\d+)/i.exec(this.buffer.subarray(0, split).toString("ascii"));
      const size = match ? Number(match[1]) : -1;
      if (!Number.isSafeInteger(size) || size < 0 || size > MAX_MESSAGE) {
        this.close(new Error("Invalid LSP frame length.")); return;
      }
      const end = split + 4 + size;
      if (this.buffer.length < end) return;
      const body = this.buffer.subarray(split + 4, end);
      this.buffer = this.buffer.subarray(end);
      try { this.message(JSON.parse(body.toString("utf8"))); }
      catch { this.close(new Error("Invalid LSP response.")); return; }
    }
  }
  private message(msg: Record<string, unknown>) {
    if (typeof msg.id === "number" && ("result" in msg || "error" in msg)) {
      const item = this.pending.get(msg.id);
      if (!item) return;
      clearTimeout(item.timer); this.pending.delete(msg.id);
      if (msg.error) item.reject(new Error("JDT LS returned an error."));
      else item.resolve(msg.result);
    } else if (msg.id === undefined && msg.method === "language/status") {
      const params = msg.params as { type?: unknown } | undefined;
      this.statusNotifications++;
      if (typeof params?.type === "number" && Number.isInteger(params.type))
        this.serverStatusCode = params.type;
    } else if (msg.id === undefined && msg.method === "$/progress") {
      this.progressNotifications++;
      const params = msg.params as { token?: unknown; value?: { kind?: unknown } } | undefined;
      if (typeof params?.token === "string" || typeof params?.token === "number") {
        const token = String(params.token);
        if (params.value?.kind === "end") this.activeProgress.delete(token);
        else if (params.value?.kind === "begin" && this.activeProgress.size < 64)
          this.activeProgress.add(token);
      }
    } else if (msg.id !== undefined && typeof msg.method === "string") {
      let result: unknown = null;
      if (msg.method === "workspace/configuration") {
        const p = msg.params as { items?: unknown[] } | undefined;
        result = (p?.items ?? []).map(() => ({}));
      }
      this.send({ jsonrpc: "2.0", id: msg.id, result });
    }
  }
  close(err: Error = new Error("JDT LS connection closed.")) {
    if (this.closed) return;
    this.closed = true; if (this.idle) clearTimeout(this.idle);
    for (const p of this.pending.values()) { clearTimeout(p.timer); p.reject(err); }
    this.pending.clear(); running.delete(this);
    this.child.kill();
  }
  async closeAndWait() {
    this.close();
    await this.exited;
  }
  async document(abs: string, text: string) {
    const uri = pathToFileURL(abs).href, prior = this.openFiles.get(uri);
    if (!prior) {
      this.openFiles.set(uri, { text, version: 1 });
      this.notify("textDocument/didOpen", { textDocument: { uri, languageId: "java", version: 1, text } });
    } else if (prior.text !== text) {
      const version = prior.version + 1;
      this.openFiles.set(uri, { text, version });
      this.notify("textDocument/didChange", { textDocument: { uri, version }, contentChanges: [{ text }] });
    }
    return uri;
  }
}
export async function getJdtClient(workspace: Workspace, injectedLaunch?: Launch): Promise<LspClient> {
  if (!injectedLaunch && !jdtEnabled()) throw new Error("JDT LS disabled: set CODEXPRO_JDTLS_HOME.");
  const key = workspace.root + "\0" + (process.env.CODEXPRO_JDTLS_HOME || (injectedLaunch ? JSON.stringify(injectedLaunch) : ""));
  const current = clients.get(key);
  if (current) {
    try { const client = await current; if (!client.isClosed()) return client; }
    catch { /* retry */ }
    clients.delete(key);
  }
  const created = LspClient.start(workspace, injectedLaunch ?? jdtLaunch(workspace));
  clients.set(key, created);
  try { return await created; }
  catch (err) { if (clients.get(key) === created) clients.delete(key); throw err; }
}
export function closeJdtClients() {
  for (const client of running) client.close();
  clients.clear();
}
export async function shutdownJdtClients() {
  const closing = [...running].map(client => client.closeAndWait());
  clients.clear();
  await Promise.all(closing);
}
