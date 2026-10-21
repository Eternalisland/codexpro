import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

async function getFreePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      const port = typeof address === 'object' && address ? address.port : undefined;
      server.close(() => (port ? resolve(port) : reject(new Error('no free port'))));
    });
    server.on('error', reject);
  });
}

function waitForListening(child) {
  return new Promise((resolve, reject) => {
    let stderr = '';
    const timer = setTimeout(() => reject(new Error(`timeout waiting for HTTP server\n${stderr}`)), 15_000);
    timer.unref();
    child.stderr.on('data', (chunk) => {
      stderr += String(chunk);
      if (stderr.includes('HTTP MCP listening')) {
        clearTimeout(timer);
        resolve();
      }
    });
    child.on('exit', (code) => {
      clearTimeout(timer);
      reject(new Error(`HTTP server exited before listening: ${code}\n${stderr}`));
    });
  });
}

async function waitForExit(child, timeoutMs = 10_000) {
  if (child.exitCode !== null || child.signalCode) return;
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('timeout waiting for HTTP server exit')), timeoutMs);
    timer.unref();
    child.once('exit', () => {
      clearTimeout(timer);
      resolve();
    });
  });
}

async function stopProcessTree(child) {
  if (!child?.pid || child.exitCode !== null || child.signalCode) return;
  if (process.platform === 'win32') {
    spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore' });
  } else {
    try { process.kill(-child.pid, 'SIGTERM'); } catch { try { child.kill('SIGTERM'); } catch {} }
    await new Promise((resolve) => setTimeout(resolve, 300));
    if (child.exitCode === null && !child.signalCode) {
      try { process.kill(-child.pid, 'SIGKILL'); } catch {}
    }
  }
  await waitForExit(child).catch(() => {});
}

async function removeTemp(dir) {
  try {
    await fs.rm(dir, { recursive: true, force: true, maxRetries: 30, retryDelay: 250 });
  } catch (error) {
    if (error?.code !== 'EBUSY') throw error;
  }
}

async function waitForFile(filePath, timeoutMs = 10_000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    try {
      await fs.access(filePath);
      return;
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`timeout waiting for ${filePath}`);
}

async function startServer(root, home, token) {
  const port = await getFreePort();
  const child = spawn('node', ['dist/http.js'], {
    cwd: path.resolve('.'),
    detached: process.platform !== 'win32',
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
      CODEXPRO_TOOL_CARDS: '0'
    },
    stdio: ['ignore', 'ignore', 'pipe']
  });
  await waitForListening(child);
  return { child, url: `http://127.0.0.1:${port}/mcp` };
}

async function withClient(url, token, fn) {
  const client = new Client({ name: 'codexpro-execution-supervisor-smoke', version: '0.1.0' });
  const transport = new StreamableHTTPClientTransport(new URL(url), {
    requestInit: { headers: { Authorization: `Bearer ${token}` } }
  });
  try {
    await client.connect(transport);
    return await fn(client);
  } finally {
    await client.close().catch(() => {});
  }
}

async function callTool(client, name, args = {}) {
  const result = await client.callTool({ name, arguments: args });
  if (result.isError) {
    const message = result.content?.find?.((part) => part.type === 'text')?.text ?? JSON.stringify(result.structuredContent);
    throw new Error(`${name} failed: ${message}`);
  }
  return result;
}

const root = await fs.mkdtemp(path.join(os.tmpdir(), 'codexpro-supervisor-root-'));
const home = await fs.mkdtemp(path.join(os.tmpdir(), 'codexpro-supervisor-home-'));
const external = await fs.mkdtemp(path.join(os.tmpdir(), 'codexpro-supervisor-state-'));
const marker = path.join(external, 'running.marker').replaceAll('\\', '/');
const runs = path.join(external, 'runs.txt').replaceAll('\\', '/');
const token = ['supervisor', 'connector', 'token', 'fixture', '123456'].join('-');
const requestId = 'runner-lease-request-001';

const command = [
  "const fs=require('fs');",
  `const marker=${JSON.stringify(marker)};`,
  `const runs=${JSON.stringify(runs)};`,
  "fs.writeFileSync(marker,'running');",
  "fs.appendFileSync(runs,'start'+String.fromCharCode(10));",
  "setTimeout(()=>{fs.appendFileSync(runs,'done'+String.fromCharCode(10));},7000);"
].join('');

await fs.writeFile(path.join(root, 'package.json'), JSON.stringify({
  scripts: { 'verify:lease': `node -e ${JSON.stringify(command)}` }
}, null, 2), 'utf8');

for (const args of [
  ['init'],
  ['add', 'package.json'],
  ['-c', 'user.email=supervisor@example.invalid', '-c', 'user.name=Supervisor', 'commit', '-m', 'fixture']
]) {
  const result = spawnSync('git', args, { cwd: root, encoding: 'utf8' });
  if (result.status !== 0) throw new Error(`git ${args.join(' ')} failed: ${result.stderr || result.stdout}`);
}

let serverA;
let serverB;
try {
  serverA = await startServer(root, home, token);
  const jobId = await withClient(serverA.url, token, async (client) => {
    const started = await callTool(client, 'start_check', {
      request_id: requestId,
      checks: ['verify:lease'],
      target_paths: ['package.json'],
      timeout_ms: 30_000
    });
    if (started.structuredContent.status !== 'running') {
      throw new Error(`runner lease fixture did not start: ${JSON.stringify(started.structuredContent)}`);
    }
    return started.structuredContent.job_id;
  });

  await waitForFile(marker);
  serverB = await startServer(root, home, token);

  await withClient(serverB.url, token, async (client) => {
    let observed;
    for (let attempt = 0; attempt < 8; attempt += 1) {
      observed = await callTool(client, 'get_check', { request_id: requestId });
      if (observed.structuredContent.runner_lease?.telemetry?.resident_memory_bytes > 0) break;
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
    const lease = observed.structuredContent.runner_lease;
    if (
      observed.structuredContent.job_id !== jobId ||
      !lease?.lease_id ||
      lease.active !== true ||
      lease.owner_alive !== true ||
      lease.owned_by_current_process !== false ||
      !(lease.telemetry?.cpu_time_ms >= 0) ||
      !(lease.telemetry?.resident_memory_bytes > 0) ||
      !(lease.telemetry?.child_process_count >= 0) ||
      observed.structuredContent.can_resume !== false ||
      observed.structuredContent.runtime?.state !== 'running' ||
      observed.structuredContent.runtime?.command !== 'npm run verify:lease' ||
      !(observed.structuredContent.runtime?.resident_memory_bytes > 0) ||
      !observed.structuredContent.log?.includes?.('[runtime]')
    ) {
      throw new Error(`second CodexPro did not observe the active foreign runner lease/runtime diagnostics: ${JSON.stringify(observed.structuredContent)}`);
    }

    const resume = await client.callTool({
      name: 'resume_check',
      arguments: { request_id: requestId }
    });
    const text = resume.content?.find?.((part) => part.type === 'text')?.text ?? '';
    if (!resume.isError || !/lease.*active|active.*lease/i.test(text)) {
      throw new Error(`foreign runner lease did not block resume_check: ${JSON.stringify(resume)}`);
    }
  });

  let completed;
  await withClient(serverA.url, token, async (client) => {
    for (let attempt = 0; attempt < 8; attempt += 1) {
      completed = await callTool(client, 'wait_check', {
        job_id: jobId,
        wait_ms: 2_000,
        max_chars: 5_000
      });
      if (completed.structuredContent.status !== 'running') break;
    }
  });
  if (completed?.structuredContent.status !== 'completed' || completed?.structuredContent.result?.ok !== true) {
    throw new Error(`lease owner did not complete normally: ${JSON.stringify(completed?.structuredContent)}`);
  }

  await withClient(serverB.url, token, async (client) => {
    const refreshed = await callTool(client, 'get_check', { request_id: requestId });
    if (
      refreshed.structuredContent.status !== 'completed' ||
      refreshed.structuredContent.result?.ok !== true ||
      refreshed.structuredContent.runner_lease?.state !== 'released' ||
      refreshed.structuredContent.runner_lease?.active !== false
    ) {
      throw new Error(`secondary CodexPro did not refresh the completed durable runner state: ${JSON.stringify(refreshed.structuredContent)}`);
    }

    const listed = await callTool(client, 'list_checks', {});
    const listedJob = listed.structuredContent.jobs?.find((job) => job.job_id === jobId);
    if (listedJob?.status !== 'completed' || listedJob?.runner_lease?.state !== 'released') {
      throw new Error(`list_checks did not refresh the completed runner lease: ${JSON.stringify(listed.structuredContent)}`);
    }
  });

  const lines = (await fs.readFile(runs, 'utf8')).trim().split(/\r?\n/).filter(Boolean);
  if (JSON.stringify(lines) !== JSON.stringify(['start', 'done'])) {
    throw new Error(`foreign CodexPro duplicated the supervised execution: ${JSON.stringify(lines)}`);
  }

  console.log('execution supervisor smoke ok');
} finally {
  if (serverA) await stopProcessTree(serverA.child);
  if (serverB) await stopProcessTree(serverB.child);
  await removeTemp(root);
  await removeTemp(home);
  await removeTemp(external);
}
