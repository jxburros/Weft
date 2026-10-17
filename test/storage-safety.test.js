import test from 'node:test';
import assert from 'node:assert/strict';
import fs, { mkdtempSync, readFileSync, writeFileSync, readdirSync, rmSync, statSync, utimesSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WorkspaceService } from '../src/workspace.js';
import { fileStamp, writeVerifiedJson, storageWarnings } from '../src/storage-safety.js';
import { inspectExportResidue } from '../src/export-safety.js';
import { migrateSchema, CURRENT_SCHEMA_VERSION } from '../src/migrations.js';
import { DatabaseSync } from '../src/sqlite.js';
import { ComponentStore } from '../src/components.js';

function fixture(t, options = {}) {
  const directory = mkdtempSync(join(tmpdir(), 'weft-storage-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const service = new WorkspaceService({ directory, ...options });
  t.after(() => service.close());
  return { directory, service, path: join(directory, 'workspace.sqlite') };
}
// Simulates a writer that ignores the profile lock (another tool or a stale process).
function externalWrite(path) {
  const db = new DatabaseSync(path);
  db.prepare("UPDATE state_meta SET value = json_set(value, '$.theme', 'dark') WHERE key = 'settings'").run();
  db.close();
}
const externalTheme = path => { const db = new DatabaseSync(path, { readOnly: true }); try { return JSON.parse(db.prepare("SELECT value FROM state_meta WHERE key = 'settings'").get().value).theme; } finally { db.close(); } };
const count = (path, collection) => { const db = new DatabaseSync(path, { readOnly: true }); try { return db.prepare('SELECT count(*) AS count FROM records WHERE collection = ?').get(collection).count; } finally { db.close(); } };

test('another process cannot open a profile; explicit close releases its lock', { timeout: 10000 }, t => {
  const { directory, service } = fixture(t);
  const code = `import { WorkspaceService } from ${JSON.stringify(new URL('../src/workspace.js', import.meta.url).href)}; const s = new WorkspaceService({directory:process.argv[1]}); s.close();`;
  const second = spawnSync(process.execPath, ['--input-type=module', '-e', code, directory], { encoding: 'utf8', timeout: 5000 });
  assert.equal(second.status, 1);
  assert.match(second.stderr, /STORE_LOCKED/);
  service.close();
  const reopened = spawnSync(process.execPath, ['--input-type=module', '-e', code, directory], { encoding: 'utf8', timeout: 5000 });
  assert.equal(reopened.status, 0, reopened.stderr);
  assert.equal(readdirSync(directory).includes('.workspace.lock'), false);
});

test('external database writes are detected and never overwritten', async t => {
  const { service, path } = fixture(t);
  externalWrite(path);
  await assert.rejects(service.execute('materials.create', { title: 'Must not write' }), /STORE_CONFLICT/);
  assert.equal(externalTheme(path), 'dark');
  assert.equal(count(path, 'materials'), 0);
  assert.deepEqual(service.snapshot().materials, []);
  // The conflict persists until restart: later writes still refuse.
  await assert.rejects(service.execute('materials.create', { title: 'Still refused' }), /STORE_CONFLICT/);
});

test('a replaced database file is detected before writing', async t => {
  const { service, path, directory } = fixture(t);
  const other = mkdtempSync(join(tmpdir(), 'weft-other-'));
  t.after(() => rmSync(other, { recursive: true, force: true }));
  fs.copyFileSync(path, join(other, 'copy.sqlite'));
  fs.renameSync(join(other, 'copy.sqlite'), path);
  await assert.rejects(service.execute('materials.create', { title: 'Must not write' }), /STORE_CONFLICT/);
  assert.equal(readdirSync(directory).includes('workspace.sqlite'), true);
});

test('history and session write conflicts restore in-memory state', async t => {
  const { service, path } = fixture(t);
  service.recordVisit({ workspaceId: service.activeWorkspaceId, url: 'https://example.com/', title: 'Existing', tabId: 1 });
  const before = service.snapshot();
  externalWrite(path);
  assert.throws(() => service.recordVisit({ workspaceId: service.activeWorkspaceId, url: 'https://different.test/', title: 'New', tabId: 1 }), /STORE_CONFLICT/);
  await assert.rejects(service.execute('history.clear'), /STORE_CONFLICT/);
  assert.throws(() => service.persistSession({ tabs: [], activeId: 7 }), /STORE_CONFLICT/);
  assert.deepEqual(service.snapshot(), before);
});

test('same-process readers cannot overwrite each other and lost locks block writes', async t => {
  const { service, directory, path } = fixture(t);
  const other = new WorkspaceService({ directory }); t.after(() => other.close());
  await service.execute('materials.create', { title: 'First writer' });
  await assert.rejects(other.execute('materials.create', { title: 'Stale writer' }), /STORE_CONFLICT/);
  writeFileSync(join(directory, '.workspace.lock'), 'replacement lock');
  await assert.rejects(service.execute('materials.create', { title: 'Lost lock' }), /STORE_LOCKED/);
  service.close(); other.close();
  assert.equal(readFileSync(join(directory, '.workspace.lock'), 'utf8'), 'replacement lock');
  assert.equal(count(path, 'materials'), 1);
});

test('temporary-byte verification refuses replacement and cleans failed temporary files', t => {
  const { directory } = fixture(t);
  const path = join(directory, 'client-grants.json');
  writeFileSync(path, '{"original":true}');
  const original = readFileSync(path, 'utf8');
  const stamp = fileStamp(path);
  const components = new ComponentStore(join(directory, 'components'));
  const write = fs.writeFileSync;
  fs.writeFileSync = (target, value, options) => write(target, String(target).endsWith('.tmp') ? '{"wrong":true}' : value, options);
  syncBuiltinESMExports();
  try {
    assert.throws(() => writeVerifiedJson(path, '{"expected":true}', stamp), /STORE_VERIFY_FAILED/);
    assert.throws(() => components.put(Buffer.from('component bytes')), /STORE_VERIFY_FAILED/);
  } finally { fs.writeFileSync = write; syncBuiltinESMExports(); }
  assert.equal(readFileSync(path, 'utf8'), original);
  assert.equal(readdirSync(directory).some(name => name.endsWith('.tmp')), false);
  assert.deepEqual(components.list(), { hashes: [], temporary: [] });
});

test('historical schemas migrate deterministically, retain unknown fields and preserve original bytes', t => {
  for (const version of [1, 2]) {
    const original = readFileSync(new URL(`./fixtures/schema-v${version}/workspace-state.json`, import.meta.url), 'utf8');
    const raw = JSON.parse(original);
    const migrated = migrateSchema(raw);
    assert.equal(raw.schemaVersion, version);
    assert.equal(migrated.schemaVersion, CURRENT_SCHEMA_VERSION);
    assert.deepEqual(migrateSchema(migrated), migrated);
    const directory = mkdtempSync(join(tmpdir(), 'weft-legacy-'));
    t.after(() => rmSync(directory, { recursive: true, force: true }));
    writeFileSync(join(directory, 'workspace-state.json'), original);
    const opened = new WorkspaceService({ directory }); t.after(() => opened.close());
    assert.equal(opened.data.extensionMetadata.preserved, 'unknown fields must survive');
    assert.deepEqual(opened.data.history, []);
    assert.equal(readdirSync(directory).includes('workspace-state.json'), false);
    const preserved = readdirSync(join(directory, 'recovery')).filter(name => name.startsWith('workspace-state.'));
    assert.equal(preserved.length, 1);
    assert.equal(readFileSync(join(directory, 'recovery', preserved[0]), 'utf8'), original);
  }
});

test('newer schemas and invalid workspace ownership fail without writes or backups', t => {
  const { service } = fixture(t);
  const invalid = service.snapshot();
  delete invalid.storageWarnings;
  invalid.materials.push({ id: 'orphan', workspaceId: 'missing', title: 'Orphan' });
  for (const state of [{ schemaVersion: 999 }, invalid]) {
    const directory = mkdtempSync(join(tmpdir(), 'weft-invalid-'));
    t.after(() => rmSync(directory, { recursive: true, force: true }));
    const original = JSON.stringify(state); writeFileSync(join(directory, 'workspace-state.json'), original);
    assert.throws(() => new WorkspaceService({ directory }), /Unsupported|reference/);
    assert.equal(readFileSync(join(directory, 'workspace-state.json'), 'utf8'), original);
    assert.deepEqual(readdirSync(directory), ['workspace-state.json']);
  }
});

test('historical export chain works and invalid imported relationships roll back', async t => {
  const { service } = fixture(t);
  for (const version of [1, 2]) {
    const input = readFileSync(new URL(`./fixtures/schema-v${version}/workspace-export.json`, import.meta.url), 'utf8');
    const imported = await service.execute('workspaces.import', { data: input });
    assert.equal(imported.name, 'Historical workspace');
  }
  const exported = service.exportWorkspace(service.activeWorkspaceId);
  exported.tasks.push({ id: 'broken-task', title: 'Broken relation', materialIds: ['missing'] });
  const before = service.snapshot();
  await assert.rejects(service.execute('workspaces.import', { data: exported }), /record reference/);
  assert.deepEqual(service.snapshot(), before);
});

test('secret fields are rejected recursively before importing, storing or accepting workflow names', async t => {
  const { service } = fixture(t);
  const before = service.storage.contentDigest();
  await assert.rejects(service.execute('workflows.create', { title: 'Unsafe', parameters: ['api_key'] }), /SECRET_FIELD/);
  await assert.rejects(service.execute('tasks.create', { title: 'Unsafe', ignored: { deeply: [{ clientSecret: 'do-not-log' }] } }), /SECRET_FIELD/);
  const exported = service.exportWorkspace(service.activeWorkspaceId);
  exported.ignored = { access_token: 'do-not-log' };
  await assert.rejects(service.execute('workspaces.import', { data: JSON.stringify(exported) }), error => error.code === 'SECRET_FIELD' && !error.message.includes('do-not-log'));
  service.data.extensionMetadata = { private_key: 'do-not-log' };
  assert.throws(() => service.save(), /SECRET_FIELD/);
  assert.equal(service.storage.contentDigest(), before);
});

test('residue scanning inspects escaped JSON, notes, capture text and decoded text files', async t => {
  const { service } = fixture(t);
  await service.execute('materials.create', { title: 'Stored file', kind: 'file', filename: 'note.txt', mimeType: 'text/plain', fileBase64: Buffer.from('private address').toString('base64') });
  await service.execute('artifacts.create', { title: 'Capture', text: 'private\nquote' });
  const result = await service.execute('workspaces.export', { id: service.activeWorkspaceId, sensitiveTerms: ['private address', 'private\nquote'] });
  assert.equal(result.residueScan.status, 'found');
  assert.equal(result.residueScan.found.length, 2);
  assert.equal(JSON.stringify(result.residueScan).includes('private address'), false);
  assert.equal(inspectExportResidue('{"text":"\\u0073ecret"}', ['secret']).status, 'found');
  assert.equal(inspectExportResidue('{"text":"ordinary"}', ['secret']).status, 'clean');
  assert.equal(inspectExportResidue('broken', ['secret']).status, 'unverifiable');
});

test('images and unsupported binary files cannot produce a clean residue result', async t => {
  const { service } = fixture(t);
  await service.execute('artifacts.create', { title: 'Image', pngBase64: Buffer.from([137,80,78,71,13,10,26,10]).toString('base64') });
  const result = await service.execute('workspaces.export', { id: service.activeWorkspaceId, sensitiveTerms: ['private'] });
  assert.equal(result.residueScan.status, 'unverifiable');
  assert.equal(result.residueScan.unverifiable.length, 1);
  assert.equal(inspectExportResidue(JSON.stringify({ fileBase64: 'c2VjcmV0', mimeType: 'application/pdf' }), ['secret']).status, 'unverifiable');
});

test('local-only metadata and turn manifests persist for provider routing', async t => {
  const { service, directory } = fixture(t);
  await service.execute('materials.create', { title: 'Confidential', localOnly: true });
  assert.equal((await service.execute('search.query', { query: 'Confidential' }))[0].localOnly, true);
  const conversation = await service.execute('conversations.create', {});
  await service.appendMessage(conversation.id, { role: 'user', content: 'Local evidence', localOnly: true });
  await service.recordTurnManifest(conversation.id, { id: 'turn1', status: 'pending', requests: [] });
  await service.recordTurnManifest(conversation.id, { id: 'turn1', status: 'complete', requests: [{ bytes: 123 }] });
  const reopened = new WorkspaceService({ directory }); t.after(() => reopened.close());
  const stored = reopened.getConversation(conversation.id);
  assert.equal(stored.messages[0].localOnly, true);
  assert.deepEqual(stored.turnManifests, [{ id: 'turn1', status: 'complete', requests: [{ bytes: 123 }] }]);
});

test('sync locations, copy and placeholder warnings surface without changing copies', t => {
  assert.equal(storageWarnings('/home/me/OneDrive - Company/profile', {}).some(item => item.code === 'SYNC_FOLDER'), true);
  assert.equal(storageWarnings('/home/me/Dropbox/profile', {}).some(item => item.code === 'SYNC_FOLDER'), true);
  assert.equal(storageWarnings('/Users/me/Library/CloudStorage/OneDrive-Personal/profile', {}).some(item => item.code === 'SYNC_FOLDER'), true);
  assert.equal(storageWarnings('/Users/me/Library/CloudStorage/GoogleDrive-me@example.com/profile', {}).some(item => item.code === 'SYNC_FOLDER'), true);
  assert.equal(storageWarnings('/home/me/local', { OneDrive: '/home/me/local' }).some(item => item.code === 'SYNC_FOLDER'), true);
  assert.deepEqual(storageWarnings('/home/me/NotDropbox/profile', {}), []);
  const warnings = [];
  const { service, directory } = fixture(t, { onWarning: warning => warnings.push(warning) });
  const conflict = join(directory, 'workspace-state (conflicted copy).json');
  writeFileSync(conflict, 'keep these original bytes');
  writeFileSync(join(directory, 'workspace-state.json.icloud'), 'placeholder');
  writeFileSync(join(directory, 'workspace-state-MY-LAPTOP.json'), 'device copy');
  writeFileSync(join(directory, 'workspace (conflicted copy).sqlite'), 'database copy');
  writeFileSync(join(directory, 'workspace.sqlite.icloud'), 'placeholder');
  assert.deepEqual(service.snapshot().storageWarnings.map(item => item.code).sort(), ['SYNC_CONFLICT_COPY', 'SYNC_CONFLICT_COPY', 'SYNC_CONFLICT_COPY', 'SYNC_PLACEHOLDER', 'SYNC_PLACEHOLDER']);
  service.save();
  assert.equal(readFileSync(conflict, 'utf8'), 'keep these original bytes');
  assert.equal(warnings.length, 5);
});

test('a conflicted copy without a canonical file blocks silent creation', t => {
  const directory = mkdtempSync(join(tmpdir(), 'weft-conflict-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  writeFileSync(join(directory, 'workspace-state (conflicted copy).json'), 'preserved');
  assert.throws(() => new WorkspaceService({ directory, onWarning() {} }), /STORE_CONFLICT/);
  assert.deepEqual(readdirSync(directory), ['workspace-state (conflicted copy).json']);
});
