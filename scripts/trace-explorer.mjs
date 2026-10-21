// Standalone, loopback-only, read-only Trace Explorer. Never mount this on the MCP tunnel.
import { createServer } from 'node:http';
import { randomBytes } from 'node:crypto';
import { fileStats, sectionForFile } from './trace-patch.mjs';
import { agentDetailFromRecord, agentGroupList, agentTraceDetail } from './trace-agent.mjs';
import { taskList, taskDetail, isTaskId } from './trace-tasks.mjs';
import { conversationList, conversationDetail, isConversationId } from './trace-sessions.mjs';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const TRACE_FILE = /^trace-\d{4}-\d{2}-\d{2}(?:\.\d+)?\.jsonl$/;
const MAX_EVENTS = 12000;
const MAX_PATCH_CHARS = 40000;
const MAX_QUERY_CHARS = 240;
const ROOT = path.dirname(fileURLToPath(import.meta.url));
const CHANGE_TOOLS = new Set(['write', 'edit', 'apply_patch']);

function text(value) { return typeof value === 'string' ? value : ''; }
function finite(value) { return Number.isFinite(value) ? value : 0; }
function listPaths(value) {
  return (Array.isArray(value) ? value : [value]).filter((item) => typeof item === 'string').slice(0, 100);
}

export class TraceIndex {
  constructor(dir) {
    this.dir = path.resolve(dir);
    this.files = new Map();
    this.events = [];
    this.nextId = 0;
    this.version = 0;
    this.polling = null;
  }

  async poll() {
    if (this.polling) return this.polling;
    this.polling = this.scan().finally(() => { this.polling = null; });
    return this.polling;
  }

  async scan() {
    const names = (await fs.readdir(this.dir, { withFileTypes: true }).catch((error) => {
      if (error.code === 'ENOENT') return [];
      throw error;
    })).filter((item) => item.isFile() && TRACE_FILE.test(item.name)).map((item) => item.name).sort();
    const present = new Set(names);
    let updated = false;
    for (const name of this.files.keys()) {
      if (present.has(name)) continue;
      this.files.delete(name);
      this.events = this.events.filter((event) => event._file !== name);
      updated = true;
    }
    for (const name of names) {
      const filename = path.join(this.dir, name);
      const stat = await fs.lstat(filename).catch((error) => {
        if (error.code === 'ENOENT') return null;
        throw error;
      });
      if (!stat?.isFile()) continue;
      let cursor = this.files.get(name);
      if (!cursor || cursor.ino !== stat.ino || stat.size < cursor.offset) {
        // After rotation/replacement a file has a new identity.
        if (cursor) {
          this.events = this.events.filter((event) => event._file !== name);
          updated = true;
        }
        cursor = { ino: stat.ino, offset: 0, pending: Buffer.alloc(0) };
        this.files.set(name, cursor);
      }
      if (stat.size === cursor.offset) continue;
      const handle = await fs.open(filename, 'r');
      try {
        const length = stat.size;
        while (cursor.offset < length) {
          const buffer = Buffer.allocUnsafe(Math.min(64 * 1024, length - cursor.offset));
          const { bytesRead } = await handle.read(buffer, 0, buffer.length, cursor.offset);
          if (!bytesRead) break;
          cursor.offset += bytesRead;
          // Split by byte before decoding UTF-8: a multibyte character can span reads.
          const combined = Buffer.concat([cursor.pending, buffer.subarray(0, bytesRead)]);
          let start = 0;
          let end;
          while ((end = combined.indexOf(10, start)) !== -1) {
            const line = combined.subarray(start, end).toString('utf8');
            start = end + 1;
            if (line.length > 2 * 1024 * 1024) continue;
            if (!line.trim()) continue;
            try {
              const parsed = JSON.parse(line);
              if (parsed && typeof parsed === 'object' && !Array.isArray(parsed) &&
                  Number.isFinite(Date.parse(parsed.ts ?? ''))) {
                this.events.push(summarizeEvent(parsed, ++this.nextId, name));
                updated = true;
              }
            } catch { /* malformed JSONL lines are skipped */ }
          }
          cursor.pending = combined.subarray(start);
          if (cursor.pending.length > 2 * 1024 * 1024) cursor.pending = Buffer.alloc(0);
        }
      } finally { await handle.close(); }
    }
    if (this.events.length > MAX_EVENTS) this.events.splice(0, this.events.length - MAX_EVENTS);
    if (updated) this.version += 1;
    return updated;
  }

  query(params = {}) {
    const filter = (key) => text(params[key]).slice(0, MAX_QUERY_CHARS).toLowerCase();
    const project = filter('project');
    const tool = filter('tool');
    const file = filter('file');
    const search = filter('search');
    const from = params.from ? Date.parse(params.from) : NaN;
    const to = params.to ? Date.parse(params.to) : NaN;
    const projectByTrace = new Map();
    for (const event of this.events) {
      if (event.workspace_id && event.trace_id) projectByTrace.set(event.trace_id, event.workspace_id);
    }
    const filtered = this.events.filter((event) => {
      const workspace = event.workspace_id || projectByTrace.get(event.trace_id) || 'unknown';
      if (project && workspace.toLowerCase() !== project) return false;
      if (tool && (event.tool || '').toLowerCase() !== tool) return false;
      if (file && !event.paths.some((p) => p.toLowerCase().includes(file))) return false;
      if (Number.isFinite(from) && event.time < from) return false;
      if (Number.isFinite(to) && event.time > to) return false;
      if (search && ![event.event, event.tool, event.trace_id, event.request_id,
        event.job_id, workspace, ...event.paths].some((v) => text(v).toLowerCase().includes(search))) return false;
      return true;
    });
    filtered.sort((a, b) => a.time - b.time || a.id - b.id);
    const dedicated = new Set(this.events.filter((e) => e.event === 'workspace.change' && e.span_id)
      .map((e) => e.span_id));
    const changes = filtered.filter((e) => e.event === 'workspace.change' ||
      (e.legacyChange && !dedicated.has(e.span_id))).map((e) => {
      const change = e.event === 'workspace.change' ? e : e.legacyChange;
      return {
        id: e.id, ts: e.ts, time: e.time, tool: change.tool,
        trace_id: e.trace_id, request_id: e.request_id, span_id: e.span_id,
        workspace_id: e.workspace_id || projectByTrace.get(e.trace_id) || 'unknown',
        paths: change.paths, additions: change.additions, deletions: change.deletions,
        file_stats: change.patch?.complete ? fileStats(change.patch.text) : {},
        truncated: Boolean(change.truncated), legacy: e.event !== 'workspace.change'
      };
    }).sort((a, b) => a.time - b.time || a.id - b.id);
    const projects = [...new Set(this.events.map((e) => e.workspace_id || projectByTrace.get(e.trace_id))
      .filter(Boolean))].sort();
    const tools = [...new Set(this.events.map((e) => e.tool).filter(Boolean))].sort();
    const outputEvents = filtered.slice(-300).reverse().map(({ id, ts, event, tool, trace_id, request_id,
      job_id, span_id, status, duration_ms, paths, workspace_id }) =>
      ({ id, ts, event, tool, trace_id, request_id, job_id, span_id, status, duration_ms,
        paths, workspace_id: workspace_id || projectByTrace.get(trace_id) || 'unknown' }));
    return {
      version: this.version, total: filtered.length, events: outputEvents,
      changes: changes.slice(-700), change_total: changes.length, projects, tools
    };
  }

  agentTraces(params = {}) { return agentGroupList(this.events, params); }

  agentTasks(params = {}) { return taskList(this.events, params); }

  agentTask(taskId) { return taskDetail(this.events, taskId); }

  agentConversations(params = {}) { return conversationList(this.events, params); }

  agentConversation(conversationId) { return conversationDetail(this.events, conversationId); }

  agentTrace(traceId) {
    if (typeof traceId !== 'string' || !/^tr_[a-zA-Z0-9_-]{1,100}$/.test(traceId)) return null;
    return agentTraceDetail(this.events, traceId);
  }

  change(id, file) {
    const event = this.events.find((e) => e.id === Number(id));
    if (!event) return null;
    const change = event.event === 'workspace.change' ? event : event.legacyChange;
    if (!change) return null;
    if (file && !change.paths.includes(file)) return null;
    const patch = change.patch ?? null;
    if (!file) {
      return { id: event.id, paths: change.paths, patch,
        truncated: Boolean(change.truncated), additions: change.additions, deletions: change.deletions };
    }
    const section = patch?.text ? sectionForFile(patch.text, file) : null;
    const selected = section && section.hunks > 0
      ? { text: section.text, complete: patch.complete, notice: patch.notice }
      : null;
    return {
      id: event.id, file, paths: change.paths, patch: selected,
      truncated: Boolean(change.truncated),
      additions: section?.additions ?? null, deletions: section?.deletions ?? null,
      unavailable_reason: selected ? '' : patch?.text
        ? '记录中的 Patch 未包含可完整定位到该文件的代码片段；可能是二进制变更或日志截断。'
        : '该次修改只保留了元数据，无法查看文件级代码差异。'
    };
  }
}

function summarizeEvent(e, id, filename) {
  const structured = e.result?.body?.structuredContent;
  const action = e.tool === 'codexpro' ? structured?.codexpro_super_action : e.tool;
  const workspace = text(e.workspace_id || structured?.workspace_id || e.arguments?.body?.workspace_id);
  const args = e.arguments?.body ?? e.payload?.body?.params?.arguments;
  const paths = listPaths(e.paths?.length ? e.paths :
    structured?.paths ?? structured?.path ?? args?.paths ?? args?.path ?? args?.target_paths);
  const base = {
    id, _file: filename, ts: text(e.ts), time: Date.parse(e.ts),
    event: text(e.event), tool: text(e.tool), workspace_id: workspace,
    trace_id: text(e.trace_id), request_id: text(e.request_id),
    span_id: text(e.span_id), job_id: text(e.job_id), status: text(e.status),
    duration_ms: finite(e.duration_ms), paths,
    task_id: isTaskId(e.task_id) ? e.task_id : '',
    conversation_id: isConversationId(e.conversation_id) ? e.conversation_id : '',
    agent_detail: agentDetailFromRecord(e)
  };
  if (e.event === 'workspace.change') {
    return {
      ...base, paths: listPaths(e.paths),
      tool: text(e.tool), additions: finite(e.additions), deletions: finite(e.deletions),
      patch: patchValue(e.patch, Boolean(e.source_truncated)),
      truncated: Boolean(e.patch?.truncated || e.source_truncated)
    };
  }
  if (e.event === 'tool.end' && e.status === 'ok' && CHANGE_TOOLS.has(action) &&
      typeof structured?.diff === 'string' && structured.diff !== 'No changes') {
    const changed = action === 'apply_patch'
      ? structured.changed === true
      : finite(structured.additions) > 0 || finite(structured.deletions) > 0;
    if (changed) base.legacyChange = {
      tool: action, paths, additions: finite(structured.additions), deletions: finite(structured.deletions),
      patch: patchValue({ body: structured.diff }, false),
      truncated: /\.\.\.\[diff truncated to \d+ chars\]$/.test(structured.diff)
    };
  }
  return base;
}

function patchValue(payload, sourceTruncated) {
  if (!payload || typeof payload !== 'object') return null;
  const body = text(payload.body);
  const preview = text(payload.preview);
  const value = body || preview;
  if (!value) return null;
  return {
    text: value.slice(0, MAX_PATCH_CHARS),
    complete: Boolean(body && !payload.truncated && !sourceTruncated &&
      value.length <= MAX_PATCH_CHARS),
    notice: sourceTruncated ? '原始工具 Diff 已截断' :
      (payload.truncated || !body || value.length > MAX_PATCH_CHARS ? '仅保留部分 Diff' : '')
  };
}

function sendJson(response, status, value) {
  response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
  response.end(JSON.stringify(value));
}

export async function startTraceExplorer({ dir, port = 0, openBrowser, logger = console } = {}) {
  if (!dir) throw new Error('Trace directory is required.');
  const index = new TraceIndex(dir);
  await index.poll();
  const token = randomBytes(24).toString('hex');
  const prefix = '/' + token + '/';
  const watchers = new Set();
  const clientJs = path.join(ROOT, 'trace-explorer-client.js');
  const server = createServer(async (request, response) => {
    try {
      const host = text(request.headers.host);
      if (!/^((127\.0\.0\.1)|(localhost)):\d+$/.test(host)) {
        sendJson(response, 403, { error: 'Invalid local host' });
        return;
      }
      if (request.headers.origin && request.headers.origin !== 'http://' + host) {
        sendJson(response, 403, { error: 'Cross-origin access denied' });
        return;
      }
      const url = new URL(request.url, 'http://' + host);
      if (request.method !== 'GET' || !url.pathname.startsWith(prefix)) {
        sendJson(response, 404, { error: 'Not found' });
        return;
      }
      const route = url.pathname.slice(prefix.length);
      if (route === '' || route === 'index.html') {
        response.writeHead(200, {
          'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store',
          'Referrer-Policy': 'no-referrer', 'X-Content-Type-Options': 'nosniff',
          'Content-Security-Policy': "default-src 'none'; script-src 'self'; connect-src 'self'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'"
        });
        response.end(EXPLORER_HTML);
      } else if (route === 'app.js') {
        response.writeHead(200, { 'Content-Type': 'application/javascript; charset=utf-8',
          'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
        response.end(await fs.readFile(clientJs));
      } else if (route === 'api/state') {
        await index.poll();
        sendJson(response, 200, index.query(Object.fromEntries(url.searchParams)));
      } else if (route === 'api/agent-conversations') {
        await index.poll();
        sendJson(response, 200, index.agentConversations(Object.fromEntries(url.searchParams)));
      } else if (route === 'api/agent-conversation') {
        await index.poll();
        const detail = index.agentConversation(url.searchParams.get('conversation_id'));
        sendJson(response, detail ? 200 : 404, detail || { error: 'Conversation not found or expired' });
      } else if (route === 'api/agent-tasks') {
        await index.poll();
        sendJson(response, 200, index.agentTasks(Object.fromEntries(url.searchParams)));
      } else if (route === 'api/agent-task') {
        await index.poll();
        const task = index.agentTask(url.searchParams.get('task_id'));
        sendJson(response, task ? 200 : 404, task || { error: 'Task not found or expired' });
      } else if (route === 'api/agent-traces') {
        await index.poll();
        sendJson(response, 200, index.agentTraces(Object.fromEntries(url.searchParams)));
      } else if (route === 'api/agent-detail') {
        await index.poll();
        const detail = index.agentTrace(url.searchParams.get('trace_id'));
        sendJson(response, detail ? 200 : 404, detail || { error: 'Request trace not found or expired' });
      } else if (route === 'api/change') {
        const change = index.change(url.searchParams.get('id'), url.searchParams.get('file'));
        sendJson(response, change ? 200 : 404, change || { error: 'Change not found or expired' });
      } else if (route === 'api/stream') {
        response.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8',
          'Cache-Control': 'no-store', 'Connection': 'keep-alive', 'X-Accel-Buffering': 'no' });
        response.write('event: version\ndata: ' + index.version + '\n\n');
        watchers.add(response);
        request.on('close', () => watchers.delete(response));
      } else {
        sendJson(response, 404, { error: 'Not found' });
      }
    } catch (error) {
      if (!response.headersSent) sendJson(response, 500, { error: 'Trace Explorer internal error' });
      else response.destroy();
      logger.error?.('Trace Explorer read failed: ' + String(error?.message || error));
    }
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', () => { server.off('error', reject); resolve(); });
  });
  let lastVersion = index.version;
  const ticker = setInterval(() => {
    index.poll().then(() => {
      if (lastVersion !== index.version) {
        lastVersion = index.version;
        for (const client of watchers) client.write('event: version\ndata: ' + index.version + '\n\n');
      } else for (const client of watchers) client.write(': heartbeat\n\n');
    }).catch((error) => logger.error?.('Trace Explorer scan failed: ' + String(error?.message || error)));
  }, 2000);
  const address = server.address();
  const url = 'http://127.0.0.1:' + address.port + prefix;
  if (openBrowser) {
    const opened = openBrowser(url);
    if (!opened) logger.log?.('Open this local URL manually: ' + url);
  }
  return {
    url, index,
    close: async () => {
      clearInterval(ticker);
      for (const client of watchers) client.end();
      await new Promise((resolve) => server.close(resolve));
    }
  };
}

const EXPLORER_HTML = `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>CodexPro · Trace Explorer</title>
<style>
:root{color-scheme:dark;font-family:ui-sans-serif,system-ui,-apple-system,"Segoe UI",sans-serif;background:#0b1018;color:#e4ebf5;font-size:14px}
*{box-sizing:border-box}body{margin:0;min-width:320px}[hidden]{display:none!important}
button,input,select{font:inherit}button{border:1px solid transparent;border-radius:7px;color:#ecf3ff;background:#294568;padding:8px 12px;cursor:pointer;transition:background .15s}
button:hover{background:#365b86}button:focus-visible,input:focus-visible,select:focus-visible,summary:focus-visible{outline:2px solid #85aff3;outline-offset:2px}
button:disabled{opacity:.4;cursor:default}button.secondary{background:#19283a;border-color:#304058;color:#c4d1e5}button.secondary:hover{background:#263a54}
input,select{background:#152235;border:1px solid #35455c;color:#e4ebf5;padding:8px 10px;border-radius:7px;max-width:100%}
label{display:flex;flex-direction:column;gap:6px;color:#a5b3c9;font-size:12px}h1,h2,h3,p{margin:0}h1{font-size:17px;font-weight:700;letter-spacing:.1px}
h2{font-size:15px}h3{font-size:13px}.sub{font-size:11px;color:#92a4be;margin-top:2px}
.topbar{height:70px;background:#101a29;border-bottom:1px solid #24344a;display:flex;align-items:center;gap:32px;padding:0 26px}
.brand{display:flex;align-items:center;gap:12px;min-width:250px}.brand-mark{width:38px;height:38px;border-radius:11px;display:grid;place-items:center;background:#294f80;color:#c5e5ff;font-weight:800;font-size:12px;letter-spacing:1px}
.view-tabs{display:flex;height:100%;align-items:stretch;gap:6px}
.tab{border:0;background:none;border-radius:0;padding:0 18px;color:#92a6c2;font-weight:600;border-bottom:2px solid transparent}
.tab:hover{background:#17283d}.tab.active{color:#e7efff;background:transparent;border-bottom-color:#6baff6}
.live{margin-left:auto;font-size:12px;color:#7bdab6;white-space:nowrap}.live:before{content:"●";margin-right:8px}
.toolbar{display:flex;gap:12px;align-items:center;padding:14px 24px;background:#0e1826;border-bottom:1px solid #233146}
.search-wrap{width:min(430px,42vw);position:relative;display:flex;align-items:center}.search-wrap span{position:absolute;left:12px;color:#8ca4c4;font-size:21px}
.search-wrap input{width:100%;padding:10px 12px 10px 38px;background:#17263a}
.mini-stats{display:flex;gap:16px;color:#96a9c1;font-size:12px;white-space:nowrap}.mini-stats b{color:#dceaff;font-weight:700}
.updated{margin-left:auto;color:#7e91a9;font-size:12px;white-space:nowrap}
.filter-panel{display:flex;gap:12px;align-items:end;flex-wrap:wrap;padding:16px 24px;background:#142033;border-bottom:1px solid #293a52}
.filter-panel input[type="datetime-local"]{width:190px}.filter-panel input[type="search"]{width:200px}
.workbench{display:grid;grid-template-columns:minmax(260px,300px) minmax(0,1fr);gap:16px;padding:18px 24px 0;min-height:calc(100vh - 188px)}
.file-sidebar,.workspace-main,.event-inspector{border:1px solid #26374e;background:#111d2c;border-radius:11px;min-width:0;overflow:hidden}
.section-heading{padding:17px 16px 15px;display:flex;align-items:center;justify-content:space-between;gap:8px;border-bottom:1px solid #253650}
.section-heading small{font-size:11px;color:#8198b8;display:block;margin-top:5px}
.count{padding:3px 8px;font-size:12px;background:#22364f;border-radius:6px;color:#a9c5e8}
.file-list{max-height:calc(100vh - 260px);min-height:350px;overflow:auto}
.file-card{display:block;width:100%;border:0;border-bottom:1px solid #233146;border-left:3px solid transparent;border-radius:0;text-align:left;background:transparent;padding:14px 15px 13px}
.file-card:hover{background:#1b2d43}.file-card.active{background:#1e354e;border-left-color:#77b4f9}
.file-name{display:block;font-size:12.5px;font-weight:650;color:#e3ebf7;word-break:break-word;line-height:1.5}
.file-dir{display:block;color:#8198b5;font-size:11px;margin-top:5px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.file-foot{display:flex;gap:8px;align-items:center;justify-content:space-between;color:#8da4c2;font-size:11px;margin-top:10px}
.delta{color:#79d7b1;font-family:ui-monospace,Consolas,monospace}
.workspace-main{display:flex;flex-direction:column;min-height:580px}
.file-heading{padding:22px 24px 19px;border-bottom:1px solid #263950;background:#132136}
.eyebrow{font-size:10px;letter-spacing:1.3px;color:#90b5df;text-transform:uppercase;font-weight:700}
.file-heading h2{margin:7px 0 4px;font-size:19px;overflow-wrap:anywhere;font-weight:720}
.path-subtitle{font-size:12px;color:#859ab6;overflow-wrap:anywhere;line-height:1.5}
.file-summary{display:flex;gap:20px;flex-wrap:wrap;font-size:12px;color:#a0b5d0;margin-top:14px}
.file-summary b{color:#e8f0ff;font-weight:600}
.workspace-body{display:grid;grid-template-columns:218px minmax(0,1fr);flex:1;min-height:0}
.revisions{border-right:1px solid #26374e;display:flex;flex-direction:column;min-width:0}
.revisions-title{padding:15px 15px 12px;display:flex;justify-content:space-between;align-items:center}
.revision-list{max-height:calc(100vh - 395px);min-height:245px;overflow-y:auto;padding:0 7px 8px}
.revision{width:100%;border-radius:7px;background:transparent;display:block;text-align:left;padding:11px 10px;margin-bottom:3px}
.revision.active{background:#233c58}.revision:hover{background:#253a53}
.revision-top{display:flex;justify-content:space-between;align-items:center;gap:7px;font-size:12px;font-weight:600}
.revision small{display:block;color:#869cba;font-size:11px;margin-top:6px}
.range-control{margin-top:auto;border-top:1px solid #2b3b50;padding:12px 14px;font-size:12px;color:#9fb2ce}
.range-control summary{cursor:pointer}.range-fields{display:grid;grid-template-columns:1fr 1fr;gap:10px;margin-top:12px}
.range-fields label{min-width:0}.range-fields select{min-width:0;width:100%}
.range-fields button{grid-column:1/-1}
.compare-area{min-width:0;display:flex;flex-direction:column}
.compare-head{padding:15px 20px 12px;display:flex;justify-content:space-between;gap:15px;align-items:center;border-bottom:1px solid #283b53}
.compare-head h3{font-size:15px;margin-top:4px}.nav-actions{display:flex;gap:7px;flex-wrap:wrap}
.change-meta{font-size:12px;color:#9aafc9;padding:10px 20px 12px;min-height:35px}
.diff-content{padding:0 16px 20px;min-width:0;overflow:auto;flex:1}
.diff-modes{display:flex;gap:3px;padding:3px;border:1px solid #34465e;border-radius:8px}.diff-modes button{border:0;padding:6px 10px}.diff-modes button.active{background:#365d89;color:#fff}
.diff{background:#111e30;border:1px solid #30445c;border-radius:8px;max-height:calc(100vh - 440px);min-height:260px;overflow:auto}
.diff-split{display:grid;grid-template-columns:repeat(2,minmax(max-content,1fr));align-content:start}
.diff-split .diff-head,.diff-split .diff-rows,.diff-split .diff-row{display:contents}
.diff-head{color:#c5d5e9;font-weight:600;font-size:12px}
.diff-head>div{position:sticky;top:0;z-index:2;padding:12px;background:#1e3047}.diff-head>div:first-child{border-right:1px solid #344961}
.diff-split .diff-row>.code-line:first-child{border-right:1px solid #30445c}
.code-line{display:flex;gap:10px;align-items:baseline;font:12px/1.65 ui-monospace,SFMono-Regular,Consolas,monospace;white-space:pre;min-height:24px;padding:2px 10px}
.diff-split .code-line{min-width:max-content}
.code-line .num{color:#8195af;min-width:36px;text-align:right;user-select:none;flex:none}.code-line .line-code{white-space:pre;flex:none}
.code-line.add{background:#1b443a}.code-line.del{background:#4b2b38}.code-line.meta{color:#9baecc;background:#1a2c40;font-size:11px}
.changed-fragment{background:#246f53;border-radius:2px;color:#ddffeb}.code-line.del .changed-fragment{background:#8a4052;color:#ffe0e6}
.diff-unified .diff-head,.diff-unified .diff-row{display:block;min-width:max-content}.diff-unified .diff-head>div{border-right:0}.diff-unified .diff-row .code-line{border-right:0}
.diff-unified .diff-head{min-width:620px}.diff-unified .diff-row{min-width:620px}
.diff-unified .code-line{width:max-content;min-width:100%}
.diff-unified .code-line.add{border-left:3px solid #54b88e}.diff-unified .code-line.del{border-left:3px solid #db7180}
.diff-note{padding:8px 12px;font-size:12px;color:#8ea6c4;background:#14233a;border-bottom:1px solid #30445c}
.notice{color:#dfc492;font-size:12px;padding:12px;background:#332d25;border-radius:6px;margin-bottom:10px}
.muted{font-size:13px;color:#91a6c2;padding:24px 16px;line-height:1.6}
.event-list{max-height:calc(100vh - 260px);min-height:350px;overflow:auto}
.event{width:100%;text-align:left;display:block;background:transparent;border:0;border-bottom:1px solid #25364b;border-radius:0;padding:12px 15px}
.event:hover,.event.active{background:#1e334b}.event-title{font-size:12.5px;font-weight:600}.event small{display:block;color:#8ea4c0;font-size:11px;margin-top:6px;overflow-wrap:anywhere}
.event-detail{padding:24px}.details-grid{display:grid;grid-template-columns:145px minmax(0,1fr);gap:11px;font-size:13px}.details-grid dt{color:#8599b4}.details-grid dd{margin:0;overflow-wrap:anywhere}
.event-inspector .section-heading{padding:17px 22px}footer{color:#7f91a8;font-size:11px;padding:14px 24px 20px}
@media(max-width:1200px){.workbench{grid-template-columns:245px minmax(0,1fr);padding:14px}.workspace-body{grid-template-columns:178px minmax(0,1fr)}.topbar{padding:0 16px}.toolbar{padding:12px 16px}.mini-stats{gap:9px}}
@media(max-width:900px){.topbar{gap:15px}.brand{min-width:auto}.toolbar{flex-wrap:wrap}.search-wrap{width:min(100%,390px)}.updated{margin-left:0}.workbench{grid-template-columns:1fr}.file-list,.event-list{max-height:235px;min-height:0}.workspace-main{min-height:520px}.revision-list{max-height:250px;min-height:160px}}
@media(max-width:580px){.topbar{height:auto;min-height:74px;flex-wrap:wrap;padding:12px}.live{margin-left:auto}.view-tabs{order:3;width:100%;height:40px}.tab{flex:1}.workbench{padding:10px}.workspace-body{grid-template-columns:1fr}.revisions{border-right:0;border-bottom:1px solid #25374e}.revision-list{display:flex;overflow-x:auto;min-height:0}.revision{min-width:140px}.range-control{margin-top:0}.file-heading{padding:16px}.compare-head{flex-wrap:wrap}.diff-content{padding:0 8px 12px}.diff{max-height:60vh}.mini-stats{order:4;width:100%}}
/* Collapsing either rail gives its width to the comparison without changing selection. */
.file-heading-top{display:flex;align-items:center;justify-content:space-between;gap:12px}
.panel-toggle,.review-toggle{white-space:nowrap;font-size:12px}
.workbench.files-collapsed{grid-template-columns:minmax(0,1fr)}
.files-collapsed>.file-sidebar{display:none}
.history-collapsed .workspace-body{grid-template-columns:minmax(0,1fr)}
.history-collapsed .revisions{display:none}
/* Viewport-sized review mode; Escape returns to the previous rail configuration. */
body.review-mode{overflow:hidden}
body.review-mode #view-files{position:fixed;inset:0;z-index:30;display:block;min-height:0;padding:0;background:#0b1018}
body.review-mode #view-files>.file-sidebar,body.review-mode #view-files .revisions{display:none}
body.review-mode #view-files .workspace-main{height:100dvh;min-height:0;border:0;border-radius:0}
body.review-mode #view-files .file-heading{padding:10px 20px}
body.review-mode #view-files .file-heading h2{font-size:16px;margin:4px 0}
body.review-mode #view-files .file-summary{margin-top:5px}
body.review-mode #view-files .workspace-body{display:flex;flex:1;min-height:0}
body.review-mode #view-files .compare-area{flex:1;min-height:0}
body.review-mode #view-files .diff-content{display:flex;flex-direction:column;min-height:0;overflow:auto}
body.review-mode #view-files .diff-content>div:only-child{display:flex;flex-direction:column;min-height:0;flex:1}
body.review-mode #view-files .diff-content>div:only-child>.diff{max-height:none;min-height:0;flex:1}
body.review-mode #toggle-files,body.review-mode #toggle-history{display:none}
body.review-mode #toggle-review{background:#355781;color:#fff}

/* Agent activity is request-scoped; it does not expose ChatGPT hidden reasoning. */
.agent-workbench{display:grid;grid-template-columns:minmax(240px,26%) minmax(280px,31%) minmax(0,1fr);gap:14px;padding:18px 24px 0;min-height:calc(100vh - 188px)}
.agent-panel{background:#111d2c;border:1px solid #26374e;border-radius:11px;min-width:0;overflow:hidden}
.agent-scroll{overflow:auto;max-height:calc(100vh - 257px);min-height:280px}
.agent-mode{display:flex;gap:6px;padding:10px 12px;border-bottom:1px solid #26374e}.agent-mode button{flex:1;font-size:12px}.agent-mode button.active{background:#365d89;color:#fff}
.agent-item{display:block;width:100%;border:0;border-bottom:1px solid #26374e;border-left:3px solid transparent;border-radius:0;padding:14px 15px;text-align:left;background:transparent}
.agent-item:hover{background:#1c3048}.agent-item.active{background:#223a54;border-left-color:#7bb9fb}
.agent-item .item-title{display:block;font-weight:600;font-size:12px;overflow-wrap:anywhere}
.agent-item .item-sub{display:block;color:#9aadc7;font-size:11px;margin-top:7px;overflow-wrap:anywhere;line-height:1.55}
.agent-item .failed{color:#f0a2ac}.agent-detail{overflow:auto;max-height:calc(100vh - 257px);padding:16px}
.agent-detail h3{font-size:15px;margin-bottom:14px}.agent-detail dl{display:grid;grid-template-columns:90px minmax(0,1fr);gap:8px;font-size:12px;margin:0 0 20px}
.agent-detail dt{color:#96abc6}.agent-detail dd{margin:0;overflow-wrap:anywhere}
.agent-detail h4{font-size:12px;margin:14px 0 7px}.agent-detail pre{font:12px/1.6 ui-monospace,Consolas,monospace;white-space:pre-wrap;overflow-wrap:anywhere;padding:13px;border:1px solid #33465b;background:#0d1827;border-radius:8px;max-height:330px;overflow:auto}
.agent-detail .notice{margin:8px 0}.agent-detail .secondary{margin-top:10px}
@media(max-width:1080px){.agent-workbench{grid-template-columns:minmax(220px,35%) minmax(0,1fr)}.agent-workbench>.agent-panel:last-child{grid-column:1/-1}.agent-detail{max-height:400px}}
@media(max-width:700px){.agent-workbench{display:block;padding:10px}.agent-panel{margin-bottom:12px}.agent-scroll{max-height:260px;min-height:120px}.agent-detail{max-height:420px}}
</style><script src="app.js" defer></script></head><body>
<header class="topbar">
  <div class="brand"><span class="brand-mark">CP</span><div><h1>Trace Explorer</h1><p class="sub">CodexPro · 本地变更记录</p></div></div>
  <nav class="view-tabs" role="tablist" aria-label="查看模式">
    <button id="tab-files" class="tab active" role="tab" aria-selected="true" aria-controls="view-files">文件变更</button>
    <button id="tab-agent" class="tab" role="tab" aria-selected="false" aria-controls="view-agent">Agent 执行</button>
    <button id="tab-events" class="tab" role="tab" aria-selected="false" aria-controls="view-events">协议事件</button>
  </nav>
  <span id="connection" class="live" role="status">连接中</span>
</header>
<div class="toolbar">
  <div class="search-wrap"><span aria-hidden="true">⌕</span><input id="search" type="search" placeholder="搜索文件、Trace ID、Request ID…" aria-label="搜索日志"></div>
  <button id="filters-toggle" class="secondary" aria-controls="filters-panel" aria-expanded="false">筛选条件</button>
  <div class="mini-stats"><span><b id="count-changes">0</b> 次修改</span><span><b id="count-events">0</b> 条事件</span><span><b id="count-projects">0</b> 个项目</span></div>
  <span class="updated">更新 <time id="updated">—</time></span>
</div>
<section id="filters-panel" class="filter-panel" hidden>
  <label>项目<select id="project"><option value="">全部项目</option></select></label>
  <label>开始时间<input type="datetime-local" id="from"></label>
  <label>结束时间<input type="datetime-local" id="to"></label>
  <label>工具<select id="tool"><option value="">全部工具</option></select></label>
  <label>文件路径<input id="file" type="search" placeholder="例如 src/server.ts"></label>
  <button id="reset" class="secondary">清空筛选</button>
</section>
<main id="view-files" class="workbench" role="tabpanel" aria-labelledby="tab-files">
  <aside id="file-sidebar" class="file-sidebar">
    <div class="section-heading"><div><h2>修改过的文件</h2><small>按最近修改排序</small></div><span id="file-count" class="count">0</span></div>
    <div id="file-list" class="file-list" aria-label="修改文件列表"></div>
  </aside>
  <section class="workspace-main">
    <div class="file-heading"><div class="file-heading-top"><span class="eyebrow">当前文件</span><button id="toggle-files" class="secondary panel-toggle" aria-controls="file-sidebar" aria-expanded="true">隐藏文件列表</button></div><h2 id="selected-filename">选择一个文件</h2>
      <p id="selected-directory" class="path-subtitle">从左侧选择文件，查看所有相关修改</p>
      <div id="file-summary" class="file-summary"></div>
    </div>
    <div class="workspace-body">
      <aside id="revisions" class="revisions">
        <div class="revisions-title"><h3>修改记录</h3><span id="revision-count" class="count">0</span></div>
        <div id="revision-list" class="revision-list" aria-label="当前文件的修改历史"></div>
        <details class="range-control"><summary>比较多个修改步骤</summary>
          <div class="range-fields"><label>从<select id="range-start" aria-label="范围开始"></select></label>
          <label>到<select id="range-end" aria-label="范围结束"></select></label>
          <button id="compare">按时间顺序查看</button></div>
        </details>
      </aside>
      <section class="compare-area">
        <div class="compare-head"><div><span class="eyebrow">代码差异</span><h3 id="diff-title">修改前后对比</h3></div>
          <div class="nav-actions"><button id="toggle-history" class="secondary panel-toggle" aria-controls="revisions" aria-expanded="true">隐藏修改记录</button><div class="diff-modes" role="group" aria-label="代码差异布局"><button id="mode-unified" class="secondary active" aria-pressed="true">单栏</button><button id="mode-split" class="secondary" aria-pressed="false">双栏</button></div><button id="prev" class="secondary" disabled>← 上一次</button><button id="next" class="secondary" disabled>下一次 →</button><button id="toggle-review" class="secondary review-toggle" aria-pressed="false" aria-label="进入全屏代码审查">全屏审查</button></div>
        </div>
        <div id="history-meta" class="change-meta"></div>
        <div id="diff" class="diff-content" aria-live="polite"><div class="muted">请选择文件修改记录以查看代码差异。</div></div>
      </section>
    </div>
  </section>
</main>
<main id="view-agent" class="agent-workbench" role="tabpanel" aria-labelledby="tab-agent" hidden>
  <aside class="agent-panel"><div class="section-heading"><div><h2>Agent 执行记录</h2><small>任务关联仅使用客户端显式提供的 task_id</small></div><span id="agent-count" class="count">0</span></div><div class="agent-mode"><button id="agent-mode-requests" class="secondary active" aria-pressed="true">按请求</button><button id="agent-mode-tasks" class="secondary" aria-pressed="false">按任务</button><button id="agent-mode-conversations" class="secondary" aria-pressed="false">按会话</button></div>
    <div id="agent-traces" class="agent-scroll" aria-label="请求列表"></div></aside>
  <section class="agent-panel"><div class="section-heading"><div><h2>执行时间线</h2><small id="agent-trace-meta">选择请求查看工具、执行及修改事件</small></div></div>
    <div id="agent-steps" class="agent-scroll" aria-label="执行步骤"></div></section>
  <section class="agent-panel"><div class="section-heading"><div><h2>步骤详情</h2><small>命令、退出状态、有限的脱敏输出</small></div></div>
    <div id="agent-detail" class="agent-detail"><div class="muted">选择一个执行步骤查看详情。</div></div></section>
</main>
<main id="view-events" class="workbench event-workbench" role="tabpanel" aria-labelledby="tab-events" hidden>
  <aside class="file-sidebar"><div class="section-heading"><div><h2>协议事件</h2><small>最近 300 条匹配事件</small></div></div>
    <div id="events" class="event-list"></div></aside>
  <section class="event-inspector"><div class="section-heading"><h2>事件详情</h2></div>
    <div id="event-detail" class="event-detail"><div class="muted">选择左侧事件，查看状态、调用标识与关联修改。</div></div>
  </section>
</main>
<footer>仅限本机访问。Diff 展示的是每次操作保留的 Patch，截断片段不代表完整文件历史。</footer>
</body></html>`;
