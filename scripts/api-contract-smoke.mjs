import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createCodexProServer } from '../dist/server.js';
import { loadConfig } from '../dist/config.js';

process.env.CODEXPRO_EXPOSE_ABSOLUTE_PATHS = '1';
const base = await fs.mkdtemp(path.join(os.tmpdir(), 'codexpro-api-contract-'));
const frontend = path.join(base, 'frontend');
const backend = path.join(base, 'backend');
const python = path.join(base, 'python');
let server;
let client;

async function put(root, file, text) {
  const target = path.join(root, file);
  await fs.mkdir(path.dirname(target), { recursive: true });
  await fs.writeFile(target, text, 'utf8');
}
async function call(name, args) {
  const response = await client.callTool({ name, arguments: args });
  if (response.isError) throw new Error(response.content?.find(p => p.type === 'text')?.text ?? JSON.stringify(response));
  return response.structuredContent;
}
try {
  await put(frontend, 'src/Chat.vue', [
    '<template><div>fetch("/api/chat/fake")</div></template>',
    '<script setup lang="ts">',
    "const stream = fetch('/api/chat/stream', { method: 'POST' })",
    "const events = new EventSource('/api/chat/events')",
    "const unmatched = fetch('/api/unknown')",
    "const wrongMethod = axios.post('/api/chat/events')",
    "const dynamic = fetch('/api/' + route)",
    '</script>',
    ''
  ].join('\n'));
  await put(frontend, 'src/client.ts', 'const local = axios.get("/api/unknown2");\n');
  await put(backend, 'src/main/java/demo/ChatController.java', [
    'package demo;',
    '@RestController',
    '@RequestMapping("/api/chat")',
    'public class ChatController {',
    '  @PostMapping(value="/stream", produces=MediaType.TEXT_EVENT_STREAM_VALUE)',
    '  public Object stream() { return null; }',
    '  @GetMapping("/events")',
    '  public Object events() { return null; }',
    '  // @GetMapping("/unknown")',
    '}',
    ''
  ].join('\n'));
  await put(backend, 'src/main/java/demo/ModelClient.java', [
    'class ModelClient {',
    '  void call() { client.post().uri("/v1/generate").retrieve(); }',
    '  // client.get().uri("/v1/unused");',
    '}',
    ''
  ].join('\n'));
  await put(python, 'app/routes.py', [
    'from fastapi import APIRouter',
    'router = APIRouter(prefix="/v1")',
    '',
    '@router.post("/generate")',
    'async def generate():',
    '    return {"ok": True}',
    '@router.get("/unused")',
    'async def unused():',
    '    return "unused"',
    ''
  ].join('\n'));
  await put(python, 'app/ignored.py', "# @app.get('/api/chat/stream')\n");

  const config = loadConfig([
    '--root', frontend, '--alias', 'frontend=' + frontend, '--alias', 'backend=' + backend, '--alias', 'model=' + python,
    '--tool-mode', 'full'
  ]);
  server = createCodexProServer(config);
  client = new Client({ name: 'api-contract-smoke', version: '1.0.0' });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await server.connect(b);
  await client.connect(a);
  const args = {
    frontend_workspace_id: 'FRONTEND',
    backend_workspace_id: 'backend',
    python_workspace_id: 'MODEL'
  };
  const opened = await call('open_current_workspace', { include_tree: false });
  const result = await call('analyze_api_contracts', args);
  assert.equal(result.schema_version, 1);
  assert.equal(result.frontend_workspace_id, opened.workspace_id, 'frontend alias must resolve to stable ID');
  assert.equal(result.frontend_to_backend.length, 2, JSON.stringify(result.frontend_to_backend));
  assert.equal(result.backend_to_python.length, 1, JSON.stringify(result.backend_to_python));
  const stream = result.frontend_to_backend.find(x => x.caller.path === '/api/chat/stream');
  assert(stream);
  assert.equal(stream.caller.line, 3);
  assert.equal(stream.endpoint.line, 5);
  assert.equal(stream.endpoint.protocol, 'sse');
  assert.equal(stream.confidence, 'inferred');
  const events = result.frontend_to_backend.find(x => x.caller.path === '/api/chat/events');
  assert.equal(events?.caller.protocol, 'sse');
  assert.equal(events?.endpoint.method, 'GET');
  assert.equal(result.backend_to_python[0].endpoint.file, 'app/routes.py');
  assert.equal(result.backend_to_python[0].endpoint.line, 4);
  assert.equal(result.backend_to_python[0].caller.line, 2);
  assert(result.unmatched_callers.some(x => x.path === '/api/unknown'));
  assert(!result.frontend_to_backend.some(x => x.caller.path === '/api/chat/fake'));
  assert(result.coverage.every(x => x.truncated === false));

  const bounded = await call('analyze_api_contracts', { ...args, max_matches: 1 });
  assert.equal(bounded.frontend_to_backend.length, 1);
  assert(bounded.warnings.some(x => x.includes('partial coverage')));

  const pair = await call('analyze_api_contracts', {
    frontend_workspace_id: opened.workspace_id, backend_workspace_id: 'backend'
  });
  assert.equal(pair.frontend_to_backend.length, 2);
  assert.equal(pair.backend_to_python.length, 0);
  const invalid = await client.callTool({ name: 'analyze_api_contracts', arguments: {
    frontend_workspace_id: 'backend', backend_workspace_id: 'backend'
  } });
  assert(invalid.isError, 'the same workspace cannot be source and target');
  await put(frontend, 'src/Widget.tsx', [
    'export function Widget() {',
    "  const result = fetch('/api/chat/events')",
    '  return <span>Hi</span>',
    '}'
  ].join('\n'));
  const tsx = await call('analyze_api_contracts', args);
  assert(tsx.frontend_to_backend.some(x => x.caller.file === 'src/Widget.tsx' && x.caller.line === 2),
    'TSX requests must preserve source lines around JSX expressions');
  await put(frontend, 'src/Many.ts', Array.from({ length: 1100 },
    () => "fetch('/api/not-present')").join('\n') + '\n');
  const recordBudget = await call('analyze_api_contracts', args);
  assert.equal(recordBudget.coverage[0].truncated, true, 'caller extraction budget should be reported');
  assert(recordBudget.unmatched_callers.length <= 100, 'unmatched callers must be bounded');
  console.log('API contract smoke passed (Vue -> Spring -> FastAPI, SSE, aliases, negatives, budgets).');
} finally {
  await client?.close();
  await server?.close();
  await fs.rm(base, { recursive: true, force: true });
}
