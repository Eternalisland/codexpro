import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { loadConfig } from '../dist/config.js';
import { WorkspaceRegistry } from '../dist/guard.js';
import { createCodexProServer } from '../dist/server.js';

process.env.CODEXPRO_EXPOSE_ABSOLUTE_PATHS = '1';
const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'codexpro-session-smoke-'));
const main = path.join(tmp, 'default');
const other = path.join(tmp, 'other');
const connections = [];

async function connect(config, registry) {
  const server = createCodexProServer(config, { workspaceRegistry: registry });
  const client = new Client({ name: 'workspace-session-smoke', version: '1.0.0' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  connections.push({ server, client });
  return client;
}

async function call(client, name, args = {}) {
  const result = await client.callTool({ name, arguments: args });
  assert.equal(result.isError, undefined, `${name}: ${JSON.stringify(result.content)}`);
  return result.structuredContent;
}

try {
  await fs.mkdir(main, { recursive: true });
  await fs.mkdir(other, { recursive: true });
  await fs.writeFile(path.join(other, 'marker.txt'), 'other project\n', 'utf8');
  const config = loadConfig(['--root', main, '--allow-root', other, '--alias', `codexpro=${other}`, '--tool-mode', 'full']);
  const registry = new WorkspaceRegistry();
  const clientA = await connect(config, registry);
  const clientB = await connect(config, registry);

  const initial = await call(clientB, 'list_workspaces');
  assert.equal(initial.configured_workspaces.find(w => w.alias === 'codexpro')?.opened, false);

  const opened = await call(clientA, 'open_workspace', { alias: 'codexpro', include_tree: false });
  assert.equal(opened.selected_workspace_id, opened.workspace_id);
  const crossSession = await call(clientB, 'list_workspaces');
  assert.equal(crossSession.configured_workspaces.find(w => w.alias === 'codexpro')?.opened, true,
    'opened status should reflect the shared server registry');
  assert(crossSession.server_opened_workspaces.some(w => w.id === opened.workspace_id),
    'shared workspace should be listed at server scope');
  assert(!crossSession.workspaces.some(w => w.id === opened.workspace_id),
    'legacy opened-workspaces field must remain session-local');
  assert.notEqual(crossSession.selected_workspace_id, opened.workspace_id,
    'session-local selection must not leak to another client');
  assert.equal((await call(clientA, 'list_workspaces')).selected_workspace_id, opened.workspace_id);

  const read = await call(clientB, 'read', { workspace_id: 'codexpro', path: 'marker.txt' });
  assert.equal(read.workspace_id, opened.workspace_id, 'alias should address workspace without selecting it');
  assert.equal((await call(clientB, 'list_workspaces')).selected_workspace_id, crossSession.selected_workspace_id,
    'explicit alias lookups must not switch the session default');
  console.log('Workspace cross-session smoke passed.');
} finally {
  for (const { server, client } of connections.reverse()) {
    await client.close();
    await server.close();
  }
  await fs.rm(tmp, { recursive: true, force: true });
}
