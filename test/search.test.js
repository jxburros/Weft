import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WorkspaceService } from '../src/workspace.js';
import { compileQuery } from '../src/search-index.js';
import { DatabaseSync } from '../src/sqlite.js';

function fixture(t) {
  const directory = mkdtempSync(join(tmpdir(), 'weft-search-'));
  const service = new WorkspaceService({ directory, onWarning() {} });
  t.after(() => { service.close(); rmSync(directory, { recursive: true, force: true }); });
  return { directory, service };
}
const ids = results => results.map(result => result.title);

// Golden corpus: expected orderings are part of the contract and fail loudly on ranking regressions.
async function corpus(service) {
  const records = {};
  records.titleHit = await service.execute('materials.create', { title: 'Solar panel efficiency', content: 'Notes on photovoltaic output.' });
  records.bodyHit = await service.execute('context.create', { title: 'Grid storage', content: 'Battery storage pairs with solar generation; panel degradation matters.' });
  records.partial = await service.execute('tasks.create', { title: 'Wind survey', objective: 'Compare wind against solar capacity factors.' });
  records.stem = await service.execute('materials.create', { title: 'Runbook', content: 'The pump is running continuously after the runs completed.' });
  records.capture = await service.execute('artifacts.create', { title: 'Agency report', text: 'Installed solar panel capacity grew 24 percent. Efficiency of panels improved.', url: 'https://example.com/report' });
  records.capture2 = await service.execute('artifacts.create', { artifactId: records.capture.id, title: 'Agency report', text: 'Revised: offshore wind leads new capacity.' });
  records.workflow = await service.execute('workflows.create', { title: 'Source checklist', steps: [{ title: 'Verify citations', instruction: 'Open each citation and confirm the quoted figure.' }] });
  records.rule = await service.execute('siteRules.create', { hostname: 'tracker.example', reason: 'Avoid advertising trackers' });
  return records;
}

test('golden queries: title outranks body, all terms outrank partial matches, stemming and phrases', async t => {
  const { service } = fixture(t);
  const records = await corpus(service);
  const solarPanel = await service.execute('search.query', { query: 'solar panel' });
  assert.deepEqual(ids(solarPanel), ['Solar panel efficiency', 'Agency report', 'Grid storage', 'Wind survey']);
  assert.deepEqual(solarPanel.map(item => item.match), ['all', 'all', 'all', 'partial']);
  assert.ok(solarPanel[0].score > solarPanel[2].score);
  // Prefix matching covers inflections and partially typed words; diacritics are folded.
  assert.deepEqual(ids(await service.execute('search.query', { query: 'run' })), ['Runbook']);
  assert.deepEqual(ids(await service.execute('search.query', { query: 'efficien' })), ['Solar panel efficiency', 'Agency report']);
  assert.deepEqual(ids(await service.execute('search.query', { query: 'phötovoltaic' })), ['Solar panel efficiency']);
  // A hyphenated chunk is a phrase: adjacent tokens only.
  assert.deepEqual(ids(await service.execute('search.query', { query: 'offshore-wind' })), ['Agency report']);
  assert.deepEqual(ids(await service.execute('search.query', { query: 'wind-offshore' })), []);
  assert.deepEqual(ids(await service.execute('search.query', { query: 'quoted figure' })), ['Source checklist']);
  assert.deepEqual(ids(await service.execute('search.query', { query: 'advertising' })), ['tracker.example']);
  assert.ok(records.workflow && records.rule);
});

test('results cite exact capture versions and record revisions', async t => {
  const { service } = fixture(t);
  const records = await corpus(service);
  const [first] = await service.execute('search.query', { query: 'installed capacity' });
  assert.equal(first.type, 'artifacts');
  assert.equal(first.versionId, records.capture.versions[0].id);
  assert.equal(first.versionNumber, 1);
  assert.deepEqual(first.citation, { recordType: 'artifacts', recordId: records.capture.id, revision: first.revision, versionId: records.capture.versions[0].id, versionNumber: 1 });
  assert.match(first.content, /Installed solar panel capacity/);
  const [second] = await service.execute('search.query', { query: 'offshore' });
  assert.equal(second.versionNumber, 2);
  const exact = await service.execute('artifacts.get', { id: second.citation.recordId, versionId: second.citation.versionId });
  assert.match(exact.text, /offshore wind/);
  const [note] = await service.execute('search.query', { query: 'photovoltaic' });
  assert.deepEqual(note.citation, { recordType: 'materials', recordId: records.titleHit.id, revision: 1, versionId: null, versionNumber: null });
});

test('the index follows creates, updates and deletes, and is scoped to the workspace in SQL', async t => {
  const { service } = fixture(t);
  const note = await service.execute('materials.create', { title: 'Draft', content: 'alpha content', localOnly: true });
  assert.equal((await service.execute('search.query', { query: 'alpha' }))[0].localOnly, true);
  await service.execute('materials.update', { id: note.id, changes: { content: 'beta content' } });
  assert.deepEqual(await service.execute('search.query', { query: 'alpha' }), []);
  assert.equal((await service.execute('search.query', { query: 'beta' }))[0].revision, 2);
  const artifact = await service.execute('artifacts.create', { title: 'Capture', text: 'gamma text' });
  await service.execute('artifacts.annotate', { id: artifact.id, note: 'delta annotation' });
  assert.equal((await service.execute('search.query', { query: 'delta' }))[0].id, artifact.id);
  await service.execute('artifacts.delete', { id: artifact.id });
  await service.execute('materials.delete', { id: note.id });
  assert.deepEqual(await service.execute('search.query', { query: 'gamma OR beta OR delta' }), []);
  // Another workspace's matches never appear, even when they would fill the limit.
  const first = service.activeWorkspaceId;
  const other = await service.execute('workspaces.create', { name: 'Other' });
  for (let i = 0; i < 30; i++) await service.execute('materials.create', { title: `Shared term ${i}`, workspaceId: other.id });
  await service.execute('materials.create', { title: 'Shared term mine', workspaceId: first });
  const scoped = await service.execute('search.query', { query: 'shared term', workspaceId: first, limit: 5 });
  assert.deepEqual(ids(scoped), ['Shared term mine']);
  await assert.rejects(service.execute('search.query', { query: 'shared' }, { actor: 'agent', workspaceId: first, }).then(() => service.execute('search.query', { query: 'shared', workspaceId: other.id }, { actor: 'agent', workspaceId: first })), /PERMISSION_REQUIRED/);
  await service.execute('workspaces.delete', { id: other.id });
  const db = new DatabaseSync(service.path, { readOnly: true });
  assert.equal(db.prepare('SELECT count(*) AS count FROM search_docs WHERE workspace_id = ?').get(other.id).count, 0);
  db.close();
});

test('user text cannot inject FTS5 syntax', async t => {
  const { service } = fixture(t);
  await service.execute('materials.create', { title: 'Secret plan', content: 'Do not reveal' });
  await service.execute('materials.create', { title: 'Public notes', content: 'title colon text NEAR here' });
  for (const query of ['title:secret', '"unbalanced', 'secret OR', 'NEAR(secret plan)', '*', '-secret', '^secret', 'secret AND NOT plan', '(((', "'; DROP TABLE records; --", '\u0000secret', 'col:*']) {
    const results = await service.execute('search.query', { query });
    assert.ok(Array.isArray(results), query);
  }
  // Column filters are literal tokens, not a way to search only titles.
  assert.deepEqual(ids(await service.execute('search.query', { query: 'title: secret' })), ['Secret plan', 'Public notes']);
  assert.deepEqual(await service.execute('search.query', { query: 'title:secret' }), []);
  assert.deepEqual(await service.execute('search.query', { query: '*' }), []);
  assert.equal(compileQuery('a"b OR c').all, '"a b"* AND "or"* AND "c"*');
  assert.equal(compileQuery('***'), null);
  assert.equal((await service.execute('materials.list')).length, 2);
});

test('the index rebuilds when its version changes and survives restart', async t => {
  const { service, directory } = fixture(t);
  await service.execute('artifacts.create', { title: 'Capture', text: 'persistent needle' });
  service.close();
  const db = new DatabaseSync(join(directory, 'workspace.sqlite'));
  db.prepare("UPDATE store_info SET value = '0' WHERE key = 'searchIndexVersion'").run();
  db.exec('DELETE FROM search_fts; DELETE FROM search_docs;');
  db.close();
  const reopened = new WorkspaceService({ directory, onWarning() {} });
  t.after(() => reopened.close());
  assert.equal((await reopened.execute('search.query', { query: 'needle' }))[0].title, 'Capture');
});
