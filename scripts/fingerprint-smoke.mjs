import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { loadConfig } from '../dist/config.js';
import { PathGuard, WorkspaceManager } from '../dist/guard.js';
import { workspaceFingerprint } from '../dist/checkOps.js';

/**
 * V100(20261019) yijiakang 【可靠性修复】验证工作区指纹覆盖暂存区、提交及完整文件内容，任务号:20260509145520000648
 */
export const verNum = 'V100(20261019)';

const fixture = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'codexpro-fingerprint-smoke-')));
const failures = [];
let passed = 0;

function git(root, ...args) {
  const result = spawnSync('git', ['-c', 'core.autocrlf=false', '-c', 'commit.gpgsign=false', ...args], {
    cwd: root, encoding: 'utf8', windowsHide: true
  });
  assert.equal(result.status, 0, result.error?.message ?? result.stderr);
  return result.stdout.trim();
}

async function repository(name) {
  const root = path.join(fixture, name);
  await fs.mkdir(root, { recursive: true });
  git(root, 'init', '--quiet');
  await fs.writeFile(path.join(root, 'value.txt'), 'before\n');
  git(root, 'add', 'value.txt');
  commit(root, 'initial');
  return root;
}

function commit(root, message) {
  git(root, '-c', 'user.name=Fingerprint Fixture', '-c', 'user.email=fingerprint@example.invalid', 'commit', '--quiet', '-m', message);
}

function snapshotter(root, overrides = {}) {
  const config = { ...loadConfig(['--root', root, '--allow-root', root, '--bash', 'off']), ...overrides };
  const guard = new PathGuard(config);
  const workspace = new WorkspaceManager(config).defaultWorkspace();
  return () => workspaceFingerprint(config, guard, workspace);
}

async function test(name, run) {
  try {
    await run();
    passed += 1;
    console.log(`PASS ${name}`);
  } catch (error) {
    failures.push(name);
    console.error(`FAIL ${name}: ${error.message}`);
  }
}

try {
  const root = await repository('main');
  const snapshot = snapshotter(root);
  const baseline = await snapshot();
  assert.match(baseline, /^[a-f0-9]{64}$/);

  await test('unchanged workspace remains stable after git status', async () => {
    const touched = new Date(Date.now() + 1_000);
    await fs.utimes(path.join(root, 'value.txt'), touched, touched);
    git(root, 'status', '--short');
    assert.equal(await snapshot(), baseline);
  });
  await fs.writeFile(path.join(root, 'value.txt'), 'after\n');
  await test('unstaged content changes invalidate the fingerprint', async () => {
    assert.notEqual(await snapshot(), baseline);
  });
  git(root, 'add', 'value.txt');
  await test('staged content changes invalidate the fingerprint', async () => {
    assert.notEqual(await snapshot(), baseline);
  });
  commit(root, 'changed');
  await test('a different clean commit invalidates the fingerprint', async () => {
    assert.notEqual(await snapshot(), baseline);
  });

  await test('untracked content is hashed beyond the per-read and display limits', async () => {
    const snapshotSmall = snapshotter(root, { maxReadBytes: 32, maxOutputBytes: 512 });
    const file = path.join(root, 'large-untracked.txt');
    const content = Buffer.alloc(8_192, 97);
    const timestamp = new Date('2026-10-19T00:00:00.000Z');
    await fs.writeFile(file, content);
    await fs.utimes(file, timestamp, timestamp);
    const first = await snapshotSmall();
    content[content.length - 1] = 98;
    await fs.writeFile(file, content);
    await fs.utimes(file, timestamp, timestamp);
    assert.notEqual(await snapshotSmall(), first);
  });

  await test('tracked changes after the display limit are not truncated or redacted before hashing', async () => {
    const snapshotSmall = snapshotter(root, { maxOutputBytes: 512 });
    const prefix = 'long stable prefix\n'.repeat(1_000);
    await fs.writeFile(path.join(root, 'value.txt'), `${prefix}first\n`);
    const first = await snapshotSmall();
    await fs.writeFile(path.join(root, 'value.txt'), `${prefix}other\n`);
    assert.notEqual(await snapshotSmall(), first);
  });

  await test('binary worktree content changes produce different fingerprints', async () => {
    const file = path.join(root, 'binary.dat');
    await fs.writeFile(file, Buffer.from([0, 1, 2, 3]));
    git(root, 'add', 'binary.dat');
    commit(root, 'binary');
    await fs.writeFile(file, Buffer.from([0, 1, 2, 4]));
    const first = await snapshot();
    await fs.writeFile(file, Buffer.from([0, 1, 2, 5]));
    assert.notEqual(await snapshot(), first);
  });

  await test('wide workspaces include staged and committed changes in nested repositories', async () => {
    const wide = path.join(fixture, 'wide');
    await fs.mkdir(wide);
    await repository('wide/repo-a');
    const second = await repository('wide/repo-b');
    const wideSnapshot = snapshotter(wide);
    const first = await wideSnapshot();
    await fs.writeFile(path.join(second, 'value.txt'), 'nested change\n');
    git(second, 'add', 'value.txt');
    assert.notEqual(await wideSnapshot(), first);
    commit(second, 'nested change');
    assert.notEqual(await wideSnapshot(), first);
  });

  await test('wide workspaces include loose files outside their nested repositories', async () => {
    const wide = path.join(fixture, 'wide');
    const wideSnapshot = snapshotter(wide);
    const loose = path.join(wide, 'loose.txt');
    await fs.writeFile(loose, 'one\n');
    const first = await wideSnapshot();
    await fs.writeFile(loose, 'two\n');
    assert.notEqual(await wideSnapshot(), first);
  });

  await test('repositories embedded inside a root repository are included', async () => {
    const inner = await repository('main/embedded');
    const first = await snapshot();
    await fs.writeFile(path.join(inner, 'value.txt'), 'embedded change\n');
    git(inner, 'add', 'value.txt');
    assert.notEqual(await snapshot(), first);
  });

  await test('non-Git workspaces use content fingerprints and honor blocked paths', async () => {
    const plain = path.join(fixture, 'plain');
    await fs.mkdir(plain);
    const file = path.join(plain, 'plain.txt');
    await fs.writeFile(file, 'one\n');
    const plainSnapshot = snapshotter(plain);
    const first = await plainSnapshot();
    await fs.writeFile(path.join(plain, '.env'), 'not part of the accessible workspace\n');
    assert.equal(await plainSnapshot(), first);
    await fs.writeFile(file, 'two\n');
    assert.notEqual(await plainSnapshot(), first);
  });

  await test('Git failure in an existing repository rejects an unverifiable fingerprint', async () => {
    await assert.rejects(snapshotter(root, { gitExecutable: path.join(fixture, 'missing-git') }), /fingerprint|Git/i);
  });

  await test('a non-Git project still fingerprints content when Git is unavailable', async () => {
    const plain = path.join(fixture, 'plain-without-git');
    await fs.mkdir(plain);
    const file = path.join(plain, 'plain.txt');
    await fs.writeFile(file, 'one\n');
    const plainSnapshot = snapshotter(plain, { gitExecutable: path.join(fixture, 'missing-git') });
    const first = await plainSnapshot();
    await fs.writeFile(file, 'two\n');
    assert.notEqual(await plainSnapshot(), first);
  });

  await test('an existing but corrupt Git repository is not treated as a plain project', async () => {
    const broken = path.join(fixture, 'broken');
    await fs.mkdir(path.join(broken, '.git'), { recursive: true });
    await assert.rejects(snapshotter(broken), /fingerprint|Git/i);
  });

  await test('a newly initialized repository without a commit remains supported', async () => {
    const unborn = path.join(fixture, 'unborn');
    await fs.mkdir(unborn);
    git(unborn, 'init', '--quiet');
    const unbornSnapshot = snapshotter(unborn);
    const first = await unbornSnapshot();
    assert.equal(await unbornSnapshot(), first);
    await fs.writeFile(path.join(unborn, 'value.txt'), 'unborn\n');
    assert.notEqual(await unbornSnapshot(), first);
  });

  await test('normal projects deeper than the display discovery limit remain supported', async () => {
    const deep = path.join(fixture, 'deep');
    const source = path.join(deep, ...Array(8).fill('level'), 'value.txt');
    await fs.mkdir(path.dirname(source), { recursive: true });
    await fs.writeFile(source, 'one\n');
    const deepSnapshot = snapshotter(deep);
    const first = await deepSnapshot();
    await fs.writeFile(source, 'two\n');
    assert.notEqual(await deepSnapshot(), first);
    git(deep, 'init', '--quiet');
    git(deep, 'add', '.');
    commit(deep, 'deep source tree');
    assert.match(await deepSnapshot(), /^[a-f0-9]{64}$/);
  });

  await test('incomplete repository discovery is rejected when the directory budget is exhausted', async () => {
    const deep = path.join(fixture, 'deep');
    const config = loadConfig(['--root', deep, '--allow-root', deep, '--bash', 'off']);
    await assert.rejects(snapshotter(deep, { analysisLimits: { ...config.analysisLimits, maxInventoryFiles: 3 } }), /fingerprint|limit|incomplete/i);
  });

  await test('Git state output budget exhaustion rejects an incomplete fingerprint', async () => {
    const config = loadConfig(['--root', root, '--allow-root', root, '--bash', 'off']);
    await assert.rejects(snapshotter(root, { analysisLimits: { ...config.analysisLimits, maxScannedBytes: 128 } }), /fingerprint|budget|limit|buffer/i);
  });

  await test('non-Git content budget exhaustion rejects an incomplete fingerprint', async () => {
    const plain = path.join(fixture, 'budget');
    await fs.mkdir(plain);
    await fs.writeFile(path.join(plain, 'large.txt'), 'x'.repeat(1_024));
    const config = loadConfig(['--root', plain, '--allow-root', plain, '--bash', 'off']);
    await assert.rejects(snapshotter(plain, { analysisLimits: { ...config.analysisLimits, maxScannedBytes: 128 } }), /fingerprint|budget|limit/i);
  });

  if (failures.length) throw new Error(`${failures.length} fingerprint regression(s) failed: ${failures.join('; ')}`);
  console.log(`Fingerprint smoke passed (${passed} cases).`);
} finally {
  // 只删除本脚本刚创建的隔离夹具，先校验 realpath，避免误清理工作区或用户目录。
  const resolved = await fs.realpath(fixture);
  const tempRoot = await fs.realpath(os.tmpdir());
  assert.equal(path.dirname(resolved), tempRoot);
  assert.ok(path.basename(resolved).startsWith('codexpro-fingerprint-smoke-'));
  await fs.rm(resolved, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
}
