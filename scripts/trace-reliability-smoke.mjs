import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { loadConfig } from '../dist/config.js';
import { createCodexProServer } from '../dist/server.js';
import { ProtocolTraceManager } from '../dist/protocolTrace.js';
import { runTraceCli } from './trace-cli.mjs';

/**
 * V100(20261019) yijiakang 【可靠性修复】回归 Trace 故障隔离及轮转顺序，任务号:20260509145520000648
 */
const verNum = 'V100(20261019)';

const scratch = await fs.mkdtemp(path.join(os.tmpdir(), 'codexpro-trace-reliability-'));
const tests = [];
const test = (name, run) => tests.push({ name, run });
const configFor = (dir) => ({ mode: 'redacted', dir, maxBodyBytes: 4096,
  maxFileBytes: 65536, retentionDays: 7 });
const contextFor = (trace) => trace.createHttpContext({
  requestId: 'trace-reliability-request', body: { method: 'tools/call' }
});

async function captureWarnings(run) {
  const original = console.warn;
  const warnings = [];
  console.warn = (...args) => warnings.push(args.join(' '));
  try { await run(warnings); } finally { console.warn = original; }
}

async function jsonCli(args) {
  let output = '';
  await runTraceCli([...args, '--json'], { stdout: { write: (value) => { output += value; } } });
  return JSON.parse(output);
}

test('rotated trace files use base, .1, .2, .10 order for tail and --last', async () => {
  const dir = path.join(scratch, 'rotations');
  await fs.mkdir(dir);
  for (const [suffix, minute, id] of [['', 1, 'base'], ['.1', 2, 'one'], ['.2', 3, 'two'], ['.10', 4, 'ten']]) {
    await fs.writeFile(path.join(dir, `trace-2026-10-19${suffix}.jsonl`), JSON.stringify({
      ts: `2026-10-19T00:0${minute}:00Z`, event: 'tool.end', trace_id: id
    }) + '\n');
  }
  const tail = await jsonCli(['tail', '--lines', '4', '--trace-dir', dir]);
  assert.deepEqual(tail.map((event) => event.trace_id), ['base', 'one', 'two', 'ten']);
  const last = await jsonCli(['show', '--last', '--trace-dir', dir]);
  assert.deepEqual(last.map((event) => event.trace_id), ['ten']);
});

test('an invalid trace directory never rejects recording or flush', async () => {
  const blocker = path.join(scratch, 'private-trace-directory');
  await fs.writeFile(blocker, 'directory blocked by a file');
  const trace = new ProtocolTraceManager(configFor(path.join(blocker, 'traces')));
  await captureWarnings(async (warnings) => {
    await trace.run(contextFor(trace), async () => {
      await trace.recordRequest({ method: 'initialize' });
      const span = await trace.toolStart('read', { path: 'hello.txt' });
      assert.equal(typeof span.spanId, 'string');
      await trace.toolEnd({ tool: 'read', ...span, status: 'ok', result: { content: [] } });
      await trace.recordResponse({ statusCode: 200, body: { result: 'ok' } });
    });
    await trace.flush();
    assert.equal(warnings.length, 1, 'persistent failures must produce one bounded warning');
    assert.match(warnings[0], /Trace.*failed.*MCP.*continue/i);
    assert.ok(!warnings[0].includes(blocker), 'warning must not expose the trace path');
  });
});

test('a failed append settles its queue and later events can still be written', async () => {
  const dir = path.join(scratch, 'append-recovery');
  const trace = new ProtocolTraceManager(configFor(dir));
  const originalAppend = fs.appendFile;
  const sensitive = 'synthetic-private-path-and-payload';
  await captureWarnings(async (warnings) => {
    try {
      fs.appendFile = async () => { throw Object.assign(new Error(sensitive), { code: 'EACCES' }); };
      await trace.run(contextFor(trace), () => trace.recordRequest({ first: true }));
      await trace.flush();
    } finally { fs.appendFile = originalAppend; }
    await trace.run(contextFor(trace), () => trace.recordRequest({ recovered: true }));
    await trace.flush();
    const text = await fs.readFile(path.join(dir, `trace-${new Date().toISOString().slice(0, 10)}.jsonl`), 'utf8');
    assert.match(text, /recovered/);
    assert.equal(warnings.length, 1);
    assert.match(warnings[0], /EACCES/);
    assert.ok(!warnings[0].includes(sensitive));
  });
});

test('synchronous trace serialization failures are isolated before queueing', async () => {
  const dir = path.join(scratch, 'serialization');
  const trace = new ProtocolTraceManager(configFor(dir));
  const sensitive = 'synthetic-sensitive-getter';
  const payload = Object.defineProperty({}, 'value', {
    enumerable: true, get() { throw new Error(sensitive); }
  });
  await captureWarnings(async (warnings) => {
    await trace.run(contextFor(trace), async () => {
      await trace.recordRequest(payload);
      // BigInt survives structural redaction but JSON.stringify cannot serialize it.
      await trace.recordSse(contextFor(trace), 'chunk', { unsupported: 1n });
      await trace.recordRequest({ afterSerializationFailure: true });
    });
    await trace.flush();
    assert.equal(warnings.length, 1);
    assert.ok(!warnings[0].includes(sensitive));
    const text = await fs.readFile(path.join(dir, `trace-${new Date().toISOString().slice(0, 10)}.jsonl`), 'utf8');
    assert.match(text, /afterSerializationFailure/);
  });
});

test('recording and flush still await the ordered append queue', async () => {
  const dir = path.join(scratch, 'ordered-queue');
  const trace = new ProtocolTraceManager(configFor(dir));
  const originalAppend = fs.appendFile;
  let release;
  let entered;
  const holdFirstAppend = new Promise((resolve) => { release = resolve; });
  const firstAppendEntered = new Promise((resolve) => { entered = resolve; });
  const appended = [];
  fs.appendFile = async (file, text, options) => {
    appended.push(JSON.parse(text).payload.body.sequence);
    if (appended.length === 1) { entered(); await holdFirstAppend; }
    return originalAppend(file, text, options);
  };
  let first;
  let second;
  let flushed;
  try {
    first = trace.run(contextFor(trace), () => trace.recordRequest({ sequence: 1 }));
    await firstAppendEntered;
    second = trace.run(contextFor(trace), () => trace.recordRequest({ sequence: 2 }));
    let recordingDone = false;
    let flushDone = false;
    void second.then(() => { recordingDone = true; });
    flushed = trace.flush().then(() => { flushDone = true; });
    // A controlled append barrier proves waiting semantics without arbitrary sleeps.
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(appended, [1]);
    assert.equal(recordingDone, false);
    assert.equal(flushDone, false);
    release();
    await Promise.all([first, second, flushed]);
    assert.deepEqual(appended, [1, 2]);
    assert.equal(flushDone, true);
  } finally {
    release();
    await Promise.allSettled([first, second, flushed]);
    fs.appendFile = originalAppend;
  }
});

for (const stage of ['toolStart', 'toolEnd']) {
  test(`${stage} failures preserve successful tools and real business errors`, async () => {
    const root = path.join(scratch, stage);
    await fs.mkdir(root);
    const config = { ...loadConfig(['--root', root, '--bash', 'off', '--write', 'workspace']),
      allowedRoots: [root], toolMode: 'full', toolCards: false };
    const trace = new ProtocolTraceManager(configFor(path.join(root, 'traces')));
    trace[stage] = () => { throw Object.assign(new Error('synthetic-trace-error'), { code: 'EIO' }); };
    const server = createCodexProServer(config, { protocolTraceManager: trace });
    const client = new Client({ name: 'trace-wrapper-regression', version: '1.0.0' });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    try {
      await server.connect(serverTransport);
      await client.connect(clientTransport);
      await captureWarnings(async (warnings) => {
        const result = await client.callTool({ name: 'write', arguments: { path: 'written.txt', content: 'business-success\n' } });
        assert.notEqual(result.isError, true);
        assert.equal(await fs.readFile(path.join(root, 'written.txt'), 'utf8'), 'business-success\n');
        const failure = await client.callTool({ name: 'read', arguments: { path: 'missing-business-file.txt' } });
        assert.equal(failure.isError, true);
        const message = failure.content.filter((item) => item.type === 'text').map((item) => item.text).join('\n');
        assert.match(message, /missing-business-file|ENOENT|does not exist|not found/i);
        assert.ok(!message.includes('synthetic-trace-error'));
        assert.equal(warnings.length, 1);
      });
    } finally {
      await client.close();
      await server.close();
    }
  });
}

async function freePort() {
  const server = net.createServer();
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  const { port } = server.address();
  await new Promise((resolve) => server.close(resolve));
  return port;
}

test('HTTP initialization and file tools work when Trace cannot write', async () => {
  const root = path.join(scratch, 'http-workspace');
  await fs.mkdir(root);
  const blocker = path.join(scratch, 'http-private-trace-blocker');
  await fs.writeFile(blocker, 'not a directory');
  const traceDir = path.join(blocker, 'traces');
  const token = randomBytes(32).toString('hex');
  const port = await freePort();
  const child = spawn(process.execPath, ['dist/http.js'], {
    cwd: path.resolve('.'), stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, CODEXPRO_ROOT: root, CODEXPRO_ALLOWED_ROOTS: root,
      CODEXPRO_HOST: '127.0.0.1', CODEXPRO_PORT: String(port), CODEXPRO_HTTP_TOKEN: token,
      CODEXPRO_BASH_MODE: 'off', CODEXPRO_WRITE_MODE: 'workspace', CODEXPRO_TOOL_MODE: 'full',
      CODEXPRO_TOOL_CARDS: '0', CODEXPRO_MCP_TRACE: 'redacted', CODEXPRO_MCP_TRACE_DIR: traceDir }
  });
  let stderr = '';
  child.stdout.resume();
  child.stderr.on('data', (chunk) => { stderr = (stderr + chunk).slice(-64000); });
  const client = new Client({ name: 'trace-http-regression', version: '1.0.0' });
  try {
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('HTTP server did not start')), 15000);
      const onData = () => {
        if (!stderr.includes('HTTP MCP listening')) return;
        clearTimeout(timer); child.stderr.off('data', onData); resolve();
      };
      child.stderr.on('data', onData);
      child.once('exit', () => { clearTimeout(timer); reject(new Error('HTTP server exited before startup')); });
    });
    await client.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${port}/mcp`), {
      requestInit: { headers: { Authorization: `Bearer ${token}` } }
    }), { timeout: 5000 });
    assert.ok((await client.listTools()).tools.some((tool) => tool.name === 'write'));
    const result = await client.callTool({ name: 'write', arguments: { path: 'http-success.txt', content: 'http-business-success\n' } });
    assert.notEqual(result.isError, true);
    assert.equal(await fs.readFile(path.join(root, 'http-success.txt'), 'utf8'), 'http-business-success\n');
    const failure = await client.callTool({ name: 'read', arguments: { path: 'missing-http-business-file.txt' } });
    assert.equal(failure.isError, true);
    const warnings = stderr.split(/\r?\n/).filter((line) => line.includes('[CodexPro Trace]'));
    assert.equal(warnings.length, 1);
    assert.ok(!warnings.join('\n').includes(traceDir));
    assert.ok(!warnings.join('\n').includes(token));
  } finally {
    await client.close().catch(() => {});
    if (child.exitCode === null && child.signalCode === null) {
      const stopped = new Promise((resolve) => child.once('exit', resolve));
      child.kill('SIGTERM');
      await stopped;
    }
  }
});

let failures = 0;
try {
  for (const { name, run } of tests) {
    try { await run(); console.log(`PASS ${name}`); }
    catch (error) { failures++; console.error(`FAIL ${name}: ${error.message}`); }
  }
} finally {
  // Only remove the unique temporary fixture directory created by this script.
  await fs.rm(scratch, { recursive: true, force: true });
}
if (failures) process.exitCode = 1;
else console.log(`trace reliability smoke ok (${tests.length} cases, ${verNum})`);
