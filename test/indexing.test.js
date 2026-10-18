import test from 'node:test';
import assert from 'node:assert/strict';
import { performance } from 'node:perf_hooks';
import { mkdtempSync, readFileSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WorkspaceService } from '../src/workspace.js';
import { DatabaseSync } from '../src/sqlite.js';
import { createKeyProtector } from '../src/encryption.js';
import { executeOutcome } from '../src/commands.js';
import { fakeSafeStorage, kdfParams } from './encryption-helpers.js';
import { closeAfter, closeQuietly, removeAfter } from './temp-profile.js';
import { budget } from './time-budget.js';

/*
 * Deferred search indexing (#30): a search-index rebuild (FTS version change, or an encrypted
 * profile's in-memory index after unlock) runs as bounded background batches. Opening and command
 * handling never wait for it; searches during the rebuild are partial and say how much is missing.
 */
const human = { actor: 'human', source: 'gui' };
const agent = { actor: 'automation', source: 'api' };
// Three times the 2,000-record batch run at open, so the rebuild is still pending afterwards; small enough for slow CI disks.
const RECORDS = 6000;

function profile(t) {
  const directory = mkdtempSync(join(tmpdir(), 'weft-indexing-'));
  removeAfter(t, directory);
  return directory;
}
async function seed(service, count = RECORDS) {
  const note = await service.execute('materials.create', { title: 'Seed', content: 'seed' });
  // Fixture construction: one commit of many records with real searchable text.
  service.data.materials = Array.from({ length: count }, (_, i) => ({ ...structuredClone(note), id: `material-index-${String(i).padStart(5, '0')}`, title: `Note ${i}`,
    content: `indexing needle ${i} ${'background rebuild filler text '.repeat(25)}` }));
  service.save();
}
/** Mark the on-disk index as an older version, as an upgrade that changes the index format would. */
function staleIndex(directory) {
  const db = new DatabaseSync(join(directory, 'workspace.sqlite'));
  try { db.prepare("UPDATE store_info SET value = '1' WHERE key = 'searchIndexVersion'").run(); } finally { db.close(); }
}

test('a search-index version change rebuilds in the background: open is fast, searches are partial with coverage, commands proceed', { timeout: budget(120000) }, async t => {
  const directory = profile(t);
  let service = new WorkspaceService({ directory, onWarning() {} });
  await seed(service);
  service.close();

  // Reference: opening with a current index, and how long a synchronous rebuild of this store takes.
  const clean = performance.now();
  service = new WorkspaceService({ directory, onWarning() {} });
  const openCleanMs = performance.now() - clean;
  assert.equal(service.storage.indexing, null);
  service.close();
  staleIndex(directory);
  const pendingStart = performance.now();
  service = new WorkspaceService({ directory, onWarning() {} });
  const openPendingMs = performance.now() - pendingStart;
  assert.ok(service.storage.indexing, 'the rebuild is still pending after open');
  // Opening may not write in proportion to the old index (zeroing every freed page made opening take seconds on Windows).
  const walBytes = (() => { try { return statSync(join(directory, 'workspace.sqlite-wal')).size; } catch (error) { if (error.code === 'ENOENT') return 0; throw error; } })();
  assert.ok(walBytes < 2 * 1024 * 1024, `opening with a stale index wrote ${walBytes} WAL bytes`);
  const syncStart = performance.now();
  service.storage.finishIndexing();
  const rebuildMs = performance.now() - syncStart;
  service.close();
  t.diagnostic(`open with current index: ${openCleanMs.toFixed(0)} ms; open with pending rebuild: ${openPendingMs.toFixed(0)} ms; synchronous rebuild of ${RECORDS} records: ${rebuildMs.toFixed(0)} ms`);
  assert.ok(openPendingMs - openCleanMs < rebuildMs * 0.75, 'opening runs at most one short batch of the rebuild');

  staleIndex(directory);
  const events = [];
  service = new WorkspaceService({ directory, onWarning() {} });
  service.onIndexingEvent = event => events.push(event);
  closeAfter(t, service, closeQuietly);
  const status = await service.execute('search.status', {}, human);
  assert.equal(status.lexical.complete, false);
  assert.equal(status.lexical.indexing.state, 'running');
  assert.equal(status.lexical.indexing.reason, 'version_change');
  assert.equal(status.lexical.indexing.totalRecords, RECORDS + 2, 'every record (and the workspace) is rebuilt');
  assert.ok(status.lexical.indexing.processedRecords < RECORDS);
  assert.ok(status.lexical.unindexedRecords > 0);

  // Searching does not wait: the page is partial, says why, and an absence is not verified.
  const page = await service.execute('search.query', { query: 'needle', page: { limit: 5 } }, human);
  assert.equal(page.partial, true);
  assert.equal(page.coverage.lexical.complete, false);
  const missing = await service.execute('search.query', { query: 'zzqqxx-not-present', page: { limit: 5 } }, human);
  assert.equal(missing.absence.verified, false);
  assert.match(missing.absence.reason, /still being rebuilt/);
  // Unpaged results stay a list; the outcome is partial and carries the coverage.
  const outcome = await executeOutcome((command, args) => service.execute(command, args, human), 'search.query', { query: 'needle', limit: 3 });
  assert.equal(outcome.status, 'partial');
  assert.equal(outcome.coverage.lexical.complete, false);
  assert.ok(Array.isArray(outcome.result));

  // Commands proceed during the rebuild, and new writes are searchable at once.
  const commandStart = performance.now();
  const fresh = await service.execute('materials.create', { title: 'Fresh', content: 'freshly-written-term' }, human);
  t.diagnostic(`write during rebuild: ${(performance.now() - commandStart).toFixed(0)} ms`);
  assert.equal((await service.execute('search.query', { query: 'freshly-written-term' }, human))[0].id, fresh.id);

  // Pausing is human-only; a paused rebuild stays partial until resumed.
  await assert.rejects(service.execute('search.indexing', { action: 'pause' }, agent), /human administration/);
  const paused = await service.execute('search.indexing', { action: 'pause' }, human);
  assert.equal(paused.indexing.state, 'paused');
  const before = service.storage.indexing.done;
  await new Promise(resolve => setTimeout(resolve, 50));
  assert.equal(service.storage.indexing.done, before, 'nothing is indexed while paused');
  await service.execute('search.indexing', { action: 'resume' }, human);

  const done = await service.indexingIdle();
  assert.equal(done.state, 'idle');
  assert.equal(done.last.reason, 'version_change');
  const complete = await service.execute('search.query', { query: 'needle', page: { limit: 5 } }, human);
  assert.equal(complete.partial, undefined);
  assert.equal(complete.coverage.lexical.complete, true);
  assert.equal(complete.total, RECORDS);
  const last = RECORDS - 1;
  assert.equal((await service.execute('search.query', { query: `needle ${last}` }, human))[0].id, `material-index-${String(last).padStart(5, '0')}`);
  const statuses = events.map(event => event.status);
  assert.ok(statuses.includes('paused') && statuses.includes('resumed') && statuses.at(-1) === 'completed', statuses.join());
  assert.ok(events.every(event => event.type === 'indexing' && Number.isSafeInteger(event.processed) && Number.isSafeInteger(event.total)));
});

test('an interrupted plaintext rebuild resumes from its saved position after a restart', { timeout: budget(60000) }, async t => {
  const directory = profile(t);
  let service = new WorkspaceService({ directory, onWarning() {} });
  await seed(service, 6000);
  service.close();
  staleIndex(directory);
  service = new WorkspaceService({ directory, onWarning() {} });
  await service.execute('search.indexing', { action: 'pause' }, human);
  service.storage.indexStep({ maxRecords: 2000, budgetMs: Infinity });
  const reached = service.storage.indexing.done;
  assert.ok(reached > 0 && reached < 6002);
  service.close();
  service = new WorkspaceService({ directory, onWarning() {} });
  closeAfter(t, service);
  const status = service.storage.indexingStatus();
  assert.equal(status.resumed, true);
  assert.ok(status.processedRecords >= reached, 'records indexed before the restart are not indexed again');
  await service.indexingIdle();
  assert.equal((await service.execute('search.query', { query: 'needle', page: { limit: 1 } }, human)).total, 6000);
});

test('an encrypted profile rebuilds its in-memory index in the background after unlock', { timeout: budget(120000) }, async t => {
  const directory = profile(t);
  const keyProtector = createKeyProtector({ safeStorage: fakeSafeStorage(), platform: 'linux' });
  let service = new WorkspaceService({ directory, onWarning() {}, keyProtector, encryption: { kdf: kdfParams } });
  await seed(service, RECORDS);
  await service.executeEncryption('encryption.enable', { acknowledgeKeyLoss: true, unlockMode: 'os' }, human);
  await service.indexingIdle();
  await service.executeEncryption('encryption.lock', {}, human);
  await service.executeEncryption('encryption.unlock', { method: 'os' }, human);
  closeAfter(t, service);
  const status = await service.execute('search.status', {}, human);
  assert.equal(status.lexical.complete, false, 'unlock returns before the in-memory index is complete');
  assert.equal(status.lexical.indexing.reason, 'unlock');
  assert.equal((await service.execute('search.query', { query: 'needle', page: { limit: 5 } }, human)).partial, true);
  await service.indexingIdle();
  const complete = await service.execute('search.query', { query: 'needle', page: { limit: 5 } }, human);
  assert.equal(complete.coverage.lexical.complete, true);
  assert.equal(complete.total, RECORDS);
  // Locking stops the rebuild with the store; nothing runs while locked.
  await service.executeEncryption('encryption.lock', {}, human);
  assert.equal(service.storage, null);
});

test('dropping a stale index at open keeps deleted text off disk and restores secure_delete', { timeout: budget(60000) }, async t => {
  const directory = profile(t);
  let service = new WorkspaceService({ directory, onWarning() {} });
  closeAfter(t, { close: () => closeQuietly(service) }); // closes whichever instance is current
  await seed(service, 500);
  const secret = await service.execute('materials.create', { title: 'Vendor quote', content: 'quoted price zebrafinch7741 per unit' });
  assert.equal((await service.execute('search.query', { query: 'zebrafinch7741' }, human))[0].id, secret.id);
  await service.execute('materials.delete', { id: secret.id });
  service.close();
  staleIndex(directory);
  // Open drops the stale index with secure_delete=FAST, then rebuilds; the deleted text must not reappear anywhere.
  service = new WorkspaceService({ directory, onWarning() {} });
  assert.equal(Number(service.storage.db.prepare('PRAGMA secure_delete').get().secure_delete), 1, 'secure_delete is ON again after the drop');
  service.storage.finishIndexing();
  assert.deepEqual(await service.execute('search.query', { query: 'zebrafinch7741' }, human), []);
  service.close();
  for (const name of ['workspace.sqlite', 'workspace.sqlite-wal']) {
    let bytes;
    try { bytes = readFileSync(join(directory, name)); } catch (error) { if (error.code === 'ENOENT') continue; throw error; }
    assert.equal(bytes.includes('zebrafinch7741'), false, `${name} still contains deleted text`);
  }
});
