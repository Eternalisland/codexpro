import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { request as httpRequest } from 'node:http';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { startTraceExplorer, TraceIndex } from './trace-explorer.mjs';
import { patchSections, sectionForFile } from './trace-patch.mjs';

// Header-looking source lines must stay inside their hunk, not become another file.
const disguisedHeaders = [
  '--- a/example.ts', '+++ b/example.ts', '@@ -1 +1 @@',
  '--- old value', '+++ new value'
].join('\n');
assert.equal(patchSections(disguisedHeaders).length, 1);
assert.equal(sectionForFile(disguisedHeaders, 'example.ts').additions, 1);
assert.equal(sectionForFile(disguisedHeaders, 'example.ts').deletions, 1);
assert.equal(sectionForFile(disguisedHeaders, 'unrelated.ts'), null);
const headerOnly = [
  '--- a/first.ts', '+++ b/first.ts', '@@ -1 +1 @@', '-one', '+two',
  '--- a/second.ts', '+++ b/second.ts', '@@ -1 +1 @@', '-old', '+new'
].join('\n');
assert.equal(patchSections(headerOnly).length, 2);
assert.doesNotMatch(sectionForFile(headerOnly, 'first.ts').text, /second.ts/);

const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'codexpro-explorer-'));
const file = path.join(dir, 'trace-2026-10-16.jsonl');
let explorer;
const start = '2026-10-16T00:01:00.000Z';
const record = (event) => JSON.stringify({ ts: start, ...event }) + '\n';
try {
  let browserURL;
  explorer = await startTraceExplorer({ dir, openBrowser: (url) => {
    browserURL = url; return true;
  }, logger: { log() {}, error(message) { throw new Error(message); } } });
  assert.equal(browserURL, explorer.url);
  assert.match(explorer.url, /^http:\/\/127\.0\.0\.1:\d+\/[a-f0-9]{48}\/$/);
  const root = explorer.url;
  const response = await fetch(root);
  assert.equal(response.status, 200);
  const html = await response.text();
  assert.match(html, /Trace Explorer/);
  assert.match(html, /项目/);
  assert.match(html, /文件变更/);
  assert.match(html, /id="tab-agent"/);
  assert.match(html, /id="view-agent"/);
  assert.match(html, /id="agent-steps"/);
  assert.match(html, /id="agent-mode-conversations"/);
  assert.match(html, /协议事件/);
  assert.match(html, /id="tab-files"[^>]+aria-selected="true"/);
  assert.match(html, /id="tab-events"[^>]+aria-selected="false"/);
  assert.match(html, /id="file-list"/);
  assert.match(html, /id="revision-list"/);
  assert.match(html, /id="toggle-files"[^>]*aria-controls="file-sidebar"/);
  assert.match(html, /id="toggle-history"[^>]*aria-controls="revisions"/);
  assert.match(html, /id="toggle-review"[^>]*aria-pressed="false"/);
  assert.match(html, /\.files-collapsed/);
  assert.match(html, /\.history-collapsed/);
  assert.match(html, /body\.review-mode/);
  assert.match(html, /id="filters-panel"[^>]+hidden/);
  assert.match(html, /id="compare"/);
  assert.match(html, /id="range-start"/);
  // Both panes must share one intrinsic-width grid, so long source lines scroll instead of overlapping.
  assert.match(html, /\.diff-split\{display:grid;grid-template-columns:repeat\(2,minmax\(max-content,1fr\)\)/);
  assert.match(html, /\.diff-split \.diff-head,\.diff-split \.diff-rows,\.diff-split \.diff-row\{display:contents\}/);
  assert.match(html, /\.diff-split \.code-line\{min-width:max-content\}/);
  assert.match(html, /\.diff-unified \.code-line\{width:max-content;min-width:100%\}/);
  assert.match(response.headers.get('content-security-policy'), /script-src 'self'/);
  assert.equal(response.headers.get('cache-control'), 'no-store');
  const clientSource = await (await fetch(root + 'app.js')).text();
  assert.match(clientSource, /比较区间|range-start/);
  assert.equal((await fetch(root.replace(/\/[a-f0-9]{48}\/$/, '/invalid/'))).status, 404);
  const invalidHostStatus = await new Promise((resolve, reject) => {
    const url = new URL(root);
    const request = httpRequest({
      hostname: '127.0.0.1', port: url.port, path: url.pathname,
      headers: { Host: 'attacker.local:1234' }
    }, (reply) => { reply.resume(); resolve(reply.statusCode); });
    request.on('error', reject);
    request.end();
  });
  assert.equal(invalidHostStatus, 403);
  assert.equal((await fetch(root, { headers: { Origin: 'http://attacker.local' } })).status, 403);
  assert.equal((await fetch(root, { method: 'POST' })).status, 404);
  assert.equal((await (await fetch(root + 'api/state')).json()).total, 0);

  // SSE opens on the same token-scoped origin, and no other services are exposed.
  const controller = new AbortController();
  const stream = await fetch(root + 'api/stream', { signal: controller.signal });
  assert.equal(stream.status, 200);
  assert.match(stream.headers.get('content-type'), /text\/event-stream/);
  const reader = stream.body.getReader();
  const first = await reader.read();
  assert.match(new TextDecoder().decode(first.value), /event: version/);

  const editA = {
    event: 'workspace.change', trace_id: 'tr_a', span_id: 'sp_a', request_id: 'req_a',
    workspace_id: 'project-a', tool: 'edit', paths: ['src/example.ts'],
    additions: 1, deletions: 1,
    patch: { body: '--- a/src/example.ts\n+++ b/src/example.ts\n@@ -1 +1 @@\n-const value = 1;\n+const value = 2;' }
  };
  const editB = {
    ...editA, trace_id: 'tr_b', span_id: 'sp_b', tool: 'apply_patch',
    patch: { body: '--- a/src/example.ts\n+++ b/src/example.ts\n@@ -1 +1 @@\n-const value = 2;\n+const value = 3;' }
  };
  const other = {
    ...editA, trace_id: 'tr_other', span_id: 'sp_other', workspace_id: 'project-b',
    tool: 'write', paths: ['other.ts'], patch: { body: '--- a/other.ts\n+++ b/other.ts\n@@ -0,0 +1 @@\n+const ok = true;' }
  };
  await fs.writeFile(file, record(editA) +
    record({ ...editB, ts: '2026-10-16T00:02:00.000Z' }) +
    record({ ...other, ts: '2026-10-16T00:03:00.000Z' }), 'utf8');
  await explorer.index.poll();
  const pushed = await Promise.race([
    reader.read(),
    new Promise((_, reject) => setTimeout(() => reject(new Error('SSE did not push updated Trace version')), 6000))
  ]);
  assert.match(new TextDecoder().decode(pushed.value), /event: version/);
  const api = async (params = '') => {
    const result = await fetch(root + 'api/state' + params);
    assert.equal(result.status, 200);
    return result.json();
  };
  let state = await api();
  assert.equal(state.total, 3);
  assert.equal(state.changes.length, 3);
  assert.deepEqual(state.projects, ['project-a', 'project-b']);
  assert.deepEqual(state.tools, ['apply_patch', 'edit', 'write']);
  const byProject = await api('?project=project-a');
  assert.equal(byProject.total, 2);
  assert.deepEqual(byProject.changes.map((item) => item.tool), ['edit', 'apply_patch']);
  assert.equal((await api('?project=project-b&file=example.ts')).total, 0);
  assert.equal((await api('?tool=write&file=other.ts')).total, 1);
  assert.equal((await api('?from=2026-10-16T00%3A02%3A00Z&to=2026-10-16T00%3A03%3A00Z')).total, 2);
  assert.equal((await api('?search=tr_b')).total, 1);
  assert.equal((await api('?file=none')).total, 0);
  const firstChange = await (await fetch(root + 'api/change?id=' + state.changes[0].id)).json();
  assert.equal(firstChange.patch.complete, true);
  assert.match(firstChange.patch.text, /const value = 1/);
  assert.equal((await fetch(root + 'api/change?id=999999')).status, 404);
  assert.equal((await fetch(root + 'api/change?id=abc')).status, 404);

  // One apply_patch may affect several paths: API returns only the selected file's hunks.
  const multiPatch = [
    'diff --git a/package.json b/package.json',
    '--- a/package.json', '+++ b/package.json', '@@ -1 +1 @@',
    '-old package', '+new package',
    'diff --git a/scripts/smoke.mjs b/scripts/smoke.mjs',
    '--- a/scripts/smoke.mjs', '+++ b/scripts/smoke.mjs', '@@ -2 +2 @@',
    '-old smoke', '+new smoke'
  ].join('\n');
  await fs.appendFile(file, record({
    event: 'workspace.change', tool: 'apply_patch', trace_id: 'tr_multi', span_id: 'sp_multi',
    workspace_id: 'project-a', paths: ['package.json', 'scripts/smoke.mjs'],
    additions: 2, deletions: 2, patch: { body: multiPatch }
  }));
  await explorer.index.poll();
  const multiState = await api('?search=tr_multi');
  assert.equal(multiState.changes.length, 1);
  const multi = multiState.changes[0];
  assert.deepEqual(multi.file_stats['package.json'], { additions: 1, deletions: 1 });
  assert.deepEqual(multi.file_stats['scripts/smoke.mjs'], { additions: 1, deletions: 1 });
  const packageUrl = root + 'api/change?id=' + multi.id + '&file=package.json';
  const packageOnly = await (await fetch(packageUrl)).json();
  assert.match(packageOnly.patch.text, /new package/);
  assert.doesNotMatch(packageOnly.patch.text, /old smoke|new smoke/);
  assert.equal(packageOnly.additions, 1);
  const smokeOnly = await (await fetch(root + 'api/change?id=' + multi.id +
    '&file=scripts%2Fsmoke.mjs')).json();
  assert.match(smokeOnly.patch.text, /new smoke/);
  assert.doesNotMatch(smokeOnly.patch.text, /old package|new package/);
  assert.equal((await fetch(root + 'api/change?id=' + multi.id + '&file=not-in-patch.ts')).status, 404);
  const legacyWhole = await (await fetch(root + 'api/change?id=' + multi.id)).json();
  assert.match(legacyWhole.patch.text, /new package/);
  assert.match(legacyWhole.patch.text, /new smoke/);

  // A partial JSONL line is never exposed; UTF-8 characters crossing chunk boundaries survive.
  const partial = record({
    event: 'workspace.change', trace_id: 'tr_unicode', span_id: 'sp_u',
    workspace_id: 'project-a', tool: 'edit', paths: ['源文件.ts'],
    additions: 1, deletions: 1, patch: { body: '--- a/源文件.ts\n+++ b/源文件.ts\n@@ -1 +1 @@\n-旧代码\n+新代码' }
  });
  const partialBuffer = Buffer.from(partial);
  const split = partialBuffer.indexOf(Buffer.from('源文件')) + 1;
  await fs.appendFile(file, partialBuffer.subarray(0, split));
  await explorer.index.poll();
  assert.equal((await api()).total, 4);
  await fs.appendFile(file, partialBuffer.subarray(split));
  await explorer.index.poll();
  state = await api('?file=源文件');
  assert.equal(state.total, 1);
  const unicode = await (await fetch(root + 'api/change?id=' + state.changes[0].id)).json();
  assert.match(unicode.patch.text, /新代码/);

  // Older tool.end events are usable, but not duplicated if a dedicated workspace.change follows.
  await fs.appendFile(file, record({
    event: 'tool.end', status: 'ok', tool: 'edit', trace_id: 'tr_legacy',
    span_id: 'sp_legacy', result: { body: { structuredContent: {
      workspace_id: 'project-a', path: 'legacy.ts', additions: 1, deletions: 1,
      diff: '--- a/legacy.ts\n+++ b/legacy.ts\n@@ -1 +1 @@\n-old\n+new'
    } } }
  }));
  await explorer.index.poll();
  assert.equal((await api('?file=legacy.ts')).changes.length, 1);
  await fs.appendFile(file, record({
    ...editA, span_id: 'sp_legacy', trace_id: 'tr_legacy', paths: ['legacy.ts']
  }));
  await explorer.index.poll();
  assert.equal((await api('?file=legacy.ts')).changes.length, 1);

  // Rotated files and retention/removal appear on subsequent scans.
  const rotated = path.join(dir, 'trace-2026-10-16.1.jsonl');
  await fs.writeFile(rotated, record({ ...other, trace_id: 'tr_rotated', span_id: 'sp_rotated' }));
  await explorer.index.poll();
  assert.equal((await api('?search=tr_rotated')).total, 1);
  await fs.unlink(rotated);
  await explorer.index.poll();
  assert.equal((await api('?search=tr_rotated')).total, 0);

  // Truncated content must never be passed off as a complete historical revision.
  await fs.appendFile(file, record({
    ...editA, span_id: 'sp_truncated', trace_id: 'tr_truncated',
    patch: { preview: '--- a/src/example.ts', truncated: true }
  }));
  await explorer.index.poll();
  const truncated = await api('?search=tr_truncated');
  const snippet = await (await fetch(root + 'api/change?id=' + truncated.changes[0].id)).json();
  assert.equal(snippet.patch.complete, false);
  assert.match(snippet.patch.notice, /部分/);
  const truncatedFile = await (await fetch(root + 'api/change?id=' +
    truncated.changes[0].id + '&file=src%2Fexample.ts')).json();
  assert.equal(truncatedFile.patch, null);
  assert.match(truncatedFile.unavailable_reason, /截断|元数据/);
  assert.deepEqual(truncated.changes[0].file_stats, {});

  // Observable Agent events are grouped per MCP request, never presented as private reasoning.
  const toolTrace = 'tr_agent_fixture';
  await fs.appendFile(file, [
    record({ event: 'tool.start', trace_id: toolTrace, request_id: 'req_agent',
      workspace_id: 'project-a', span_id: 'sp_cmd', tool: 'bash',
      arguments: { body: { command: 'npm run build', cwd: '.' } } }),
    record({ event: 'tool.end', trace_id: toolTrace, request_id: 'req_agent',
      span_id: 'sp_cmd', tool: 'bash', status: 'ok', duration_ms: 123,
      result: { body: { structuredContent: {
        command: 'npm run build', exit_code: 0, stdout: 'Build ok', stderr: '',
        output_truncated: false
      } } } }),
    record({ event: 'tool.start', trace_id: toolTrace, request_id: 'req_agent',
      workspace_id: 'project-a', span_id: 'sp_edit', tool: 'edit',
      arguments: { body: { path: 'src/example.ts' } } }),
    record({ event: 'workspace.change', trace_id: toolTrace, request_id: 'req_agent',
      workspace_id: 'project-a', span_id: 'sp_edit', tool: 'edit',
      paths: ['src/example.ts'], additions: 1, deletions: 1,
      patch: { body: '--- a/src/example.ts\\n+++ b/src/example.ts\\n@@ -1 +1 @@\\n-old\\n+new' } }),
    record({ event: 'tool.end', trace_id: toolTrace, request_id: 'req_agent',
      span_id: 'sp_edit', tool: 'edit', status: 'ok', duration_ms: 10 }),
    record({ event: 'execution.output', trace_id: toolTrace, request_id: 'req_agent',
      job_id: 'check_1', stream: 'stdout', check: 'build', preview: 'compiling...', preview_truncated: true }),
    record({ event: 'tool.start', trace_id: 'tr_failed_agent', request_id: 'req_failed',
      workspace_id: 'project-b', span_id: 'sp_fail', tool: 'bash',
      arguments: { body: { command: 'npm run missing' } } }),
    record({ event: 'tool.end', trace_id: 'tr_failed_agent', request_id: 'req_failed',
      span_id: 'sp_fail', tool: 'bash', status: 'error', duration_ms: 5,
      result: { body: { content: [{ text: 'Command failed' }] } } })
  ].join(''));
  await explorer.index.poll();
  const agentList = await (await fetch(root + 'api/agent-traces?project=project-a&tool=bash')).json();
  const agentSummary = agentList.traces.find((item) => item.trace_id === toolTrace);
  assert.ok(agentSummary);
  assert.equal(agentSummary.command_count, 1);
  assert.equal(agentSummary.change_count, 1);
  assert.equal(agentSummary.tool_count, 2);
  assert.equal((await (await fetch(root + 'api/agent-traces?search=req_failed')).json()).total, 1);
  assert.equal((await (await fetch(root + 'api/agent-traces?file=src%2Fexample.ts')).json())
    .traces.some((item) => item.trace_id === toolTrace), true);
  const agent = await (await fetch(root + 'api/agent-detail?trace_id=' + toolTrace)).json();
  assert.equal(agent.trace_id, toolTrace);
  assert.equal(agent.steps.filter((step) => step.event === 'tool.start').length, 2);
  const cmd = agent.steps.find((step) => step.tool === 'bash');
  assert.equal(cmd.detail.command, 'npm run build');
  assert.equal(cmd.status, 'ok');
  assert.equal(cmd.result.exit_code, 0);
  assert.match(cmd.result.stdout, /Build ok/);
  const edited = agent.steps.find((step) => step.tool === 'edit');
  assert.equal(edited.changes.length, 1);
  assert.deepEqual(edited.changes[0].paths, ['src/example.ts']);
  assert.equal(agent.steps.find((step) => step.event === 'execution.output').detail.preview, 'compiling...');
  const failedAgent = await (await fetch(root + 'api/agent-detail?trace_id=tr_failed_agent')).json();
  assert.equal(failedAgent.steps[0].status, 'error');
  assert.match(failedAgent.steps[0].result.error, /Command failed/);
  assert.equal((await fetch(root + 'api/agent-detail?trace_id=tr_missing')).status, 404);
  // A command can exit non-zero even when the MCP envelope itself returns status=ok.
  await fs.appendFile(file, [
    record({ event: 'tool.start', trace_id: 'tr_nonzero_agent', span_id: 'sp_nonzero',
      tool: 'bash', request_id: 'req_nonzero', workspace_id: 'project-a',
      arguments: { body: { command: 'npm run missing' } } }),
    record({ event: 'tool.end', trace_id: 'tr_nonzero_agent', span_id: 'sp_nonzero',
      tool: 'bash', request_id: 'req_nonzero', status: 'ok',
      result: { body: { structuredContent: { exit_code: 2,
        stderr: 'command not found', output_truncated: true } } } }),
    record({ event: 'execution.end', trace_id: 'tr_nonzero_agent', job_id: 'check_2',
      request_id: 'req_nonzero', status: 'failed', error: 'test check failed' })
  ].join(''));
  await explorer.index.poll();
  const nonzeroSummary = (await (await fetch(root +
    'api/agent-traces?search=tr_nonzero_agent')).json()).traces[0];
  assert.equal(nonzeroSummary.error_count, 2);
  const nonzeroDetail = await (await fetch(root +
    'api/agent-detail?trace_id=tr_nonzero_agent')).json();
  assert.equal(nonzeroDetail.steps[0].status, 'error');
  assert.equal(nonzeroDetail.steps[0].result.exit_code, 2);
  assert.equal(nonzeroDetail.steps[0].result.output_truncated, true);
  assert.equal(nonzeroDetail.steps[1].status, 'error');
  assert.equal(nonzeroDetail.steps[1].detail.error, 'test check failed');
  assert.equal((await fetch(root + 'api/agent-detail?trace_id=bad%2Ftrace')).status, 404);

  // Explicit task_id groups two distinct requests; unlabelled requests must remain separate.
  const taskEvents = [
    record({ event: 'tool.start', task_id: 'task_refactor_7', trace_id: 'tr_task_first',
      request_id: 'req_first', span_id: 'sp_first', workspace_id: 'project-a',
      tool: 'read', arguments: { body: { path: 'src/example.ts' } },
      ts: '2026-10-16T08:00:00.000Z' }),
    record({ event: 'tool.end', task_id: 'task_refactor_7', trace_id: 'tr_task_first',
      request_id: 'req_first', span_id: 'sp_first', tool: 'read', status: 'ok',
      ts: '2026-10-16T08:00:01.000Z' }),
    record({ event: 'tool.start', task_id: 'task_refactor_7', trace_id: 'tr_task_second',
      request_id: 'req_second', span_id: 'sp_second', workspace_id: 'project-a',
      tool: 'bash', arguments: { body: { command: 'npm run check:explorer' } },
      ts: '2026-10-16T08:01:00.000Z' }),
    record({ event: 'tool.end', task_id: 'task_refactor_7', trace_id: 'tr_task_second',
      request_id: 'req_second', span_id: 'sp_second', tool: 'bash', status: 'ok',
      duration_ms: 99, result: { body: { structuredContent: { exit_code: 0 } } },
      ts: '2026-10-16T08:01:01.000Z' }),
    record({ event: 'tool.start', trace_id: 'tr_same_time_other',
      request_id: 'req_other', span_id: 'sp_other_unlabelled', workspace_id: 'project-a',
      tool: 'bash', ts: '2026-10-16T08:01:01.000Z' }),
    record({ event: 'tool.start', task_id: 'invalid/path', trace_id: 'tr_bad_label',
      request_id: 'req_bad', span_id: 'sp_bad', tool: 'bash',
      ts: '2026-10-16T08:01:01.000Z' })
  ].join('');
  await fs.appendFile(file, taskEvents);
  await explorer.index.poll();
  const tasks = await (await fetch(root + 'api/agent-tasks')).json();
  assert.equal(tasks.total, 1);
  assert.equal(tasks.tasks[0].task_id, 'task_refactor_7');
  assert.equal(tasks.tasks[0].request_count, 2);
  assert.equal(tasks.tasks[0].tool_count, 2);
  assert.equal((await (await fetch(root + 'api/agent-tasks?project=project-b')).json()).total, 0);
  assert.equal((await (await fetch(root + 'api/agent-tasks?search=task_refactor_7')).json()).total, 1);
  const task = await (await fetch(root + 'api/agent-task?task_id=task_refactor_7')).json();
  assert.equal(task.request_count, 2);
  assert.equal(task.steps.length, 2);
  assert.deepEqual(task.steps.map((step) => step.trace_id), ['tr_task_first', 'tr_task_second']);
  assert.equal(task.steps[1].result.exit_code, 0);
  assert.equal((await fetch(root + 'api/agent-task?task_id=tr_same_time_other')).status, 404);
  assert.equal((await fetch(root + 'api/agent-task?task_id=bad%2Fpath')).status, 404);

  // ChatGPT _meta supplies an anonymized conversation id, not a task id.
  // The recorder stores only this deterministic hash and never the source value.
  const anonymized = 'opaque-host-provided-session-for-tests';
  const digest = 'sha256:' + createHash('sha256').update('openai/session:' + anonymized)
    .digest('hex').slice(0, 24);
  const otherDigest = 'sha256:' + createHash('sha256').update('openai/session:other-session')
    .digest('hex').slice(0, 24);
  await fs.appendFile(file, [
    record({ event: 'tool.start', conversation_id: digest, trace_id: 'tr_chat_first',
      request_id: 'req_chat_1', span_id: 'sp_chat_1', workspace_id: 'project-a',
      tool: 'read', ts: '2026-10-16T09:00:00.000Z' }),
    record({ event: 'tool.end', conversation_id: digest, trace_id: 'tr_chat_first',
      request_id: 'req_chat_1', span_id: 'sp_chat_1', status: 'ok', tool: 'read',
      ts: '2026-10-16T09:00:01.000Z' }),
    record({ event: 'tool.start', conversation_id: digest, trace_id: 'tr_chat_second',
      request_id: 'req_chat_2', span_id: 'sp_chat_2', workspace_id: 'project-a',
      tool: 'bash', arguments: { body: { command: 'npm run build' } },
      ts: '2026-10-16T09:01:00.000Z' }),
    record({ event: 'tool.end', conversation_id: digest, trace_id: 'tr_chat_second',
      request_id: 'req_chat_2', span_id: 'sp_chat_2', tool: 'bash', status: 'ok',
      result: { body: { structuredContent: { exit_code: 0 } } },
      ts: '2026-10-16T09:01:01.000Z' }),
    record({ event: 'tool.start', conversation_id: otherDigest, trace_id: 'tr_chat_other',
      request_id: 'req_chat_other', span_id: 'sp_chat_other', workspace_id: 'project-b',
      tool: 'write', ts: '2026-10-16T09:01:01.000Z' }),
    record({ event: 'tool.start', trace_id: 'tr_chat_unlabelled',
      request_id: 'req_chat_none', span_id: 'sp_chat_none', tool: 'read',
      ts: '2026-10-16T09:01:01.000Z' })
  ].join(''));
  await explorer.index.poll();
  const sessionList = await (await fetch(root + 'api/agent-conversations')).json();
  assert.equal(sessionList.total, 2);
  const grouped = sessionList.conversations.find((row) => row.conversation_id === digest);
  assert.equal(grouped.request_count, 2);
  assert.equal(grouped.tool_count, 2);
  assert.equal((await (await fetch(root + 'api/agent-conversations?project=project-b')).json()).total, 1);
  assert.equal((await (await fetch(root + 'api/agent-conversations?search=' + digest)).json()).total, 1);
  const sessionDetail = await (await fetch(root + 'api/agent-conversation?conversation_id=' +
    encodeURIComponent(digest))).json();
  assert.equal(sessionDetail.request_count, 2);
  assert.deepEqual(sessionDetail.steps.map((item) => item.trace_id), ['tr_chat_first', 'tr_chat_second']);
  assert.equal((await fetch(root + 'api/agent-conversation?conversation_id=' +
    encodeURIComponent('sha256:000000000000000000000000'))).status, 404);
  assert.equal((await fetch(root + 'api/agent-conversation?conversation_id=not-hashed')).status, 404);
  assert.doesNotMatch(JSON.stringify(sessionList) + JSON.stringify(sessionDetail), /opaque-host-provided/);
  assert.equal((await (await fetch(root + 'api/agent-tasks')).json()).total, 1);

  // Separate instance: no files initially, then discover new trace file later.
  const empty = new TraceIndex(path.join(dir, 'missing-dir'));
  await empty.poll();
  assert.equal(empty.query().total, 0);

  // The documented CLI launches the same service without attempting to open a browser.
  const cli = spawn(process.execPath, [
    'scripts/codexpro.mjs', 'trace', 'explorer', '--trace-dir', dir, '--no-open'
  ], { cwd: path.resolve('.'), stdio: ['ignore', 'pipe', 'pipe'] });
  try {
    const cliURL = await new Promise((resolve, reject) => {
      let output = '';
      const timeout = setTimeout(() => reject(new Error('trace explorer CLI launch timed out')), 10000);
      cli.stdout.on('data', (chunk) => {
        output += String(chunk);
        const found = /Trace Explorer listening locally: (http:\/\/127\.0\.0\.1:\d+\/[a-f0-9]{48}\/)/.exec(output);
        if (found) { clearTimeout(timeout); resolve(found[1]); }
      });
      cli.once('exit', (code) => { clearTimeout(timeout); reject(new Error('trace explorer CLI exited early: ' + code)); });
      cli.once('error', (error) => { clearTimeout(timeout); reject(error); });
    });
    assert.equal((await fetch(cliURL)).status, 200);
    assert.equal((await (await fetch(cliURL + 'api/state')).json()).total, explorer.index.query().total);
  } finally {
    cli.kill();
    await new Promise((resolve) => {
      if (cli.exitCode !== null || cli.signalCode !== null) return resolve();
      cli.once('exit', resolve);
      setTimeout(resolve, 3000).unref();
    });
  }

  controller.abort();
  await reader.cancel().catch(() => {});
  console.log('trace explorer smoke ok');
} finally {
  if (explorer) await explorer.close();
  await fs.rm(dir, { recursive: true, force: true });
}
