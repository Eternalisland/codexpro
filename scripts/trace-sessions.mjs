import { agentGroupList, agentTraceDetail } from './trace-agent.mjs';

// ChatGPT _meta["openai/session"] is a conversation identifier, not a task boundary.
// Only derived digests emitted by the recorder are eligible for automatic grouping.
export const isConversationId = (value) =>
  typeof value === 'string' && /^sha256:[a-f0-9]{24}$/.test(value);

function conversations(events) {
  const groups = new Map();
  for (const event of events) {
    if (!isConversationId(event.conversation_id) || !event.trace_id) continue;
    const group = groups.get(event.conversation_id) || [];
    if (!groups.has(event.conversation_id)) groups.set(event.conversation_id, group);
    group.push(event);
  }
  return groups;
}

export function conversationList(events, params = {}) {
  const search = String(params.search || '').toLowerCase().slice(0, 240);
  const rows = [];
  for (const [conversationId, records] of conversations(events)) {
    const filters = { ...params };
    if (conversationId.toLowerCase().includes(search)) delete filters.search;
    const requests = agentGroupList(records, filters, { limit: Number.MAX_SAFE_INTEGER }).traces;
    if (!requests.length) continue;
    rows.push({
      conversation_id: conversationId,
      started: requests.reduce((min, row) => min < row.started ? min : row.started, requests[0].started),
      ended: requests.reduce((max, row) => max > row.ended ? max : row.ended, requests[0].ended),
      request_count: requests.length,
      tool_count: requests.reduce((sum, row) => sum + row.tool_count, 0),
      command_count: requests.reduce((sum, row) => sum + row.command_count, 0),
      change_count: requests.reduce((sum, row) => sum + row.change_count, 0),
      error_count: requests.reduce((sum, row) => sum + row.error_count, 0),
      projects: [...new Set(requests.map((row) => row.workspace_id))]
    });
  }
  rows.sort((a, b) => b.ended.localeCompare(a.ended) || a.conversation_id.localeCompare(b.conversation_id));
  return { total: rows.length, conversations: rows.slice(0, 80) };
}

export function conversationDetail(events, conversationId) {
  if (!isConversationId(conversationId)) return null;
  const records = conversations(events).get(conversationId);
  if (!records) return null;
  const requests = new Map();
  for (const event of records) {
    const group = requests.get(event.trace_id) || [];
    if (!requests.has(event.trace_id)) requests.set(event.trace_id, group);
    group.push(event);
  }
  const steps = [];
  for (const [traceId, group] of requests) {
    const detail = agentTraceDetail(group, traceId, Number.MAX_SAFE_INTEGER);
    if (!detail) continue;
    for (const step of detail.steps) {
      steps.push({ ...step, trace_id: traceId, request_id: detail.request_id,
        conversation_id: conversationId });
    }
  }
  steps.sort((a, b) => Date.parse(a.ts) - Date.parse(b.ts) || a.id - b.id);
  const limit = 400;
  return { conversation_id: conversationId, request_count: requests.size, total_steps: steps.length,
    truncated: steps.length > limit, steps: steps.slice(-limit) };
}
