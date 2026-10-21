import { agentGroupList, agentTraceDetail } from './trace-agent.mjs';

// Only a validated, explicitly supplied task_id can unite different MCP requests.
export const isTaskId = (value) =>
  typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,63}$/.test(value);

function members(events) {
  const tasks = new Map();
  for (const event of events) {
    if (!isTaskId(event.task_id) || !event.trace_id) continue;
    let bucket = tasks.get(event.task_id);
    if (!bucket) tasks.set(event.task_id, bucket = []);
    bucket.push(event);
  }
  return tasks;
}

export function taskList(events, params = {}) {
  const search = String(params.search || '').toLowerCase().slice(0, 240);
  const tasks = [];
  for (const [taskId, records] of members(events)) {
    const filtered = { ...params };
    // Searching a task id must not hide its constituent requests.
    if (taskId.toLowerCase().includes(search)) delete filtered.search;
    const requests = agentGroupList(records, filtered, { limit: Number.MAX_SAFE_INTEGER }).traces;
    if (!requests.length) continue;
    const projects = [...new Set(requests.map((item) => item.workspace_id))];
    tasks.push({
      task_id: taskId,
      started: requests.reduce((a, item) => a < item.started ? a : item.started, requests[0].started),
      ended: requests.reduce((a, item) => a > item.ended ? a : item.ended, requests[0].ended),
      request_count: requests.length,
      tool_count: requests.reduce((n, item) => n + item.tool_count, 0),
      command_count: requests.reduce((n, item) => n + item.command_count, 0),
      change_count: requests.reduce((n, item) => n + item.change_count, 0),
      error_count: requests.reduce((n, item) => n + item.error_count, 0),
      projects
    });
  }
  tasks.sort((a, b) => b.ended.localeCompare(a.ended) || a.task_id.localeCompare(b.task_id));
  return { total: tasks.length, tasks: tasks.slice(0, 80) };
}

export function taskDetail(events, taskId) {
  if (!isTaskId(taskId)) return null;
  const records = members(events).get(taskId);
  if (!records) return null;
  const requests = new Map();
  for (const e of records) {
    if (!requests.has(e.trace_id)) requests.set(e.trace_id, []);
    requests.get(e.trace_id).push(e);
  }
  const allSteps = [];
  for (const [traceId, entries] of requests) {
    const detail = agentTraceDetail(entries, traceId, Number.MAX_SAFE_INTEGER);
    if (!detail) continue;
    for (const step of detail.steps) {
      allSteps.push({ ...step, trace_id: traceId, request_id: detail.request_id, task_id: taskId });
    }
  }
  allSteps.sort((a, b) => Date.parse(a.ts) - Date.parse(b.ts) || a.id - b.id);
  const max = 400;
  return {
    task_id: taskId, request_count: requests.size, total_steps: allSteps.length,
    truncated: allSteps.length > max,
    steps: allSteps.slice(-max)
  };
}
