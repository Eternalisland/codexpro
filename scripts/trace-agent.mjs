// A trace is one MCP request, not a ChatGPT conversation or hidden reasoning.
const LIMIT_GROUPS = 80;
const LIMIT_STEPS = 250;
const MAX_FIELD = 3500;
const str = (v) => typeof v === 'string' ? v.slice(0, MAX_FIELD) : '';
const num = (v) => Number.isFinite(v) ? v : 0;
const timeSort = (a, b) => a.time - b.time || a.id - b.id;
function failedExecution(event) {
  if (event.event === 'tool.end') return event.status === 'error' ||
    (event.agent_detail?.exit_code !== null && event.agent_detail?.exit_code !== undefined &&
      event.agent_detail.exit_code !== 0) ||
    event.agent_detail?.timed_out === true || event.agent_detail?.cancelled === true;
  if (event.event === 'execution.end') return ['failed', 'error', 'cancelled', 'timed_out']
    .includes(event.status);
  return false;
}

export function agentDetailFromRecord(event) {
  const type = event.event;
  if (type === 'tool.start') {
    const args = event.arguments?.body;
    // Trace already applied its redaction rules. Never return the full argument object.
    return {
      action: str(event.tool === 'codexpro' ? args?.action : event.tool),
      command: str(args?.command || args?.args?.command),
      cwd: str(args?.cwd || args?.args?.cwd),
      target: str(args?.path || args?.args?.path),
      input_truncated: Boolean(event.arguments?.truncated || event.arguments?.preview)
    };
  }
  if (type === 'tool.end') {
    const result = event.result?.body?.structuredContent;
    return {
      exit_code: typeof result?.exit_code === 'number' ? result.exit_code : null,
      stdout: str(result?.stdout),
      stderr: str(result?.stderr),
      command: str(result?.command),
      timed_out: result?.timed_out === true,
      cancelled: result?.cancelled === true,
      output_truncated: Boolean(result?.output_truncated || event.result?.truncated),
      result_available: Boolean(result),
      error: event.status === 'error' ? str(event.result?.body?.content?.[0]?.text ||
        event.result?.body?.error || event.result?.preview) : ''
    };
  }
  if (type?.startsWith('execution.')) {
    return {
      check: str(event.check),
      stream: str(event.stream),
      preview: str(event.preview),
      preview_truncated: event.preview_truncated === true,
      check_index: Number.isInteger(event.check_index) ? event.check_index : null,
      checks: Array.isArray(event.checks) ? event.checks.slice(0, 12)
        .map((check) => str(typeof check === 'string' ? check : check?.check)).filter(Boolean) : [],
      error: str(event.error),
      command: str(event.command),
      phase: str(event.phase),
      runtime_event: str(event.runtime_event),
      elapsed_ms: num(event.elapsed_ms),
      output_bytes: num(event.output_bytes),
      status: str(event.status)
    };
  }
  return null;
}

export function agentGroupList(events, params = {}, options = {}) {
  const groups = new Map();
  for (const event of events) {
    if (!event.trace_id || !(['tool.start', 'tool.end', 'workspace.change'].includes(event.event) ||
      event.event.startsWith('execution.'))) continue;
    let group = groups.get(event.trace_id);
    if (!group) {
      group = { trace_id: event.trace_id, request_id: event.request_id,
        workspace_id: '', started: event.time, ended: event.time, tools: new Set(),
        paths: new Set(), job_ids: new Set(), calls: new Set(),
        finished: new Set(), failures: 0, changes: 0, commands: 0,
        events: [] };
      groups.set(event.trace_id, group);
    }
    group.events.push(event);
    if (event.workspace_id) group.workspace_id = event.workspace_id;
    group.started = Math.min(group.started, event.time);
    group.ended = Math.max(group.ended, event.time);
    if (event.tool) group.tools.add(event.tool);
    if (event.job_id) group.job_ids.add(event.job_id);
    for (const p of event.paths) group.paths.add(p);
    if (event.event === 'tool.start') {
      group.calls.add(event.span_id || event.id);
      if (event.agent_detail?.command) group.commands++;
    }
    if (event.event === 'tool.end') {
      group.finished.add(event.span_id || event.id);
      if (failedExecution(event)) group.failures++;
      // Older traces may have no matching start.
      if (event.tool === 'bash' && !group.events.some((e) =>
        e.event === 'tool.start' && e.span_id && e.span_id === event.span_id)) group.commands++;
    }
    if (event.event === 'execution.end' && failedExecution(event)) group.failures++;
    if (event.event === 'workspace.change') group.changes++;
  }
  const filter = (key) => String(params[key] || '').toLowerCase().slice(0, 240);
  const from = params.from ? Date.parse(params.from) : NaN;
  const to = params.to ? Date.parse(params.to) : NaN;
  const all = [...groups.values()].filter((g) => {
    if (filter('project') && (g.workspace_id || 'unknown').toLowerCase() !== filter('project')) return false;
    if (filter('tool') && ![...g.tools].some((t) => t.toLowerCase() === filter('tool'))) return false;
    if (filter('file') && ![...g.paths].some((p) => p.toLowerCase().includes(filter('file')))) return false;
    if (Number.isFinite(from) && g.ended < from) return false;
    if (Number.isFinite(to) && g.started > to) return false;
    if (filter('search') && ![
      g.trace_id, g.request_id, g.workspace_id, ...g.tools, ...g.paths, ...g.job_ids
    ].some((field) => field.toLowerCase().includes(filter('search')))) return false;
    return true;
  }).sort((a, b) => b.ended - a.ended || b.events.at(-1).id - a.events.at(-1).id);
  return {
    total: all.length,
    traces: all.slice(0, options.limit ?? LIMIT_GROUPS).map((g) => ({
      trace_id: g.trace_id, request_id: g.request_id, workspace_id: g.workspace_id || 'unknown',
      started: new Date(g.started).toISOString(), ended: new Date(g.ended).toISOString(),
      tool_count: Math.max(g.calls.size, g.finished.size),
      change_count: g.changes, command_count: g.commands, error_count: g.failures,
      tools: [...g.tools].slice(0, 12), paths: [...g.paths].slice(0, 12)
    }))
  };
}

export function agentTraceDetail(events, traceId, limit = LIMIT_STEPS) {
  const input = events.filter((e) => e.trace_id === traceId &&
    (e.event === 'tool.start' || e.event === 'tool.end' ||
      e.event === 'workspace.change' || e.event.startsWith('execution.'))).sort(timeSort);
  if (!input.length) return null;
  const steps = [];
  const spans = new Map();
  for (const event of input) {
    const base = {
      id: event.id, event: event.event, ts: event.ts, tool: event.tool,
      span_id: event.span_id, job_id: event.job_id, status: event.status,
      duration_ms: event.duration_ms, paths: [...event.paths],
      detail: event.agent_detail || null
    };
    if (event.event === 'tool.start') {
      const step = { ...base, status: 'running', changes: [] };
      steps.push(step);
      if (event.span_id) spans.set(event.span_id, step);
    } else if (event.event === 'tool.end') {
      const step = spans.get(event.span_id);
      if (step) {
        step.status = failedExecution(event) ? 'error' : event.status || 'unknown';
        step.duration_ms = event.duration_ms;
        step.result = event.agent_detail || null;
      } else {
        steps.push({ ...base, status: failedExecution(event) ? 'error' : base.status,
          changes: [], result: event.agent_detail || null });
      }
    } else if (event.event === 'workspace.change') {
      const step = spans.get(event.span_id);
      if (step) step.changes.push({ id: event.id, paths: event.paths });
      else steps.push(base);
    } else {
      steps.push({ ...base, status: failedExecution(event) ? 'error' : base.status });
    }
  }
  const limited = steps.length > limit;
  return { trace_id: traceId, request_id: input[0].request_id,
    workspace_id: input.find((e) => e.workspace_id)?.workspace_id || 'unknown',
    total_steps: steps.length, truncated: limited,
    steps: limited ? steps.slice(-limit) : steps };
}
