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

async function stopServerOnly(child) {
  if (!child?.pid || child.exitCode !== null || child.signalCode) return;
  if (process.platform === 'win32') {
    spawnSync('taskkill', ['/PID', String(child.pid), '/F'], { stdio: 'ignore' });
  } else {
    try { child.kill('SIGKILL'); } catch {}
  }
  await waitForExit(child).catch(() => {});
}

async function stopProcessTree(child) {
  if (!child?.pid || child.exitCode !== null || child.signalCode) return;
  if (process.platform === 'win32') {
    spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore' });
  } else {
    try {
      process.kill(-child.pid, 'SIGTERM');
    } catch {
      try { child.kill('SIGTERM'); } catch {}
    }
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
    process.stderr.write(`warning: temporary recovery fixture remained busy: ${dir}\n`);
  }
}

async function readReceipt(home, jobId) {
  const jobsRoot = path.join(home, 'runtime', 'check-jobs');
  const workspaces = await fs.readdir(jobsRoot).catch(() => []);
  for (const workspaceDir of workspaces) {
    const candidate = path.join(jobsRoot, workspaceDir, `${jobId}.json`);
    try {
      return JSON.parse(await fs.readFile(candidate, 'utf8'));
    } catch {}
  }
  return undefined;
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
  const client = new Client({ name: 'codexpro-check-recovery-smoke', version: '0.1.0' });
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

const root = await fs.mkdtemp(path.join(os.tmpdir(), 'codexpro-check-recovery-root-'));
const home = await fs.mkdtemp(path.join(os.tmpdir(), 'codexpro-check-recovery-home-'));
const external = await fs.mkdtemp(path.join(os.tmpdir(), 'codexpro-check-recovery-state-'));
const marker = path.join(external, 'first-run.marker').replaceAll('\\', '/');
const resumed = path.join(external, 'resumed.txt').replaceAll('\\', '/');
const orphanMarker = path.join(external, 'orphan.marker').replaceAll('\\', '/');
const orphanRuns = path.join(external, 'orphan-runs.txt').replaceAll('\\', '/');
const token = ['recovery', 'connector', 'token', 'fixture', '123456'].join('-');
const requestId = 'restart-recovery-request-001';
const orphanRequestId = 'orphan-recovery-request-001';

const command = [
  "const fs=require('fs');",
  `const marker=${JSON.stringify(marker)};`,
  `const resumed=${JSON.stringify(resumed)};`,
  "if(!fs.existsSync(marker)){fs.writeFileSync(marker,'started');console.log('first-run-started');setTimeout(()=>process.exit(0),5000);}else{fs.appendFileSync(resumed,'resumed\\n');console.log('resume-complete');}"
].join('');
const orphanCommand = [
  "const fs=require('fs');",
  `const marker=${JSON.stringify(orphanMarker)};`,
  `const runs=${JSON.stringify(orphanRuns)};`,
  "if(!fs.existsSync(marker)){fs.writeFileSync(marker,'started');fs.appendFileSync(runs,'original'+String.fromCharCode(10));console.log('orphan-original-started');setTimeout(()=>{fs.appendFileSync(runs,'original-done'+String.fromCharCode(10));},8000);}else{fs.appendFileSync(runs,'resumed'+String.fromCharCode(10));console.log('orphan-resume-complete');}"
].join('');
await fs.writeFile(path.join(root, 'package.json'), JSON.stringify({
  scripts: {
    'verify:restart': `node -e ${JSON.stringify(command)}`,
    'verify:orphan': `node -e ${JSON.stringify(orphanCommand)}`
  }
}, null, 2), 'utf8');

for (const args of [
  ['init'],
  ['add', 'package.json'],
  ['-c', 'user.email=recovery@example.invalid', '-c', 'user.name=Recovery', 'commit', '-m', 'fixture']
]) {
  const result = spawnSync('git', args, { cwd: root, encoding: 'utf8' });
  if (result.status !== 0) throw new Error(`git ${args.join(' ')} failed: ${result.stderr || result.stdout}`);
}

let firstServer;
let secondServer;
let thirdServer;
let orphanServer;
let orphanRecoveryServer;
try {
  firstServer = await startServer(root, home, token);
  const firstJobId = await withClient(firstServer.url, token, async (client) => {
    const started = await callTool(client, 'start_check', {
      request_id: requestId,
      checks: ['verify:restart'],
      target_paths: ['package.json'],
      timeout_ms: 30_000
    });
    if (started.structuredContent.reused !== false || started.structuredContent.status !== 'running') {
      throw new Error(`expected fresh running job: ${JSON.stringify(started.structuredContent)}`);
    }
    return started.structuredContent.job_id;
  });

  await waitForFile(marker);
  await stopProcessTree(firstServer.child);
  firstServer = undefined;

  const statusAfterCrash = spawnSync('git', ['status', '--porcelain'], { cwd: root, encoding: 'utf8' });
  if (statusAfterCrash.status !== 0 || statusAfterCrash.stdout.trim()) {
    throw new Error(`durable receipt polluted workspace git state: ${statusAfterCrash.stderr || statusAfterCrash.stdout}`);
  }

  secondServer = await startServer(root, home, token);
  await withClient(secondServer.url, token, async (client) => {
    const tools = await client.listTools();
    if (!tools.tools.some((tool) => tool.name === 'resume_check')) {
      throw new Error('resume_check was not registered after restart');
    }

    const recoveredWork = await callTool(client, 'recover_work', {});
    if (
      recoveredWork.structuredContent.suggested_action?.action !== 'resume_check' ||
      recoveredWork.structuredContent.suggested_action?.job_id !== firstJobId
    ) {
      throw new Error(`recover_work did not recommend resuming the interrupted job: ${JSON.stringify(recoveredWork.structuredContent)}`);
    }

    const recovered = await callTool(client, 'get_check', { request_id: requestId });
    if (recovered.structuredContent.job_id !== firstJobId || recovered.structuredContent.status !== 'interrupted' || !recovered.structuredContent.interrupted_at || recovered.structuredContent.completed_at) {
      throw new Error(`expected interrupted persisted job after restart: ${JSON.stringify(recovered.structuredContent)}`);
    }

    const packagePath = path.join(root, 'package.json');
    const packageBefore = await fs.readFile(packagePath, 'utf8');
    await fs.writeFile(packagePath, packageBefore + '\n', 'utf8');
    const staleResume = await client.callTool({
      name: 'resume_check',
      arguments: { request_id: requestId }
    });
    const staleText = staleResume.content?.find?.((part) => part.type === 'text')?.text ?? '';
    if (!staleResume.isError || !staleText.includes('Workspace changed')) {
      throw new Error(`resume_check did not reject a changed workspace: ${JSON.stringify(staleResume)}`);
    }
    await fs.writeFile(packagePath, packageBefore, 'utf8');

    const resumedJob = await callTool(client, 'resume_check', { request_id: requestId });
    if (resumedJob.structuredContent.job_id !== firstJobId || !['running', 'completed'].includes(resumedJob.structuredContent.status)) {
      throw new Error(`resume_check did not restart the interrupted job: ${JSON.stringify(resumedJob.structuredContent)}`);
    }

    let final = resumedJob;
    for (let attempt = 0; attempt < 8 && final.structuredContent.status === 'running'; attempt += 1) {
      final = await callTool(client, 'wait_check', {
        job_id: firstJobId,
        wait_ms: 2_000,
        max_chars: 5_000
      });
    }
    if (final.structuredContent.status !== 'completed' || final.structuredContent.result?.ok !== true) {
      throw new Error(`resumed job did not complete: ${JSON.stringify(final.structuredContent)}`);
    }
  });

  await stopProcessTree(secondServer.child);
  secondServer = undefined;

  thirdServer = await startServer(root, home, token);
  await withClient(thirdServer.url, token, async (client) => {
    const durableCompleted = await callTool(client, 'get_check', { request_id: requestId });
    if (
      durableCompleted.structuredContent.status !== 'completed' ||
      durableCompleted.structuredContent.result?.ok !== true ||
      !durableCompleted.structuredContent.interrupted_at ||
      !durableCompleted.structuredContent.resumed_at ||
      !durableCompleted.structuredContent.completed_at
    ) {
      throw new Error(`completed receipt did not survive a second restart: ${JSON.stringify(durableCompleted.structuredContent)}`);
    }
  });

  await stopProcessTree(thirdServer.child);
  thirdServer = undefined;

  orphanServer = await startServer(root, home, token);
  const orphanJobId = await withClient(orphanServer.url, token, async (client) => {
    const started = await callTool(client, 'start_check', {
      request_id: orphanRequestId,
      checks: ['verify:orphan'],
      target_paths: ['package.json'],
      timeout_ms: 30_000
    });
    if (started.structuredContent.status !== 'running') {
      throw new Error(`expected orphan fixture to start running: ${JSON.stringify(started.structuredContent)}`);
    }
    return started.structuredContent.job_id;
  });

  await waitForFile(orphanMarker);
  await withClient(orphanServer.url, token, async (client) => {
    const liveOwner = await callTool(client, 'get_check', { request_id: orphanRequestId });
    if (!liveOwner.structuredContent.active_process?.pid || liveOwner.structuredContent.process_active !== true) {
      throw new Error(`running orphan fixture did not expose active process ownership: ${JSON.stringify(liveOwner.structuredContent)}`);
    }
  });
  const receiptBeforeCrash = await readReceipt(home, orphanJobId);
  if (!receiptBeforeCrash?.activeProcess?.pid) {
    throw new Error(`running orphan fixture did not persist active process ownership: ${JSON.stringify(receiptBeforeCrash)}`);
  }

  await stopServerOnly(orphanServer.child);
  orphanServer = undefined;

  const receiptAfterCrash = await readReceipt(home, orphanJobId);
  if (!receiptAfterCrash?.activeProcess?.pid) {
    throw new Error(`active process ownership disappeared from receipt during parent crash: ${JSON.stringify(receiptAfterCrash)}`);
  }

  orphanRecoveryServer = await startServer(root, home, token);
  await withClient(orphanRecoveryServer.url, token, async (client) => {
    const recovered = await callTool(client, 'get_check', { request_id: orphanRequestId });
    if (
      recovered.structuredContent.job_id !== orphanJobId ||
      recovered.structuredContent.status !== 'interrupted' ||
      recovered.structuredContent.process_active !== true ||
      recovered.structuredContent.can_resume !== false ||
      !recovered.structuredContent.active_process?.pid
    ) {
      throw new Error(`expected orphaned job to recover as active interrupted work: ${JSON.stringify(recovered.structuredContent)}`);
    }

    const recoveredWork = await callTool(client, 'recover_work', {});
    if (
      recoveredWork.structuredContent.suggested_action?.action !== 'wait_check' ||
      recoveredWork.structuredContent.suggested_action?.job_id !== orphanJobId
    ) {
      throw new Error(`recover_work did not wait for the still-active orphan runner: ${JSON.stringify(recoveredWork.structuredContent)}`);
    }

    const listedActive = await callTool(client, 'list_checks', {
      status: ['interrupted']
    });
    const listedOrphan = listedActive.structuredContent.jobs?.find((job) => job.job_id === orphanJobId);
    if (!listedOrphan || listedOrphan.process_active !== true || listedOrphan.can_resume !== false) {
      throw new Error(`list_checks did not expose orphan process safety state: ${JSON.stringify(listedActive.structuredContent)}`);
    }

    const unsafeResume = await client.callTool({
      name: 'resume_check',
      arguments: { request_id: orphanRequestId }
    });
    const unsafeText = unsafeResume.content?.find?.((part) => part.type === 'text')?.text ?? '';
    if (!unsafeResume.isError || !unsafeText.includes('still active')) {
      throw new Error(`resume_check did not block while the original validation process was still active: ${JSON.stringify(unsafeResume)}`);
    }

    const startedWaiting = Date.now();
    while (Date.now() - startedWaiting < 15_000) {
      const runText = await fs.readFile(orphanRuns, 'utf8').catch(() => '');
      if (runText.includes('original-done')) break;
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
    const beforeResume = await fs.readFile(orphanRuns, 'utf8');
    if (!beforeResume.includes('original-done') || beforeResume.includes('resumed')) {
      throw new Error(`orphan fixture did not settle before safe resume: ${JSON.stringify(beforeResume)}`);
    }

    let ownerSettled = false;
    for (let attempt = 0; attempt < 20; attempt += 1) {
      const owner = await callTool(client, 'get_check', { request_id: orphanRequestId });
      if (owner.structuredContent.process_active === false) {
        if (owner.structuredContent.can_resume !== true) {
          throw new Error(`settled orphan job was not resumable: ${JSON.stringify(owner.structuredContent)}`);
        }
        ownerSettled = true;
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
    if (!ownerSettled) {
      throw new Error('orphan validation process tree remained active after its fixture completed');
    }

    let resumedOrphan = await callTool(client, 'resume_check', { request_id: orphanRequestId });
    for (let attempt = 0; attempt < 8 && resumedOrphan.structuredContent.status === 'running'; attempt += 1) {
      resumedOrphan = await callTool(client, 'wait_check', {
        job_id: orphanJobId,
        wait_ms: 2_000,
        max_chars: 5_000
      });
    }
    if (resumedOrphan.structuredContent.status !== 'completed' || resumedOrphan.structuredContent.result?.ok !== true) {
      throw new Error(`orphaned job did not complete after the original process exited: ${JSON.stringify(resumedOrphan.structuredContent)}`);
    }
  });

  const orphanLines = (await fs.readFile(orphanRuns, 'utf8')).trim().split(/\r?\n/).filter(Boolean);
  if (JSON.stringify(orphanLines) !== JSON.stringify(['original', 'original-done', 'resumed'])) {
    throw new Error(`orphan recovery executed an unexpected sequence: ${JSON.stringify(orphanLines)}`);
  }

  const resumedText = await fs.readFile(resumed, 'utf8');
  if (resumedText.trim().split(/\r?\n/).filter(Boolean).length !== 1) {
    throw new Error(`resume executed an unexpected number of times: ${JSON.stringify(resumedText)}`);
  }

  console.log('check recovery smoke ok');
} finally {
  if (firstServer) await stopProcessTree(firstServer.child);
  if (secondServer) await stopProcessTree(secondServer.child);
  if (thirdServer) await stopProcessTree(thirdServer.child);
  if (orphanServer) await stopProcessTree(orphanServer.child);
  if (orphanRecoveryServer) await stopProcessTree(orphanRecoveryServer.child);
  await removeTemp(root);
  await removeTemp(home);
  await removeTemp(external);
}
