// Offline, script-free timeline: rendering trace files never exposes a new HTTP endpoint.
const esc = (value) => String(value ?? "")
  .replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;")
  .replaceAll('"', "&quot;").replaceAll("'", "&#39;");

const finite = (value, fallback = 0) =>
  typeof value === "number" && Number.isFinite(value) ? value : fallback;

export function buildTraceTimeline(sourceEvents) {
  const sorted = sourceEvents
    .map((event, index) => ({ event, index, time: Date.parse(event.ts ?? "") }))
    .filter((item) => Number.isFinite(item.time))
    .sort((a, b) => a.time - b.time || a.index - b.index);
  const first = sorted[0]?.time ?? 0;
  const last = sorted[sorted.length - 1]?.time ?? first;
  const requests = new Set(sorted.map(({ event }) => event.request_id).filter(Boolean));
  const jobs = new Set(sorted.map(({ event }) => event.job_id).filter(Boolean));
  const events = sorted.map(({ event, time }) => ({
    ...event,
    offset_ms: Math.max(0, time - first)
  }));
  return {
    total_events: events.length,
    duration_ms: Math.max(0, last - first),
    request_count: requests.size,
    job_count: jobs.size,
    started_at: sorted[0]?.event.ts ?? null,
    finished_at: sorted[sorted.length - 1]?.event.ts ?? null,
    events
  };
}

function eventKind(event) {
  const name = String(event.event ?? "");
  if (name.startsWith("mcp.sse.")) return "sse";
  if (name.startsWith("execution.")) return "execution";
  if (name.startsWith("tool.")) return "tool";
  if (name.startsWith("http.")) return "http";
  return "mcp";
}

function detailSummary(event) {
  return [
    event.tool ? `tool=${event.tool}` : "",
    event.runtime_event ? `phase=${event.runtime_event}` : "",
    event.event_type ? `type=${event.event_type}` : "",
    event.status ? `status=${event.status}` : "",
    Number.isFinite(event.duration_ms) ? `duration=${event.duration_ms}ms` : "",
    event.client_aborted === true ? "client-aborted" : "",
    Number.isFinite(event.cpu_time_ms) ? `CPU=${event.cpu_time_ms}ms` : "",
    Number.isFinite(event.resident_memory_bytes)
      ? `RAM=${Math.round(event.resident_memory_bytes / 1048576)}MiB` : ""
  ].filter(Boolean).join(" · ");
}


const CHANGE_TOOLS = new Set(["write", "edit", "apply_patch"]);

function changeFromEvent(event, recordedSpans) {
  if (event.event === "workspace.change") return event;
  // Older JSONL files have no dedicated change event: use the complete tool result if present.
  if (event.event !== "tool.end" || event.status !== "ok" ||
      !CHANGE_TOOLS.has(event.tool) || recordedSpans.has(event.span_id)) return null;
  const result = event.result?.body?.structuredContent;
  if (!result || typeof result.diff !== "string") return null;
  const changed = event.tool === "apply_patch"
    ? result.changed === true
    : Number(result.additions) > 0 || Number(result.deletions) > 0;
  if (!changed) return null;
  return {
    ...event,
    paths: Array.isArray(result.paths) ? result.paths : [result.path].filter(Boolean),
    additions: result.additions,
    deletions: result.deletions,
    patch: { body: result.diff },
    source_truncated: /\.\.\.\[diff truncated to \d+ chars\]$/.test(result.diff),
    legacy: true
  };
}

function renderSideBySideDiff(patch) {
  const maxChars = 40000;
  const maxRows = 900;
  const source = patch.slice(0, maxChars);
  const lines = source.split(/\r?\n/);
  const html = [];
  let oldLine = 0;
  let newLine = 0;
  let inHunk = false;
  let removed = [];
  let added = [];
  let limited = patch.length > maxChars;

  const side = (line, kind) => line
    ? '<td class="' + kind + '"><span class="line-no">' + line.number +
      '</span><span class="line-text">' + esc(line.text) + '</span></td>'
    : '<td class="empty"><span class="line-no"></span><span class="line-text"></span></td>';
  const row = (left, right, leftKind = "context", rightKind = "context") => {
    if (html.length >= maxRows) { limited = true; return; }
    html.push('<tr>' + side(left, leftKind) + side(right, rightKind) + '</tr>');
  };
  const flush = () => {
    for (let i = 0; i < Math.max(removed.length, added.length); i += 1) {
      row(removed[i], added[i], "deletion", "addition");
    }
    removed = [];
    added = [];
  };
  const meta = (line) => {
    if (html.length >= maxRows) { limited = true; return; }
    html.push('<tr><th colspan="2" class="diff-meta">' + esc(line) + '</th></tr>');
  };

  for (const line of lines) {
    if (html.length >= maxRows) { limited = true; break; }
    const hunk = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(line);
    if (hunk) {
      flush();
      oldLine = Number(hunk[1]);
      newLine = Number(hunk[2]);
      inHunk = true;
      meta(line);
    } else if (line.startsWith("diff --git ") || line.startsWith("--- ") ||
               line.startsWith("+++ ") || line.startsWith("index ") ||
               line.startsWith("new file mode ") || line.startsWith("deleted file mode ") ||
               line.startsWith("rename from ") || line.startsWith("rename to ")) {
      flush();
      if (line.startsWith("diff --git ") || line.startsWith("--- ")) inHunk = false;
      meta(line);
    } else if (inHunk && line.startsWith("-")) {
      removed.push({ number: oldLine++, text: line.slice(1) });
    } else if (inHunk && line.startsWith("+")) {
      added.push({ number: newLine++, text: line.slice(1) });
    } else if (inHunk && line.startsWith(" ")) {
      flush();
      row({ number: oldLine++, text: line.slice(1) }, { number: newLine++, text: line.slice(1) });
    } else if (line.startsWith("\\")) {
      flush();
      meta(line);
    } else if (line) {
      flush();
      meta(line);
    }
  }
  flush();
  return '<div class="diff-scroll"><table class="split-diff">' +
    '<thead><tr><th>Before</th><th>After</th></tr></thead><tbody>' +
    html.join("") + '</tbody></table></div>' +
    (limited ? '<p class="notice">Viewer preview limited; inspect the source JSONL for the retained patch.</p>' : "");
}

function renderChangeCard(change, index) {
  const paths = Array.isArray(change.paths) ? change.paths.filter((x) => typeof x === "string") : [];
  const patch = change.patch;
  const complete = typeof patch?.body === "string" && patch.truncated !== true;
  const preview = typeof patch?.preview === "string" ? patch.preview : "";
  let body;
  if (complete) {
    body = (change.source_truncated
      ? '<p class="notice">The source operation returned a shortened diff; later changes may not be present.</p>'
      : '') + renderSideBySideDiff(patch.body);
  } else if (preview) {
    body = '<p class="notice">Patch was truncated by Trace recording. This is only a preview, not a complete comparison.</p>' +
      '<pre>' + esc(preview.slice(0, 12000)) + '</pre>';
  } else {
    body = '<p class="notice">Only change metadata was retained. Enable redacted traces to inspect future diffs.</p>';
  }
  return '<details class="change-card"' + (index === 0 ? ' open' : '') + '>' +
    '<summary><span><b>' + esc(change.tool || "change") + '</b> · ' +
    esc(paths.join(", ") || "Unknown path") + '</span><span class="change-stats">' +
    '+' + finite(change.additions) + ' / -' + finite(change.deletions) + '</span></summary>' +
    '<div class="meta">Trace: ' + esc(change.trace_id || "—") + ' · Span: ' +
    esc(change.span_id || "—") + ' · Request: ' + esc(change.request_id || "—") +
    (change.legacy ? ' · Legacy tool result' : '') + '</div>' + body + '</details>';
}

export function renderTraceTimelineHtml(timeline, options = {}) {
  const label = String(options.label ?? "Recent trace");
  // Bound the exported file: very long SSE traces are sampled by the recorder, and the
  // viewer separately caps event details to avoid generating an unresponsive HTML document.
  const rows = timeline.events.slice(0, 2500);
  const recordedSpans = new Set(rows.filter((event) => event.event === "workspace.change" && event.span_id)
    .map((event) => event.span_id));
  const changes = rows.map((event) => changeFromEvent(event, recordedSpans)).filter(Boolean);
  const changeCards = changes.map(renderChangeCard).join("\n");
  const extent = Math.max(timeline.duration_ms, 1);
  const htmlRows = rows.map((event, index) => {
    const offset = finite(event.offset_ms);
    const duration = Math.max(0, finite(event.duration_ms));
    const start = Math.max(0, offset - duration);
    const left = Math.max(0, Math.min(99.5, start / extent * 100));
    const width = duration > 0 ? Math.max(0.4, Math.min(100 - left, duration / extent * 100)) : 0.55;
    const kind = eventKind(event);
    const details = JSON.stringify(event, null, 2);
    const detailBody = details.length > 12000
      ? details.slice(0, 12000) + "\n[Viewer detail truncated; inspect source JSONL for full redacted record.]"
      : details;
    return `<details class="event-row ${kind}">
      <summary>
        <span class="offset">+${(offset / 1000).toFixed(3)}s</span>
        <span class="event-label"><b>${esc(event.event)}</b><small>${esc(detailSummary(event))}</small></span>
        <span class="track"><i style="left:${left.toFixed(3)}%;width:${width.toFixed(3)}%"></i></span>
      </summary>
      <div class="meta">Request: ${esc(event.request_id || "—")} · Trace: ${esc(event.trace_id || "—")} · Job: ${esc(event.job_id || "—")}</div>
      <pre>${esc(detailBody)}</pre>
    </details>`;
  }).join("\n");
  const wasLimited = timeline.events.length > rows.length;

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'">
<title>CodexPro Trace Timeline</title>
<style>
:root{color-scheme:dark;font-family:ui-sans-serif,system-ui,Arial,sans-serif;background:#0b1020;color:#e3e9f8}
*{box-sizing:border-box}body{margin:0;max-width:1450px;padding:32px 22px 70px;margin-inline:auto}
h1{font-size:26px;margin:0 0 8px}p{color:#a7b5ce;line-height:1.5}header{margin-bottom:26px}
.metrics{display:flex;flex-wrap:wrap;gap:12px;margin:18px 0}
.metric{padding:13px 17px;border:1px solid #303c56;border-radius:10px;background:#151e32;min-width:125px}
.metric strong{font-size:19px;display:block}.metric small{color:#9bacc8}
.caption{font-size:13px;margin-bottom:14px}.event-row{border-bottom:1px solid #27334b}
.event-row summary{display:grid;grid-template-columns:96px minmax(180px,390px) minmax(80px,1fr);gap:14px;align-items:center;padding:12px 10px;cursor:pointer;list-style:none}
.event-row summary::-webkit-details-marker{display:none}.event-row summary:hover{background:#17223b}
.offset{font-variant-numeric:tabular-nums;color:#9fb1cd;font-size:13px}
.event-label b{display:block;font-size:14px;overflow-wrap:anywhere}
.event-label small{display:block;color:#9eb0c9;margin-top:3px;overflow-wrap:anywhere}
.track{height:17px;position:relative;border-radius:3px;background:repeating-linear-gradient(90deg,#1b2a44 0 1px,transparent 1px 10%);border-left:1px solid #536580}
.track i{position:absolute;height:9px;top:3px;border-radius:3px;background:var(--bar,#728fcf);min-width:3px}
.sse{--bar:#a88afa}.execution{--bar:#45bea0}.tool{--bar:#64a1f5}.http{--bar:#e6aa65}.mcp{--bar:#728fcf}.change{--bar:#45bea0}
pre{background:#0d1528;color:#d7e7f4;white-space:pre-wrap;overflow-wrap:anywhere;border-radius:8px;padding:16px;margin:8px 10px 17px;font-size:12px;max-height:350px;overflow:auto}
.meta{font-size:12px;color:#98a9c3;margin:8px 10px}
.notice{padding:12px;border:1px solid #52402e;border-radius:8px;color:#d8bd8e}
h2{font-size:18px;margin:26px 0 12px}.change-card{border:1px solid #35465c;background:#121e31;border-radius:10px;margin-bottom:12px;overflow:hidden}
.change-card>summary{list-style:none;display:flex;gap:16px;justify-content:space-between;padding:14px;cursor:pointer;overflow-wrap:anywhere}
.change-card>summary::-webkit-details-marker{display:none}.change-card>summary:hover{background:#1a2a40}
.change-stats{font:13px ui-monospace,monospace;white-space:nowrap;color:#93d6b8}
.diff-scroll{overflow:auto;max-height:520px;margin:10px;border:1px solid #30405a;border-radius:6px}
.split-diff{width:100%;table-layout:fixed;border-collapse:collapse;font:12px/1.5 ui-monospace,Consolas,monospace}
.split-diff thead th{position:sticky;top:0;text-align:left;background:#233249;color:#e0eaf7;padding:8px 10px;z-index:1}
.split-diff td{width:50%;vertical-align:top;padding:0;white-space:pre-wrap;overflow-wrap:anywhere;border-right:1px solid #33435d}
.split-diff td>.line-no{display:inline-block;min-width:44px;padding:3px 7px;color:#7891ae;user-select:none;text-align:right}
.split-diff td>.line-text{padding:3px 9px;white-space:pre-wrap;overflow-wrap:anywhere}
.split-diff td.deletion{background:#4c2633}.split-diff td.addition{background:#1b4b3e}.split-diff td.empty{background:#111828}
.split-diff .diff-meta{text-align:left;padding:5px 11px;color:#a9c1e3;background:#18283f;font-weight:normal;overflow-wrap:anywhere}
.change-card pre{max-height:250px}.change-card .notice{margin:12px}
@media(max-width:760px){body{padding:18px 10px}.event-row summary{grid-template-columns:78px 1fr;gap:8px}.track{grid-column:1/-1}.metric{min-width:100px}}
</style>
</head>
<body>
<header>
<h1>CodexPro Trace Timeline</h1>
<p>${esc(label)} · Offline, read-only view of redacted local MCP trace records.</p>
<div class="metrics">
<div class="metric"><strong>${timeline.total_events}</strong><small>Events</small></div>
<div class="metric"><strong>${(timeline.duration_ms / 1000).toFixed(2)}s</strong><small>Observed span</small></div>
<div class="metric"><strong>${timeline.request_count}</strong><small>Requests</small></div>
<div class="metric"><strong>${timeline.job_count}</strong><small>Jobs</small></div>
</div>
<p class="caption">Time offsets are relative to the earliest selected event. Bars show recorded duration; dots mark point events. Expand any row to inspect its metadata.</p>
${wasLimited ? '<p class="notice">Only the first 2500 events are rendered to keep the file responsive; consult JSONL for the rest.</p>' : ""}
</header>
<section aria-label="File change history"><h2>Change history (${changes.length})</h2>
${changeCards || '<p>No recorded file changes in this selection.</p>'}
</section>
<main aria-label="Trace event timeline"><h2>Event timeline</h2>${htmlRows || "<p>No trace events matched.</p>"}</main>
</body>
</html>`;
}
