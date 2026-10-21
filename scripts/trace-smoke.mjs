import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { SseFrameInspector, ProtocolTraceManager, validTaskId, hashTraceIdentifier, summarizeTracePayload } from '../dist/protocolTrace.js';
import { formatConsoleTimestamp, safeToolTask } from '../dist/consoleDiagnostics.js';
import { buildTraceTimeline, renderTraceTimelineHtml } from './trace-viewer.mjs';

async function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      const port = typeof address === 'object' && address ? address.port : undefined;
      server.close(() => port ? resolve(port) : reject(new Error('no free port')));
    });
    server.on('error', reject);
  });
}

function waitForListening(child) {
  return new Promise((resolve, reject) => {
    let stderr = '';
    const timer = setTimeout(() => reject(new Error(`timeout waiting for trace HTTP server\n${stderr}`)), 15_000);
    timer.unref();
    child.stderr.on('data', (chunk) => {
      stderr += String(chunk);
      if (stderr.includes('HTTP MCP listening')) {
        clearTimeout(timer);
        resolve();
      }
    });
    child.once('exit', (code) => {
      clearTimeout(timer);
      reject(new Error(`trace HTTP server exited before listening: ${code}\n${stderr}`));
    });
  });
}

async function waitForHealth(url, timeoutMs = 15_000) {
  const started = Date.now();
  let lastError = '';
  while (Date.now() - started < timeoutMs) {
    try {
      const response = await fetch(url);
      if (response.ok) return await response.json();
      lastError = `${response.status} ${await response.text()}`;
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
    }
    await new Promise((resolve) => setTimeout(resolve, 150));
  }
  throw new Error(`timeout waiting for ${url}: ${lastError}`);
}

async function stop(child) {
  if (!child?.pid || child.exitCode !== null || child.signalCode) return;
  if (process.platform === 'win32') {
    spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore' });
  } else {
    child.kill('SIGTERM');
  }
  await new Promise((resolve) => {
    const timer = setTimeout(resolve, 8_000);
    timer.unref();
    child.once('exit', () => {
      clearTimeout(timer);
      resolve();
    });
  });
}

async function readEvents(dir, timeoutMs = 8_000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const names = await fs.readdir(dir).catch(() => []);
    const files = names.filter((name) => name.endsWith('.jsonl')).sort();
    const events = [];
    for (const name of files) {
      const text = await fs.readFile(path.join(dir, name), 'utf8').catch(() => '');
      for (const line of text.split(/\r?\n/)) {
        if (!line.trim()) continue;
        try { events.push(JSON.parse(line)); } catch {}
      }
    }
    if (events.some((event) => event.event === 'mcp.response' && event.tool === 'codexpro')) return events;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  return [];
}

// Task correlation must be explicit; sessions and timestamps cannot substitute for task ids.
const traceManager = new ProtocolTraceManager({
  mode: 'meta', dir: '.', maxBodyBytes: 1000, maxFileBytes: 100000, retentionDays: 1
});
const metaTask = { method: 'tools/call', params: {
  name: 'read', _meta: { 'codexpro/task_id': 'task_review_42' }
} };
const ctxA = traceManager.createHttpContext({ requestId: 'req_1', body: metaTask });
const ctxB = traceManager.createHttpContext({ requestId: 'req_2', body: metaTask });
if (ctxA.taskId !== 'task_review_42' || ctxB.taskId !== ctxA.taskId ||
    ctxA.traceId === ctxB.traceId) {
  throw new Error('Explicit task correlation failed across distinct request traces');
}
const headerCtx = traceManager.createHttpContext({
  requestId: 'req_3', body: metaTask, taskId: 'task_override_9'
});
if (headerCtx.taskId !== 'task_override_9' ||
    traceManager.createHttpContext({ requestId: 'req_4', body: {}, sessionId: 'same-session' }).taskId !== undefined ||
    traceManager.createHttpContext({ requestId: 'req_5', body: { params: {
      _meta: { 'codexpro/task_id': '../invalid-task' }
    } } }).taskId !== undefined ||
    validTaskId(' bad') !== undefined || validTaskId('x'.repeat(65)) !== undefined) {
  throw new Error('Invalid or missing task id was accepted or invented');
}

const hostSession = 'host-anonymous-session-test-value';
const sessionBody = { method: 'tools/call', params: {
  _meta: { 'openai/session': hostSession }, name: 'read'
} };
const sessionCtx1 = traceManager.createHttpContext({ requestId: 'req_session_1', body: sessionBody });
const sessionCtx2 = traceManager.createHttpContext({ requestId: 'req_session_2', body: sessionBody });
const differentSession = traceManager.createHttpContext({ requestId: 'req_session_3',
  body: { params: { _meta: { 'openai/session': 'another-session' } } } });
const invalidSession = traceManager.createHttpContext({ requestId: 'req_session_4',
  body: { params: { _meta: { 'openai/session': 'x'.repeat(257) } } } });
const storedPayload = summarizeTracePayload(sessionBody, 'redacted', 2000);
if (sessionCtx1.conversationId !== hashTraceIdentifier('openai/session:' + hostSession) ||
    sessionCtx2.conversationId !== sessionCtx1.conversationId ||
    sessionCtx1.traceId === sessionCtx2.traceId ||
    differentSession.conversationId === sessionCtx1.conversationId ||
    invalidSession.conversationId !== undefined ||
    traceManager.createHttpContext({ requestId: 'req_session_5', body: {},
      sessionId: 'same-mcp-session' }).conversationId !== undefined ||
    JSON.stringify(storedPayload).includes(hostSession) ||
    storedPayload.body?.params?._meta?.['openai/session'] !== '[REDACTED_SECRET]') {
  throw new Error('Conversation correlation or anonymized metadata redaction failed');
}

const sseInspector = new SseFrameInspector();
const ssePayload = ['very', 'private', 'payload'].join('-');
const sseChunks = [
  Buffer.from('event: message\ndata: {"value":"'),
  Buffer.from(ssePayload.slice(0, 5)),
  Buffer.from(ssePayload.slice(5) + '"}\n\n: keepalive\r\nevent: progress\r\ndata: ok\r\n\r\n'),
  Buffer.from('event: partial\ndata: unfinished')
];
const sseFrames = sseChunks.flatMap((chunk) => sseInspector.push(chunk));
const sseSummary = sseInspector.snapshot();
if (
  sseFrames.length !== 2 ||
  sseFrames[0].event_type !== 'message' ||
  sseFrames[1].event_type !== 'progress' ||
  !(sseFrames[0].data_bytes > 0) ||
  !(sseFrames[1].frame_bytes > 0) ||
  sseSummary.chunk_count !== 4 ||
  sseSummary.event_count !== 2 ||
  !(sseSummary.partial_frame_bytes > 0) ||
  JSON.stringify({ sseFrames, sseSummary }).includes(ssePayload)
) {
  throw new Error(`SSE chunk parser did not preserve fragmented frame boundaries or metadata-only safety: ${JSON.stringify({ sseFrames, sseSummary })}`);
}

const longSseInspector = new SseFrameInspector();
const longData = 'x'.repeat(2048);
const longWire = Buffer.from(`event: message\r\ndata: ${longData}\r\n\r\n`);
const longFrames = [
  ...longSseInspector.push(longWire.subarray(0, 123)),
  ...longSseInspector.push(longWire.subarray(123))
];
if (longFrames.length !== 1 ||
    longFrames[0].data_bytes !== Buffer.byteLength(longData) ||
    longFrames[0].frame_bytes !== longWire.byteLength ||
    longSseInspector.snapshot().partial_frame_bytes !== 0) {
  throw new Error(`long CRLF SSE line was not byte-accurate: ${JSON.stringify(longFrames)}`);
}

const injected = '<img src=x onerror=alert(1)>';
const hostileTimeline = buildTraceTimeline([{
  ts: '2026-10-08T01:01:01.000Z',
  event: injected,
  request_id: 'request-x',
  duration_ms: 1
}]);
const hostileHtml = renderTraceTimelineHtml(hostileTimeline, { label: injected });
if (hostileHtml.includes(injected) || hostileHtml.includes('<script') ||
    !hostileHtml.includes('&lt;img') || !hostileHtml.includes('Content-Security-Policy')) {
  throw new Error('offline timeline did not escape untrusted trace metadata');
}

const changedTimeline = buildTraceTimeline([{
  ts: '2026-10-08T01:01:02.000Z',
  event: 'workspace.change',
  trace_id: 'tr_fixture',
  span_id: 'sp_fixture',
  tool: 'edit',
  paths: ['src/example.ts'],
  additions: 1,
  deletions: 1,
  patch: {
    body: '--- a/src/example.ts\n+++ b/src/example.ts\n@@ -1 +1 @@\n-const value = 1;\n+const value = 2;'
  }
}]);
const changedHtml = renderTraceTimelineHtml(changedTimeline);
if (!changedHtml.includes('Change history') || !changedHtml.includes('Before') ||
    !changedHtml.includes('After') || !changedHtml.includes('src/example.ts') ||
    !changedHtml.includes('const value = 1;') || !changedHtml.includes('const value = 2;') ||
    !changedHtml.includes('class="deletion"') || !changedHtml.includes('class="addition"')) {
  throw new Error('offline timeline did not provide side-by-side change history');
}
const injectedPatch = '--- a/example.ts\n+++ b/example.ts\n@@ -1 +1 @@\n-safe\n+' + injected;
const injectedChangeHtml = renderTraceTimelineHtml(buildTraceTimeline([{
  ts: '2026-10-08T01:01:03.000Z', event: 'workspace.change', tool: 'edit',
  paths: ['example.ts'], patch: { body: injectedPatch }, additions: 1, deletions: 1
}]));
if (injectedChangeHtml.includes(injected) || !injectedChangeHtml.includes('&lt;img') ||
    injectedChangeHtml.includes('<script')) {
  throw new Error('offline diff viewer did not escape code from trace files');
}
const truncatedChangeHtml = renderTraceTimelineHtml(buildTraceTimeline([{
  ts: '2026-10-08T01:01:04.000Z', event: 'workspace.change', tool: 'edit',
  paths: ['example.ts'], additions: 10, deletions: 1,
  patch: { preview: '--- a/example.ts', truncated: true }
}]));
const metaChangeHtml = renderTraceTimelineHtml(buildTraceTimeline([{
  ts: '2026-10-08T01:01:05.000Z', event: 'workspace.change', tool: 'write',
  paths: ['example.ts'], additions: 1, deletions: 0,
  patch: { original_bytes: 32, retained_bytes: 0 }
}]));
if (!truncatedChangeHtml.includes('not a complete comparison') ||
    !metaChangeHtml.includes('Only change metadata was retained')) {
  throw new Error('trace viewer mislabeled truncated or metadata-only patches as complete');
}

const suspiciousShell = 'npm run test:unit; echo '+ssePayload;
if (
  safeToolTask('bash', { command: suspiciousShell }) !== 'custom-command' ||
  safeToolTask('bash', { command: 'npm run check:smoke-integration' }) !== 'npm run check:smoke-integration' ||
  safeToolTask('run_checks', { checks: ['test:unit', 'lint'] }) !== 'test:unit,lint'
) {
  throw new Error('console task labels are not safely bounded to allowlisted check names');
}

const fixedInstant = new Date('2026-01-01T00:15:09.007Z');
const localTimestampCases = [
  [480, '2026-01-01 08:15:09.007 +08:00'],
  [-300, '2025-12-31 19:15:09.007 -05:00'],
  [345, '2026-01-01 06:00:09.007 +05:45'],
  [0, '2026-01-01 00:15:09.007 +00:00']
];
for (const [offsetMinutes, expected] of localTimestampCases) {
  const actual = formatConsoleTimestamp(fixedInstant, offsetMinutes);
  if (actual !== expected) {
    throw new Error(`console timestamp conversion failed at UTC offset ${offsetMinutes}: ${actual}`);
  }
}
const actualHostTimestamp = formatConsoleTimestamp(fixedInstant);
const hostClockPrefix = [
  fixedInstant.getFullYear(),
  String(fixedInstant.getMonth() + 1).padStart(2, '0'),
  String(fixedInstant.getDate()).padStart(2, '0')
].join('-') + ' ' +
  [fixedInstant.getHours(), fixedInstant.getMinutes(), fixedInstant.getSeconds()]
    .map((part) => String(part).padStart(2, '0')).join(':') + '.007 ';
if (!actualHostTimestamp.startsWith(hostClockPrefix)) {
  throw new Error(`console timestamp ignored host local wall clock: ${actualHostTimestamp}`);
}

const root = await fs.mkdtemp(path.join(os.tmpdir(), 'codexpro-trace-root-'));
const home = await fs.mkdtemp(path.join(os.tmpdir(), 'codexpro-trace-home-'));
const traceDir = path.join(home, 'traces');
const port = await freePort();
const token = ['trace', 'connector', 'token', 'fixture', '123456789'].join('-');
const secret = ['sk', 'tracefixturesecret123456789'].join('-');
const shortMarker = ['mini', 'pw', 'fixture', '42'].join('-');
const sensitiveKey = ['custom', 'password'].join('_');
const requestId = 'trace-smoke-request-001';
const abortRequestId = 'trace-abort-request-001';

await fs.writeFile(path.join(root, 'package.json'), JSON.stringify({
  name: 'trace-fixture',
  private: true,
  scripts: {
    'verify:trace': `node -e "console.log('trace-job-ok')"`,
    'verify:trace-slow': `node -e "console.log('trace-slow-started'); setTimeout(() => console.log('trace-slow-done'), 6000)"`
  }
}, null, 2), 'utf8');
for (const args of [
  ['init'],
  ['add', 'package.json'],
  ['-c', 'user.email=trace@example.invalid', '-c', 'user.name=Trace', 'commit', '-m', 'fixture']
]) {
  const result = spawnSync('git', args, { cwd: root, encoding: 'utf8' });
  if (result.status !== 0) throw new Error(`git ${args.join(' ')} failed: ${result.stderr || result.stdout}`);
}

const child = spawn(process.execPath, ['dist/http.js'], {
  cwd: path.resolve('.'),
  env: {
    ...process.env,
    CODEXPRO_ROOT: root,
    CODEXPRO_ALLOWED_ROOTS: root,
    CODEXPRO_HOME: home,
    CODEXPRO_HOST: '127.0.0.1',
    CODEXPRO_PORT: String(port),
    CODEXPRO_HTTP_TOKEN: token,
    CODEXPRO_BASH_MODE: 'safe',
    CODEXPRO_WRITE_MODE: 'workspace',
    CODEXPRO_TOOL_MODE: 'full',
    CODEXPRO_TOOL_CARDS: '0',
    CODEXPRO_LOG_REQUESTS: '1',
    CODEXPRO_LOG_TOOL_CALLS: '1',
    CODEXPRO_LOG_HEARTBEAT_MS: '1000',
    CODEXPRO_MCP_TRACE: 'redacted',
    CODEXPRO_MCP_TRACE_DIR: traceDir,
    CODEXPRO_MCP_TRACE_MAX_BODY_BYTES: '512',
    CODEXPRO_MCP_TRACE_MAX_FILE_BYTES: '1048576',
    CODEXPRO_MCP_TRACE_RETENTION_DAYS: '2'
  },
  stdio: ['ignore', 'ignore', 'pipe']
});
let diagnosticConsole = '';
child.stderr.on('data', (chunk) => { diagnosticConsole += String(chunk); });

try {
  await waitForListening(child);
  const client = new Client({ name: 'codexpro-trace-smoke', version: '0.1.0' });
  const transport = new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${port}/mcp`), {
    requestInit: {
      headers: {
        Authorization: `Bearer ${token}`,
        'X-CodexPro-Request-Id': requestId,
        'X-CodexPro-Task-Id': 'task_smoke_transport'
      }
    }
  });
  let traceJobId;
  try {
    await client.connect(transport);
    const chatConversationFixture = 'opaque-fixture-conversation-source';
    const result = await client.callTool({
      _meta: { 'openai/session': chatConversationFixture },
      name: 'codexpro',
      arguments: {
        action: 'list_actions',
        args: {
          api_token: secret,
          [sensitiveKey]: shortMarker,
          padding: 'x'.repeat(4_000)
        }
      }
    });
    if (result.isError) throw new Error(`trace fixture tool call failed: ${JSON.stringify(result)}`);
    const started = await client.callTool({
      _meta: { 'openai/session': chatConversationFixture },
      name: 'start_check',
      arguments: {
        request_id: 'trace-job-request-001',
        checks: ['verify:trace'],
        target_paths: ['package.json'],
        timeout_ms: 10_000
      }
    });
    if (started.isError || !started.structuredContent?.job_id) {
      throw new Error(`trace managed check did not start: ${JSON.stringify(started)}`);
    }
    traceJobId = started.structuredContent.job_id;
    let terminal = started;
    for (let attempt = 0; attempt < 6 && terminal.structuredContent?.status === 'running'; attempt += 1) {
      terminal = await client.callTool({
        name: 'wait_check',
        arguments: {
          job_id: traceJobId,
          wait_ms: 2_000,
          max_chars: 2_000
        }
      });
    }
    if (terminal.isError || terminal.structuredContent?.status !== 'completed') {
      throw new Error(`trace managed check did not complete: ${JSON.stringify(terminal)}`);
    }

    const writeChange = await client.callTool({
      name: 'write', arguments: { path: 'trace-change.txt', content: 'const duration = 5000;\n' }
    });
    const editChange = await client.callTool({
      name: 'edit', arguments: {
        path: 'trace-change.txt', old_text: '5000', new_text: '10000'
      }
    });
    const patchChange = await client.callTool({
      name: 'apply_patch', arguments: {
        patch: '--- a/trace-change.txt\n+++ b/trace-change.txt\n@@ -1 +1,2 @@\n const duration = 10000;\n+const retries = 2;\n'
      }
    });
    for (const [tool, output] of [['write', writeChange], ['edit', editChange], ['apply_patch', patchChange]]) {
      if (output.isError) throw new Error(`trace ${tool} fixture failed: ${JSON.stringify(output)}`);
    }
    const noOpChange = await client.callTool({
      name: 'write', arguments: { path: 'trace-change.txt', content: 'const duration = 10000;\nconst retries = 2;\n' }
    });
    const failedEdit = await client.callTool({
      name: 'edit', arguments: { path: 'trace-change.txt', old_text: 'missing text', new_text: 'broken' }
    });
    if (noOpChange.isError || !failedEdit.isError) {
      throw new Error('trace change fixture failed to exercise no-op and error paths');
    }
    const supertoolChange = await client.callTool({
      name: 'codexpro', arguments: {
        action: 'edit', args: {
          path: 'trace-change.txt', old_text: '10000', new_text: '15000'
        }
      }
    });
    if (supertoolChange.isError) {
      throw new Error(`trace supertool edit fixture failed: ${JSON.stringify(supertoolChange)}`);
    }

    const slowBash = await client.callTool({
      name: 'bash',
      arguments: { command: 'npm run verify:trace-slow', timeout_ms: 12_000 }
    });
    if (slowBash.isError || slowBash.structuredContent?.ok !== true) {
      throw new Error(`trace fixture long bash check failed: ${JSON.stringify(slowBash)}`);
    }
    const toolStartLine = diagnosticConsole.split(/\r?\n/).find((line) =>
      line.includes('[CodexProTool] bash start') && line.includes('task=npm run verify:trace-slow'));
    const toolProgressLines = diagnosticConsole.split(/\r?\n/).filter((line) =>
      line.includes('[CodexProTool] bash running') && line.includes('output_bytes='));
    if (
      !toolStartLine ||
      !/^\[\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}\.\d{3} [+-]\d{2}:\d{2}\]/.test(toolStartLine) ||
      !toolStartLine.includes(`request_id=${requestId}`) ||
      toolProgressLines.length < 2 ||
      !toolProgressLines.some((line) => /pid=\d+/.test(line)) ||
      !diagnosticConsole.includes('[CodexProTool] bash ok') ||
      !diagnosticConsole.includes('task=npm run verify:trace-slow') ||
      !diagnosticConsole.includes('[CodexPro] POST /mcp pending')
    ) {
      throw new Error(`long MCP tool did not expose time-stamped running diagnostics: ${diagnosticConsole.slice(-6000)}`);
    }

    const invalidBash = await client.callTool({
      name: 'bash',
      arguments: { command: 'node -e "console.log(\'' + secret + '\')"', timeout_ms: 3_000 }
    });
    if (!invalidBash.isError ||
        diagnosticConsole.includes(secret) ||
        !diagnosticConsole.includes('[CodexProTool] bash error') ||
        !diagnosticConsole.includes('task=custom-command')) {
      throw new Error(`failing command was not safely diagnosed: ${diagnosticConsole.slice(-3800)}`);
    }

    const abortClient = new Client({ name: 'codexpro-trace-abort-smoke', version: '0.1.0' });
    const abortTransport = new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${port}/mcp`), {
      requestInit: {
        headers: {
          Authorization: `Bearer ${token}`,
          'X-CodexPro-Request-Id': abortRequestId
        }
      }
    });
    let abortJobId;
    try {
      await abortClient.connect(abortTransport);
      const abortStarted = await abortClient.callTool({
        name: 'start_check',
        arguments: {
          request_id: 'trace-abort-job-request-001',
          checks: ['verify:trace-slow'],
          target_paths: ['package.json'],
          timeout_ms: 20_000
        }
      });
      if (abortStarted.isError || !abortStarted.structuredContent?.job_id) {
        throw new Error(`trace abort fixture did not start: ${JSON.stringify(abortStarted)}`);
      }
      abortJobId = abortStarted.structuredContent.job_id;
      const pending = abortClient.callTool({
        name: 'wait_check',
        arguments: {
          job_id: abortJobId,
          wait_ms: 10_000,
          max_chars: 2_000
        }
      }).catch(() => undefined);
      await new Promise((resolve) => setTimeout(resolve, 250));
      await abortClient.close().catch(() => {});
      await pending;
    } finally {
      await abortClient.close().catch(() => {});
      if (abortJobId) {
        await client.callTool({
          name: 'stop_check',
          arguments: { job_id: abortJobId }
        }).catch(() => {});
      }
    }

    const openStreamRequestId = 'trace-get-stream-001';
    const initializedStream = await fetch(`http://127.0.0.1:${port}/mcp`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: 'application/json, text/event-stream',
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 'stream-init-1',
        method: 'initialize',
        params: {
          protocolVersion: '2025-03-26',
          capabilities: {},
          clientInfo: { name: 'codexpro-trace-sse-get', version: '0.1.0' }
        }
      })
    });
    const sessionId = initializedStream.headers.get('mcp-session-id');
    if (!initializedStream.ok || !sessionId) {
      throw new Error(`trace SSE GET fixture could not initialize a fresh session: ${initializedStream.status}`);
    }
    await initializedStream.body?.cancel().catch(() => {});
    const streamController = new AbortController();
    const streamResponse = await fetch(`http://127.0.0.1:${port}/mcp`, {
      method: 'GET',
      headers: {
        Authorization: `Bearer ${token}`,
        'Mcp-Session-Id': sessionId,
        Accept: 'text/event-stream',
        'X-CodexPro-Request-Id': openStreamRequestId
      },
      signal: streamController.signal
    });
    if (!streamResponse.ok || !streamResponse.headers.get('content-type')?.includes('text/event-stream')) {
      throw new Error(`MCP SSE GET could not be opened: ${streamResponse.status} ${await streamResponse.text()}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 180));
    streamController.abort();
    await streamResponse.body?.cancel().catch(() => {});

  } finally {
    await client.close().catch(() => {});
  }

  let events = await readEvents(traceDir);
  if (!events.length || !events.every((event) => typeof event.ts === 'string' && /Z$/.test(event.ts))) {
    throw new Error('Protocol Trace JSONL must retain UTC timestamps independently of local console formatting');
  }
  const conversationHash = hashTraceIdentifier('openai/session:opaque-fixture-conversation-source');
  const conversationEvents = events.filter((event) =>
    event.conversation_id === conversationHash && event.event === 'tool.start');
  if (conversationEvents.length < 2 ||
      new Set(conversationEvents.map((event) => event.trace_id)).size < 2 ||
      JSON.stringify(events).includes('opaque-fixture-conversation-source')) {
    throw new Error('ChatGPT conversation _meta was not correlated or was written without redaction');
  }
  const tagged = events.filter((event) => event.task_id === 'task_smoke_transport' &&
    event.event === 'tool.start');
  if (tagged.length < 2 || new Set(tagged.map((event) => event.trace_id)).size < 2) {
    throw new Error('HTTP task header did not correlate distinct tool request traces');
  }
  for (let attempt = 0; attempt < 25 && !events.some(
    (event) => event.request_id === 'trace-get-stream-001' && event.event === 'http.response.close'
  ); attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 100));
    events = await readEvents(traceDir);
  }
  const getStreamEvents = events.filter((event) => event.request_id === 'trace-get-stream-001');
  if (!getStreamEvents.some((event) => event.event === 'mcp.request' && event.http_method === 'GET') ||
      !getStreamEvents.some((event) => event.event === 'http.response.close' && event.client_aborted === true) ||
      !getStreamEvents.some((event) => event.event === 'mcp.sse.summary' && event.reason === 'close' && event.event_count >= 0)) {
    throw new Error(`GET /mcp SSE lifecycle was not captured: ${JSON.stringify(getStreamEvents)}`);
  }
  const getCloseLine = diagnosticConsole.split(/\r?\n/).find((line) =>
    line.includes('[CodexPro] GET /mcp closed') && line.includes('request_id=trace-get-stream-001'));
  if (!getCloseLine || !getCloseLine.includes('client_aborted=true') ||
      !/^\[\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}\.\d{3} [+-]\d{2}:\d{2}\]/.test(getCloseLine)) {
    throw new Error(`console diagnostics failed to identify an SSE client disconnect: ${diagnosticConsole.slice(-4000)}`);
  }
  const sseEvents = events.filter((event) => event.event?.startsWith?.('mcp.sse.'));
  const sseKinds = new Set(sseEvents.map((event) => event.event));
  for (const kind of ['mcp.sse.chunk', 'mcp.sse.event', 'mcp.sse.summary']) {
    if (!sseKinds.has(kind)) {
      throw new Error(`actual MCP HTTP traffic was not traced as SSE frames: missing ${kind}; kinds=${JSON.stringify([...sseKinds])}`);
    }
  }
  if (!sseEvents.every((event) => event.trace_id && event.request_id) ||
      !sseEvents.some((event) => event.event === 'mcp.sse.summary' && event.event_count > 0)) {
    throw new Error('SSE trace did not preserve request correlation or event counters');
  }
  const initialSupertoolTrace = events.find(
    (event) => event.event === 'mcp.request' && event.tool === 'codexpro'
  )?.trace_id;
  const toolEvents = events.filter(
    (event) => event.tool === 'codexpro' && event.trace_id === initialSupertoolTrace
  );
  const kinds = new Set(toolEvents.map((event) => event.event));
  for (const expected of ['mcp.request', 'tool.start', 'tool.end', 'mcp.response', 'http.response.finish']) {
    if (!kinds.has(expected)) {
      throw new Error(`trace missing ${expected}: ${JSON.stringify(toolEvents)}`);
    }
  }

  const abortedWait = events.filter(
    (event) => event.request_id === abortRequestId && event.tool === 'wait_check'
  );
  if (
    !abortedWait.some(
      (event) =>
        event.event === 'http.response.close' &&
        event.after_finish === false &&
        event.client_aborted === true
    )
  ) {
    throw new Error(`trace did not record an early client disconnect: ${JSON.stringify(abortedWait)}`);
  }

  const traceIds = new Set(toolEvents.map((event) => event.trace_id).filter(Boolean));
  if (traceIds.size !== 1) {
    throw new Error(`tool trace was not correlated by one trace_id: ${JSON.stringify([...traceIds])}`);
  }
  if (!toolEvents.every((event) => event.request_id === requestId)) {
    throw new Error(`request_id did not propagate through trace: ${JSON.stringify(toolEvents)}`);
  }

  const serialized = JSON.stringify(events);
  if (serialized.includes(secret) || serialized.includes(shortMarker) || serialized.includes(token)) {
    throw new Error('trace persisted an unredacted secret');
  }
  if (!serialized.includes('[REDACTED_SECRET]')) {
    throw new Error('trace did not preserve a visible redaction marker');
  }
  const request = toolEvents.find((event) => event.event === 'mcp.request');
  if (!request?.payload?.truncated || !(request.payload?.original_bytes > request.payload?.retained_bytes)) {
    throw new Error(`large MCP request was not bounded: ${JSON.stringify(request)}`);
  }
  if (!toolEvents.some((event) => event.event === 'tool.end' && event.status === 'ok' && event.duration_ms >= 0)) {
    throw new Error(`tool end trace did not include status/duration: ${JSON.stringify(toolEvents)}`);
  }

  const changes = events.filter((event) => event.event === 'workspace.change');
  if (changes.length !== 4 || changes.some((event) =>
    event.paths?.[0] !== 'trace-change.txt' || !event.trace_id || !event.span_id ||
    !(event.patch?.body || event.patch?.preview) || event.additions < 0 || event.deletions < 0 ||
    !events.some((toolEnd) => toolEnd.event === 'tool.end' && toolEnd.span_id === event.span_id)
  ) || new Set(changes.map((event) => event.tool)).size !== 3 ||
      !changes.some((event) => event.tool === 'edit' && events.some((toolEnd) =>
        toolEnd.event === 'tool.end' && toolEnd.tool === 'codexpro' && toolEnd.span_id === event.span_id))) {
    throw new Error(`operation-level change events were not recorded correctly: ${JSON.stringify(changes)}`);
  }
  const editTraceId = changes.find((event) => event.tool === 'edit')?.trace_id;
  const changeTimelineHtmlPath = path.join(home, 'change-timeline.html');
  const changeExport = spawnSync(process.execPath, [
    'scripts/codexpro.mjs', 'trace', 'timeline',
    '--trace-id', editTraceId, '--trace-dir', traceDir, '--html', changeTimelineHtmlPath
  ], { cwd: path.resolve('.'), encoding: 'utf8', env: { ...process.env, CODEXPRO_HOME: home } });
  const changeExportHtml = changeExport.status === 0
    ? await fs.readFile(changeTimelineHtmlPath, 'utf8') : '';
  if (changeExport.status !== 0 || !changeExportHtml.includes('Change history') ||
      !changeExportHtml.includes('Before') || !changeExportHtml.includes('After') ||
      !changeExportHtml.includes('5000') || !changeExportHtml.includes('10000')) {
    throw new Error(`trace change timeline export did not display edit diff: ${changeExport.stderr || changeExport.stdout}`);
  }

  const showByRequest = spawnSync(process.execPath, [
    'scripts/codexpro.mjs',
    'trace',
    'show',
    '--request',
    requestId,
    '--trace-dir',
    traceDir,
    '--json'
  ], {
    cwd: path.resolve('.'),
    encoding: 'utf8',
    env: { ...process.env, CODEXPRO_HOME: home }
  });
  if (showByRequest.status !== 0) {
    throw new Error(`trace show --request failed: ${showByRequest.stderr || showByRequest.stdout}`);
  }
  const shownEvents = JSON.parse(showByRequest.stdout);
  const shownKinds = new Set(shownEvents.filter((event) => event.tool === 'codexpro').map((event) => event.event));
  for (const expected of ['mcp.request', 'tool.start', 'tool.end', 'mcp.response']) {
    if (!shownKinds.has(expected)) {
      throw new Error(`trace show --request missing ${expected}: ${showByRequest.stdout}`);
    }
  }

  const executionEvents = events.filter((event) => event.job_id === traceJobId);
  const executionKinds = new Set(executionEvents.map((event) => event.event));
  for (const kind of ['execution.start', 'execution.output', 'execution.runtime', 'execution.end']) {
    if (!executionKinds.has(kind)) {
      throw new Error(`trace missing ${kind} for managed check ${traceJobId}: ${JSON.stringify(executionEvents)}`);
    }
  }
  if (!executionEvents.some((event) => event.event === 'execution.output' && event.stream === 'stdout')) {
    throw new Error('execution trace did not capture a redacted stdout summary');
  }
  const executionOrigin = executionEvents.find((event) => event.event === 'execution.start');
  if (!executionOrigin?.trace_id || !executionOrigin?.request_id) {
    throw new Error('execution trace lost the originating MCP request correlation');
  }

  const showByJob = spawnSync(process.execPath, [
    'scripts/codexpro.mjs',
    'trace',
    'show',
    '--job',
    traceJobId,
    '--trace-dir',
    traceDir,
    '--json'
  ], {
    cwd: path.resolve('.'),
    encoding: 'utf8',
    env: { ...process.env, CODEXPRO_HOME: home }
  });
  if (showByJob.status !== 0) {
    throw new Error(`trace show --job failed: ${showByJob.stderr || showByJob.stdout}`);
  }
  const jobEvents = JSON.parse(showByJob.stdout);
  if (
    !jobEvents.some((event) => event.event === 'tool.end' && event.tool === 'start_check' && event.job_id === traceJobId) ||
    !jobEvents.some((event) => event.event === 'mcp.request' && event.tool === 'start_check') ||
    !jobEvents.some((event) => event.event === 'mcp.response' && event.tool === 'start_check')
  ) {
    throw new Error(`trace show --job did not recover the start_check exchange: ${showByJob.stdout}`);
  }

  const timelineHtmlPath = path.join(home, 'trace-timeline.html');
  const timeline = spawnSync(process.execPath, [
    'scripts/codexpro.mjs', 'trace', 'timeline',
    '--job', traceJobId, '--trace-dir', traceDir, '--html', timelineHtmlPath
  ], {
    cwd: path.resolve('.'), encoding: 'utf8',
    env: { ...process.env, CODEXPRO_HOME: home }
  });
  if (timeline.status !== 0) {
    throw new Error(`trace timeline export failed: ${timeline.stderr || timeline.stdout}`);
  }
  const timelineHtml = await fs.readFile(timelineHtmlPath, 'utf8');
  if (
    !timelineHtml.includes('CodexPro Trace Timeline') ||
    !timelineHtml.includes('execution.start') ||
    !timelineHtml.includes('mcp.sse.event') ||
    !timelineHtml.includes('Content-Security-Policy') ||
    timelineHtml.includes('<script') ||
    timelineHtml.includes(secret) ||
    timelineHtml.includes(shortMarker)
  ) {
    throw new Error('offline timeline did not render expected safe correlated events');
  }
  const timelineJson = spawnSync(process.execPath, [
    'scripts/codexpro.mjs', 'trace', 'timeline',
    '--job', traceJobId, '--trace-dir', traceDir, '--json'
  ], {
    cwd: path.resolve('.'), encoding: 'utf8',
    env: { ...process.env, CODEXPRO_HOME: home }
  });
  const timelineData = timelineJson.status === 0 ? JSON.parse(timelineJson.stdout) : undefined;
  if (!timelineData || timelineData.total_events < 4 ||
      !timelineData.events.every((item) => item.offset_ms >= 0) ||
      !timelineData.events.some((item) => item.event === 'execution.end')) {
    throw new Error(`trace timeline JSON did not include a nonnegative correlated timeline: ${timelineJson.stderr || timelineJson.stdout}`);
  }

  const tail = spawnSync(process.execPath, [
    'scripts/codexpro.mjs',
    'trace',
    'tail',
    '--lines',
    '4',
    '--trace-dir',
    traceDir,
    '--json'
  ], {
    cwd: path.resolve('.'),
    encoding: 'utf8',
    env: { ...process.env, CODEXPRO_HOME: home }
  });
  if (tail.status !== 0) {
    throw new Error(`trace tail failed: ${tail.stderr || tail.stdout}`);
  }
  const tailEvents = JSON.parse(tail.stdout);
  if (!Array.isArray(tailEvents) || tailEvents.length < 1 || tailEvents.length > 4) {
    throw new Error(`trace tail did not return a bounded event list: ${tail.stdout}`);
  }
  if (JSON.stringify(shownEvents).includes(shortMarker) || JSON.stringify(tailEvents).includes(shortMarker)) {
    throw new Error('trace CLI exposed a redacted sensitive field');
  }

  const launcherPort = await freePort();
  const launcherTraceDir = path.join(home, 'launcher-traces');
  const launcher = spawn(process.execPath, [
    'scripts/codexpro.mjs',
    'start',
    '--root',
    root,
    '--tunnel',
    'none',
    '--no-auth',
    '--no-profile',
    '--headless',
    '--port',
    String(launcherPort),
    '--mcp-trace',
    'redacted',
    '--mcp-trace-dir',
    launcherTraceDir,
    '--mcp-trace-max-body-bytes',
    '768',
    '--mcp-trace-max-file-bytes',
    '1048576',
    '--mcp-trace-retention-days',
    '3'
  ], {
    cwd: path.resolve('.'),
    env: { ...process.env, CODEXPRO_HOME: home },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  try {
    const launcherHealth = await waitForHealth(`http://127.0.0.1:${launcherPort}/healthz`);
    if (
      launcherHealth.mcpTrace !== 'redacted' ||
      !String(launcherHealth.mcpTraceDir).endsWith('launcher-traces') ||
      launcherHealth.mcpTraceMaxBodyBytes !== 768 ||
      launcherHealth.mcpTraceMaxFileBytes !== 1048576 ||
      launcherHealth.mcpTraceRetentionDays !== 3
    ) {
      throw new Error(`launcher did not propagate MCP trace config: ${JSON.stringify(launcherHealth)}`);
    }

    const launcherClient = new Client({ name: 'codexpro-trace-launcher-smoke', version: '0.1.0' });
    const launcherTransport = new StreamableHTTPClientTransport(
      new URL(`http://127.0.0.1:${launcherPort}/mcp`)
    );
    try {
      await launcherClient.connect(launcherTransport);
      const launcherResult = await launcherClient.callTool({
        name: 'codexpro',
        arguments: { action: 'list_actions', args: {} }
      });
      if (launcherResult.isError) {
        throw new Error(`launcher trace tool call failed: ${JSON.stringify(launcherResult)}`);
      }
    } finally {
      await launcherClient.close().catch(() => {});
    }

    const launcherEvents = await readEvents(launcherTraceDir);
    if (
      !launcherEvents.some((event) => event.event === 'mcp.request' && event.tool === 'codexpro') ||
      !launcherEvents.some((event) => event.event === 'tool.end' && event.tool === 'codexpro')
    ) {
      throw new Error(`launcher trace directory did not receive MCP/tool events: ${JSON.stringify(launcherEvents)}`);
    }
  } finally {
    await stop(launcher);
  }

  const workspaceTrace = path.join(root, '.ai-bridge', 'traces');
  try {
    await fs.access(workspaceTrace);
    throw new Error('trace files polluted the workspace');
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
  }

  console.log('trace smoke ok');
} finally {
  await stop(child);
  await fs.rm(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
  await fs.rm(home, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
}
