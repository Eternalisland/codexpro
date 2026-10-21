import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';
import { buildTraceTimeline, renderTraceTimelineHtml } from './trace-viewer.mjs';
import { startTraceExplorer } from './trace-explorer.mjs';

/**
 * V100(20261019) yijiakang 【可靠性修复】按数字轮转序号读取 Trace，任务号:20260509145520000648
 */
const verNum = 'V100(20261019)';

function expandHome(value) {
  if (!value || value === '~') return os.homedir();
  if (value.startsWith('~/')) return path.join(os.homedir(), value.slice(2));
  return value;
}

function defaultTraceDir(env = process.env) {
  const home = env.CODEXPRO_HOME
    ? path.resolve(expandHome(env.CODEXPRO_HOME))
    : path.join(os.homedir(), '.codexpro');
  return path.resolve(expandHome(env.CODEXPRO_MCP_TRACE_DIR || path.join(home, 'traces')));
}

function parseTraceArgs(argv) {
  const action = argv[0] && !argv[0].startsWith('--') ? argv[0] : 'tail';
  const start = action === argv[0] ? 1 : 0;
  const out = { action, lines: 40 };
  for (let i = start; i < argv.length; i += 1) {
    const raw = argv[i];
    if (!raw.startsWith('--')) continue;
    const option = raw.slice(2);
    const eq = option.indexOf('=');
    const key = eq >= 0 ? option.slice(0, eq) : option;
    const inline = eq >= 0 ? option.slice(eq + 1) : undefined;
    if (['json', 'last', 'help', 'no-open'].includes(key)) {
      out[key] = true;
      continue;
    }
    const next = inline ?? argv[i + 1];
    if (next === undefined || (inline === undefined && next.startsWith('--'))) {
      throw new Error(`Missing value for --${key}`);
    }
    if (inline === undefined) i += 1;
    const camel = key.replace(/-([a-z])/g, (_, c) => c.toUpperCase());
    out[camel] = next;
  }
  const parsedLines = Number(out.lines);
  out.lines = Number.isFinite(parsedLines) ? Math.max(1, Math.min(500, Math.floor(parsedLines))) : 40;
  return out;
}

async function traceFiles(dir) {
  const names = await fsp.readdir(dir).catch((error) => {
    if (error?.code === 'ENOENT') return [];
    throw error;
  });
  return names
    .filter((name) => /^trace-\d{4}-\d{2}-\d{2}(?:\.\d+)?\.jsonl$/.test(name))
    .sort((left, right) => {
      const pattern = /^trace-(\d{4}-\d{2}-\d{2})(?:\.(\d+))?\.jsonl$/;
      const a = pattern.exec(left);
      const b = pattern.exec(right);
      if (a[1] !== b[1]) return a[1] < b[1] ? -1 : 1;
      // Lexical sorting puts .10 before .2 and the base file after all rotations.
      const aSequence = BigInt(a[2] || '0');
      const bSequence = BigInt(b[2] || '0');
      return aSequence < bSequence ? -1 : aSequence > bSequence ? 1 : left.localeCompare(right);
    })
    .map((name) => path.join(dir, name));
}

async function *eventsFromFiles(files) {
  for (const file of files) {
    const input = fs.createReadStream(file, { encoding: 'utf8' });
    const lines = readline.createInterface({ input, crlfDelay: Infinity });
    for await (const line of lines) {
      if (!line.trim()) continue;
      try {
        const event = JSON.parse(line);
        if (event && typeof event === 'object') yield event;
      } catch {}
    }
  }
}

async function readAllEvents(files) {
  const events = [];
  for await (const event of eventsFromFiles(files)) events.push(event);
  return events;
}

function eventSummary(event) {
  const parts = [
    event.ts || '',
    event.event || 'event',
    event.tool ? `tool=${event.tool}` : '',
    event.status ? `status=${event.status}` : '',
    Number.isFinite(event.duration_ms) ? `duration=${event.duration_ms}ms` : '',
    event.job_id ? `job=${event.job_id}` : '',
    event.request_id ? `request=${event.request_id}` : '',
    event.trace_id ? `trace=${event.trace_id}` : ''
  ].filter(Boolean);
  return parts.join(' ');
}

function usage() {
  return [
    'CodexPro MCP trace viewer',
    '',
    'Usage:',
    '  codexpro trace tail [--lines 40] [--trace-dir <dir>] [--json]',
    '  codexpro trace show --last [--trace-dir <dir>] [--json]',
    '  codexpro trace show --request <request_id> [--json]',
    '  codexpro trace show --job <job_id> [--json]',
    '  codexpro trace show --trace-id <trace_id> [--json]',
    '  codexpro trace explorer [--trace-dir <dir>] [--port <port>] [--no-open]',
    '  codexpro trace timeline --job <job_id> [--json]',
    '  codexpro trace timeline --last --html ./codexpro-timeline.html',
    '  codexpro trace timeline --trace-id <trace_id> --html <output.html>',
    '  codexpro trace timeline --request <request_id> --html <output.html>',
    '',
    'Offline HTML includes side-by-side changes for retained write/edit/apply_patch diffs.',
    'Redacted traces retain bounded payloads; truncated diffs cannot be fully reconstructed.',
    '',
    'Trace recording is enabled when CodexPro starts with:',
    '  --mcp-trace redacted',
    'or:',
    '  CODEXPRO_MCP_TRACE=redacted'
  ].join('\n');
}

function selectTraceEvents(events, args) {
  if (args.traceId) return events.filter((event) => event.trace_id === args.traceId);
  if (args.request) return events.filter((event) => event.request_id === args.request);
  if (args.job) {
    const traces = new Set(
      events
        .filter((event) => event.job_id === args.job)
        .map((event) => event.trace_id)
        .filter(Boolean)
    );
    return events.filter((event) => event.job_id === args.job || (event.trace_id && traces.has(event.trace_id)));
  }

  const last = [...events].reverse().find((event) => event.trace_id);
  if (!last?.trace_id) return [];
  return events.filter((event) => event.trace_id === last.trace_id);
}

export async function runTraceCli(argv, options = {}) {
  const env = options.env ?? process.env;
  const stdout = options.stdout ?? process.stdout;
  const args = parseTraceArgs(argv);
  if (args.help || args.action === 'help') {
    stdout.write(usage() + '\n');
    return 0;
  }
  if (!['tail', 'show', 'timeline', 'explorer'].includes(args.action)) {
    throw new Error(`Unknown trace action: ${args.action}. Use tail, show, timeline, or explorer.`);
  }

  const dir = path.resolve(expandHome(args.traceDir || defaultTraceDir(env)));
  if (args.action === 'explorer') {
    const port = args.port === undefined ? 0 : Number(args.port);
    if (!Number.isInteger(port) || port < 0 || port > 65535) {
      throw new Error('Explorer port must be an integer from 0 to 65535.');
    }
    const explorer = await startTraceExplorer({
      dir, port,
      openBrowser: args['no-open'] ? undefined : options.openBrowser
    });
    stdout.write(`Trace Explorer listening locally: ${explorer.url}\n`);
    stdout.write('Press Ctrl+C to stop Trace Explorer.\n');
    return 0;
  }
  const files = await traceFiles(dir);
  if (!files.length) {
    if (args.json) stdout.write('[]\n');
    else stdout.write(`No CodexPro trace files found in ${dir}\n`);
    return 0;
  }

  const events = await readAllEvents(files);
  if (args.action === 'tail') {
    const selected = events.slice(-args.lines);
    if (args.json) stdout.write(JSON.stringify(selected, null, 2) + '\n');
    else {
      stdout.write(`Trace dir: ${dir}\n`);
      for (const event of selected) stdout.write(eventSummary(event) + '\n');
    }
    return 0;
  }

  const selected = selectTraceEvents(events, args);
  if (args.action === 'timeline') {
    const timeline = buildTraceTimeline(selected);
    if (args.html) {
      const filePath = path.resolve(expandHome(args.html));
      if (!filePath.toLowerCase().endsWith('.html')) {
        throw new Error('Timeline export requires an .html destination.');
      }
      await fsp.mkdir(path.dirname(filePath), { recursive: true });
      // Explicit opt-in export with no automatic overwrite of existing user files.
      await fsp.writeFile(filePath, renderTraceTimelineHtml(timeline, {
        label: args.job ? `Job ${args.job}` : args.request ? `Request ${args.request}` : 'Selected trace'
      }), { encoding: 'utf8', mode: 0o600, flag: 'wx' });
      stdout.write(`Wrote offline CodexPro trace timeline: ${filePath}\n`);
    } else if (args.json) {
      stdout.write(JSON.stringify(timeline, null, 2) + '\n');
    } else if (!timeline.events.length) {
      stdout.write('No matching trace events.\n');
    } else {
      stdout.write(`CodexPro trace timeline: ${timeline.total_events} events over ${(timeline.duration_ms / 1000).toFixed(2)}s\n`);
      for (const event of timeline.events) {
        stdout.write(`+${(event.offset_ms / 1000).toFixed(3)}s ${eventSummary(event)}\n`);
      }
    }
    return 0;
  }

  if (args.json) {
    stdout.write(JSON.stringify(selected, null, 2) + '\n');
  } else if (!selected.length) {
    stdout.write('No matching trace events.\n');
  } else {
    stdout.write(`Trace dir: ${dir}\n`);
    for (const event of selected) {
      stdout.write('\n' + eventSummary(event) + '\n');
      stdout.write(JSON.stringify(event, null, 2) + '\n');
    }
  }
  return 0;
}
