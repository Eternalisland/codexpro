import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createCodexProServer } from '../dist/server.js';
import { loadConfig } from '../dist/config.js';

const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'codexpro-task-checkpoint-'));
const originalHome = process.env.CODEXPRO_HOME;
process.env.CODEXPRO_HOME = path.join(temp, 'home');
const project = path.join(temp, 'web');
const other = path.join(temp, 'java');
const sessions = [];
const createClient = async (config) => {
  const server = createCodexProServer(config);
  const client = new Client({ name: 'task-checkpoint-test', version: '1.0.0' });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await server.connect(b);
  await client.connect(a);
  sessions.push({server, client});
  return client;
};
async function call(client, name, args = {}) {
  const result = await client.callTool({ name, arguments: args });
  assert.equal(result.isError, undefined, name + ': ' + JSON.stringify(result.content));
  return result.structuredContent;
}
async function error(client, name, args) {
  const result = await client.callTool({ name, arguments: args });
  assert(result.isError, name + ' unexpectedly succeeded');
}
const firstSteps = [
  {id: 'inspect', title: 'Inspect routes', status: 'completed'},
  {id: 'implement', title: 'Implement analysis', status: 'in_progress'},
  {id: 'verify', title: 'Run regression', status: 'pending'}
];
try {
  await fs.mkdir(project);
  await fs.mkdir(other);
  await fs.writeFile(path.join(project, 'App.vue'), '<script setup>const x = 1</script>\n');
  await fs.writeFile(path.join(other, 'Api.java'), 'class Api {}\n');
  const config = loadConfig(['--root', project, '--alias', 'web=' + project,
    '--alias', 'java=' + other, '--tool-mode', 'full']);
  const client1 = await createClient(config);
  const payload = {
    workspace_id: 'web',
    task_id: 'multi-repo-api',
    title: 'Vue + Java API contract analysis',
    status: 'in_progress',
    steps: firstSteps,
    next_step_id: 'implement',
    related_workspace_ids: ['java'],
    changed_files: [{ workspace_id: 'web', path: 'App.vue' },
      { workspace_id: 'java', path: 'Api.java' }],
    check_job_ids: [],
    note: 'Inspect the two contracts before changing callers',
    expected_revision: 0
  };
  const saved = await call(client1, 'save_task_checkpoint', payload);
  assert.equal(saved.checkpoint.revision, 1);
  assert.equal(saved.checkpoint.steps[0].status, 'completed');
  assert.equal(saved.checkpoint.related_workspaces.length, 1);
  const replay = await call(client1, 'save_task_checkpoint', payload);
  assert.equal(replay.reused, true);
  assert.equal(replay.checkpoint.revision, 1);

  const client2 = await createClient(config); // Another MCP session / server instance.
  const recovered = await call(client2, 'get_task_checkpoint',
    {workspace_id: 'web', task_id: 'multi-repo-api'});
  assert.equal(recovered.checkpoint.revision, 1);
  assert.equal(recovered.recovery_plan.next_step.id, 'implement');
  assert.equal(recovered.recovery_plan.requires_review, false);
  assert.equal(recovered.recovery_plan.workspace_changes.length, 2);
  const listing = await call(client2, 'list_task_checkpoints', {workspace_id: 'web'});
  assert(listing.tasks.some(x => x.task_id === 'multi-repo-api'));
  const work = await call(client2, 'recover_work', {workspace_id: 'web', limit: 3});
  assert.equal(work.latest_task_checkpoint.task_id, 'multi-repo-api');
  assert.equal(work.suggested_action.action, 'get_task_checkpoint');

  await error(client2, 'save_task_checkpoint', {...payload, expected_revision: 0,
    note: 'stale overwrite attempt'});
  await error(client2, 'save_task_checkpoint', {...payload, task_id: '../escape'});
  await error(client2, 'save_task_checkpoint', {...payload,
    changed_files: [{workspace_id: 'web', path: '../escape.txt'}]});
  const secondPayload = {...payload, expected_revision: 1, note: 'Implementation completed',
    steps: [
      firstSteps[0],
      {...firstSteps[1], status: 'completed'},
      {...firstSteps[2], status: 'in_progress'}
    ], next_step_id: 'verify'};
  const updated = await call(client2, 'save_task_checkpoint', secondPayload);
  assert.equal(updated.checkpoint.revision, 2);
  assert.equal(updated.checkpoint.steps[1].status, 'completed');

  await fs.writeFile(path.join(other, 'Api.java'), 'class Api { int v; }\n');
  const changed = await call(client2, 'get_task_checkpoint', {workspace_id: 'web', task_id: 'multi-repo-api'});
  assert.equal(changed.recovery_plan.requires_review, true);
  assert(changed.recovery_plan.workspace_changes.some(x => x.workspace_id === updated.checkpoint.related_workspaces[0].workspace_id && x.changed));
  const recoverChanged = await call(client2, 'recover_work', {workspace_id: 'web'});
  assert.equal(recoverChanged.suggested_action.action, 'show_changes');
  assert.equal(recoverChanged.suggested_action.workspace_id, updated.checkpoint.related_workspaces[0].workspace_id,
    'review action should target the changed linked workspace, not always the primary workspace');

  const completed = await call(client2, 'save_task_checkpoint', {
    ...secondPayload, expected_revision: 2, status: 'completed', next_step_id: undefined,
    steps: secondPayload.steps.map(x => ({...x, status: 'completed'}))
  });
  assert.equal(completed.checkpoint.status, 'completed');
  const doneRecovery = await call(client2, 'get_task_checkpoint', {workspace_id: 'web', task_id: 'multi-repo-api'});
  assert.equal(doneRecovery.recovery_plan.next_step, null);

  await error(client2, 'get_task_checkpoint', {workspace_id: 'java', task_id: 'multi-repo-api'});
  const offConfig = {...config, writeMode: 'off'};
  const offClient = await createClient(offConfig);
  const tools = (await offClient.listTools()).tools.map(x => x.name);
  assert(!tools.includes('save_task_checkpoint'));
  assert(tools.includes('get_task_checkpoint'));
  assert(tools.includes('recover_work'));

  // Two independent MCP instances race to publish the same immutable revision.
  const concurrent = [
    {...payload, task_id: 'parallel-checkpoint', note: 'writer A'},
    {...payload, task_id: 'parallel-checkpoint', note: 'writer B'}
  ];
  const winners = await Promise.all([
    client1.callTool({name: 'save_task_checkpoint', arguments: concurrent[0]}),
    client2.callTool({name: 'save_task_checkpoint', arguments: concurrent[1]})
  ]);
  assert.equal(winners.filter(x => !x.isError).length, 1, 'only one concurrent revision may be committed');
  const winner = await call(client2, 'get_task_checkpoint', {
    workspace_id: 'web', task_id: 'parallel-checkpoint'
  });
  assert.equal(winner.checkpoint.revision, 1);
  assert(['writer A', 'writer B'].includes(winner.checkpoint.note));
  console.log('Task checkpoint smoke passed (CAS, races, retries, reconnect, cross-repo drift, permissions, completion).');
} finally {
  for (const {client, server} of sessions.reverse()) { await client.close(); await server.close(); }
  if (originalHome === undefined) delete process.env.CODEXPRO_HOME;
  else process.env.CODEXPRO_HOME = originalHome;
  await fs.rm(temp, {recursive: true, force: true});
}
