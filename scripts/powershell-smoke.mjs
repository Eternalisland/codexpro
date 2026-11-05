import assert from 'node:assert/strict';
import { mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { loadConfig } from '../dist/config.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createCodexProServer } from '../dist/server.js';
import { PathGuard } from '../dist/guard.js';
import { bashRuntimeStatus, resolveBashInvocation, runBash } from '../dist/bashOps.js';

const configured = 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe';
const mock = { platform: 'win32', env: { SystemRoot: 'C:\\Windows', ProgramFiles: 'C:\\Program Files' },
  exists: candidate => candidate === configured, pathCommands: () => [] };
const base = { bashRuntime: 'powershell', bashMode: 'safe', maxBashTimeoutMs: 10000, maxOutputBytes: 50000,
  inheritEnv: false, blockedGlobs: [] };
const win = resolveBashInvocation(base, mock);
assert.equal(win.runtime, 'powershell');
assert.equal(win.executable, configured);
assert.equal(win.source, 'system');
const args = win.args("Write-Output '中文 hello'");
assert(args.includes('-NoProfile') && args.includes('-NonInteractive'));
assert(args.includes('-EncodedCommand'));
const body = Buffer.from(args[args.indexOf('-EncodedCommand') + 1], 'base64').toString('utf16le');
assert(body.includes("Write-Output '中文 hello'"));
assert(body.includes('OutputEncoding'));
assert(!args.includes('-ExecutionPolicy'), 'do not bypass the system execution policy');
assert.equal(bashRuntimeStatus({ ...base, bashRuntime: 'pwsh' }, mock).available, false);
assert.throws(() => resolveBashInvocation({ ...base, bashRuntime: 'powershell',
  bashExecutable: 'C:\\other\\powershell.exe' }, mock), /not found/i);
assert.throws(() => resolveBashInvocation(base, { ...mock, platform: 'linux' }), /Windows/i);
const ps7 = resolveBashInvocation({ ...base, bashRuntime: 'pwsh', bashExecutable: 'C:\\PowerShell 7\\pwsh.exe' },
  { ...mock, exists: x => x === 'C:\\PowerShell 7\\pwsh.exe' });
assert.equal(ps7.runtime, 'pwsh');

if (process.platform === 'win32') {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), 'codexpro-powershell 中文 ')));
  try {
    await writeFile(path.join(root, 'package.json'), JSON.stringify({scripts: {
      'check:ps-smoke': 'node -e "console.log(\'中文 npm smoke\')"',
      'test:fail': 'node -e "process.exit(13)"'
    }}, null, 2), 'utf8');
    for (const runtime of ['powershell', 'pwsh']) {
      const config = loadConfig(['--root', root, '--bash', 'safe', '--bash-runtime', runtime]);
      const status = bashRuntimeStatus(config);
      if (!status.available) {
        if (runtime === 'powershell') throw new Error('Windows PowerShell is unavailable: ' + status.reason);
        console.log('PowerShell 7 (pwsh) is not installed; resolver test passed, execution test skipped.');
        continue;
      }
      const workspace = { id: 'ps-fixture', root, openedAt: new Date().toISOString() };
      const guard = new PathGuard(config);
      const location = await runBash(config, guard, workspace, 'Get-Location');
      assert.equal(location.status, 'passed', JSON.stringify(location));
      assert(location.stdout.includes(path.basename(root)), location.stdout);
      assert.equal(location.bashRuntime, runtime);
      const nodeVersion = await runBash(config, guard, workspace, 'node --version');
      assert.equal(nodeVersion.status, 'passed', JSON.stringify(nodeVersion));
      assert.match(nodeVersion.stdout, /^v\d+/m);
      const npmVersion = await runBash(config, guard, workspace, 'npm --version');
      assert.equal(npmVersion.status, 'passed', JSON.stringify(npmVersion));
      const script = await runBash(config, guard, workspace, 'npm run check:ps-smoke');
      assert.equal(script.status, 'passed', JSON.stringify(script));
      assert(script.stdout.includes('中文 npm smoke'), JSON.stringify(script));
      const failedScript = await runBash(config, guard, workspace, 'npm run test:fail');
      assert.equal(failedScript.exitCode, 13, JSON.stringify(failedScript));

      await assert.rejects(runBash(config, guard, workspace, 'Get-Location; Remove-Item x'),
        /blocked|allowlist/i);
      await assert.rejects(runBash(config, guard, workspace, 'Get-Location $env:PATH'),
        /blocked|allowlist/i);
      await assert.rejects(runBash(config, guard, workspace, 'ls C:\\'),
        /blocked|allowlist/i);
      await assert.rejects(runBash(config, guard, workspace, 'npm --version (Write-Output unsafe)'),
        /blocked|allowlist/i);
      const full = { ...config, bashMode: 'full' };
      const utf8 = await runBash(full, guard, workspace, "Write-Output 'UTF-8 中文编码'");
      assert.equal(utf8.status, 'passed', JSON.stringify(utf8));
      assert.equal(utf8.stdout.trim(), 'UTF-8 中文编码');
      const failedNative = await runBash(full, guard, workspace, "& node -e 'process.exit(7)'");
      assert.equal(failedNative.exitCode, 7, JSON.stringify(failedNative));
      const failedShell = await runBash(full, guard, workspace, "throw 'boom'");
      assert.equal(failedShell.status, 'failed');
      assert.notEqual(failedShell.exitCode, 0);
      const notFound = await runBash(full, guard, workspace, "Get-Command no_such_codexpro_command");
      assert.notEqual(notFound.exitCode, 0);
      const timeout = await runBash(full, guard, workspace, "Start-Sleep -Seconds 4", { timeoutMs: 1000 });
      assert.equal(timeout.status, 'timed_out', JSON.stringify(timeout));
      if (runtime === 'powershell') {
        const server = createCodexProServer({ ...config, toolMode: 'full' });
        const client = new Client({ name: 'powershell-integration-smoke', version: '1.0.0' });
        const [a, b] = InMemoryTransport.createLinkedPair();
        try {
          await server.connect(b);
          await client.connect(a);
          const sync = await client.callTool({ name: 'run_checks',
            arguments: { checks: ['check:ps-smoke'] } });
          assert(!sync.isError && sync.structuredContent.ok,
            'run_checks PowerShell failed: ' + JSON.stringify(sync.structuredContent));
          assert(sync.structuredContent.results[0].stdout.includes('中文 npm smoke'));

          const started = await client.callTool({ name: 'start_check',
            arguments: { checks: ['check:ps-smoke'], request_id: 'powershell-mcp-check' } });
          assert(!started.isError, JSON.stringify(started.content));
          let finished;
          for (let i = 0; i < 25; i++) {
            const result = await client.callTool({name: 'wait_check',
              arguments: {job_id: started.structuredContent.job_id, wait_ms: 1000} });
            assert(!result.isError, JSON.stringify(result.content));
            if (result.structuredContent.status !== 'running') {
              finished = result.structuredContent;
              break;
            }
          }
          assert(finished && finished.status === 'completed',
            'start_check PowerShell failed: ' + JSON.stringify(finished));
          assert.equal(finished.result.results[0].ok, true);
          assert(finished.log.includes('中文 npm smoke'), 'managed check log should retain UTF-8 output');
        } finally {
          await client.close();
          await server.close();
        }
      }
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}
console.log('PowerShell runtime smoke passed.');
