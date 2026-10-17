import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const src = join(root, 'src');
// Reviewed exceptions: [from, to, reason]. A stale entry fails so the list only shrinks.
const KNOWN_COUPLINGS = [
  ['src/preload.cjs', 'electron', 'Electron preload scripts must use CommonJS require; not a plugin path'],
  ['src/sqlite.js', 'node:sqlite', 'Constant built-in specifier loaded dynamically only to filter its load-time ExperimentalWarning; not a plugin path'],
  ['src/credential-entry-preload.cjs', 'electron', 'Preload of the browser-owned credential entry window; Electron preloads use CommonJS require; not a plugin path'],
  ['src/credential-broker-child.cjs', 'node:crypto', 'Credential broker process: self-contained CommonJS with built-in modules only, so the Node permission model need not grant reads of other source files; not a plugin path'],
  ['src/redaction.js', 'node:vm', 'Runs one constant, module-defined matching script under a timeout so caller-supplied redaction patterns cannot stall the process; loads no code and is not a plugin path'],
];
// The one door from core into the plugin layer.
const BOUNDARY = new Set(['src/plugins/registry.js']);
// Plugin infrastructure may use pure core helpers, never services or the catalog.
const INFRA_MAY_IMPORT = new Set(['src/autonomy.js', 'src/storage-safety.js']);
const LOADER = /\b(?:createRequire|require\s*\(|import\s*\(|new\s+Function\b|eval\s*\()|['"]node:vm['"]/;

export function importsOf(source) {
  const found = [];
  const patterns = [/\bimport\s+(?:[^'"()]*?\s+from\s+)?['"]([^'"]+)['"]/g, /\bexport\s+[^'"]*?\s+from\s+['"]([^'"]+)['"]/g, /\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/g, /\brequire\s*\(\s*['"]([^'"]+)['"]\s*\)/g];
  for (const pattern of patterns) for (const match of source.matchAll(pattern)) found.push(match[1]);
  return found;
}
const files = directory => readdirSync(directory, { withFileTypes: true }).flatMap(entry => entry.isDirectory() ? files(join(directory, entry.name)) : /\.(?:c|m)?js$/.test(entry.name) ? [join(directory, entry.name)] : []);
const repo = path => relative(root, path).replaceAll('\\', '/');
function edges() {
  return files(src).filter(file => !file.endsWith('gui.js')).flatMap(file => importsOf(readFileSync(file, 'utf8')).map(specifier => ({
    from: repo(file), to: specifier.startsWith('.') ? repo(resolve(dirname(file), specifier)) : specifier,
  })));
}
const layer = path => path.startsWith('src/plugins/builtin/') ? 'plugin' : path.startsWith('src/plugins/') ? 'infra' : path.startsWith('src/') ? 'core' : 'external';
const known = ({ from, to }) => KNOWN_COUPLINGS.some(([a, b]) => a === from && b === to);

export function violations(list) {
  const problems = [];
  for (const edge of list) {
    if (known(edge)) continue;
    const [from, to] = [layer(edge.from), layer(edge.to)];
    if (from === 'core' && ['plugin', 'infra'].includes(to) && !BOUNDARY.has(edge.to)) problems.push(`${edge.from} imports plugin module ${edge.to}; use the registry hooks instead`);
    if (from === 'plugin' && !(to === 'plugin' || edge.to === 'zod')) problems.push(`${edge.from} imports ${edge.to}; plugins may import only zod and sibling plugin files`);
    if (from === 'infra' && to === 'core' && !INFRA_MAY_IMPORT.has(edge.to)) problems.push(`${edge.from} imports core service ${edge.to}`);
  }
  return problems;
}

test('core modules reach plugins only through the registry and plugins never import core', () => {
  const list = edges();
  assert.ok(list.some(edge => edge.from === 'src/commands.js' && edge.to === 'src/plugins/registry.js'), 'catalog merges plugin commands through the registry');
  assert.ok(list.some(edge => layer(edge.from) === 'plugin'), 'built-in plugins exist, so the boundary check is not vacuous');
  assert.deepEqual(violations(list), []);
  for (const coupling of KNOWN_COUPLINGS) assert.ok(list.some(edge => edge.from === coupling[0] && edge.to === coupling[1]), `stale KNOWN_COUPLINGS entry ${coupling.join(' -> ')}`);
});

test('core modules contain no dynamic loader shortcut that could bypass the boundary', () => {
  for (const file of files(src).filter(path => layer(repo(path)) === 'core' && !path.endsWith('gui.js'))) {
    const source = readFileSync(file, 'utf8');
    const match = LOADER.exec(source);
    if (match && !KNOWN_COUPLINGS.some(([from]) => from === repo(file))) assert.fail(`${repo(file)} uses ${match[0]}`);
  }
});

test('the scanner detects violations it is meant to prevent', () => {
  assert.deepEqual(importsOf("import a from './x.js';\nexport { b } from \"../y.js\";\nconst c = await import('./z.js');\nrequire('w');"), ['./x.js', '../y.js', './z.js', 'w']);
  assert.equal(violations([{ from: 'src/workspace.js', to: 'src/plugins/builtin/markdown.js' }]).length, 1);
  assert.equal(violations([{ from: 'src/dispatch.js', to: 'src/plugins/sandbox.js' }]).length, 1);
  assert.equal(violations([{ from: 'src/plugins/builtin/markdown.js', to: 'src/workspace.js' }]).length, 1);
  assert.equal(violations([{ from: 'src/plugins/builtin/markdown.js', to: 'node:fs' }]).length, 1);
  assert.equal(violations([{ from: 'src/plugins/registry.js', to: 'src/workspace.js' }]).length, 1);
  assert.equal(violations([{ from: 'src/commands.js', to: 'src/plugins/registry.js' }]).length, 0);
  assert.ok(LOADER.test("const m = await import(name)") && LOADER.test("createRequire(import.meta.url)") && LOADER.test("import vm from 'node:vm'"));
});
