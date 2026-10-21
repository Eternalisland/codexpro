import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

/**
 * V100(20261019) yijiakang 【可靠性修复】验证分析预算丢失结果时的覆盖率及等限边界，任务号:20260509145520000648
 */
const verNum = 'V100(20261019)';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const importBuilt = (relativePath) => import(pathToFileURL(path.join(projectRoot, 'dist', relativePath)).href);
const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'codexpro-analysis-budget-'));
const fixtureFiles = ['main.ts', 'a.ts', 'b.ts'];

try {
  await fs.writeFile(path.join(tmp, 'main.ts'), 'import { a } from "./a.js";\nimport { b } from "./b.js";\nexport const ready = a + b;\n');
  await fs.writeFile(path.join(tmp, 'a.ts'), 'export const a = 1;\n');
  await fs.writeFile(path.join(tmp, 'b.ts'), 'export const b = 2;\n');

  const [{ loadConfig }, { PathGuard, WorkspaceManager }, analysis, graph] = await Promise.all([
    importBuilt('config.js'),
    importBuilt('guard.js'),
    importBuilt('analysis/index.js'),
    importBuilt('analysis/graph.js')
  ]);
  const baseConfig = loadConfig(['--root', tmp, '--bash', 'off', '--write', 'off']);
  const configFor = (maxRelationships, maxSymbols) => ({
    ...baseConfig,
    analysisEnabled: true,
    analysisLimits: { ...baseConfig.analysisLimits, maxRelationships, maxSymbols }
  });
  const guard = new PathGuard(baseConfig);
  const workspace = new WorkspaceManager(baseConfig).defaultWorkspace();
  const inspect = (maxRelationships, maxSymbols) => analysis.inspectWorkspace(configFor(maxRelationships, maxSymbols), guard, workspace);
  const assertWarning = (result, fragment) => {
    assert.equal(result.coverage.truncated, true, `${fragment} must mark coverage as partial`);
    assert(result.warnings.some((warning) => warning.includes(fragment)), `${fragment} warning must reach the result`);
    assert(result.coverage.warnings.some((warning) => warning.includes(fragment)), `${fragment} warning must reach coverage`);
  };

  // Exactly filling a budget is complete; only an actually discarded item makes coverage partial.
  const exact = await inspect(2, 3);
  assert.equal(exact.relationships.length, 2);
  assert.equal(exact.symbols.length, 3);
  assert.equal(exact.coverage.truncated, false);
  assert.deepEqual(exact.warnings, []);

  const relationshipLimited = await inspect(1, 3);
  assert.equal(relationshipLimited.relationships.length, 1);
  assert.equal(relationshipLimited.coverage.relationshipCount, 1);
  assertWarning(relationshipLimited, 'Relationship extraction reached');

  const symbolLimited = await inspect(2, 2);
  assert.equal(symbolLimited.symbols.length, 2);
  assert.equal(symbolLimited.coverage.symbolCount, 2);
  assertWarning(symbolLimited, 'Symbol extraction reached');

  const bothLimited = await inspect(1, 2);
  assertWarning(bothLimited, 'Relationship extraction reached');
  assertWarning(bothLimited, 'Symbol extraction reached');
  const cached = await inspect(1, 2);
  assert.equal(cached.cache.hit, true);
  assertWarning(cached, 'Relationship extraction reached');
  assertWarning(cached, 'Symbol extraction reached');

  const limitedConfig = configFor(1, 2);
  const search = await analysis.searchWorkspaceStructured(limitedConfig, guard, workspace, { query: 'a', intent: 'references' });
  assertWarning(search, 'Relationship extraction reached');
  assertWarning(search, 'Symbol extraction reached');
  const review = await analysis.reviewWorkspaceChanges(limitedConfig, guard, workspace, { changedPaths: ['a.ts'] });
  assertWarning(review, 'Relationship extraction reached');
  assertWarning(review, 'Symbol extraction reached');

  // Preserve the original public array-returning helper for callers outside inspectWorkspace.
  const extracted = [{ path: 'main.ts', text: '', symbols: [], imports: ['a.ts', 'b.ts'] }];
  const inventory = [{ path: 'main.ts', role: 'source' }];
  const legacy = graph.buildRelationships(extracted, inventory, 1);
  assert(Array.isArray(legacy));
  assert.equal(legacy.length, 1);
  assert.deepEqual(legacy[0], { from: 'main.ts', to: 'a.ts', kind: 'imports', confidence: 'strong', source: 'built-in import extraction' });
  assert.deepEqual(graph.buildRelationships([], [], 0), []);

  console.log(`analysis budget smoke passed (${verNum}; exact limits, relationship/symbol overflow, cache/search/review propagation, public API compatibility)`);
} finally {
  // Only remove files created by this fixture; no recursive workspace cleanup is needed.
  for (const name of fixtureFiles) await fs.unlink(path.join(tmp, name)).catch((error) => { if (error.code !== 'ENOENT') throw error; });
  await fs.rmdir(tmp);
}
