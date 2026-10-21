import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { loadConfig } from '../dist/config.js';
import { PathGuard, WorkspaceManager } from '../dist/guard.js';
import { editTextFile, readManyTextFiles, readTextFile, sha256, writeTextFile } from '../dist/fsOps.js';

/**
 * V100(20261019) yijiakang 【可靠性修复】覆盖非 UTF-8 拒绝和原编码字节保护，任务号:20260509145520000648
 */
const verNum = 'V100(20261019)';

const root = await fs.mkdtemp(path.join(os.tmpdir(), 'codexpro-file-encoding-'));
const fixtures = new Set();
const failures = [];
let passed = 0;
const config = loadConfig(['--root', root, '--allow-root', root, '--write', 'workspace']);
const guard = new PathGuard(config);
const workspace = new WorkspaceManager(config).defaultWorkspace();
const gbk = Buffer.concat([
  Buffer.from('// '), Buffer.from([0xd6, 0xd0, 0xce, 0xc4]),
  Buffer.from('\r\nexport const value = 1;\r\n')
]);

async function fixture(name, bytes) {
  fixtures.add(name);
  await fs.writeFile(path.join(root, name), bytes);
}

async function check(name, fn) {
  try {
    await fn();
    passed++;
  } catch (error) {
    failures.push(`${name}: ${error.message}`);
  }
}

try {
  for (const [name, operation] of [
    ['read', () => readTextFile(config, guard, workspace, 'legacy.ts')],
    ['edit', () => editTextFile(config, guard, workspace, 'legacy.ts', 'value = 1', 'value = 2')],
    ['write', () => writeTextFile(config, guard, workspace, 'legacy.ts', 'replacement\n')]
  ]) {
    await check(`GBK ${name} rejects without changing bytes`, async () => {
      await fixture('legacy.ts', gbk);
      // The failure must happen before truncating the existing file, even for an ASCII-only edit.
      let rejected;
      try { await operation(); } catch (error) { rejected = error; }
      assert.deepEqual(await fs.readFile(path.join(root, 'legacy.ts')), gbk, 'original GBK bytes changed');
      assert.match(rejected?.message ?? '', /UTF-8/i, 'non-UTF-8 operation must report its encoding limitation');
    });
  }

  await check('malformed UTF-8 is rejected on full and ranged reads', async () => {
    await fixture('invalid.ts', Buffer.from([0x61, 0x0a, 0xc3, 0x28]));
    await assert.rejects(readTextFile(config, guard, workspace, 'invalid.ts'), /UTF-8/i);
    await assert.rejects(readTextFile(config, guard, workspace, 'invalid.ts', { startLine: 1, endLine: 1 }), /UTF-8/i);
  });

  await check('read_many retains good files and reports encoding errors', async () => {
    await fixture('legacy.ts', gbk);
    await fixture('valid.ts', 'export const valid = true;\n');
    const result = await readManyTextFiles(config, guard, workspace, [{ path: 'legacy.ts' }, { path: 'valid.ts' }]);
    assert.deepEqual(result.results.map((entry) => entry.path), ['valid.ts']);
    assert.equal(result.errors.length, 1);
    assert.match(result.errors[0].error, /UTF-8/i);
  });

  await check('UTF-8 BOM, Chinese and CRLF survive an edit', async () => {
    const before = '\ufeff// 中文\r\nexport const value = 1;\r\n';
    const after = before.replace('value = 1', 'value = 2');
    await fixture('bom.ts', before);
    const read = await readTextFile(config, guard, workspace, 'bom.ts');
    assert.equal(read.sha256, sha256(before));
    await editTextFile(config, guard, workspace, 'bom.ts', 'value = 1', 'value = 2', { expectedSha256: read.sha256 });
    assert.deepEqual(await fs.readFile(path.join(root, 'bom.ts')), Buffer.from(after));
  });

  await check('literal replacement characters are valid UTF-8', async () => {
    await fixture('literal.txt', 'valid \ufffd character\n');
    const read = await readTextFile(config, guard, workspace, 'literal.txt');
    assert.match(read.text, /\ufffd/);
    await editTextFile(config, guard, workspace, 'literal.txt', 'valid', 'still valid');
    assert.equal(await fs.readFile(path.join(root, 'literal.txt'), 'utf8'), 'still valid \ufffd character\n');
  });

  await check('empty and new UTF-8 files remain writable', async () => {
    await fixture('empty.txt', '');
    assert.equal((await readTextFile(config, guard, workspace, 'empty.txt')).bytes, 0);
    await writeTextFile(config, guard, workspace, 'empty.txt', '中文\n');
    fixtures.add('new.txt');
    await writeTextFile(config, guard, workspace, 'new.txt', 'new\n');
    assert.equal(await fs.readFile(path.join(root, 'empty.txt'), 'utf8'), '中文\n');
    assert.equal(await fs.readFile(path.join(root, 'new.txt'), 'utf8'), 'new\n');
  });

  await check('stale SHA still prevents a valid UTF-8 overwrite', async () => {
    await fixture('sha.txt', 'current\n');
    await assert.rejects(writeTextFile(config, guard, workspace, 'sha.txt', 'after\n', { expectedSha256: sha256('old\n') }), /changed since/);
    assert.equal(await fs.readFile(path.join(root, 'sha.txt'), 'utf8'), 'current\n');
  });
} finally {
  // Remove only the fixture files created above; no recursive deletion of workspace paths.
  for (const name of fixtures) await fs.unlink(path.join(root, name)).catch((error) => { if (error.code !== 'ENOENT') throw error; });
  await fs.rmdir(root);
}

assert.equal(failures.length, 0, `${verNum}: ${failures.join('\n')}`);
console.log(`file encoding smoke passed (${passed} cases)`);
