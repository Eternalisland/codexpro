// Local Trace Explorer UI. Trace-sourced values only enter DOM via textContent.
const $ = (id) => document.getElementById(id);
const base = new URL('.', location.href);
const ui = {
  project: $('project'), from: $('from'), to: $('to'), tool: $('tool'),
  file: $('file'), search: $('search'), events: $('events'), files: $('file-list'),
  revisions: $('revision-list'), diff: $('diff'), prev: $('prev'), next: $('next'),
  connection: $('connection')
};
let changes = [];
let fileGroups = [];
let selectedFileKey = null;
let selectedId = null;
let selectedEventId = null;
let visibleEvents = [];
let version = 0;
let lastSelectionKey = '';
let rangeKey = '';
let diffRequest = 0;
let requestEpoch = 0;
let activeTab = 'files';
let diffMode = 'unified';
let renderedPatches = [];
let filesCollapsed = false;
let historyCollapsed = false;
let reviewMode = false;

function updateReviewLayout() {
  $('view-files').classList.toggle('files-collapsed', filesCollapsed);
  $('view-files').classList.toggle('history-collapsed', historyCollapsed);
  document.body.classList.toggle('review-mode', reviewMode);
  $('toggle-files').textContent = filesCollapsed ? '显示文件列表' : '隐藏文件列表';
  $('toggle-files').setAttribute('aria-expanded', String(!filesCollapsed));
  $('toggle-history').textContent = historyCollapsed ? '显示修改记录' : '隐藏修改记录';
  $('toggle-history').setAttribute('aria-expanded', String(!historyCollapsed));
  $('toggle-review').textContent = reviewMode ? '退出全屏' : '全屏审查';
  $('toggle-review').setAttribute('aria-label', reviewMode ? '退出全屏代码审查' : '进入全屏代码审查');
  $('toggle-review').setAttribute('aria-pressed', String(reviewMode));
}
$('toggle-files').addEventListener('click', () => {
  filesCollapsed = !filesCollapsed;
  updateReviewLayout();
});
$('toggle-history').addEventListener('click', () => {
  historyCollapsed = !historyCollapsed;
  updateReviewLayout();
});
$('toggle-review').addEventListener('click', () => {
  reviewMode = !reviewMode;
  updateReviewLayout();
});
window.addEventListener('keydown', (event) => {
  if (reviewMode && event.key === 'Escape') {
    reviewMode = false;
    updateReviewLayout();
  }
});
updateReviewLayout();

function node(tag, className, content) {
  const element = document.createElement(tag);
  if (className) element.className = className;
  if (content !== undefined) element.textContent = String(content);
  return element;
}
function button(label, className, onClick) {
  const element = node('button', className, label);
  element.type = 'button';
  element.addEventListener('click', onClick);
  return element;
}
function empty(element, message) {
  element.replaceChildren(node('div', 'muted', message));
}
function ts(value) {
  const date = new Date(value);
  return Number.isFinite(date.getTime()) ? date.toLocaleString() : String(value || '—');
}
function clock(value) {
  const date = new Date(value);
  return Number.isFinite(date.getTime()) ? date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' }) : '—';
}
function updateSelect(select, values, label) {
  const previous = select.value;
  const options = [new Option(label, ''), ...values.map((value) => new Option(value, value))];
  select.replaceChildren(...options);
  select.value = options.some((option) => option.value === previous) ? previous : '';
}
function searchParams() {
  const params = new URLSearchParams();
  for (const name of ['project', 'tool', 'file', 'search']) {
    const value = ui[name].value.trim();
    if (value) params.set(name, value);
  }
  if (ui.from.value) params.set('from', new Date(ui.from.value).toISOString());
  if (ui.to.value) params.set('to', new Date(ui.to.value).toISOString());
  return params;
}
function groupKey(project, file) {
  return JSON.stringify([project, file]);
}
function statsForFile(change, file) {
  const stats = change.file_stats?.[file];
  if (stats) return stats;
  return change.paths.length === 1
    ? { additions: change.additions, deletions: change.deletions } : null;
}
function statsLabel(stats) {
  return stats ? '+' + stats.additions + ' / -' + stats.deletions : '统计不可用';
}
function groupChanges(items) {
  const groups = new Map();
  for (const change of items) {
    for (const file of change.paths) {
      const key = groupKey(change.workspace_id, file);
      let group = groups.get(key);
      if (!group) {
        group = { key, project: change.workspace_id, path: file, history: [],
          additions: 0, deletions: 0, statsMissing: false, last: 0, lastTool: '' };
        groups.set(key, group);
      }
      group.history.push(change);
      const stats = statsForFile(change, file);
      if (stats) {
        group.additions += stats.additions;
        group.deletions += stats.deletions;
      } else group.statsMissing = true;
      if (change.time >= group.last) {
        group.last = change.time;
        group.lastTool = change.tool;
      }
    }
  }
  for (const group of groups.values()) {
    group.history.sort((a, b) => a.time - b.time || a.id - b.id);
  }
  return [...groups.values()].sort((a, b) => b.last - a.last || a.path.localeCompare(b.path));
}
function currentGroup() {
  return fileGroups.find((group) => group.key === selectedFileKey);
}
function currentRevision() {
  return currentGroup()?.history.find((change) => change.id === selectedId);
}

async function refresh() {
  const epoch = ++requestEpoch;
  try {
    const response = await fetch(new URL('api/state?' + searchParams(), base), { cache: 'no-store' });
    if (!response.ok) throw new Error('HTTP ' + response.status);
    const data = await response.json();
    if (epoch !== requestEpoch) return;
    version = data.version;
    updateSelect(ui.project, data.projects, '全部项目');
    updateSelect(ui.tool, data.tools, '全部工具');
    $('count-events').textContent = data.total;
    $('count-changes').textContent = data.change_total;
    $('count-projects').textContent = data.projects.length;
    $('updated').textContent = new Date().toLocaleTimeString();

    changes = data.changes;
    fileGroups = groupChanges(changes);
    $('file-count').textContent = fileGroups.length;
    if (!currentGroup()) {
      selectedFileKey = fileGroups[0]?.key ?? null;
      selectedId = fileGroups[0]?.history.at(-1)?.id ?? null;
      rangeKey = '';
      lastSelectionKey = '';
    } else if (!currentRevision()) {
      selectedId = currentGroup().history.at(-1)?.id ?? null;
    }
    renderFiles();
    renderHistory();
    visibleEvents = data.events;
    if (activeTab === 'events') renderEvents();
    if (activeTab === 'agent') void refreshAgents();
    ui.connection.textContent = '实时连接';
  } catch (error) {
    ui.connection.textContent = '连接中断 · 正在重试';
  }
}

function renderFiles() {
  const previousScroll = ui.files.scrollTop;
  const contents = document.createDocumentFragment();
  for (const group of fileGroups) {
    const parts = group.path.split(/[\\/]/);
    const filename = parts.pop() || group.path;
    const item = button('', 'file-card' + (group.key === selectedFileKey ? ' active' : ''), () => {
      selectedFileKey = group.key;
      selectedId = group.history.at(-1).id;
      rangeKey = '';
      lastSelectionKey = '';
      ui.revisions.scrollTop = 0;
      renderFiles();
      renderHistory();
    });
    item.title = group.project + ' · ' + group.path;
    item.setAttribute('aria-pressed', String(group.key === selectedFileKey));
    item.append(node('span', 'file-name', filename));
    item.append(node('span', 'file-dir', (parts.join('/') || '根目录') + ' · ' + group.project));
    const foot = node('span', 'file-foot');
    foot.append(node('span', '', group.history.length + ' 次 · ' + clock(group.last)));
    foot.append(node('span', 'delta', group.statsMissing ? '部分统计不可用' : statsLabel(group)));
    item.append(foot);
    contents.append(item);
  }
  ui.files.replaceChildren(contents);
  if (!fileGroups.length) empty(ui.files, '当前筛选下没有文件变更。可清空筛选或切换到协议事件。');
  else ui.files.scrollTop = previousScroll;
}

function renderHistory() {
  const group = currentGroup();
  if (!group) {
    $('selected-filename').textContent = '暂无文件修改记录';
    $('selected-directory').textContent = '可尝试更换时间范围或清空筛选条件';
    $('file-summary').replaceChildren();
    $('revision-count').textContent = '0';
    ui.revisions.replaceChildren();
    $('history-meta').textContent = '';
    $('diff-title').textContent = '修改前后对比';
    ui.prev.disabled = true;
    ui.next.disabled = true;
    $('compare').disabled = true;
    $('range-start').replaceChildren();
    $('range-end').replaceChildren();
    rangeKey = '';
    lastSelectionKey = '';
    empty(ui.diff, '选择左侧文件以查看代码差异。');
    return;
  }
  const pathParts = group.path.split(/[\\/]/);
  $('selected-filename').textContent = pathParts.pop();
  $('selected-directory').textContent = (pathParts.join('/') || '根目录') + ' · ' + group.project;
  $('selected-directory').title = group.path;
  const summary = $('file-summary');
  summary.replaceChildren();
  for (const value of [
    group.history.length + ' 次修改',
    (group.statsMissing ? '部分统计不可用' : statsLabel(group)) + ' 行',
    '最近 ' + ts(group.last)
  ]) summary.append(node('span', '', value));

  const series = group.history;
  const index = series.findIndex((change) => change.id === selectedId);
  const selected = series[index];
  $('revision-count').textContent = series.length;
  ui.prev.disabled = index <= 0;
  ui.next.disabled = index < 0 || index >= series.length - 1;
  $('compare').disabled = !series.length;
  if (rangeKey !== group.key || $('range-start').options.length !== series.length) {
    $('range-start').replaceChildren(...series.map((change, i) => new Option('第 ' + (i + 1) + ' 次', String(i))));
    $('range-end').replaceChildren(...series.map((change, i) => new Option('第 ' + (i + 1) + ' 次', String(i))));
    $('range-start').value = '0';
    $('range-end').value = String(series.length - 1);
    rangeKey = group.key;
  }
  const previousScroll = ui.revisions.scrollTop;
  const out = document.createDocumentFragment();
  for (let i = series.length - 1; i >= 0; i--) {
    const revision = series[i];
    const item = button('', 'revision' + (revision.id === selectedId ? ' active' : ''), () => {
      selectedId = revision.id;
      lastSelectionKey = '';
      renderHistory();
    });
    item.setAttribute('aria-pressed', String(revision.id === selectedId));
    const row = node('span', 'revision-top');
    row.append(node('span', '', '第 ' + (i + 1) + ' 次'));
    row.append(node('span', 'delta', statsLabel(statsForFile(revision, group.path))));
    item.append(row, node('small', '', revision.tool + ' · ' + clock(revision.ts)));
    out.append(item);
  }
  ui.revisions.replaceChildren(out);
  ui.revisions.scrollTop = previousScroll;
  $('diff-title').textContent = '第 ' + (index + 1) + ' 次修改 · ' + selected.tool;
  $('history-meta').textContent = ts(selected.ts) + '  ·  ' +
    statsLabel(statsForFile(selected, group.path)) + ' 行  ·  ' + (selected.truncated ? '差异已截断' : '操作级 Diff');
  const selectionKey = selected.id + ':' + version;
  if (lastSelectionKey === selectionKey) return;
  lastSelectionKey = selectionKey;
  showDiff(selected).catch(() => empty(ui.diff, '修改内容暂时不可用。'));
}

function navigate(direction) {
  const series = currentGroup()?.history || [];
  const index = series.findIndex((change) => change.id === selectedId);
  const next = series[index + direction];
  if (next) {
    selectedId = next.id;
    lastSelectionKey = '';
    renderHistory();
  }
}
ui.prev.addEventListener('click', () => navigate(-1));
ui.next.addEventListener('click', () => navigate(1));

function parseDiff(source) {
  const before = [], after = [];
  let oldLine = 0, newLine = 0, inHunk = false;
  let oldRemaining = 0, newRemaining = 0;
  let removed = [], added = [];
  const flush = () => {
    for (let i = 0; i < Math.max(removed.length, added.length); i++) {
      before.push(removed[i] || { text: ' ' });
      after.push(added[i] || { text: ' ' });
    }
    removed = []; added = [];
  };
  for (const line of source.split(/\r?\n/).slice(0, 1100)) {
    const hunk = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(line);
    if (hunk) {
      flush();
      inHunk = true; oldLine = Number(hunk[1]); newLine = Number(hunk[3]);
      oldRemaining = hunk[2] === undefined ? 1 : Number(hunk[2]);
      newRemaining = hunk[4] === undefined ? 1 : Number(hunk[4]);
      before.push({ text: line, kind: 'meta' });
      after.push({ text: line, kind: 'meta' });
    } else if (inHunk && line.startsWith('-')) {
      removed.push({ num: oldLine++, text: line.slice(1), kind: 'del' });
      oldRemaining--;
    } else if (inHunk && line.startsWith('+')) {
      added.push({ num: newLine++, text: line.slice(1), kind: 'add' });
      newRemaining--;
    } else if (inHunk && line.startsWith(' ')) {
      flush();
      before.push({ num: oldLine++, text: line.slice(1) });
      after.push({ num: newLine++, text: line.slice(1) });
      oldRemaining--;
      newRemaining--;
    } else if (!inHunk && /^(diff --git |--- |\+\+\+ |index |new file mode |deleted file mode |rename )/.test(line)) {
      flush();
    } else if (line.startsWith('\\')) {
      flush();
    }
    if (inHunk && oldRemaining <= 0 && newRemaining <= 0) inHunk = false;
  }
  flush();
  return [before, after];
}

function changedSpan(text, other) {
  // Bound the work for unusually long generated/minified lines.
  if (text.length > 2000 || other.length > 2000) return node('span', '', text);
  let prefix = 0;
  while (prefix < Math.min(text.length, other.length) && text[prefix] === other[prefix]) prefix++;
  let suffix = 0;
  while (suffix < Math.min(text.length, other.length) - prefix &&
    text[text.length - suffix - 1] === other[other.length - suffix - 1]) suffix++;
  const content = node('span', 'line-code');
  content.append(node('span', '', text.slice(0, prefix)));
  const changed = text.slice(prefix, text.length - suffix);
  if (changed) content.append(node('span', 'changed-fragment', changed));
  if (suffix) content.append(node('span', '', text.slice(text.length - suffix)));
  return content;
}
function diffCell(row, counterpart) {
  const line = node('div', 'code-line ' + (row.kind || ''));
  line.append(node('span', 'num', row.num ?? ''));
  const value = row.text ?? ' ';
  line.append(counterpart && (row.kind === 'del' || row.kind === 'add')
    ? changedSpan(value, counterpart.text ?? '') : node('span', 'line-code', value));
  return line;
}
function diffTable(before, after) {
  const table = node('div', 'diff diff-' + diffMode);
  const head = node('div', 'diff-head');
  if (diffMode === 'split') head.append(node('div', '', '修改前 · Before'), node('div', '', '修改后 · After'));
  else head.append(node('div', '', '修改内容 · Unified'));
  table.append(head);
  const content = node('div', 'diff-rows');
  for (let i = 0; i < Math.max(before.length, after.length); i++) {
    const oldRow = before[i] || { text: ' ' };
    const newRow = after[i] || { text: ' ' };
    const deletion = oldRow.kind === 'del' ? newRow : null;
    const addition = newRow.kind === 'add' ? oldRow : null;
    if (diffMode === 'split') {
      const pair = node('div', 'diff-row');
      pair.append(diffCell(oldRow, deletion), diffCell(newRow, addition));
      content.append(pair);
    } else {
      const pair = node('div', 'diff-row');
      if (oldRow.kind === 'del') pair.append(diffCell(oldRow, deletion));
      if (newRow.kind === 'add') pair.append(diffCell(newRow, addition));
      if (oldRow.kind !== 'del' && newRow.kind !== 'add') pair.append(diffCell(oldRow));
      content.append(pair);
    }
  }
  table.append(content);
  return table;
}
async function loadChange(id, file) {
  const url = new URL('api/change', base);
  url.searchParams.set('id', id);
  url.searchParams.set('file', file);
  const response = await fetch(url, { cache: 'no-store' });
  if (!response.ok) throw new Error('HTTP ' + response.status);
  return response.json();
}
function patchView(data) {
  const wrapper = node('div');
  if (data.patch?.notice) wrapper.append(node('div', 'notice', data.patch.notice));
  if (!data.patch?.text) {
    wrapper.append(node('div', 'muted', data.unavailable_reason ||
      '仅有修改元数据，未保留该文件的代码差异。'));
    return wrapper;
  }
  const [before, after] = parseDiff(data.patch.text);
  wrapper.append(diffTable(before, after));
  if (!data.patch.complete) wrapper.append(node('div', 'notice', '仅展示保留的片段，不能作为完整文件版本比较。'));
  return wrapper;
}
function renderPatches() {
  const content = document.createDocumentFragment();
  if (renderedPatches.length > 1) {
    content.append(node('div', 'notice',
      '依时间顺序展示 ' + renderedPatches.length + ' 次文件级 Patch；并非两个历史版本的最终净 Diff。'));
  }
  for (const entry of renderedPatches) {
    if (entry.title) content.append(node('h3', 'muted', entry.title));
    content.append(patchView(entry.data));
  }
  ui.diff.replaceChildren(content);
}
function selectDiffMode(mode) {
  diffMode = mode;
  for (const name of ['unified', 'split']) {
    const control = $('mode-' + name);
    control.classList.toggle('active', name === mode);
    control.setAttribute('aria-pressed', String(name === mode));
  }
  if (renderedPatches.length) renderPatches();
}
$('mode-unified').addEventListener('click', () => selectDiffMode('unified'));
$('mode-split').addEventListener('click', () => selectDiffMode('split'));

async function showDiff(change) {
  const token = ++diffRequest;
  renderedPatches = [];
  empty(ui.diff, '正在读取当前文件差异…');
  const selectedFile = currentGroup()?.path;
  const result = await loadChange(change.id, selectedFile);
  if (token !== diffRequest || change.id !== selectedId || currentGroup()?.path !== selectedFile) return;
  renderedPatches = [{ data: result }];
  renderPatches();
}

$('compare').addEventListener('click', async () => {
  const series = currentGroup()?.history || [];
  let from = Number($('range-start').value);
  let to = Number($('range-end').value);
  if (!series.length || !Number.isInteger(from) || !Number.isInteger(to)) return;
  if (from > to) [from, to] = [to, from];
  const portion = series.slice(from, Math.min(to + 1, from + 20));
  const selectedFile = currentGroup().path;
  const token = ++diffRequest;
  lastSelectionKey = selectedId + ':' + version + ':range';
  renderedPatches = [];
  empty(ui.diff, '正在加载区间修改…');
  try {
    const results = await Promise.all(portion.map((item) => loadChange(item.id, selectedFile)));
    if (token !== diffRequest || currentGroup()?.path !== selectedFile) return;
    renderedPatches = results.map((data, i) => ({
      data, title: '第 ' + (from + i + 1) + ' 次 · ' + portion[i].tool + ' · ' + ts(portion[i].ts)
    }));
    renderPatches();
    if (to - from + 1 > 20) ui.diff.append(node('div', 'notice', '每次最多显示 20 步，请调整起止位置。'));
  } catch {
    if (token === diffRequest) empty(ui.diff, '连续修改内容读取失败。');
  }
});

const EVENT_NAMES = {
  'workspace.change': '文件内容已修改',
  'tool.start': '工具开始执行',
  'tool.end': '工具执行结束',
  'mcp.request': '收到 MCP 请求',
  'mcp.response': 'MCP 返回响应',
  'mcp.sse.chunk': 'SSE 数据分块',
  'mcp.sse.event': 'SSE 事件',
  'mcp.sse.summary': 'SSE 流摘要',
  'http.response.finish': 'HTTP 响应已写出',
  'http.response.close': 'HTTP 连接关闭',
  'execution.start': '任务开始',
  'execution.end': '任务结束'
};
function renderEvents() {
  const previousScroll = ui.events.scrollTop;
  const out = document.createDocumentFragment();
  for (const event of visibleEvents) {
    const element = button('', 'event' + (event.id === selectedEventId ? ' active' : ''), () => {
      selectedEventId = event.id;
      renderEvents();
      renderEventDetail(event);
    });
    element.append(node('div', 'event-title', EVENT_NAMES[event.event] || event.event));
    element.append(node('small', '', (event.tool ? event.tool + ' · ' : '') + ts(event.ts)));
    element.append(node('small', '', event.paths.join(', ') || event.trace_id || ''));
    out.append(element);
  }
  ui.events.replaceChildren(out);
  if (!visibleEvents.length) empty(ui.events, '当前筛选没有协议事件。');
  else ui.events.scrollTop = previousScroll;
  const selected = visibleEvents.find((event) => event.id === selectedEventId);
  if (selected) renderEventDetail(selected);
  else empty($('event-detail'), '选择左侧事件，查看关联标识和执行状态。');
}
function renderEventDetail(event) {
  const container = $('event-detail');
  const heading = node('h2', '', EVENT_NAMES[event.event] || event.event);
  heading.style.marginBottom = '18px';
  const details = node('dl', 'details-grid');
  const fields = [
    ['事件类型', event.event], ['执行时间', ts(event.ts)], ['工具', event.tool],
    ['项目', event.workspace_id], ['状态', event.status],
    ['耗时', event.duration_ms ? event.duration_ms + ' ms' : '—'],
    ['Trace ID', event.trace_id], ['Request ID', event.request_id],
    ['Span ID', event.span_id], ['Job ID', event.job_id],
    ['关联文件', event.paths.join(', ')]
  ];
  for (const [label, value] of fields) {
    details.append(node('dt', '', label), node('dd', '', value || '—'));
  }
  container.replaceChildren(heading, details);
  const linked = changes.find((change) => change.id === event.id ||
    (change.span_id && change.span_id === event.span_id));
  if (linked) {
    const open = button('查看关联代码修改 →', '', () => {
      const path = linked.paths[0];
      selectedFileKey = groupKey(linked.workspace_id, path);
      selectedId = linked.id;
      rangeKey = '';
      lastSelectionKey = '';
      activateTab('files');
      renderFiles();
      renderHistory();
    });
    open.style.marginTop = '24px';
    container.append(open);
  }
}
// Tool activity is an observable execution trace; it is not private model reasoning.
let agentTraces = [];
let selectedAgentTrace = null;
let agentSteps = [];
let selectedAgentStep = null;
let agentEpoch = 0;
let agentDetailEpoch = 0;
let agentTaskMode = false;
let agentConversationMode = false;
let selectedAgentTask = null;
let selectedAgentConversation = null;
const getAgentMode = () => agentConversationMode ? 'conversations' : agentTaskMode ? 'tasks' : 'requests';
const agentRecordKey = (record) => agentConversationMode
  ? record.conversation_id : agentTaskMode ? record.task_id : record.trace_id;
const currentAgentKey = () => agentConversationMode
  ? selectedAgentConversation : agentTaskMode ? selectedAgentTask : selectedAgentTrace;

async function refreshAgents() {
  const epoch = ++agentEpoch;
  try {
    const mode = getAgentMode();
    const endpoint = mode === 'conversations' ? 'api/agent-conversations?' :
      mode === 'tasks' ? 'api/agent-tasks?' : 'api/agent-traces?';
    const url = new URL(endpoint + searchParams(), base);
    const response = await fetch(url, { cache: 'no-store' });
    if (!response.ok) throw new Error('HTTP ' + response.status);
    const result = await response.json();
    if (epoch !== agentEpoch || activeTab !== 'agent' || mode !== getAgentMode()) return;
    agentTraces = mode === 'conversations' ? result.conversations :
      mode === 'tasks' ? result.tasks : result.traces;
    $('agent-count').textContent = result.total;
    const currentId = currentAgentKey();
    if (!agentTraces.some((item) => agentRecordKey(item) === currentId)) {
      if (mode === 'conversations') selectedAgentConversation = agentTraces[0]?.conversation_id || null;
      else if (mode === 'tasks') selectedAgentTask = agentTraces[0]?.task_id || null;
      else selectedAgentTrace = agentTraces[0]?.trace_id || null;
      selectedAgentStep = null;
    }
    renderAgentTraces();
    const selected = currentAgentKey();
    if (selected) await loadAgentDetail(selected);
    else {
      agentSteps = [];
      $('agent-trace-meta').textContent = '当前筛选下没有工具调用记录';
      empty($('agent-steps'), '没有匹配的 MCP 工具调用。');
      empty($('agent-detail'), '当前没有可查看的步骤。');
    }
  } catch {
    if (epoch === agentEpoch && activeTab === 'agent') {
      empty($('agent-traces'), 'Agent 执行记录暂时不可用。');
    }
  }
}

function renderAgentTraces() {
  const out = document.createDocumentFragment();
  for (const trace of agentTraces) {
    const key = agentRecordKey(trace);
    const isSelected = currentAgentKey() === key;
    const control = button('', 'agent-item' + (isSelected ? ' active' : ''), () => {
      if (agentConversationMode) selectedAgentConversation = key;
      else if (agentTaskMode) selectedAgentTask = key;
      else selectedAgentTrace = key;
      selectedAgentStep = null;
      renderAgentTraces();
      loadAgentDetail(key);
    });
    control.append(node('span', 'item-title', (agentConversationMode ? 'ChatGPT 会话 · ' + trace.conversation_id.slice(-8) :
        agentTaskMode ? trace.task_id : trace.tools.join(' → ')) || '工具调用'));
    control.append(node('span', 'item-sub', ts(trace.ended) + ' · ' +
      (agentTaskMode || agentConversationMode ? trace.request_count + ' 个请求 · ' : '') +
      trace.tool_count + ' 次调用 · ' + trace.command_count + ' 个命令' +
      (trace.error_count ? ' · ' + trace.error_count + ' 次错误' : '')));
    control.append(node('span', 'item-sub', (agentTaskMode || agentConversationMode) ?
      trace.projects.join(', ') : trace.workspace_id + ' · ' + trace.trace_id));
    out.append(control);
  }
  $('agent-traces').replaceChildren(out);
  if (!agentTraces.length) empty($('agent-traces'), agentConversationMode ?
    '没有带 ChatGPT 会话元数据的调用记录。请检查客户端是否传送 openai/session。' :
    agentTaskMode ? '没有显式关联的任务。请让客户端在 MCP 请求中提供 task_id。' :
    '没有匹配的 Agent 工具调用记录。');
}

async function loadAgentDetail(traceId) {
  const epoch = ++agentDetailEpoch;
  const mode = getAgentMode();
  try {
    const endpoint = mode === 'conversations' ? 'api/agent-conversation' :
      mode === 'tasks' ? 'api/agent-task' : 'api/agent-detail';
    const url = new URL(endpoint, base);
    url.searchParams.set(mode === 'conversations' ? 'conversation_id' :
      mode === 'tasks' ? 'task_id' : 'trace_id', traceId);
    const response = await fetch(url, { cache: 'no-store' });
    if (!response.ok) throw new Error('HTTP ' + response.status);
    const result = await response.json();
    if (epoch !== agentDetailEpoch || traceId !== currentAgentKey() ||
      activeTab !== 'agent' || mode !== getAgentMode()) return;
    agentSteps = result.steps;
    if (!agentSteps.some((item) => item.id === selectedAgentStep)) {
      selectedAgentStep = agentSteps.at(-1)?.id ?? null;
    }
    $('agent-trace-meta').textContent = (mode === 'conversations' ? '会话 · ' + result.conversation_id + ' · ' + result.request_count + ' 个请求' :
      mode === 'tasks' ? result.task_id + ' · ' + result.request_count + ' 个请求' : result.trace_id) +
      ' · ' + result.total_steps + ' 步' +
      (result.truncated ? (mode === 'requests' ? '（最近 250 步）' : '（最近 400 步）') : '');
    renderAgentSteps();
  } catch {
    if (epoch === agentDetailEpoch && activeTab === 'agent') {
      empty($('agent-steps'), '执行步骤读取失败或已过期。');
      empty($('agent-detail'), '当前请求的详情不可用。');
    }
  }
}
const AGENT_EVENT_LABELS = {
  'tool.start': '工具调用', 'tool.end': '工具完成', 'workspace.change': '文件修改',
  'execution.start': '验证任务开始', 'execution.output': '命令输出',
  'execution.runtime': '执行进度', 'execution.end': '验证任务结束'
};
function renderAgentSteps() {
  const out = document.createDocumentFragment();
  for (const step of agentSteps) {
    const control = button('', 'agent-item' +
      (step.id === selectedAgentStep ? ' active' : ''), () => {
      selectedAgentStep = step.id;
      renderAgentSteps();
    });
    const status = step.status === 'error' ? ' · 失败' : step.status === 'running' ? ' · 执行中' : '';
    control.append(node('span', 'item-title' + (step.status === 'error' ? ' failed' : ''),
      (AGENT_EVENT_LABELS[step.event] || step.event) + ' · ' +
      (step.detail?.action || step.tool || step.detail?.check || '') + status));
    control.append(node('span', 'item-sub', ts(step.ts) +
      (step.duration_ms ? ' · ' + step.duration_ms + 'ms' : '') +
      (step.job_id ? ' · ' + step.job_id : '') +
      (agentTaskMode || agentConversationMode ? ' · ' + step.trace_id : '')));
    if (step.detail?.command) control.append(node('span', 'item-sub', step.detail.command));
    if (step.changes?.length) control.append(node('span', 'item-sub', step.changes.length + ' 条关联文件变更'));
    out.append(control);
  }
  $('agent-steps').replaceChildren(out);
  if (!agentSteps.length) empty($('agent-steps'), '此请求中没有可展示的执行事件。');
  const current = agentSteps.find((step) => step.id === selectedAgentStep);
  if (current) renderAgentStepDetail(current);
  else empty($('agent-detail'), '请选择执行步骤。');
}

function renderAgentStepDetail(step) {
  const element = $('agent-detail');
  const out = document.createDocumentFragment();
  out.append(node('h3', '', (AGENT_EVENT_LABELS[step.event] || step.event) + ' · ' +
    (step.detail?.action || step.tool || '')));
  const fields = [
    ['开始时间', ts(step.ts)], ['状态', step.status || '未提供'], ['耗时', step.duration_ms ? step.duration_ms + ' ms' : '未提供'],
    ['Trace ID', step.trace_id], ['Span ID', step.span_id], ['Job ID', step.job_id], ['工作目录', step.detail?.cwd],
    ['目标文件', step.detail?.target], ['退出码', step.result?.exit_code ?? '']
  ];
  const details = node('dl');
  for (const [label, value] of fields) {
    if (value === '' || value === undefined || value === null) continue;
    details.append(node('dt', '', label), node('dd', '', value));
  }
  out.append(details);
  const addBlock = (label, value) => {
    if (!value) return;
    out.append(node('h4', '', label));
    out.append(node('pre', '', value));
  };
  addBlock('执行命令', step.detail?.command || step.result?.command);
  if (step.detail?.checks?.length) addBlock('验证项目', step.detail.checks.join('\n'));
  addBlock('任务错误', step.detail?.error);
  addBlock('标准输出（已保留片段）', step.result?.stdout || (step.event === 'execution.output' && step.detail?.stream === 'stdout' ? step.detail.preview : ''));
  addBlock('错误输出（已保留片段）', step.result?.stderr || (step.event === 'execution.output' && step.detail?.stream === 'stderr' ? step.detail.preview : ''));
  addBlock('错误信息', step.result?.error);
  if (step.detail?.input_truncated || step.result?.output_truncated || step.detail?.preview_truncated) {
    out.append(node('div', 'notice', 'Trace 已截断输入或输出，仅显示保留内容。'));
  }
  if (step.event.startsWith('execution.') && !step.detail?.preview) {
    out.append(node('div', 'muted', '此执行事件仅有状态及运行元数据，未包含命令文本或完整输出。'));
  }
  if (step.changes?.length || step.event === 'workspace.change') {
    const links = step.changes?.length ? step.changes : [{ id: step.id, paths: step.paths }];
    for (const change of links) {
      for (const file of change.paths || []) {
        out.append(button('查看文件差异 · ' + file, 'secondary', () => {
          const group = fileGroups.find((item) => item.path === file &&
            item.history.some((revision) => revision.id === change.id));
          if (!group) {
            element.append(node('div', 'notice', '该文件不在当前文件变更筛选结果中，请清空筛选后查看。'));
            return;
          }
          selectedFileKey = group.key;
          selectedId = group.history.find((item) => item.id === change.id)?.id || group.history.at(-1).id;
          lastSelectionKey = '';
          rangeKey = '';
          activateTab('files');
          renderFiles();
          renderHistory();
        }));
      }
    }
  }
  if (!step.detail && !step.result && !step.changes?.length) {
    out.append(node('div', 'muted', '仅有时间与关联标识；原始内容可能未保留。'));
  }
  element.replaceChildren(out);
}

function switchAgentMode(mode) {
  agentTaskMode = mode === 'tasks';
  agentConversationMode = mode === 'conversations';
  selectedAgentStep = null;
  agentSteps = [];
  agentTraces = [];
  ++agentDetailEpoch;
  for (const name of ['requests', 'tasks', 'conversations']) {
    const active = name === getAgentMode();
    const element = $('agent-mode-' + name);
    element.classList.toggle('active', active);
    element.setAttribute('aria-pressed', String(active));
  }
  if (activeTab === 'agent') void refreshAgents();
}
$('agent-mode-requests').addEventListener('click', () => switchAgentMode('requests'));
$('agent-mode-tasks').addEventListener('click', () => switchAgentMode('tasks'));
$('agent-mode-conversations').addEventListener('click', () => switchAgentMode('conversations'));

function activateTab(name) {
  if (name !== 'files' && reviewMode) {
    reviewMode = false;
    updateReviewLayout();
  }
  activeTab = name;
  for (const entry of ['files', 'agent', 'events']) {
    const button = $('tab-' + entry);
    const active = entry === name;
    button.classList.toggle('active', active);
    button.setAttribute('aria-selected', String(active));
    $('view-' + entry).hidden = !active;
  }
  if (name === 'events') renderEvents();
  if (name === 'agent') void refreshAgents();
}
$('tab-files').addEventListener('click', () => activateTab('files'));
$('tab-agent').addEventListener('click', () => activateTab('agent'));
$('tab-events').addEventListener('click', () => activateTab('events'));

$('filters-toggle').addEventListener('click', () => {
  const panel = $('filters-panel');
  panel.hidden = !panel.hidden;
  $('filters-toggle').setAttribute('aria-expanded', String(!panel.hidden));
});
let debounce;
for (const field of [ui.project, ui.from, ui.to, ui.tool, ui.file, ui.search]) {
  field.addEventListener('input', () => {
    clearTimeout(debounce);
    debounce = setTimeout(refresh, 200);
  });
}
$('reset').addEventListener('click', () => {
  for (const field of [ui.project, ui.from, ui.to, ui.tool, ui.file, ui.search]) field.value = '';
  selectedFileKey = null; selectedId = null; selectedEventId = null;
  lastSelectionKey = ''; rangeKey = '';
  refresh();
});

const stream = new EventSource(new URL('api/stream', base));
stream.addEventListener('version', (message) => {
  const next = Number(message.data);
  if (next !== version) refresh();
  else ui.connection.textContent = '实时连接';
});
stream.addEventListener('error', () => { ui.connection.textContent = '正在重新连接…'; });
const updateTimer = setInterval(refresh, 10000);
window.addEventListener('pagehide', () => { clearInterval(updateTimer); stream.close(); });
refresh();
