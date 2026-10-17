import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { WorkspaceService } from '../src/workspace.js';
import { DatabaseSync } from '../src/sqlite.js';
import { tempDirectory, beforeRemoval } from './temp-profile.js';
import { budget } from './time-budget.js';

/*
 * A search-index version change drops the old index while opening with secure_delete=FAST, so opening stays fast.
 * The freed pages still hold old index text until they are scrubbed. These cases reset the index FIRST and remove
 * content AFTER, then check that no removed text survives in the database or WAL bytes.
 */
const human = { actor: 'human', source: 'gui' };
const marker = 'codexuniqueprivacymarker';

function staleIndex(directory) {
  const db = new DatabaseSync(join(directory, 'workspace.sqlite'));
  try { db.prepare("UPDATE store_info SET value = '1' WHERE key = 'searchIndexVersion'").run(); } finally { db.close(); }
}
function assertGoneFromDisk(directory, what) {
  for (const file of readdirSync(directory).filter(name => /^workspace\.sqlite(?:-wal)?$/.test(name))) {
    assert.equal(readFileSync(join(directory, file)).includes(Buffer.from(marker)), false, `${what} text remains in ${file}`);
  }
}
/** 3,000 filler artifacts plus one sensitive artifact sorting after the bounded opening batch. */
async function seedSensitive(service) {
  const filler = await service.execute('artifacts.create', { title: 'Filler', text: 'ordinary filler content '.repeat(40) });
  const fillerDoc = structuredClone(service.data.artifacts.find(a => a.id === filler.id));
  const sensitive = await service.execute('artifacts.create', { title: 'Sensitive', text: `${marker} `.repeat(20000) });
  const sensitiveDoc = service.data.artifacts.find(a => a.id === sensitive.id);
  sensitiveDoc.id = 'zzzz-sensitive';
  // Fixture-only bulk save.
  service.data.artifacts = [...Array.from({ length: 3000 }, (_, i) => ({ ...structuredClone(fillerDoc), id: `artifact-${String(i).padStart(6, '0')}` })), sensitiveDoc];
  service.save();
  return { id: sensitiveDoc.id, versionId: sensitiveDoc.versions[0].id };
}
async function until(predicate, what, timeoutMs = 60000) {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${what}`);
    await new Promise(resolve => setTimeout(resolve, 20));
  }
}

for (const restart of [false, true]) {
  for (const action of ['setAccess', 'purgeContent']) {
    test(`index reset then ${action} removes old index bytes${restart ? ' after another restart' : ''}`, { timeout: budget(120000) }, async t => {
      const directory = tempDirectory(t, 'weft-reset-privacy-');
      let service;
      beforeRemoval(t, () => service?.close());
      service = new WorkspaceService({ directory, onWarning() {} });
      const sensitive = await seedSensitive(service);
      service.close();
      staleIndex(directory);
      service = new WorkspaceService({ directory, onWarning() {} });
      assert.ok(service.storage.indexing, 'rebuild must still be pending');
      assert.equal(service.storage.needsScrub, true, 'the drop recorded a durable scrub marker');
      await service.execute('search.indexing', { action: 'pause' }, human);
      if (restart) {
        service.close();
        service = new WorkspaceService({ directory, onWarning() {} });
        assert.ok(service.storage.indexing, 'rebuild remains pending across restart');
        assert.equal(service.storage.needsScrub, true, 'the scrub marker survives a restart');
        await service.execute('search.indexing', { action: 'pause' }, human);
      }
      await service.execute(`artifacts.${action}`, { id: sensitive.id, versionId: sensitive.versionId, ...(action === 'setAccess' ? { access: 'restricted' } : {}) }, human);
      assert.deepEqual(await service.execute('search.query', { query: marker }), []);
      assert.equal(service.storage.needsScrub, false, 'restricting or purging scrubbed the freed pages');
      assertGoneFromDisk(directory, action === 'setAccess' ? 'restricted' : 'purged');
    });
  }
}

test('index reset then an ordinary delete leaves no text once the background rebuild and scrub finish', { timeout: budget(120000) }, async t => {
  const directory = tempDirectory(t, 'weft-reset-privacy-');
  let service;
  beforeRemoval(t, () => service?.close());
  service = new WorkspaceService({ directory, onWarning() {} });
  const sensitive = await seedSensitive(service);
  service.close();
  staleIndex(directory);
  service = new WorkspaceService({ directory, onWarning() {} });
  assert.ok(service.storage.indexing, 'rebuild must still be pending');
  await service.execute('artifacts.delete', { id: sensitive.id }, human);
  await service.indexingIdle();
  await until(() => !service.storage.needsScrub, 'the background scrub');
  assertGoneFromDisk(directory, 'deleted');
});

test('the scrub marker is durable: an interrupted session scrubs at the next open, never during open', { timeout: budget(120000) }, async t => {
  const directory = tempDirectory(t, 'weft-reset-privacy-');
  let service;
  beforeRemoval(t, () => service?.close());
  service = new WorkspaceService({ directory, onWarning() {} });
  await seedSensitive(service);
  service.close();
  staleIndex(directory);
  service = new WorkspaceService({ directory, onWarning() {} });
  assert.equal(service.storage.needsScrub, true);
  // Closed before the rebuild and scrub could run, as a crash would.
  service.close();
  service = new WorkspaceService({ directory, onWarning() {} });
  assert.equal(service.storage.needsScrub, true, 'opening never scrubs synchronously');
  await service.indexingIdle();
  await until(() => !service.storage.needsScrub, 'the background scrub');
  assert.equal(service.storage.indexing, null);
  assert.deepEqual((await service.execute('search.query', { query: marker })).map(item => item.id), ['zzzz-sensitive'], 'live content stays searchable');
});
