import test from 'node:test';
import assert from 'node:assert/strict';
import { performance } from 'node:perf_hooks';
import { mkdtempSync, rmSync, statSync, readdirSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { WorkspaceService } from '../src/workspace.js';
import { commands } from '../src/commands.js';
import { createOpenApiDocument } from '../src/openapi.js';

async function budget(t, name, milliseconds, operation) {
  const start = performance.now();
  const result = await operation();
  const elapsed = performance.now() - start;
  t.diagnostic(`${name}: ${elapsed.toFixed(1)} ms (budget ${milliseconds} ms)`);
  assert.ok(elapsed < milliseconds, `${name}: ${elapsed.toFixed(1)} ms exceeds ${milliseconds} ms budget`);
  return result;
}

test('10k-record store write, 1k-capture search and workspace transfer budgets', async t => {
  const directory = mkdtempSync(join(tmpdir(), 'weft-perf-'));
  const service = new WorkspaceService({ directory });
  t.after(() => { service.close?.(); rmSync(directory, { recursive: true, force: true }); });
  const note = await service.execute('materials.create', { title: 'Seed note', content: 'Performance fixture' });
  const capture = await service.execute('artifacts.create', { title: 'Seed capture', text: 'fixture searchable-needle '.repeat(100) });
  // Fixture construction is deliberately outside the timed path. Each operation
  // below uses production persistence/search/import/export APIs.
  service.data.materials = Array.from({ length: 10000 }, (_, i) => ({ ...structuredClone(note), id: `material-perf-${i}`, title: `Note ${i}` }));
  // Capture text is component-backed (lazy), so the fixture supplies it explicitly.
  service.data.artifacts = Array.from({ length: 1000 }, (_, i) => ({ ...structuredClone(capture), id: `capture-perf-${i}`, versions: [{ ...service.data.artifacts[0].versions[0], id: `version-perf-${i}`, text: 'fixture searchable-needle '.repeat(100) }] }));
  service.save();
  await budget(t, 'write with 10k records', 5000, () => service.execute('materials.update', { id: 'material-perf-9999', changes: { content: 'Updated last record' } }));
  const results = await budget(t, 'search across 1k captures', 2000, () => service.execute('search.query', { query: 'searchable-needle', limit: 200 }));
  assert.equal(results.length, 200);
  assert.ok(results.every(result => result.type === 'artifacts'));
  const exported = await budget(t, 'export large workspace', 5000, () => service.execute('workspaces.export', { id: service.activeWorkspaceId }));
  const imported = await budget(t, 'import large workspace', 10000, () => service.execute('workspaces.import', { data: exported }));
  const records = await service.execute('materials.list', { workspaceId: imported.id });
  assert.equal(records.length, 10000);
  assert.ok(records.some(record => record.content === 'Updated last record'));
  assert.equal((await service.execute('artifacts.list', { workspaceId: imported.id })).length, 1000);
});

test('metadata changes in a capture-heavy store never rewrite capture components', async t => {
  const directory = mkdtempSync(join(tmpdir(), 'weft-perf-captures-'));
  let service = new WorkspaceService({ directory });
  t.after(() => { service.close?.(); rmSync(directory, { recursive: true, force: true }); });
  const seed = await service.execute('artifacts.create', { title: 'Seed', text: 'seed' });
  const png = size => Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), randomBytes(size)]).toString('base64');
  // 500 captures, each with a unique 96 KiB image and 24 KiB of text (~60 MiB of components).
  service.data.artifacts = Array.from({ length: 500 }, (_, i) => ({ ...structuredClone(seed), id: `capture-heavy-${i}`, title: `Capture ${i}`,
    versions: [{ ...structuredClone(seed.versions[0]), id: `version-heavy-${i}`, text: `capture ${i} body `.repeat(1500), pngBase64: png(96 * 1024) }] }));
  service.data.materials = Array.from({ length: 2000 }, (_, i) => ({ id: `material-heavy-${i}`, workspaceId: service.activeWorkspaceId, title: `Note ${i}`, content: `note ${i}`, kind: 'note', tags: [], localOnly: false, pinned: false, createdAt: seed.createdAt, updatedAt: seed.createdAt, revision: 1, history: [] }));
  await budget(t, 'initial write of 500 captures (components + index)', 30000, () => service.save());
  const components = join(directory, 'components');
  const files = readdirSync(components).flatMap(prefix => readdirSync(join(components, prefix)).map(name => join(components, prefix, name)));
  const stamps = new Map(files.map(file => { const stat = statSync(file); return [file, `${stat.ino}:${stat.mtimeMs}:${stat.size}`]; }));
  assert.equal(files.length, 1000); // the replaced seed capture was garbage-collected
  const componentBytes = files.reduce((sum, file) => sum + statSync(file).size, 0);
  t.diagnostic(`components: ${files.length} files, ${(componentBytes / 1024 / 1024).toFixed(1)} MiB; database: ${(statSync(join(directory, 'workspace.sqlite')).size / 1024 / 1024).toFixed(1)} MiB (+WAL)`);
  await budget(t, 'note update with 500 captures', 1000, () => service.execute('materials.update', { id: 'material-heavy-1999', changes: { content: 'changed' } }));
  await budget(t, 'capture annotation with 500 captures', 1000, () => service.execute('artifacts.annotate', { id: 'capture-heavy-250', note: 'Reviewed' }));
  await budget(t, 'ranked search over 500 captures', 1000, async () => assert.equal((await service.execute('search.query', { query: 'capture 499 body', limit: 5 }))[0].id, 'capture-heavy-499'));
  for (const file of files) { const stat = statSync(file); assert.equal(`${stat.ino}:${stat.mtimeMs}:${stat.size}`, stamps.get(file), 'metadata changes must not rewrite capture components'); }
  service.close();
  service = await budget(t, 'reopen capture-heavy store', 5000, () => new WorkspaceService({ directory }));
  assert.equal((await service.execute('artifacts.get', { id: 'capture-heavy-7', versionId: 'version-heavy-7' })).text.startsWith('capture 7 body'), true);
});

test('100 catalog and OpenAPI serializations stay within budget', async t => {
  await budget(t, '100 catalog serializations', 2000, () => {
    for (let i = 0; i < 100; i++) assert.ok(JSON.stringify(commands).length > 1000);
  });
  await budget(t, '100 OpenAPI generations', 3000, () => {
    for (let i = 0; i < 100; i++) {
      const document = createOpenApiDocument();
      assert.ok(JSON.stringify(document).length > 1000);
      assert.ok(document.components.schemas['tabs.list']);
    }
  });
});

test('exact cosine search at the 20k-vector per-workspace limit', async t => {
  const { DatabaseSync } = await import('../src/sqlite.js');
  const { VectorIndex, MAX_VECTORS_PER_WORKSPACE, normalize } = await import('../src/vector-index.js');
  const db = new DatabaseSync(':memory:');
  db.exec('CREATE TABLE store_info(key TEXT PRIMARY KEY, value TEXT NOT NULL); CREATE TABLE search_docs(rowid INTEGER PRIMARY KEY, collection TEXT, record_id TEXT, version_id TEXT, workspace_id TEXT, local_only INTEGER)');
  const index = new VectorIndex(db);
  index.ensure(key => db.prepare('SELECT value FROM store_info WHERE key = ?').get(key)?.value, (key, value) => db.prepare('INSERT OR REPLACE INTO store_info VALUES (?, ?)').run(key, value));
  const dims = 768;
  const vector = () => normalize(Array.from({ length: dims }, () => Math.random() - 0.5));
  db.exec('BEGIN');
  for (let i = 0; i < MAX_VECTORS_PER_WORKSPACE / 4; i++) index.replace('materials', `mate-${i}`, 'ws_perf', Array.from({ length: 4 }, (_, chunk) => ({ versionId: '', chunk, start: 0, end: 0, sha256: 'x', modelKey: 'model', vector: vector() })));
  db.exec('COMMIT');
  const query = vector();
  await budget(t, `first search over ${MAX_VECTORS_PER_WORKSPACE} x ${dims} vectors (loads matrix)`, 5000, () => index.search('ws_perf', 'model', query, { minSimilarity: 0 }));
  const results = await budget(t, `cached search over ${MAX_VECTORS_PER_WORKSPACE} x ${dims} vectors`, 1500, () => index.search('ws_perf', 'model', query, { minSimilarity: 0 }));
  assert.equal(results.length, 100);
  db.close();
});
