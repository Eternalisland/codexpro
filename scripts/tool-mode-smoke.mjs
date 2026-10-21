import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { loadConfig } from '../dist/config.js';
import { createCodexProServer } from '../dist/server.js';

/**
 * V100(20261019) yijiakang 【可靠性修复】覆盖工具模式与会话权限组合，任务号:20260509145520000648
 */
const verNum = 'V100(20261019)';
const root = await fs.mkdtemp(path.join(os.tmpdir(), 'codexpro-tool-modes-'));
const failures = [];
let passed = 0;
const sessionTools = ['codex_sessions', 'read_codex_session', 'search_codex_session', 'read_codex_session_around'];
const checkTools = ['bash', 'run_checks', 'start_check', 'get_check', 'list_checks', 'resume_check', 'wait_check', 'stop_check'];
const writeTools = ['write', 'edit', 'preview_patch', 'apply_patch', 'import_file'];

async function verify(toolMode, sessions, overrides = {}) {
  const config = { ...loadConfig(['--root', root, '--allow-root', root]), toolMode, codexSessions: sessions, ...overrides };
  // These fixtures exercise registration only; no local Codex transcript is opened.
  const server = createCodexProServer(config);
  const client = new Client({ name: 'codexpro-tool-mode-smoke', version: '1.0.0' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const label = `${toolMode}/${sessions}/${JSON.stringify(overrides)}`;
  try {
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    const listed = await client.listTools();
    const names = listed.tools.map((tool) => tool.name);
    const expectedSessions = sessions === 'off' ? [] : sessions === 'metadata' ? ['codex_sessions'] : sessionTools;
    assert.deepEqual(names.filter((name) => sessionTools.includes(name)).sort(), [...expectedSessions].sort(), label);
    if (config.bashMode === 'off') assert(!names.some((name) => checkTools.includes(name)), `${label}: bash disabled`);
    if (!config.analysisEnabled) assert(!names.some((name) => name !== 'bash' && checkTools.includes(name)), `${label}: analysis disabled`);
    if (config.writeMode !== 'workspace') assert(!names.some((name) => writeTools.includes(name)), `${label}: workspace editing tools disabled`);
    if (config.writeMode === 'workspace' && !config.connectionTest) assert(names.includes('preview_patch'), `${label}: preview unavailable`);
    if (config.writeMode === 'handoff' && !config.connectionTest) assert(names.includes('handoff_to_agent'), `${label}: handoff available`);
    if (toolMode === 'minimal') assert(!names.includes('tree'), `${label}: minimal tool surface`);
    const semanticTools = ['find_symbol', 'find_references', 'find_implementations', 'get_type_hierarchy'];
    for (const name of semanticTools) {
      assert.equal(names.includes(name), config.analysisEnabled && toolMode !== 'minimal', `${label}: ${name} registration`);
    }
    if (toolMode === 'full') assert(names.includes('git_status'), `${label}: full tool surface`);

    if (!config.connectionTest) {
      const actions = await client.callTool({ name: 'codexpro', arguments: { action: 'list_actions' } });
      assert(!actions.isError, `${label}: actions query failed`);
      // Querying the aggregate entrypoint also checks that permission filtering cannot be bypassed there.
      for (const name of sessionTools.filter((name) => !expectedSessions.includes(name))) {
        const hidden = await client.callTool({ name: 'codexpro', arguments: { action: name, args: {} } });
        assert(hidden.isError, `${label}: disabled session action ${name} is callable`);
      }
    }
    passed++;
  } catch (error) {
    failures.push(`${label}: ${error.message}`);
  } finally {
    await client.close();
    await server.close();
  }
}

try {
  for (const toolMode of ['minimal', 'standard', 'full']) {
    for (const sessions of ['off', 'metadata', 'read']) await verify(toolMode, sessions);
    for (const overrides of [
      { bashMode: 'off' }, { analysisEnabled: false },
      { writeMode: 'off' }, { writeMode: 'handoff' },
      { connectionTest: true }, { bashMode: 'off', writeMode: 'off', analysisEnabled: false }
    ]) await verify(toolMode, 'read', overrides);
  }
} finally {
  await fs.rmdir(root);
}
assert.equal(failures.length, 0, `${verNum}: ${failures.join('\n')}`);
console.log(`tool mode smoke passed (${passed} configurations)`);
