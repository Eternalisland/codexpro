import { AsyncLocalStorage } from "node:async_hooks";
import { createHash, randomBytes } from "node:crypto";
import fsp from "node:fs/promises";
import path from "node:path";
import { redactSensitiveText, redactStructured } from "./redact.js";

export type ProtocolTraceMode = "off" | "meta" | "redacted" | "full";

export interface ProtocolTraceConfig {
  mode: ProtocolTraceMode;
  dir: string;
  maxBodyBytes: number;
  maxFileBytes: number;
  retentionDays: number;
}

export interface ProtocolTraceContext {
  traceId: string;
  requestId: string;
  jsonrpcId?: string | number | null;
  mcpMethod?: string;
  tool?: string;
  mcpSession?: string;
  transport: "http" | "stdio";
  httpMethod?: string;
  startedAtMs: number;
}

export interface TracePayloadSummary {
  original_bytes: number;
  retained_bytes: number;
  truncated: boolean;
  sha256: string;
  sha256_scope?: "full" | "retained";
  body?: unknown;
  preview?: string;
}

type TraceEvent = Record<string, unknown>;

function isoDay(date = new Date()): string {
  return date.toISOString().slice(0, 10);
}

function hashText(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function newTraceId(): string {
  return `tr_${randomBytes(12).toString("hex")}`;
}

function newSpanId(): string {
  return `sp_${randomBytes(8).toString("hex")}`;
}

function byteLength(value: string): number {
  return Buffer.byteLength(value, "utf8");
}

function truncateUtf8(value: string, maxBytes: number): string {
  const source = Buffer.from(value, "utf8");
  if (source.byteLength <= maxBytes) return value;
  let end = Math.max(0, Math.min(source.byteLength, maxBytes));
  while (end > 0 && (source[end] & 0xc0) === 0x80) end -= 1;
  return source.subarray(0, end).toString("utf8");
}

function traceSensitiveKey(key: string): boolean {
  const normalized = key.toLowerCase().replace(/[^a-z0-9]/g, "");
  return /(?:authorization|cookie|password|passwd|apikey|privatekey|clientsecret|token|secret)$/.test(normalized);
}

function redactTraceStructured(value: unknown, key = "", depth = 0): unknown {
  if (key && traceSensitiveKey(key)) return "[REDACTED_SECRET]";
  if (depth > 12 || value === null || value === undefined) return value;
  if (typeof value === "string") return redactSensitiveText(value);
  if (Array.isArray(value)) return value.map((item) => redactTraceStructured(item, "", depth + 1));
  if (typeof value !== "object") return value;

  const out: Record<string, unknown> = {};
  for (const [childKey, childValue] of Object.entries(value as Record<string, unknown>)) {
    out[childKey] = redactTraceStructured(childValue, childKey, depth + 1);
  }
  return out;
}

function payloadText(value: unknown): { redacted: unknown; text: string } {
  const redacted = redactTraceStructured(value);
  if (typeof redacted === "string") return { redacted, text: redactSensitiveText(redacted) };
  try {
    const text = JSON.stringify(redacted);
    // GET/DELETE MCP streams have no JSON request body; JSON.stringify(undefined) is not a string.
    return { redacted: text === undefined ? null : redacted, text: text ?? "null" };
  } catch {
    const text = redactSensitiveText(String(redacted));
    return { redacted: text, text };
  }
}

export function summarizeTracePayload(
  value: unknown,
  mode: ProtocolTraceMode,
  maxBodyBytes: number
): TracePayloadSummary | undefined {
  if (mode === "off") return undefined;
  const { redacted, text } = payloadText(value);
  const originalBytes = byteLength(text);
  const sha256 = hashText(text);
  if (mode === "meta") {
    return {
      original_bytes: originalBytes,
      retained_bytes: 0,
      truncated: false,
      sha256
    };
  }

  if (originalBytes <= maxBodyBytes) {
    return {
      original_bytes: originalBytes,
      retained_bytes: originalBytes,
      truncated: false,
      sha256,
      body: redacted
    };
  }

  const preview = truncateUtf8(text, maxBodyBytes);
  return {
    original_bytes: originalBytes,
    retained_bytes: byteLength(preview),
    truncated: true,
    sha256,
    preview
  };
}

function summarizeCapturedResponse(
  value: unknown,
  responseBytes: number | undefined,
  mode: ProtocolTraceMode,
  maxBodyBytes: number
): TracePayloadSummary | undefined {
  const summary = summarizeTracePayload(value, mode, maxBodyBytes);
  if (!summary || responseBytes === undefined || responseBytes <= summary.original_bytes) return summary;

  const retainedValue =
    summary.preview ??
    (summary.body === undefined
      ? ""
      : typeof summary.body === "string"
        ? summary.body
        : JSON.stringify(summary.body));
  const preview = truncateUtf8(retainedValue, maxBodyBytes);
  return {
    ...summary,
    original_bytes: responseBytes,
    retained_bytes: byteLength(preview),
    truncated: true,
    sha256_scope: "retained",
    body: undefined,
    preview
  };
}

export interface SseFrameMetadata {
  event_index: number;
  event_type: string;
  data_bytes: number;
  frame_bytes: number;
}

export interface SseStreamSummary {
  chunk_count: number;
  event_count: number;
  total_bytes: number;
  partial_frame_bytes: number;
}

/**
 * Counts SSE frames across arbitrarily split HTTP writes. The parser never stores data:
 * payload contents; it retains at most a short line prefix to identify field names.
 * The trace is therefore a transport timeline, not a duplicate response transcript.
 */
export class SseFrameInspector {
  private chunkCount = 0;
  private eventCount = 0;
  private totalBytes = 0;
  private frameBytes = 0;
  private lineBytes = 0;
  private lastLineByte: number | undefined;
  private linePrefix: number[] = [];
  private eventType = "message";
  private dataBytes = 0;
  private hasData = false;

  push(chunk: Uint8Array): SseFrameMetadata[] {
    this.chunkCount += 1;
    this.totalBytes += chunk.byteLength;
    const completed: SseFrameMetadata[] = [];
    for (const byte of chunk) {
      this.frameBytes += 1;
      if (byte === 10) {
        const prefix = Buffer.from(this.linePrefix).toString("utf8");
        const trailingCr = this.lineBytes > 0 && this.lastLineByte === 13;
        const lineSize = this.lineBytes - (trailingCr ? 1 : 0);
        if (lineSize === 0) {
          if (this.hasData) {
            this.eventCount += 1;
            completed.push({
              event_index: this.eventCount,
              event_type: this.eventType,
              data_bytes: this.dataBytes,
              frame_bytes: this.frameBytes
            });
          }
          this.frameBytes = 0;
          this.dataBytes = 0;
          this.eventType = "message";
          this.hasData = false;
        } else if (prefix.startsWith("event:")) {
          const raw = prefix.slice(6).trim();
          // Event names are metadata but may still be user-defined. Do not persist arbitrary text.
          this.eventType = /^(message|progress|ping|heartbeat|error|notification|result|keepalive)$/.test(raw)
            ? raw
            : "custom";
        } else if (prefix.startsWith("data:")) {
          this.hasData = true;
          const spaceAfterColon = this.linePrefix[5] === 32 ? 1 : 0;
          this.dataBytes += Math.max(0, lineSize - 5 - spaceAfterColon);
        } else if (prefix === "data") {
          this.hasData = true;
        }
        this.lineBytes = 0;
        this.lastLineByte = undefined;
        this.linePrefix = [];
      } else {
        this.lineBytes += 1;
        this.lastLineByte = byte;
        if (this.linePrefix.length < 96) this.linePrefix.push(byte);
      }
    }
    return completed;
  }

  snapshot(): SseStreamSummary {
    return {
      chunk_count: this.chunkCount,
      event_count: this.eventCount,
      total_bytes: this.totalBytes,
      partial_frame_bytes: this.frameBytes
    };
  }
}

export function hashTraceIdentifier(value: string | undefined): string | undefined {
  if (!value) return undefined;
  return `sha256:${hashText(value).slice(0, 24)}`;
}

function eventJobId(value: unknown): string | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  if (typeof record.job_id === "string") return record.job_id;
  const structured = record.structuredContent;
  if (structured && typeof structured === "object" && !Array.isArray(structured)) {
    const jobId = (structured as Record<string, unknown>).job_id;
    if (typeof jobId === "string") return jobId;
  }
  return undefined;
}

function eventRequestId(value: unknown): string | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  if (typeof record.request_id === "string") return record.request_id;
  return undefined;
}

function safeJsonLine(event: TraceEvent): string {
  return JSON.stringify(redactStructured(event)) + "\n";
}

export class ProtocolTraceManager {
  private readonly storage = new AsyncLocalStorage<ProtocolTraceContext>();
  private writeChain: Promise<void> = Promise.resolve();
  private retentionCheckedDay = "";

  constructor(readonly config: ProtocolTraceConfig) {}

  get enabled(): boolean {
    return this.config.mode !== "off";
  }

  current(): ProtocolTraceContext | undefined {
    return this.storage.getStore();
  }

  createHttpContext(input: {
    requestId: string;
    body: unknown;
    sessionId?: string;
    httpMethod?: string;
  }): ProtocolTraceContext {
    const body =
      input.body && typeof input.body === "object" && !Array.isArray(input.body)
        ? input.body as Record<string, unknown>
        : {};
    const params =
      body.params && typeof body.params === "object" && !Array.isArray(body.params)
        ? body.params as Record<string, unknown>
        : {};
    const method = typeof body.method === "string" ? body.method : undefined;
    const tool = method === "tools/call" && typeof params.name === "string" ? params.name : undefined;
    const id =
      typeof body.id === "string" || typeof body.id === "number" || body.id === null
        ? body.id
        : undefined;
    return {
      traceId: newTraceId(),
      requestId: input.requestId,
      ...(id !== undefined ? { jsonrpcId: id } : {}),
      ...(method ? { mcpMethod: method } : {}),
      ...(tool ? { tool } : {}),
      ...(hashTraceIdentifier(input.sessionId) ? { mcpSession: hashTraceIdentifier(input.sessionId) } : {}),
      transport: "http",
      ...(input.httpMethod ? { httpMethod: input.httpMethod } : {}),
      startedAtMs: Date.now()
    };
  }

  run<T>(context: ProtocolTraceContext, fn: () => T): T {
    return this.storage.run(context, fn);
  }

  async recordRequest(body: unknown, requestBytes?: number): Promise<void> {
    const ctx = this.current();
    if (!ctx || !this.enabled) return;
    await this.record({
      event: "mcp.request",
      ...this.contextFields(ctx),
      ...(ctx.tool ? { tool: ctx.tool } : {}),
      request_bytes: requestBytes ?? undefined,
      payload: summarizeTracePayload(body, this.config.mode, this.config.maxBodyBytes)
    });
  }

  async recordSse(
    context: ProtocolTraceContext,
    kind: "chunk" | "event" | "summary",
    details: Record<string, string | number | boolean>
  ): Promise<void> {
    if (!this.enabled) return;
    await this.record({
      ...details,
      ...this.contextFields(context),
      ...(context.tool ? { tool: context.tool } : {}),
      event: `mcp.sse.${kind}`,
      elapsed_ms: Date.now() - context.startedAtMs
    });
  }

  async recordResponseLifecycle(
    context: ProtocolTraceContext,
    event: "finish" | "close" | "error",
    input: {
      statusCode: number;
      responseBytes?: number;
      afterFinish?: boolean;
      writableEnded?: boolean;
      headersSent?: boolean;
      requestAborted?: boolean;
      error?: unknown;
    }
  ): Promise<void> {
    if (!this.enabled) return;
    await this.record({
      event: `http.response.${event}`,
      ...this.contextFields(context),
      ...(context.tool ? { tool: context.tool } : {}),
      http_status: input.statusCode,
      duration_ms: Date.now() - context.startedAtMs,
      response_bytes: input.responseBytes ?? undefined,
      ...(input.afterFinish !== undefined ? { after_finish: input.afterFinish } : {}),
      ...(input.writableEnded !== undefined ? { writable_ended: input.writableEnded } : {}),
      ...(input.headersSent !== undefined ? { headers_sent: input.headersSent } : {}),
      ...(input.requestAborted !== undefined ? { request_aborted: input.requestAborted } : {}),
      ...(event === "close" ? { client_aborted: input.afterFinish === false } : {}),
      ...(input.error !== undefined ? { error: redactSensitiveText(input.error instanceof Error ? input.error.message : String(input.error)) } : {})
    });
  }

  async recordResponse(input: {
    statusCode: number;
    body?: unknown;
    responseBytes?: number;
    isError?: boolean;
  }): Promise<void> {
    const ctx = this.current();
    if (!ctx || !this.enabled) return;
    await this.record({
      event: "mcp.response",
      ...this.contextFields(ctx),
      ...(ctx.tool ? { tool: ctx.tool } : {}),
      status: input.isError || input.statusCode >= 400 ? "error" : "ok",
      http_status: input.statusCode,
      duration_ms: Date.now() - ctx.startedAtMs,
      response_bytes: input.responseBytes ?? undefined,
      payload: input.body === undefined
        ? undefined
        : summarizeCapturedResponse(
            input.body,
            input.responseBytes,
            this.config.mode,
            this.config.maxBodyBytes
          )
    });
  }

  async recordExecution(
    kind: "start" | "output" | "runtime" | "end",
    jobId: string,
    details: Record<string, unknown>,
    origin?: ProtocolTraceContext
  ): Promise<void> {
    const context = origin ?? this.current();
    if (!context || !this.enabled) return;
    // Managed jobs continue after an MCP response; retain the originating request context
    // explicitly rather than relying on AsyncLocalStorage across future timer/process callbacks.
    const { event: runtimeEvent, ...fields } = details;
    await this.record({
      ...fields,
      ...(typeof runtimeEvent === "string" ? { runtime_event: runtimeEvent } : {}),
      ...this.contextFields(context),
      ...(context.tool ? { tool: context.tool } : {}),
      job_id: jobId,
      event: `execution.${kind}`
    });
  }

  async toolStart(tool: string, args: unknown): Promise<{ spanId: string; startedAtMs: number }> {
    const ctx = this.current();
    const spanId = newSpanId();
    const startedAtMs = Date.now();
    if (!ctx || !this.enabled) return { spanId, startedAtMs };
    await this.record({
      event: "tool.start",
      ...this.contextFields(ctx),
      span_id: spanId,
      tool,
      ...(eventRequestId(args) ? { check_request_id: eventRequestId(args) } : {}),
      ...(eventJobId(args) ? { job_id: eventJobId(args) } : {}),
      arguments: summarizeTracePayload(args, this.config.mode, this.config.maxBodyBytes)
    });
    return { spanId, startedAtMs };
  }

  async toolEnd(input: {
    tool: string;
    spanId: string;
    startedAtMs: number;
    status: "ok" | "error";
    result?: unknown;
    error?: unknown;
  }): Promise<void> {
    const ctx = this.current();
    if (!ctx || !this.enabled) return;
    const payloadValue =
      input.status === "error"
        ? { error: input.error instanceof Error ? input.error.message : String(input.error ?? "unknown error") }
        : input.result;
    await this.record({
      event: "tool.end",
      ...this.contextFields(ctx),
      span_id: input.spanId,
      tool: input.tool,
      status: input.status,
      duration_ms: Date.now() - input.startedAtMs,
      ...(eventJobId(input.result) ? { job_id: eventJobId(input.result) } : {}),
      result: summarizeTracePayload(payloadValue, this.config.mode, this.config.maxBodyBytes)
    });
  }

  async flush(): Promise<void> {
    await this.writeChain.catch(() => {});
  }

  private contextFields(ctx: ProtocolTraceContext): TraceEvent {
    return {
      trace_id: ctx.traceId,
      request_id: ctx.requestId,
      ...(ctx.jsonrpcId !== undefined ? { jsonrpc_id: ctx.jsonrpcId } : {}),
      ...(ctx.mcpMethod ? { mcp_method: ctx.mcpMethod } : {}),
      ...(ctx.mcpSession ? { mcp_session: ctx.mcpSession } : {}),
      transport: ctx.transport,
      ...(ctx.httpMethod ? { http_method: ctx.httpMethod } : {})
    };
  }

  private async record(event: TraceEvent): Promise<void> {
    const entry = {
      ts: new Date().toISOString(),
      ...event
    };
    const line = safeJsonLine(entry);
    this.writeChain = this.writeChain
      .catch(() => {})
      .then(async () => {
        await this.cleanupRetentionIfNeeded();
        const filePath = await this.currentFile(byteLength(line));
        await fsp.mkdir(path.dirname(filePath), { recursive: true, mode: 0o700 });
        await fsp.appendFile(filePath, line, { encoding: "utf8", mode: 0o600 });
      });
    await this.writeChain;
  }

  private async currentFile(incomingBytes: number): Promise<string> {
    const day = isoDay();
    await fsp.mkdir(this.config.dir, { recursive: true, mode: 0o700 });
    for (let index = 0; index < 10_000; index += 1) {
      const name = index === 0 ? `trace-${day}.jsonl` : `trace-${day}.${index}.jsonl`;
      const candidate = path.join(this.config.dir, name);
      try {
        const stat = await fsp.stat(candidate);
        if (stat.size + incomingBytes <= this.config.maxFileBytes) return candidate;
      } catch (error) {
        if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") return candidate;
        throw error;
      }
    }
    throw new Error("CodexPro trace rotation exhausted file sequence.");
  }

  private async cleanupRetentionIfNeeded(): Promise<void> {
    const day = isoDay();
    if (this.retentionCheckedDay === day) return;
    this.retentionCheckedDay = day;
    const cutoff = Date.now() - this.config.retentionDays * 24 * 60 * 60_000;
    let names: string[];
    try {
      names = await fsp.readdir(this.config.dir);
    } catch (error) {
      if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") return;
      throw error;
    }
    for (const name of names) {
      if (!/^trace-\d{4}-\d{2}-\d{2}(?:\.\d+)?\.jsonl$/.test(name)) continue;
      const filePath = path.join(this.config.dir, name);
      try {
        const stat = await fsp.stat(filePath);
        if (stat.mtimeMs < cutoff) await fsp.rm(filePath, { force: true });
      } catch {}
    }
  }
}
