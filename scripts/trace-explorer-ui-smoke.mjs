import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { runInNewContext } from 'node:vm';

class MockElement {
  constructor(tag = 'div') {
    this.tag = tag;
    this.children = [];
    this.listeners = new Map();
    this.attributes = new Map();
    this.style = {};
    this.className = '';
    this.hidden = false;
    this.value = '';
    this.scrollTop = 0;
    this.textContent = '';
    this.classList = { toggle: (token, enabled) => {
      const classes = new Set(this.className.split(' ').filter(Boolean));
      if (enabled) classes.add(token);
      else classes.delete(token);
      this.className = [...classes].join(' ');
    } };
  }
  get options() { return this.children.filter((child) => child.tag === 'option'); }
  append(...nodes) {
    for (const element of nodes) {
      if (element.tag === 'fragment') this.children.push(...element.children);
      else this.children.push(element);
    }
  }
  replaceChildren(...nodes) { this.children = []; this.append(...nodes); }
  addEventListener(type, callback) { this.listeners.set(type, callback); }
  setAttribute(key, value) { this.attributes.set(key, value); }
  fire(type) { this.listeners.get(type)?.(); }
}
const names = [
  'project','from','to','tool','file','search','events','file-list','revision-list',
  'diff','prev','next','connection','count-events','count-changes','count-projects',
  'updated','file-count','selected-filename','selected-directory','file-summary',
  'revision-count','history-meta','diff-title','range-start','range-end',
  'compare','mode-unified','mode-split','reset','tab-files','tab-events','view-files','view-events',
  'event-detail','filters-toggle','filters-panel','toggle-files','toggle-history','toggle-review',
  'tab-agent','view-agent','agent-traces','agent-steps','agent-detail','agent-count','agent-trace-meta',
  'agent-mode-requests','agent-mode-tasks','agent-mode-conversations'
];
const dom = new Map(names.map((name) => [name, new MockElement(name)]));
const body = new MockElement('body');
const windowListeners = new Map();
dom.get('filters-panel').hidden = true;
dom.get('view-events').hidden = true;
dom.get('view-agent').hidden = true;

const changes = [
  { id: 1, ts:'2026-10-16T01:00:00Z', time:1792112400000,
    tool:'edit', trace_id:'tr_1', span_id:'sp_1', workspace_id:'project-a',
    paths:['src/First.ts'], additions:1, deletions:1 },
  { id: 2, ts:'2026-10-16T01:01:00Z', time:1792112460000,
    tool:'edit', trace_id:'tr_2', span_id:'sp_2', workspace_id:'project-a',
    paths:['src/First.ts'], additions:2, deletions:1 },
  { id: 3, ts:'2026-10-16T01:02:00Z', time:1792112520000,
    tool:'write', trace_id:'tr_3', span_id:'sp_3', workspace_id:'project-b',
    paths:['src/Second.ts'], additions:2, deletions:0 }
];
let queried = 0;
const state = {
  version:1, total:3, change_total:3, projects:['project-a','project-b'],
  tools:['edit','write'], changes,
  events: changes.map((entry) => ({
    ...entry, event:'workspace.change', request_id:'req_' + entry.id,
    job_id:'', status:'ok', duration_ms:12
  }))
};
const requestedChanges = [];
const requestedFiles = [];
const fetchMock = async (target) => {
  const url = new URL(String(target));
  if (url.pathname.endsWith('/api/state')) {
    queried++;
    const project = url.searchParams.get('project');
    const selected = project ? changes.filter((c) => c.workspace_id === project) : changes;
    return { ok:true, json: async () => ({
      ...state, changes: selected, change_total:selected.length, total:selected.length,
      events:state.events.filter((e) => selected.includes(changes.find((c) => c.id === e.id)))
    }) };
  }
  if (url.pathname.endsWith('/api/agent-conversations')) {
    return { ok: true, json: async () => ({
      total: 1, conversations: [{
        conversation_id: 'sha256:0123456789abcdef01234567', request_count: 2,
        tool_count: 2, command_count: 1, change_count: 1, error_count: 0,
        projects: ['project-a'], ended: '2026-10-16T01:01:00Z'
      }]
    }) };
  }
  if (url.pathname.endsWith('/api/agent-conversation')) {
    return { ok: true, json: async () => ({
      conversation_id: 'sha256:0123456789abcdef01234567',
      request_count: 2, total_steps: 2, truncated: false,
      steps: [
        { id: 100, trace_id: 'tr_first', event: 'tool.start', tool: 'bash',
          ts: '2026-10-16T01:00:00Z', status: 'ok', paths: [], changes: [],
          detail: { command: 'npm run build' }, result: { exit_code: 0, stdout: 'build ok' } },
        { id: 101, trace_id: 'tr_second', event: 'tool.start', tool: 'edit',
          ts: '2026-10-16T01:01:00Z', status: 'ok', paths: ['src/First.ts'],
          changes: [{ id: 2, paths: ['src/First.ts'] }] }
      ]
    }) };
  }
  if (url.pathname.endsWith('/api/agent-tasks')) {
    return { ok: true, json: async () => ({
      total: 1, tasks: [{
        task_id: 'task_ui_1', request_count: 2, tool_count: 2, command_count: 1,
        change_count: 1, error_count: 0, projects: ['project-a'],
        ended: '2026-10-16T01:01:00Z'
      }]
    }) };
  }
  if (url.pathname.endsWith('/api/agent-task')) {
    return { ok: true, json: async () => ({
      task_id: 'task_ui_1', request_count: 2, total_steps: 2, truncated: false,
      steps: [
        { id: 100, trace_id: 'tr_first', event: 'tool.start', tool: 'bash',
          ts: '2026-10-16T01:00:00Z', status: 'ok', paths: [], changes: [],
          detail: { command: 'npm run build' }, result: { exit_code: 0, stdout: 'build ok' } },
        { id: 101, trace_id: 'tr_second', event: 'tool.start', tool: 'edit',
          ts: '2026-10-16T01:01:00Z', status: 'ok', paths: ['src/First.ts'],
          changes: [{ id: 2, paths: ['src/First.ts'] }] }
      ]
    }) };
  }
  if (url.pathname.endsWith('/api/agent-traces')) {
    return { ok: true, json: async () => ({ total: 1, traces: [{
      trace_id: 'tr_test', request_id: 'req_test', workspace_id: 'project-a',
      started: '2026-10-16T01:00:00Z', ended: '2026-10-16T01:01:00Z',
      tools: ['bash', 'edit'], tool_count: 2, command_count: 1,
      change_count: 1, error_count: 0
    }] }) };
  }
  if (url.pathname.endsWith('/api/agent-detail')) {
    return { ok: true, json: async () => ({
      trace_id: 'tr_test', total_steps: 2, truncated: false,
      steps: [
        { id: 100, event: 'tool.start', tool: 'bash', ts: '2026-10-16T01:00:00Z',
          status: 'ok', span_id: 'sp_agent', paths: [], changes: [],
          detail: { command: 'npm run build' },
          result: { exit_code: 0, stdout: 'build ok', stderr: '' } },
        { id: 101, event: 'tool.start', tool: 'edit', ts: '2026-10-16T01:01:00Z',
          status: 'ok', paths: ['src/First.ts'], span_id: 'sp_change',
          detail: { target: 'src/First.ts' }, changes: [{ id: 2, paths: ['src/First.ts'] }] }
      ]
    }) };
  }
  if (url.pathname.endsWith('/api/change')) {
    const id = Number(url.searchParams.get('id'));
    requestedChanges.push(id);
    requestedFiles.push(url.searchParams.get('file'));
    return { ok:true, json: async () => ({
      id, patch:{ complete:true, text: [
        '--- a/src/example.ts', '+++ b/src/example.ts', '@@ -1 +1 @@',
        '-const total = 100;', '+const total = 200;'
      ].join('\n') }
    }) };
  }
  throw new Error('Unexpected URL ' + url);
};
class MockEventSource {
  constructor(url) { this.url = url; this.listeners = new Map(); }
  addEventListener(name, listener) { this.listeners.set(name, listener); }
  close() {}
}
const source = await fs.readFile(new URL('./trace-explorer-client.js', import.meta.url), 'utf8');
runInNewContext(source, {
  document: {
    body,
    getElementById: (id) => dom.get(id),
    createElement: (tag) => new MockElement(tag),
    createDocumentFragment: () => new MockElement('fragment')
  },
  window: { addEventListener(name, callback) { windowListeners.set(name, callback); } },
  Option: class extends MockElement {
    constructor(text, value) { super('option'); this.textContent = text; this.value = value; }
  },
  EventSource:MockEventSource,
  fetch:fetchMock,
  URL, URLSearchParams,
  location:{href:'http://127.0.0.1:9876/local-token/'},
  setInterval:() => 1,
  clearInterval:() => {},
  setTimeout:(fn) => { fn(); return 1; },
  clearTimeout:() => {},
  Date,
  console
});
const tick = () => new Promise((resolve) => setImmediate(resolve));
await tick();
await tick();

assert.equal(String(dom.get('file-count').textContent), '2');
assert.equal(dom.get('selected-filename').textContent, 'Second.ts');
assert.equal(dom.get('file-list').children.length, 2);
assert.equal(dom.get('revision-list').children.length, 1);
assert.equal(dom.get('view-events').hidden, true);
assert.equal(dom.get('view-files').hidden, false);

const firstFile = dom.get('file-list').children.find((element) =>
  element.children.some((child) => child.className === 'file-name' && child.textContent === 'First.ts'));
assert.ok(firstFile);
firstFile.fire('click');
await tick();
assert.equal(dom.get('selected-filename').textContent, 'First.ts');
assert.equal(dom.get('revision-list').children.length, 2);
assert.match(dom.get('diff-title').textContent, /第 2 次修改/);
dom.get('prev').fire('click');
await tick();
assert.match(dom.get('diff-title').textContent, /第 1 次修改/);
assert.equal(dom.get('prev').disabled, true);
dom.get('next').fire('click');
await tick();
assert.match(dom.get('diff-title').textContent, /第 2 次修改/);
assert.equal(requestedFiles.at(-1), 'src/First.ts');

// Collapse controls preserve the active file/revision; focused review temporarily hides both rails.
const selectedTitle = dom.get('diff-title').textContent;
const requestsBeforeLayout = requestedChanges.length;
dom.get('toggle-files').fire('click');
assert.match(dom.get('view-files').className, /files-collapsed/);
assert.equal(dom.get('toggle-files').attributes.get('aria-expanded'), 'false');
assert.equal(dom.get('toggle-files').textContent, '显示文件列表');
dom.get('toggle-history').fire('click');
assert.match(dom.get('view-files').className, /history-collapsed/);
assert.equal(dom.get('toggle-history').attributes.get('aria-expanded'), 'false');
assert.equal(dom.get('diff-title').textContent, selectedTitle);
dom.get('toggle-review').fire('click');
assert.match(body.className, /review-mode/);
assert.equal(dom.get('toggle-review').attributes.get('aria-pressed'), 'true');
assert.equal(dom.get('toggle-review').textContent, '退出全屏');
assert.equal(dom.get('diff-title').textContent, selectedTitle);
assert.equal(requestedChanges.length, requestsBeforeLayout);
windowListeners.get('keydown')({ key: 'Escape' });
assert.doesNotMatch(body.className, /review-mode/);
assert.equal(dom.get('toggle-review').attributes.get('aria-pressed'), 'false');
assert.match(dom.get('view-files').className, /files-collapsed/);
assert.match(dom.get('view-files').className, /history-collapsed/);
// Live refresh must not reset layout state or the selected revision.
dom.get('project').value = 'project-a';
dom.get('project').fire('input');
await tick();
assert.match(dom.get('view-files').className, /files-collapsed/);
assert.match(dom.get('view-files').className, /history-collapsed/);
assert.equal(dom.get('diff-title').textContent, selectedTitle);
dom.get('project').value = '';
dom.get('project').fire('input');
await tick();
dom.get('toggle-review').fire('click');
dom.get('toggle-review').fire('click');
assert.doesNotMatch(body.className, /review-mode/);
dom.get('toggle-history').fire('click');
dom.get('toggle-files').fire('click');
assert.doesNotMatch(dom.get('view-files').className, /files-collapsed|history-collapsed/);
const flatten = (root) => [root, ...root.children.flatMap(flatten)];
assert.ok(flatten(dom.get('diff')).some((element) => element.className === 'changed-fragment'));
assert.ok(flatten(dom.get('diff')).some((element) => element.className === 'diff diff-unified'));
dom.get('mode-split').fire('click');
assert.equal(dom.get('mode-split').attributes.get('aria-pressed'), 'true');
assert.ok(flatten(dom.get('diff')).some((element) => element.className === 'diff diff-split'));
dom.get('mode-unified').fire('click');
assert.equal(dom.get('mode-unified').attributes.get('aria-pressed'), 'true');

dom.get('compare').fire('click');
await tick();
await tick();
assert.ok(requestedChanges.includes(1) && requestedChanges.includes(2));
assert.ok(requestedFiles.every((file) => file === 'src/First.ts' || file === 'src/Second.ts'));
assert.ok(dom.get('diff').children.length > 0);

dom.get('tab-events').fire('click');
assert.equal(dom.get('view-files').hidden, true);
assert.equal(dom.get('view-events').hidden, false);
assert.equal(dom.get('tab-events').attributes.get('aria-selected'), 'true');
assert.equal(dom.get('events').children.length, 3);
dom.get('events').children[0].fire('click');
assert.ok(dom.get('event-detail').children.length > 0);
dom.get('tab-files').fire('click');
assert.equal(dom.get('view-files').hidden, false);

// Agent trace tab shows only observed tool activity, command output and file links.
dom.get('tab-agent').fire('click');
await tick();
await tick();
assert.equal(dom.get('view-agent').hidden, false);
assert.equal(dom.get('view-files').hidden, true);
assert.equal(dom.get('agent-traces').children.length, 1);
assert.equal(dom.get('agent-steps').children.length, 2);
dom.get('agent-steps').children[0].fire('click');
assert.ok(flatten(dom.get('agent-detail')).some((item) => item.textContent === 'npm run build'));
assert.ok(flatten(dom.get('agent-detail')).some((item) => item.textContent === 'build ok'));
dom.get('agent-mode-tasks').fire('click');
await tick();
await tick();
assert.equal(dom.get('agent-mode-tasks').attributes.get('aria-pressed'), 'true');
assert.equal(dom.get('agent-traces').children.length, 1);
assert.equal(dom.get('agent-steps').children.length, 2);
assert.match(dom.get('agent-trace-meta').textContent, /2 个请求/);
dom.get('agent-steps').children[0].fire('click');
assert.ok(flatten(dom.get('agent-detail')).some((item) => item.textContent === 'tr_first'));
// Automatic conversation grouping is distinct from explicit task grouping.
dom.get('agent-mode-conversations').fire('click');
await tick();
await tick();
assert.equal(dom.get('agent-mode-conversations').attributes.get('aria-pressed'), 'true');
assert.equal(dom.get('agent-mode-tasks').attributes.get('aria-pressed'), 'false');
assert.equal(dom.get('agent-traces').children.length, 1);
assert.match(dom.get('agent-trace-meta').textContent, /会话.*2 个请求/);
assert.equal(dom.get('agent-steps').children.length, 2);
dom.get('agent-steps').children[0].fire('click');
assert.ok(flatten(dom.get('agent-detail')).some((item) => item.textContent === 'tr_first'));
dom.get('agent-steps').children[1].fire('click');
const link = flatten(dom.get('agent-detail')).find((item) =>
  String(item.textContent).includes('查看文件差异'));
assert.ok(link);
link.fire('click');
assert.equal(dom.get('view-files').hidden, false);
assert.equal(dom.get('selected-filename').textContent, 'First.ts');

dom.get('filters-toggle').fire('click');
assert.equal(dom.get('filters-panel').hidden, false);
assert.equal(dom.get('filters-toggle').attributes.get('aria-expanded'), 'true');
dom.get('project').value = 'project-b';
dom.get('project').fire('input');
await tick();
assert.equal(dom.get('selected-filename').textContent, 'Second.ts');
assert.equal(String(dom.get('file-count').textContent), '1');
dom.get('reset').fire('click');
await tick();
assert.equal(String(dom.get('file-count').textContent), '2');
assert.ok(queried >= 3);
console.log('trace explorer UI smoke ok');
