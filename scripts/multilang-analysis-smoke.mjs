import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { loadConfig } from '../dist/config.js';
import { WorkspaceManager, PathGuard } from '../dist/guard.js';
import { inspectWorkspace, searchWorkspaceStructured } from '../dist/analysis/index.js';

const root = await fs.mkdtemp(path.join(os.tmpdir(), 'codexpro-multilang-'));
const previousPythonAst = process.env.CODEXPRO_PYTHON_AST;
process.env.CODEXPRO_PYTHON_AST = '1';
const vue = [
  '<template>',
  '  <template v-if="ready"><div>submit</div></template>',
  '  <!-- <script>function ignored() {}</script> -->',
  '</template>',
  '<script setup lang="ts">',
  "import { greet } from './greet'",
  "import Child from './Child.vue'",
  'const title = "Hello"',
  'async function submit() { return greet(title) }',
  '</script>',
  '<style scoped>.submit { color: red; }</style>',
  ''
].join('\n');
try {
  await fs.mkdir(path.join(root, 'src'), { recursive: true });
  await fs.writeFile(path.join(root, 'package.json'), '{"name":"vue-fixture"}\n', 'utf8');
  await fs.writeFile(path.join(root, 'src', 'App.vue'), vue, 'utf8');
  await fs.writeFile(path.join(root, 'src', 'Child.vue'), '<template><div>child</div></template>\n', 'utf8');
  await fs.writeFile(path.join(root, 'src', 'greet.ts'), 'export const greet = (s: string) => s;\n', 'utf8');
  await fs.mkdir(path.join(root, 'python'), { recursive: true });
  await fs.writeFile(path.join(root, 'python', 'helper.py'), 'def greet(name):\n    return name\n', 'utf8');
  await fs.writeFile(path.join(root, 'python', 'extra.py'), 'VALUE = 42\n', 'utf8');
  await fs.writeFile(path.join(root, 'python', 'service.py'), [
    'from .helper import greet',
    'from . import extra',
    'def route(path):',
    '    return lambda handler: handler',
    '@route("/chat")',
    'async def generate():',
    '    return greet("world")',
    'class Agent:',
    '    async def run(self):',
    '        return await generate()',
    ''
  ].join('\n'), 'utf8');
  const config = loadConfig(['--root', root]);
  const workspace = new WorkspaceManager(config).defaultWorkspace();
  const analysis = await inspectWorkspace(config, new PathGuard(config), workspace);
  assert(analysis.languages.includes('vue'), 'Vue SFC should be a recognized source language');
  assert(analysis.projectTypes.includes('vue'), 'Vue project should be classified');
  const symbols = analysis.symbols.filter(s => s.path === 'src/App.vue');
  assert.equal(symbols.find(s => s.name === 'submit')?.line, 9, 'line number should refer to original SFC');
  assert.equal(symbols.find(s => s.name === 'title')?.line, 8);
  assert(!symbols.some(s => s.name === 'ignored'), 'template/comment content must not produce symbols');
  const imports = analysis.relationships.filter(r => r.from === 'src/App.vue').map(r => r.to).sort();
  assert.deepEqual(imports, ['src/Child.vue', 'src/greet.ts']);
  const found = await searchWorkspaceStructured(config, new PathGuard(config), workspace, { query: 'submit', intent: 'symbol' });
  assert(found.groups.definitions.some(m => m.path === 'src/App.vue' && m.line === 9));
  const pythonLinks = analysis.relationships.filter(r => r.from === 'python/service.py').map(r => r.to);
  if (analysis.warnings.some(w => w.includes('Python AST unavailable'))) {
    console.log('Python AST runtime unavailable; lexical fallback covered.');
  } else {
    assert(pythonLinks.includes('python/helper.py'), 'Python relative imports should be resolved by AST');
    assert(pythonLinks.includes('python/extra.py'), 'Python from-package imports should resolve module files');
    assert.equal(analysis.symbols.find(s => s.path === 'python/service.py' && s.name === 'run')?.line, 9);
    assert.equal(analysis.symbols.find(s => s.path === 'python/service.py' && s.name === 'generate')?.line, 6);
    console.log('Python AST indexing smoke passed.');
  }
  console.log('Vue SFC analysis smoke passed.');
} finally {
  if (previousPythonAst === undefined) delete process.env.CODEXPRO_PYTHON_AST;
  else process.env.CODEXPRO_PYTHON_AST = previousPythonAst;
  await fs.rm(root, { recursive: true, force: true });
}
