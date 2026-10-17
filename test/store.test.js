import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WorkspaceService } from '../src/workspace.js';
import { MetadataStore, storeMigrations } from '../src/store.js';
import { ComponentStore, MAX_COMPONENT_BYTES } from '../src/components.js';
import { DatabaseSync } from '../src/sqlite.js';

const sha = value => createHash('sha256').update(value).digest('hex');
const PNG = bytes => Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), Buffer.from(bytes)]).toString('base64');
function profile(t) {
  const directory = mkdtempSync(join(tmpdir(), 'weft-store-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  return directory;
}
function open(t, directory, options = {}) {
  const service = new WorkspaceService({ directory, onWarning() {}, ...options });
  t.after(() => service.close());
  return service;
}
const componentFiles = directory => {
  const root = join(directory, 'components');
  if (!existsSync(root)) return [];
  return readdirSync(root).flatMap(prefix => readdirSync(join(root, prefix)).map(name => join(root, prefix, name)));
};
// A version-1 JSON store as written by earlier Weft releases, with captures and relationships.
function legacyState() {
  const ws = 'ws_00000000-0000-4000-8000-000000000001';
  const other = 'ws_00000000-0000-4000-8000-000000000002';
  const at = '2026-01-02T03:04:05.000Z';
  const text = 'Captured <b>source</b> text';
  const png = PNG([1, 2, 3, 4]);
  const pngBytes = Buffer.from(png, 'base64');
  return {
    schemaVersion: 1, activeWorkspaceId: ws,
    workspaces: [{ id: ws, name: 'Research', description: '', color: '#7563A8', icon: 'R', archived: false, createdAt: at, updatedAt: at, revision: 3 },
      { id: other, name: 'Archive', description: '', color: '#7563A8', icon: 'A', archived: true, createdAt: at, updatedAt: at, revision: 1 }],
    materials: [{ id: 'mate_00000000-0000-4000-8000-000000000003', workspaceId: ws, title: 'Paper', localOnly: true, kind: 'file', content: '', filename: 'paper.txt', mimeType: 'text/plain', fileBase64: Buffer.from('file bytes').toString('base64'), size: 10, sha256: sha('file bytes'), tags: [], pinned: false, createdAt: at, updatedAt: at, revision: 2, history: [{ revision: 1, content: '', actor: 'human', createdAt: at }] }],
    context: [{ id: 'cont_00000000-0000-4000-8000-000000000004', workspaceId: ws, title: 'Finding', localOnly: false, content: 'See artifact_00000000-0000-4000-8000-000000000005', category: 'findings', sources: ['https://example.com/a'], tags: [], createdAt: at, updatedAt: at, revision: 1, history: [{ revision: 1, content: 'See artifact', actor: 'agent', createdAt: at }] }],
    tasks: [{ id: 'task_00000000-0000-4000-8000-000000000006', workspaceId: ws, title: 'Review', objective: '', status: 'running', assignee: 'agent', progress: 10, blocker: '', checkpoint: '', nextStep: '', evidence: ['artifact_00000000-0000-4000-8000-000000000005'], materialIds: ['mate_00000000-0000-4000-8000-000000000003'], tabIds: [3], outputs: [], createdAt: at, updatedAt: at, revision: 4 }],
    conversations: [{ id: 'conv_00000000-0000-4000-8000-000000000007', workspaceId: ws, title: 'Chat', messages: [{ id: 'msg_1', role: 'user', content: 'Hello', createdAt: at, localOnly: true }], turnManifests: [{ id: 'turn1', status: 'complete' }], createdAt: at, updatedAt: at, revision: 2 }],
    workflows: [], siteRules: [{ id: 'site_00000000-0000-4000-8000-000000000008', workspaceId: null, enabled: true, hostname: 'blocked.test', includeSubdomains: true, path: '/', behavior: 'block', mode: 'navigation', reason: 'Personal preference', note: '', scope: 'global', createdAt: at, updatedAt: at, revision: 1 }],
    artifacts: [{ id: 'artifact_00000000-0000-4000-8000-000000000005', workspaceId: ws, title: 'Source', note: '', tags: [], annotations: [], createdAt: at, updatedAt: at, revision: 3,
      versions: [{ id: 'version_1', number: 1, createdAt: at, actor: 'agent', method: 'browser-capture', url: 'https://example.com/a', title: 'Source', components: [{ type: 'text/plain', size: Buffer.byteLength(text), sha256: sha(text) }, { type: 'image/png', size: pngBytes.length, sha256: sha(pngBytes) }], text, pngBase64: png, navigationVersion: 7, limitations: [], redactionStatus: 'not-reviewed', previousVersionId: null },
        { id: 'version_2', number: 2, createdAt: at, actor: 'agent', method: 'supplied-content', url: '', title: 'Source', components: [{ type: 'text/plain', size: 6, sha256: sha('second') }], text: 'second', limitations: [], redactionStatus: 'not-reviewed', previousVersionId: 'version_1' }] }],
    activity: [{ id: 'event_1', workspaceId: ws, targetId: ws, action: 'workspaces.create', actor: 'human', detail: '', createdAt: at }],
    settings: { theme: 'dark', model: { provider: 'compatible', endpoint: 'http://localhost:11434/v1', model: '' }, sidebarCollapsed: false, agentPanelOpen: false },
    browserSession: { tabs: [{ id: 3, workspaceId: ws, url: 'https://example.com/a', title: 'Source', pinned: true, version: 9, group: '' }, { id: 4, workspaceId: other, url: 'about:blank', title: '', pinned: false, version: 1, group: '' }], activeId: 3 },
    pluginData: { kept: true },
  };
}

test('version-1 JSON stores migrate losslessly with preserved original, records, relationships, captures and browser containers', async t => {
  const directory = profile(t);
  const legacy = legacyState();
  const original = JSON.stringify(legacy, null, 2);
  writeFileSync(join(directory, 'workspace-state.json'), original);
  const service = open(t, directory);
  assert.equal(existsSync(join(directory, 'workspace-state.json')), false);
  assert.equal(readFileSync(join(directory, 'recovery', `workspace-state.${sha(original)}.json`), 'utf8'), original);
  const expected = { ...structuredClone(legacy), schemaVersion: 2, history: [], handoffs: [], sharedCollections: [], conflicts: [], freshnessPolicies: [], tabGroups: [], resumeStates: [] };
  assert.deepEqual(JSON.parse(JSON.stringify(service.storage.materialize(service.data), (key, value) => value && typeof value === 'object' && !Array.isArray(value) ? Object.fromEntries(Object.entries(value).sort()) : value)),
    JSON.parse(JSON.stringify(expected, (key, value) => value && typeof value === 'object' && !Array.isArray(value) ? Object.fromEntries(Object.entries(value).sort()) : value)));
  // Browser containers are derived from workspace IDs; tab ownership survives.
  assert.deepEqual(service.snapshot().browserSession, legacy.browserSession);
  assert.deepEqual(service.snapshot().workspaces.map(item => item.id), legacy.workspaces.map(item => item.id));
  const task = await service.execute('tasks.get', { id: legacy.tasks[0].id });
  assert.deepEqual([task.evidence, task.materialIds, task.revision], [legacy.tasks[0].evidence, legacy.tasks[0].materialIds, 4]);
  const version = await service.execute('artifacts.get', { id: legacy.artifacts[0].id, versionId: 'version_1' });
  assert.equal(version.text, legacy.artifacts[0].versions[0].text);
  assert.equal(version.pngBase64, legacy.artifacts[0].versions[0].pngBase64);
  assert.equal((await service.execute('materials.get', { id: legacy.materials[0].id })).fileBase64, legacy.materials[0].fileBase64);
  // Capture bytes now live outside the database as verified content-addressed files.
  assert.deepEqual(componentFiles(directory).map(file => file.split(/[\\/]/).pop()).sort(), [sha('file bytes'), sha(Buffer.from(legacy.artifacts[0].versions[0].pngBase64, 'base64')), sha('second'), sha(legacy.artifacts[0].versions[0].text)].sort());
  service.close();
  const reopened = open(t, directory);
  assert.equal(reopened.data.pluginData.kept, true);
  assert.equal((await reopened.execute('search.query', { query: 'captured source' }))[0].versionId, 'version_1');
});

test('interrupted migrations recover: abandoned temporary databases are discarded and a finished migration completes', async t => {
  const directory = profile(t);
  const original = JSON.stringify(legacyState());
  writeFileSync(join(directory, 'workspace-state.json'), original);
  // A crash mid-build leaves only a temporary database; the JSON original is untouched.
  writeFileSync(join(directory, `workspace.sqlite.migrating-${randomUUID()}`), 'partial');
  let service = open(t, directory);
  assert.equal(readdirSync(directory).some(name => name.includes('.migrating-')), false);
  assert.equal(service.data.materials.length, 1);
  service.close();
  // A crash after the database became canonical but before the JSON was moved.
  writeFileSync(join(directory, 'workspace-state.json'), original);
  service = open(t, directory);
  assert.equal(existsSync(join(directory, 'workspace-state.json')), false);
  assert.equal(service.data.materials.length, 1);
  service.close();
  // A different JSON beside the database is never merged or discarded.
  writeFileSync(join(directory, 'workspace-state.json'), original.replace('Research', 'Changed'));
  assert.throws(() => new WorkspaceService({ directory, onWarning() {} }), /STORE_CONFLICT/);
  assert.match(readFileSync(join(directory, 'workspace-state.json'), 'utf8'), /Changed/);
});

test('a damaged database is preserved byte-for-byte and reported, never replaced', t => {
  const directory = profile(t);
  open(t, directory).close();
  for (const suffix of ['-wal', '-shm']) rmSync(join(directory, `workspace.sqlite${suffix}`), { force: true });
  const path = join(directory, 'workspace.sqlite');
  const bytes = readFileSync(path);
  bytes.fill(0x41, 4096, 8192);
  writeFileSync(path, bytes);
  assert.throws(() => new WorkspaceService({ directory, onWarning() {} }), /STORE_CORRUPT/);
  assert.deepEqual(readFileSync(path), bytes);
  writeFileSync(path, 'not a database at all');
  assert.throws(() => new WorkspaceService({ directory, onWarning() {} }), /STORE_CORRUPT/);
  assert.equal(readFileSync(path, 'utf8'), 'not a database at all');
  assert.equal(existsSync(join(directory, '.workspace.lock')), false);
});

test('metadata changes never rewrite capture components or unrelated rows', async t => {
  const directory = profile(t);
  const service = open(t, directory);
  const artifact = await service.execute('artifacts.create', { title: 'Large capture', text: 'x'.repeat(200000), pngBase64: PNG(Buffer.alloc(50000, 7)) });
  const note = await service.execute('materials.create', { title: 'Note' });
  const files = componentFiles(directory);
  assert.equal(files.length, 2);
  const stamps = files.map(file => { const stat = statSync(file); return `${stat.ino}:${stat.mtimeMs}`; });
  const row = () => { const db = new DatabaseSync(join(directory, 'workspace.sqlite'), { readOnly: true }); try { return db.prepare("SELECT doc FROM records WHERE collection = 'artifacts'").get().doc; } finally { db.close(); } };
  const before = row();
  assert.ok(before.length < 4000, 'capture bytes must not be stored in the metadata row');
  await service.execute('materials.update', { id: note.id, changes: { content: 'edited' } });
  await service.execute('settings.update', { theme: 'dark' });
  assert.equal(row(), before);
  await service.execute('artifacts.annotate', { id: artifact.id, note: 'Reviewed' });
  assert.notEqual(row(), before);
  assert.deepEqual(componentFiles(directory).map(file => { const stat = statSync(file); return `${stat.ino}:${stat.mtimeMs}`; }), stamps);
});

test('component reads are verified and damaged components fail explicitly', async t => {
  const directory = profile(t);
  const service = open(t, directory);
  const artifact = await service.execute('artifacts.create', { title: 'Capture', text: 'original capture text' });
  const [file] = componentFiles(directory);
  writeFileSync(file, 'tampered capture text');
  await assert.rejects(service.execute('artifacts.get', { id: artifact.id }), /COMPONENT_INTEGRITY/);
  assert.equal(service.storage.verifyComponents().length, 1);
  rmSync(file);
  await assert.rejects(service.execute('artifacts.get', { id: artifact.id, versionId: artifact.versions[0].id }), /COMPONENT_MISSING/);
  // Listing metadata does not depend on component bytes.
  assert.equal((await service.execute('artifacts.list')).length, 1);
});

test('deleting captures removes their bytes; interrupted writes leave no orphaned components', async t => {
  const directory = profile(t);
  let service = open(t, directory);
  const kept = await service.execute('artifacts.create', { title: 'Shared', text: 'same bytes' });
  const removed = await service.execute('artifacts.create', { title: 'Removed', text: 'unique bytes' });
  await service.execute('artifacts.create', { title: 'Duplicate', text: 'same bytes' });
  assert.equal(componentFiles(directory).length, 2);
  await service.execute('artifacts.delete', { id: removed.id });
  assert.deepEqual(componentFiles(directory).map(file => file.split(/[\\/]/).pop()), [sha('same bytes')]);
  await service.execute('artifacts.delete', { id: kept.id });
  assert.equal(componentFiles(directory).length, 1, 'content-addressed bytes shared by another capture remain');
  service.close();
  // Simulate a crash after a component was written but before its transaction committed.
  const orphan = new ComponentStore(join(directory, 'components')).put(Buffer.from('never committed'));
  mkdirSync(join(directory, 'components', 'ab'), { recursive: true });
  writeFileSync(join(directory, 'components', 'ab', `${'a'.repeat(64)}.123.tmp`), 'partial');
  service = open(t, directory);
  assert.equal(existsSync(join(directory, 'components', orphan.sha256.slice(0, 2), orphan.sha256)), false);
  assert.deepEqual(componentFiles(directory).map(file => file.split(/[\\/]/).pop()), [sha('same bytes')]);
});

test('failed commits roll back memory and disk; cloned state keeps component-backed fields', async t => {
  const directory = profile(t);
  const service = open(t, directory);
  const artifact = await service.execute('artifacts.create', { title: 'Capture', text: 'kept text' });
  const before = service.storage.contentDigest();
  await assert.rejects(service.execute('tasks.update', { id: 'missing', changes: { title: 'x' } }), /not found/);
  await assert.rejects(service.execute('materials.create', { title: 'Bad', kind: 'file', fileBase64: '!!' }), /base64/);
  assert.equal(service.storage.contentDigest(), before);
  // Community-list style rollback: structuredClone drops lazy getters, reassignment restores them.
  const copy = structuredClone(service.data);
  service.data.artifacts = [];
  service.data = copy;
  assert.equal((await service.execute('artifacts.get', { id: artifact.id })).versions[0].text, 'kept text');
  service.save();
  service.close();
  assert.equal((await open(t, directory).execute('artifacts.get', { id: artifact.id })).versions[0].text, 'kept text');
});

test('store schema runner applies append-only migrations with a preserved copy and refuses newer databases', t => {
  const directory = profile(t);
  open(t, directory).close();
  const upgraded = [...storeMigrations, { version: 2, up: db => db.exec('CREATE TABLE future_feature(id TEXT PRIMARY KEY)') }];
  const store = new MetadataStore({ directory, migrations: upgraded }).open();
  assert.equal(store.version(), 2);
  assert.deepEqual(store.db.prepare('SELECT version FROM store_migrations ORDER BY version').all().map(row => row.version), [1, 2]);
  store.close();
  const preserved = readdirSync(join(directory, 'recovery')).filter(name => name.startsWith('workspace.pre-migration-v1'));
  assert.equal(preserved.length, 1);
  const copy = new DatabaseSync(join(directory, 'recovery', preserved[0]), { readOnly: true });
  assert.equal(copy.prepare('PRAGMA user_version').get().user_version, 1);
  copy.close();
  // The current release refuses the newer database without modifying it.
  const bytes = readFileSync(join(directory, 'workspace.sqlite'));
  assert.throws(() => new WorkspaceService({ directory, onWarning() {} }), /STORE_UNSUPPORTED/);
  assert.deepEqual(readFileSync(join(directory, 'workspace.sqlite')), bytes);
});

test('stored files are private to the user and oversized components are refused', { skip: process.platform === 'win32' && 'POSIX permissions' }, async t => {
  const directory = profile(t);
  const service = open(t, directory);
  await service.execute('artifacts.create', { title: 'Capture', text: 'private' });
  for (const file of ['workspace.sqlite', ...componentFiles(directory).map(file => file.slice(directory.length + 1))]) assert.equal(statSync(join(directory, file)).mode & 0o077, 0, file);
  assert.equal(statSync(join(directory, 'components')).mode & 0o077, 0);
  assert.throws(() => new ComponentStore(join(directory, 'components')).put(Buffer.alloc(MAX_COMPONENT_BYTES + 1)), /COMPONENT_SIZE_LIMIT/);
});

test('session and history writes commit only their own rows, never unrelated uncommitted changes', async t => {
  const directory = mkdtempSync(join(tmpdir(), 'weft-store-only-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  let service = new WorkspaceService({ directory });
  const note = await service.execute('materials.create', { title: 'Committed title' });
  // A change still in progress elsewhere (not saved) must not ride along with a tab update.
  service.data.materials.find(item => item.id === note.id).title = 'Uncommitted edit';
  service.persistSession({ tabs: [{ id: 3, workspaceId: service.activeWorkspaceId, url: 'https://example.com/a', title: 'Tab', pinned: false, version: 2, controller: 'available',
    suspended: { at: '2026-10-17T00:00:00.000Z', reason: 'idle', scrollX: 0, scrollY: 640, zoom: 1.25 }, groupId: 'tgrp_x' }], activeId: 3 });
  service.recordVisit({ workspaceId: service.activeWorkspaceId, url: 'https://example.com/a', title: 'Visit', tabId: 3 });
  service.close();
  service = new WorkspaceService({ directory });
  try {
    assert.equal(service.data.materials.find(item => item.id === note.id).title, 'Committed title');
    assert.deepEqual(service.data.browserSession.tabs[0].suspended, { at: '2026-10-17T00:00:00.000Z', reason: 'idle', scrollX: 0, scrollY: 640, zoom: 1.25 });
    assert.equal(service.data.browserSession.tabs[0].groupId, 'tgrp_x');
    assert.equal(service.data.history.at(-1).url, 'https://example.com/a');
  } finally { service.close(); }
});
