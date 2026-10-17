import test from 'node:test';
import assert from 'node:assert/strict';
import { performance } from 'node:perf_hooks';
import { mkdtempSync, rmSync } from 'node:fs';
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
  service.data.artifacts = Array.from({ length: 1000 }, (_, i) => ({ ...structuredClone(capture), id: `capture-perf-${i}`, versions: [{ ...service.data.artifacts[0].versions[0], id: `version-perf-${i}` }] }));
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
