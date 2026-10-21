import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { hasNewSecretValue } from '../dist/redact.js';

const tokenPrefix = String.fromCharCode(115, 107, 45);
const existingToken = tokenPrefix + 'existingFixtureToken123456';
const introducedToken = tokenPrefix + 'introducedFixtureToken987654';
if (hasNewSecretValue(`${existingToken}\nkeep`, `${existingToken}\nchanged`)) {
  throw new Error('unchanged pre-existing sensitive fixture was treated as newly introduced');
}
if (!hasNewSecretValue(existingToken, `${existingToken}\n${introducedToken}`)) {
  throw new Error('newly introduced sensitive value was not detected');
}

function encode(message) {
  return `${JSON.stringify(message)}\n`;
}

function windowsProcessTree(rootPid) {
  if (process.platform !== 'win32' || !rootPid) return [];
  const script = [
    '$root=' + Number(rootPid),
    '$items=Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId,Name,CommandLine',
    '$pending=@($root)',
    '$seen=@{}',
    '$out=@()',
    'while($pending.Count -gt 0){$p=$pending[0];if($pending.Count -eq 1){$pending=@()}else{$pending=$pending[1..($pending.Count-1)]};foreach($x in $items){if($x.ParentProcessId -eq $p -and -not $seen.ContainsKey([string]$x.ProcessId)){$seen[[string]$x.ProcessId]=$true;$out+=$x;$pending+=@($x.ProcessId)}}}',
    '$out | ConvertTo-Json -Compress'
  ].join(';');
  const result = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], {
    encoding: 'utf8',
    timeout: 4_000,
    windowsHide: true
  });
  if (result.status !== 0 || !result.stdout.trim()) return [];
  try {
    const parsed = JSON.parse(result.stdout);
    return Array.isArray(parsed) ? parsed : [parsed];
  } catch {
    return [];
  }
}

class McpStdioClient {
  constructor(command, args, options) {
    this.child = spawn(command, args, options);
    this.buffer = '';
    this.nextId = 1;
    this.pending = new Map();
    this.child.stdout.on('data', (chunk) => this.onData(String(chunk)));
    this.child.stderr.on('data', (chunk) => process.stderr.write(chunk));
    this.child.on('exit', (code) => {
      for (const { reject } of this.pending.values()) reject(new Error(`server exited ${code}`));
    });
  }

  onData(chunk) {
    this.buffer += chunk;
    while (true) {
      const index = this.buffer.indexOf('\n');
      if (index < 0) return;
      const line = this.buffer.slice(0, index).replace(/\r$/, '');
      this.buffer = this.buffer.slice(index + 1);
      if (!line.trim()) continue;
      const message = JSON.parse(line);
      if (!message.id || !this.pending.has(message.id)) continue;
      const { resolve, reject, timer } = this.pending.get(message.id);
      clearTimeout(timer);
      this.pending.delete(message.id);
      if (message.error) reject(new Error(message.error.message));
      else resolve(message.result);
    }
  }

  request(method, params) {
    const id = this.nextId++;
    this.child.stdin.write(encode({ jsonrpc: '2.0', id, method, params }));
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`timeout waiting for ${method}`)), 30_000);
      timer.unref();
      this.pending.set(id, { resolve, reject, timer });
    });
  }

  notify(method, params = {}) {
    this.child.stdin.write(encode({ jsonrpc: '2.0', method, params }));
  }

  async close() {
    if (this.child.exitCode !== null || this.child.signalCode) return;
    this.child.kill();
    await new Promise((resolve) => {
      const timer = setTimeout(resolve, 5_000);
      timer.unref();
      this.child.once('exit', () => {
        clearTimeout(timer);
        resolve();
      });
    });
  }
}

const root = await fs.mkdtemp(path.join(os.tmpdir(), 'codexpro-verification-'));
const home = await fs.mkdtemp(path.join(os.tmpdir(), 'codexpro-verification-home-'));
await fs.mkdir(path.join(root, 'src'), { recursive: true });
await fs.writeFile(path.join(root, 'src', 'value.ts'), 'export const value = 1;\n', 'utf8');
await fs.writeFile(path.join(root, 'package.json'), JSON.stringify({
  scripts: {
    build: `node -e "console.log('build ok')"`,
    smoke: `node -e "console.log('smoke ok')"`,
    'test:fail': `node -e "console.error('src/value.ts(7,3): error TS9999: expected true'); process.exit(1)"`,
    'verify:mutate': `node -e "require('fs').appendFileSync('src/value.ts', '// mutated\\n')"`,
    'verify:output-limit': `node -e "process.stdout.write('x'.repeat(12000))"`,
    'verify:managed': `node -e "console.log('managed-start'); console.log('x'.repeat(600)); setTimeout(() => console.log('managed-done'), 250)"`,
    'verify:runtime': `node -e "console.log('phase=started'); setTimeout(() => console.log('phase=done'), 6500)"`,
    'verify:silent-runtime': `node -e "setTimeout(()=>{},6500)"`,
    'verify:timeout-runtime': `node -e "setTimeout(()=>{},10000)"`,
    'verify:stream-redaction': `node -e "const s=String.fromCharCode(115,107,45)+Array(24).fill('a').join(''); process.stdout.write(s.slice(0,7)); setTimeout(()=>process.stdout.write(s.slice(7)+String.fromCharCode(10)),250)"`,
    'verify:cancel': `node -e "let i=0; setInterval(() => console.log('tick-' + (++i)), 100)"`
  }
}, null, 2), 'utf8');

for (const args of [
  ['init'],
  ['add', 'package.json', 'src/value.ts'],
  ['-c', 'user.email=verification@example.invalid', '-c', 'user.name=Verification', 'commit', '-m', 'fixture']
]) {
  const result = spawnSync('git', args, { cwd: root, encoding: 'utf8' });
  if (result.status !== 0) throw new Error(`git ${args.join(' ')} failed: ${result.stderr || result.stdout}`);
}

const client = new McpStdioClient('node', ['dist/stdio.js', '--root', root, '--allow-root', root, '--bash', 'safe', '--tool-mode', 'full'], {
  cwd: path.resolve('.'),
  env: {
    ...process.env,
    CODEXPRO_ROOT: root,
    CODEXPRO_ALLOWED_ROOTS: root,
    CODEXPRO_HOME: home,
    CODEXPRO_MAX_OUTPUT_BYTES: '4000',
    CODEXPRO_TOOL_CARDS: '0'
  }
});

try {
  await client.request('initialize', {
    protocolVersion: '2024-11-05',
    capabilities: {},
    clientInfo: { name: 'codexpro-verification-smoke', version: '0.1.0' }
  });
  client.notify('notifications/initialized');

  const tools = await client.request('tools/list', {});
  const names = tools.tools.map((tool) => tool.name);
  for (const required of ['run_checks', 'start_check', 'get_check', 'list_checks', 'resume_check', 'wait_check', 'stop_check', 'recover_work', 'read_many']) {
    if (!names.includes(required)) throw new Error(`${required} was not registered: ${names.join(', ')}`);
  }

  const opened = await client.request('tools/call', {
    name: 'open_current_workspace',
    arguments: { include_tree: false }
  });
  const repository = opened.structuredContent.repositories?.[0];
  const project = opened.structuredContent.projects?.find((item) => item.path === '.');
  if (
    opened.isError ||
    repository?.path !== '.' ||
    repository?.dirty !== false ||
    !project ||
    !project.runners?.includes('npm') ||
    !project.checks?.some((item) => item.check === 'build' && item.command === 'npm run build' && item.cwd === '.' && item.runnable === true)
  ) {
    throw new Error(`workspace discovery did not expose repositories/projects: ${JSON.stringify(opened.structuredContent)}`);
  }

  const many = await client.request('tools/call', {
    name: 'read_many',
    arguments: {
      files: [
        { path: 'src/value.ts', start_line: 1, end_line: 1 },
        { path: 'package.json', start_line: 1, end_line: 4 },
        { path: 'missing.txt', start_line: 1, end_line: 1 }
      ]
    }
  });
  if (
    many.isError ||
    many.structuredContent.results?.length !== 2 ||
    many.structuredContent.errors?.length !== 1 ||
    many.structuredContent.results?.[0]?.path !== 'src/value.ts'
  ) {
    throw new Error(`read_many did not return partial structured results: ${JSON.stringify(many.structuredContent)}`);
  }

  const managed = await client.request('tools/call', {
    name: 'start_check',
    arguments: { checks: ['verify:managed'], target_paths: ['src/value.ts'], timeout_ms: 30_000 }
  });
  const managedId = managed.structuredContent.job_id;
  if (managed.isError || !managedId || managed.structuredContent.status !== 'running') {
    throw new Error(`start_check did not return a running job: ${JSON.stringify(managed.structuredContent)}`);
  }
  let managedDone;
  for (let attempt = 0; attempt < 6; attempt += 1) {
    managedDone = await client.request('tools/call', {
      name: 'wait_check',
      arguments: { job_id: managedId, wait_ms: 3_000, cursor: 0, max_chars: 180 }
    });
    if (managedDone.isError || managedDone.structuredContent.status !== 'running') break;
  }
  if (
    managedDone?.isError ||
    managedDone?.structuredContent.status !== 'completed' ||
    managedDone?.structuredContent.result?.ok !== true ||
    !managedDone?.structuredContent.log ||
    managedDone?.structuredContent.has_more !== true ||
    !(managedDone?.structuredContent.next_cursor > 0)
  ) {
    throw new Error(`wait_check did not eventually return completed paginated output: ${JSON.stringify(managedDone?.structuredContent)}`);
  }
  const managedTail = await client.request('tools/call', {
    name: 'wait_check',
    arguments: { job_id: managedId, cursor: managedDone.structuredContent.next_cursor, max_chars: 5_000 }
  });
  if (managedTail.isError || !managedTail.structuredContent.log?.includes?.('managed-done')) {
    throw new Error(`wait_check pagination lost the final output: ${JSON.stringify(managedTail.structuredContent)}`);
  }

  const runtime = await client.request('tools/call', {
    name: 'start_check',
    arguments: { checks: ['verify:runtime'], target_paths: ['src/value.ts'], timeout_ms: 30_000 }
  });
  const runtimeId = runtime.structuredContent.job_id;
  const runtimeProgress = await client.request('tools/call', {
    name: 'wait_check',
    arguments: { job_id: runtimeId, wait_ms: 3_000, cursor: 0, max_chars: 5_000 }
  });
  const recoveredWork = await client.request('tools/call', {
    name: 'recover_work',
    arguments: {}
  });
  if (
    recoveredWork.isError ||
    recoveredWork.structuredContent.suggested_action?.action !== 'wait_check' ||
    recoveredWork.structuredContent.suggested_action?.job_id !== runtimeId ||
    recoveredWork.structuredContent.latest_check?.job_id !== runtimeId ||
    recoveredWork.structuredContent.latest_check?.runtime?.command !== 'npm run verify:runtime'
  ) {
    await client.request('tools/call', {
      name: 'stop_check',
      arguments: { job_id: runtimeId }
    });
    throw new Error(`recover_work did not reconstruct the running job: ${JSON.stringify(recoveredWork.structuredContent)}`);
  }
  await client.request('tools/call', {
    name: 'stop_check',
    arguments: { job_id: runtimeId }
  });
  if (
    runtime.isError ||
    runtimeProgress.isError ||
    runtimeProgress.structuredContent.status !== 'running' ||
    !runtimeProgress.structuredContent.log?.includes?.('phase=started') ||
    !runtimeProgress.structuredContent.log?.includes?.('[runtime]') ||
    !runtimeProgress.structuredContent.log?.includes?.('elapsed_ms=') ||
    !runtimeProgress.structuredContent.log?.includes?.('output_bytes=') ||
    runtimeProgress.structuredContent.phase !== 'running_checks' ||
    runtimeProgress.structuredContent.runtime?.state !== 'running' ||
    runtimeProgress.structuredContent.runtime?.command !== 'npm run verify:runtime' ||
    !(runtimeProgress.structuredContent.runtime?.elapsed_ms >= 1000) ||
    !(runtimeProgress.structuredContent.runtime?.output_bytes > 0)
  ) {
    throw new Error(`running check did not expose live stdout/runtime diagnostics: ${JSON.stringify(runtimeProgress.structuredContent)}`);
  }

  const silentRuntime = await client.request('tools/call', {
    name: 'start_check',
    arguments: { checks: ['verify:silent-runtime'], target_paths: ['src/value.ts'], timeout_ms: 30_000 }
  });
  const silentProgress = await client.request('tools/call', {
    name: 'wait_check',
    arguments: { job_id: silentRuntime.structuredContent.job_id, wait_ms: 3_000, cursor: 0, max_chars: 5_000 }
  });
  const silentProgressLater = await client.request('tools/call', {
    name: 'wait_check',
    arguments: { job_id: silentRuntime.structuredContent.job_id, wait_ms: 2_500, cursor: 0, max_chars: 5_000 }
  });
  await client.request('tools/call', {
    name: 'stop_check',
    arguments: { job_id: silentRuntime.structuredContent.job_id }
  });
  if (
    silentRuntime.isError ||
    silentProgress.isError ||
    silentProgressLater.isError ||
    silentProgress.structuredContent.status !== 'running' ||
    silentProgressLater.structuredContent.status !== 'running' ||
    silentProgressLater.structuredContent.process_active !== true ||
    silentProgressLater.structuredContent.runtime?.state !== 'running' ||
    silentProgressLater.structuredContent.runtime?.command !== 'npm run verify:silent-runtime' ||
    !(silentProgress.structuredContent.runtime?.output_bytes > 0) ||
    silentProgressLater.structuredContent.runtime?.output_bytes !== silentProgress.structuredContent.runtime?.output_bytes ||
    !(silentProgressLater.structuredContent.runtime?.last_output_age_ms > silentProgress.structuredContent.runtime?.last_output_age_ms + 1_000) ||
    !(silentProgressLater.structuredContent.runtime?.elapsed_ms > silentProgress.structuredContent.runtime?.elapsed_ms + 1_000) ||
    !(silentProgressLater.structuredContent.runtime?.cpu_time_ms >= 0) ||
    !(silentProgressLater.structuredContent.runtime?.resident_memory_bytes > 0) ||
    !['working_set', 'rss'].includes(silentProgressLater.structuredContent.runtime?.memory_kind) ||
    !(silentProgressLater.structuredContent.runtime?.child_process_count >= 0) ||
    !(silentProgressLater.structuredContent.runtime?.process_count >= silentProgressLater.structuredContent.runtime?.child_process_count + 1) ||
    !silentProgressLater.structuredContent.runtime?.telemetry_sampled_at ||
    !(silentProgressLater.structuredContent.runner_lease?.telemetry?.resident_memory_bytes > 0) ||
    !silentProgressLater.structuredContent.log?.includes?.('event=progress') ||
    !silentProgressLater.structuredContent.log?.includes?.('event=telemetry')
  ) {
    throw new Error(`silent running check did not expose stalled-output diagnostics: first=${JSON.stringify(silentProgress.structuredContent)} later=${JSON.stringify(silentProgressLater.structuredContent)}`);
  }

  const timeoutRuntime = await client.request('tools/call', {
    name: 'start_check',
    arguments: { checks: ['verify:timeout-runtime'], target_paths: ['src/value.ts'], timeout_ms: 3_500 }
  });
  let timeoutDone;
  let timeoutProcessTree = [];
  for (let attempt = 0; attempt < 5; attempt += 1) {
    timeoutDone = await client.request('tools/call', {
      name: 'wait_check',
      arguments: { job_id: timeoutRuntime.structuredContent.job_id, wait_ms: 3_000, cursor: 0, max_chars: 8_000 }
    });
    if (attempt === 0 && timeoutDone.structuredContent.status === 'running') {
      timeoutProcessTree = windowsProcessTree(timeoutDone.structuredContent.runtime?.pid);
    }
    if (timeoutDone.structuredContent.status !== 'running') break;
  }
  if (
    timeoutRuntime.isError ||
    timeoutDone?.isError ||
    timeoutDone?.structuredContent.status !== 'failed' ||
    timeoutDone?.structuredContent.phase !== 'finished' ||
    timeoutDone?.structuredContent.result?.results?.[0]?.status !== 'timed_out' ||
    timeoutDone?.structuredContent.runtime?.state !== 'exited' ||
    !(timeoutDone?.structuredContent.runtime?.elapsed_ms >= 3_000) ||
    !(timeoutDone?.structuredContent.runtime?.elapsed_ms < 8_000) ||
    !(timeoutDone?.structuredContent.result?.results?.[0]?.duration_ms < 8_000) ||
    !timeoutDone?.structuredContent.log?.includes?.('event=progress') ||
    !timeoutDone?.structuredContent.log?.includes?.('phase=fingerprinting_after') ||
    !timeoutDone?.structuredContent.log?.includes?.('status: timed_out')
  ) {
    throw new Error(`timed out check lost runtime diagnostics: ${JSON.stringify(timeoutDone?.structuredContent)} processTree=${JSON.stringify(timeoutProcessTree)}`);
  }

  const streamed = await client.request('tools/call', {
    name: 'start_check',
    arguments: { checks: ['verify:stream-redaction'], target_paths: ['src/value.ts'], timeout_ms: 30_000 }
  });
  let streamedDone;
  for (let attempt = 0; attempt < 6; attempt += 1) {
    streamedDone = await client.request('tools/call', {
      name: 'wait_check',
      arguments: { job_id: streamed.structuredContent.job_id, wait_ms: 2_000, cursor: 0, max_chars: 5_000 }
    });
    if (streamedDone.structuredContent.status !== 'running') break;
  }
  const generatedSensitiveValue = tokenPrefix + 'a'.repeat(24);
  if (
    streamed.isError ||
    streamedDone?.isError ||
    streamedDone?.structuredContent.status !== 'completed' ||
    !streamedDone?.structuredContent.log?.includes?.('[REDACTED_SECRET]') ||
    streamedDone?.structuredContent.log?.includes?.(generatedSensitiveValue) ||
    streamedDone?.structuredContent.log?.includes?.(generatedSensitiveValue.slice(0, 7))
  ) {
    throw new Error(`live output redaction leaked a split sensitive value: ${JSON.stringify(streamedDone?.structuredContent)}`);
  }

  const cancellable = await client.request('tools/call', {
    name: 'start_check',
    arguments: { checks: ['verify:cancel'], target_paths: ['src/value.ts'], timeout_ms: 30_000 }
  });
  const cancelled = await client.request('tools/call', {
    name: 'stop_check',
    arguments: { job_id: cancellable.structuredContent.job_id }
  });
  if (
    cancellable.isError ||
    cancelled.isError ||
    cancelled.structuredContent.status !== 'cancelled' ||
    cancelled.structuredContent.result?.results?.[0]?.status !== 'cancelled'
  ) {
    throw new Error(`stop_check did not cancel the running job: ${JSON.stringify(cancelled.structuredContent)}`);
  }

  const checks = await client.request('tools/call', {
    name: 'run_checks',
    arguments: {
      checks: ['build'],
      target_paths: ['src/value.ts'],
      timeout_ms: 30_000
    }
  });
  if (checks.isError || !checks.structuredContent.ok) {
    throw new Error(`run_checks failed: ${JSON.stringify(checks.structuredContent)}`);
  }
  const first = checks.structuredContent.results?.[0];
  if (!first || first.exit_code !== 0 || first.status !== 'passed' || first.cwd !== '.') {
    throw new Error(`run_checks returned an invalid result: ${JSON.stringify(checks.structuredContent)}`);
  }
  if (!/^[a-f0-9]{64}$/.test(checks.structuredContent.workspace_fingerprint ?? '') || checks.structuredContent.stale) {
    throw new Error(`run_checks fingerprint was missing or stale: ${JSON.stringify(checks.structuredContent)}`);
  }

  const failingCheck = await client.request('tools/call', {
    name: 'run_checks',
    arguments: { checks: ['test:fail'], target_paths: ['src/value.ts'], timeout_ms: 30_000 }
  });
  const failed = failingCheck.structuredContent.results?.[0];
  const located = failed?.failures?.[0];
  if (
    failingCheck.isError ||
    failingCheck.structuredContent.ok !== false ||
    failed?.status !== 'failed' ||
    failed?.exit_code !== 1 ||
    located?.path !== 'src/value.ts' ||
    located?.line !== 7 ||
    located?.column !== 3
  ) {
    throw new Error(`run_checks did not structure a located failure: ${JSON.stringify(failingCheck.structuredContent)}`);
  }

  const staleCheck = await client.request('tools/call', {
    name: 'run_checks',
    arguments: { checks: ['verify:mutate'], target_paths: ['src/value.ts'], timeout_ms: 30_000 }
  });
  if (staleCheck.isError || !staleCheck.structuredContent.ok || staleCheck.structuredContent.stale !== true) {
    throw new Error(`run_checks did not mark a code-changing verification as stale: ${JSON.stringify(staleCheck.structuredContent)}`);
  }

  const smoke = await client.request('tools/call', {
    name: 'bash',
    arguments: { command: 'npm run smoke', timeout_ms: 30_000 }
  });
  if (smoke.isError || !smoke.structuredContent.ok || smoke.structuredContent.status !== 'passed') {
    throw new Error(`safe bash rejected smoke: ${JSON.stringify(smoke.structuredContent)}`);
  }

  const outputLimit = await client.request('tools/call', {
    name: 'bash',
    arguments: { command: 'npm run verify:output-limit', timeout_ms: 30_000 }
  });
  if (
    outputLimit.isError ||
    !outputLimit.structuredContent.ok ||
    outputLimit.structuredContent.exit_code !== 0 ||
    outputLimit.structuredContent.status !== 'passed' ||
    outputLimit.structuredContent.output_limit_exceeded !== true ||
    outputLimit.structuredContent.output_truncated !== true ||
    !(outputLimit.structuredContent.observed_output_bytes > 4000)
  ) {
    throw new Error(`output-limit execution was killed or misreported: ${JSON.stringify(outputLimit.structuredContent)}`);
  }

  const wideRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'codexpro-verification-wide-'));
  const wideClient = new McpStdioClient('node', ['dist/stdio.js', '--root', wideRoot, '--allow-root', wideRoot, '--bash', 'off', '--tool-mode', 'full'], {
    cwd: path.resolve('.'),
    env: {
      ...process.env,
      CODEXPRO_ROOT: wideRoot,
      CODEXPRO_ALLOWED_ROOTS: wideRoot,
      CODEXPRO_ANALYSIS: '1',
      CODEXPRO_TOOL_CARDS: '0'
    }
  });
  try {
    for (const name of ['project-a', 'project-b']) {
      const repo = path.join(wideRoot, name);
      await fs.mkdir(repo, { recursive: true });
      await fs.writeFile(path.join(repo, 'tracked.txt'), 'before\n', 'utf8');
      for (const args of [
        ['init'],
        ['add', 'tracked.txt'],
        ['-c', 'user.email=verification@example.invalid', '-c', 'user.name=Verification', 'commit', '-m', 'fixture']
      ]) {
        const result = spawnSync('git', args, { cwd: repo, encoding: 'utf8' });
        if (result.status !== 0) throw new Error(`wide git ${name} ${args.join(' ')} failed: ${result.stderr || result.stdout}`);
      }
      await fs.writeFile(path.join(repo, 'tracked.txt'), 'after\n', 'utf8');
    }

    await wideClient.request('initialize', {
      protocolVersion: '2024-11-05',
      capabilities: {},
      clientInfo: { name: 'codexpro-verification-wide-smoke', version: '0.1.0' }
    });
    wideClient.notify('notifications/initialized');

    const wideOpened = await wideClient.request('tools/call', {
      name: 'open_current_workspace',
      arguments: { include_tree: false }
    });
    if (wideOpened.structuredContent.repositories?.length !== 2) {
      throw new Error(`wide workspace did not expose two repositories: ${JSON.stringify(wideOpened.structuredContent)}`);
    }

    const wideChanges = await wideClient.request('tools/call', {
      name: 'show_changes',
      arguments: { since: 'workspace' }
    });
    const byRepository = wideChanges.structuredContent.changes_by_repository ?? [];
    const repoA = byRepository.find((item) => item.repository === 'project-a');
    const repoB = byRepository.find((item) => item.repository === 'project-b');
    if (
      wideChanges.isError ||
      !repoA?.changed_files?.some((file) => file.includes('project-a/tracked.txt')) ||
      !repoB?.changed_files?.some((file) => file.includes('project-b/tracked.txt')) ||
      repoA?.additions !== 1 ||
      repoA?.deletions !== 1 ||
      repoB?.additions !== 1 ||
      repoB?.deletions !== 1
    ) {
      throw new Error(`show_changes did not return structured repository changes: ${JSON.stringify(wideChanges.structuredContent)}`);
    }
  } finally {
    await wideClient.close();
    await fs.rm(wideRoot, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
  }

  console.log('verification smoke ok');
} finally {
  await client.close();
  await fs.rm(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
  await fs.rm(home, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
}
