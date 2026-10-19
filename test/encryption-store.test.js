import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, sep } from 'node:path';
import { WorkspaceService } from '../src/workspace.js';
import { DatabaseSync } from '../src/sqlite.js';
import { createKeyProtector, KEYRING_FILE } from '../src/encryption.js';
import { fakeSafeStorage, kdfParams } from './encryption-helpers.js';
import { closeAfter, closeQuietly, removeAfter } from './temp-profile.js';

const human = { actor: 'human', source: 'gui' };
const PNG = Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), Buffer.from('NEEDLE-IMAGE-BYTES')]).toString('base64');
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
function profile(t) {
  const directory = mkdtempSync(join(tmpdir(), 'weft-encryption-'));
  removeAfter(t, directory);
  return directory;
}
function open(t, directory, { safeStorage = fakeSafeStorage(), platform = 'linux' } = {}) {
  const service = new WorkspaceService({ directory, onWarning() {}, keyProtector: createKeyProtector({ safeStorage, platform }), encryption: { kdf: kdfParams } });
  closeAfter(t, service, closeQuietly);
  return service;
}
const enc = (service, name, args = {}, context = human) => service.executeEncryption(name, args, context);
/** Every file in the profile that contains one of the needles (database, WAL, components, backups, recovery copies, keyring). */
function plaintextHits(directory, needles) {
  const hits = [];
  const walk = path => {
    for (const entry of readdirSync(path, { withFileTypes: true })) {
      const file = join(path, entry.name);
      if (entry.isDirectory()) walk(file);
      else { const bytes = readFileSync(file); for (const needle of needles) if (bytes.includes(needle)) hits.push(`${file.slice(directory.length).replaceAll(sep, '/')}: ${needle}`); }
    }
  };
  walk(directory);
  return hits;
}
function rows(directory, sql) {
  const db = new DatabaseSync(join(directory, 'workspace.sqlite'));
  try { return db.prepare(sql).all(); } finally { db.close(); }
}
async function seed(service) {
  const note = await service.execute('materials.create', { title: 'NEEDLE-TITLE plan', content: 'NEEDLE-NOTE-CONTENT and more' });
  const file = await service.execute('materials.create', { title: 'Paper', kind: 'file', filename: 'paper.txt', mimeType: 'text/plain', fileBase64: Buffer.from('NEEDLE-FILE-BODY').toString('base64') });
  const capture = await service.execute('artifacts.create', { title: 'Evidence', text: 'NEEDLE-CAPTURE-TEXT searchable evidence', pngBase64: PNG });
  service.persistSession({ tabs: [{ id: 1, workspaceId: service.activeWorkspaceId, url: 'https://needle-host.example/needle-path', title: 'NEEDLE-TAB-TITLE', version: 1 }], activeId: 1 });
  return { note, file, capture };
}
const NEEDLES = ['NEEDLE-TITLE', 'NEEDLE-NOTE-CONTENT', 'NEEDLE-FILE-BODY', 'NEEDLE-CAPTURE-TEXT', 'NEEDLE-IMAGE-BYTES', 'needle-host.example', 'NEEDLE-TAB-TITLE'];

test('enabling encryption rewrites records, settings, captures and files so no plaintext remains in the profile', async t => {
  const directory = profile(t);
  const service = open(t, directory);
  const { note, file, capture } = await seed(service);
  assert.ok(plaintextHits(directory, NEEDLES).length > 0, 'fixture must start with plaintext on disk');
  const plainComponents = new Set(readdirSync(join(directory, 'components')).flatMap(prefix => readdirSync(join(directory, 'components', prefix))));
  const result = await enc(service, 'encryption.enable', { acknowledgeKeyLoss: true, unlockMode: 'os', passphrase: 'correct horse battery staple' });
  assert.match(result.recoveryKey, /^(?:[A-Z2-7]{4}-){9}[A-Z2-7]{4}$/);
  assert.equal(result.backup.status, 'verified');
  assert.deepEqual(plaintextHits(directory, [...NEEDLES, result.recoveryKey]), []);
  // Components are sealed under keyed locators: no plaintext digest names remain.
  const sealed = readdirSync(join(directory, 'components')).flatMap(prefix => readdirSync(join(directory, 'components', prefix)));
  assert.equal(sealed.length, plainComponents.size);
  assert.ok(sealed.every(name => !plainComponents.has(name)));
  assert.ok(!sealed.includes(sha256(Buffer.from('NEEDLE-FILE-BODY'))));
  // Every record and setting is sealed; the full-text index is not on disk.
  assert.ok(rows(directory, 'SELECT doc FROM records').every(row => row.doc.startsWith('wfe1.')));
  assert.ok(rows(directory, "SELECT key, value FROM state_meta WHERE key != 'schemaVersion'").every(row => row.value.startsWith('wfe1.')));
  assert.deepEqual(rows(directory, "SELECT name FROM sqlite_master WHERE name LIKE 'search%'"), []);
  // Reads, file materials, captures and in-memory search keep working.
  assert.equal((await service.execute('materials.get', { id: note.id })).content, 'NEEDLE-NOTE-CONTENT and more');
  assert.equal(Buffer.from((await service.execute('materials.get', { id: file.id })).fileBase64, 'base64').toString(), 'NEEDLE-FILE-BODY');
  const version = await service.execute('artifacts.get', { id: capture.id, versionId: capture.versions[0].id });
  assert.equal(version.pngBase64, PNG);
  const hits = await service.execute('search.query', { query: 'searchable evidence' });
  assert.equal(hits[0].id, capture.id);
  const status = await enc(service, 'encryption.status', {}, { actor: 'automation' });
  assert.equal(status.enabled, true);
  assert.equal(status.locked, false);
  assert.equal(status.plaintextCopies, undefined, 'only a person sees the plaintext inventory');
  // Reopening with the OS key store unlocks automatically; new writes are sealed too.
  service.close();
  const reopened = open(t, directory);
  assert.equal(reopened.locked, false);
  await reopened.execute('context.create', { title: 'NEEDLE-AFTER-REOPEN', content: 'later' });
  assert.equal((await reopened.execute('search.query', { query: 'later' }))[0].title, 'NEEDLE-AFTER-REOPEN');
  assert.deepEqual(plaintextHits(directory, ['NEEDLE-AFTER-REOPEN', ...NEEDLES]), []);
});

test('manual unlock mode starts locked; every in-process path returns locked; only a person with the right secret unlocks', async t => {
  const directory = profile(t);
  let service = open(t, directory);
  const { note } = await seed(service);
  const { recoveryKey } = await enc(service, 'encryption.enable', { acknowledgeKeyLoss: true, unlockMode: 'manual', passphrase: 'correct horse battery staple' });
  service.close();
  service = open(t, directory);
  assert.equal(service.locked, true);
  for (const [name, args] of [['materials.list', {}], ['materials.get', { id: note.id }], ['materials.create', { title: 'x' }], ['search.query', { query: 'needle' }], ['workspace.snapshot', {}], ['backups.create', {}]]) {
    await assert.rejects(service.execute(name, args, human), error => error.code === 'locked' && /A person must unlock/.test(error.message), name);
  }
  assert.throws(() => service.snapshot(), error => error.code === 'locked');
  assert.throws(() => service.activeWorkspaceId, error => error.code === 'locked');
  assert.throws(() => service.save(), error => error.code === 'locked');
  assert.equal(service.matchSiteRule('https://example.com/').behavior, 'block', 'no workspace page loads while locked');
  const status = await enc(service, 'encryption.status');
  assert.deepEqual({ enabled: status.enabled, locked: status.locked, reason: status.lockReason, os: status.methods.os.configured, passphrase: status.methods.passphrase.configured }, { enabled: true, locked: true, reason: 'unlock_required', os: false, passphrase: true });
  await assert.rejects(enc(service, 'encryption.unlock', { method: 'passphrase', secret: 'correct horse battery staple' }, { actor: 'automation' }), error => error.code === 'permission_required');
  await assert.rejects(enc(service, 'encryption.unlock', { method: 'passphrase', secret: 'wrong horse battery staple' }), error => error.code === 'key_invalid');
  await assert.rejects(enc(service, 'encryption.unlock', { method: 'os' }), error => error.code === 'unavailable');
  assert.equal(service.locked, true);
  const calls = [];
  service.encryptionHooks = { beforeLock: async options => calls.push(['beforeLock', options.persist]), afterUnlock: async () => calls.push(['afterUnlock']) };
  const unlocked = await enc(service, 'encryption.unlock', { method: 'passphrase', secret: 'correct horse battery staple' });
  assert.equal(unlocked.unlocked, true);
  assert.equal((await service.execute('materials.get', { id: note.id })).content, 'NEEDLE-NOTE-CONTENT and more');
  await assert.rejects(enc(service, 'encryption.lock', {}, { actor: 'automation' }), error => error.code === 'permission_required');
  assert.deepEqual(await enc(service, 'encryption.lock'), { locked: true });
  await assert.rejects(service.execute('materials.list', {}, human), error => error.code === 'locked');
  await enc(service, 'encryption.unlock', { method: 'recovery', secret: recoveryKey.toLowerCase() });
  assert.deepEqual(calls, [['afterUnlock'], ['beforeLock', true], ['afterUnlock']]);
  assert.equal((await service.execute('materials.list')).length, 2);
});

test('OS key unavailable at startup leaves data locked; the recovery key unlocks and the OS key can be re-enrolled', async t => {
  const directory = profile(t);
  let service = open(t, directory, { safeStorage: fakeSafeStorage({ account: 'alice' }) });
  const { note } = await seed(service);
  const { recoveryKey } = await enc(service, 'encryption.enable', { acknowledgeKeyLoss: true, unlockMode: 'os' });
  service.close();
  // Same profile copied to another OS account: the OS key store cannot unwrap the profile key.
  service = open(t, directory, { safeStorage: fakeSafeStorage({ account: 'mallory' }) });
  assert.equal(service.locked, true);
  assert.equal((await enc(service, 'encryption.status')).lockReason, 'os_key_unavailable');
  await assert.rejects(enc(service, 'encryption.unlock', { method: 'os' }), error => error.code === 'unavailable');
  await enc(service, 'encryption.unlock', { method: 'recovery', secret: recoveryKey });
  assert.equal((await service.execute('materials.get', { id: note.id })).title, 'NEEDLE-TITLE plan');
  await enc(service, 'encryption.configure', { unlockMode: 'os' });
  service.close();
  service = open(t, directory, { safeStorage: fakeSafeStorage({ account: 'mallory' }) });
  assert.equal(service.locked, false, 'the re-enrolled OS key unlocks at startup');
  service.close();
  // Linux without a secret service (basic_text): Weft refuses to call that protection.
  service = open(t, directory, { safeStorage: fakeSafeStorage({ backend: 'basic_text', account: 'mallory' }) });
  assert.equal(service.locked, true);
  const status = await enc(service, 'encryption.status');
  assert.equal(status.methods.os.protects, false);
  assert.equal(status.methods.os.backend, 'basic_text');
  await enc(service, 'encryption.unlock', { method: 'recovery', secret: recoveryKey });
  await assert.rejects(enc(service, 'encryption.configure', { unlockMode: 'os' }), error => error.code === 'unavailable');
  const fresh = open(t, profile(t), { safeStorage: fakeSafeStorage({ backend: 'basic_text' }) });
  await assert.rejects(enc(fresh, 'encryption.enable', { acknowledgeKeyLoss: true, unlockMode: 'os' }), error => error.code === 'unavailable');
  assert.equal((await enc(fresh, 'encryption.enable', { acknowledgeKeyLoss: true, unlockMode: 'manual' })).enabled, true);
});

test('tampered or transplanted ciphertext is detected and the profile is left unchanged', async t => {
  const directory = profile(t);
  let service = open(t, directory);
  const { note, capture } = await seed(service);
  const second = await service.execute('materials.create', { title: 'Other', content: 'other content' });
  await enc(service, 'encryption.enable', { acknowledgeKeyLoss: true, unlockMode: 'os' });
  service.close();
  const database = join(directory, 'workspace.sqlite');
  const edit = (sql, ...args) => { const db = new DatabaseSync(database); try { db.prepare(sql).run(...args); db.prepare('PRAGMA wal_checkpoint(TRUNCATE)').get(); } finally { db.close(); } };
  const [{ doc }] = rows(directory, `SELECT doc FROM records WHERE id = '${note.id}'`);
  const flipped = doc.slice(0, -10) + (doc.at(-10) === 'A' ? 'B' : 'A') + doc.slice(-9);
  edit('UPDATE records SET doc = ? WHERE id = ?', flipped, note.id);
  const before = sha256(readFileSync(database));
  assert.throws(() => open(t, directory), error => error.code === 'component_integrity' && /failed authentication/.test(error.message));
  assert.equal(sha256(readFileSync(database)), before, 'a failed open changes nothing');
  // A valid ciphertext moved to another record's row is rejected too.
  const [{ doc: otherDoc }] = rows(directory, `SELECT doc FROM records WHERE id = '${second.id}'`);
  edit('UPDATE records SET doc = ? WHERE id = ?', otherDoc, note.id);
  assert.throws(() => open(t, directory), error => error.code === 'component_integrity');
  // A plaintext row injected into the encrypted store is not trusted.
  edit('UPDATE records SET doc = ? WHERE id = ?', JSON.stringify({ id: note.id, title: 'Injected', revision: 1 }), note.id);
  assert.throws(() => open(t, directory), error => error.code === 'component_integrity');
  edit('UPDATE records SET doc = ? WHERE id = ?', doc, note.id);
  service = open(t, directory);
  // A modified component file fails GCM authentication when read.
  const [{ sha256: id }] = rows(directory, "SELECT sha256 FROM component_refs WHERE size = 18 + 8");
  const path = join(directory, 'components', id.slice(0, 2), id);
  const bytes = readFileSync(path); bytes[bytes.length - 3] ^= 1; writeFileSync(path, bytes);
  await assert.rejects(service.execute('artifacts.get', { id: capture.id, versionId: capture.versions[0].id }), error => error.code === 'component_integrity');
  assert.ok(service.storage.verifyComponents().some(problem => problem.sha256 === id));
});

test('request identities survive enabling encryption, are keyed on disk and never re-apply after disabling', async t => {
  const directory = profile(t);
  const service = open(t, directory);
  const first = await service.execute('materials.create', { title: 'Once', content: 'NEEDLE-IDEMPOTENT', requestId: 'req-1' });
  const [plainRow] = rows(directory, "SELECT fingerprint FROM requests WHERE request_id = 'req-1'");
  await enc(service, 'encryption.enable', { acknowledgeKeyLoss: true, unlockMode: 'os' });
  const [sealedRow] = rows(directory, "SELECT fingerprint, result FROM requests WHERE request_id = 'req-1'");
  assert.notEqual(sealedRow.fingerprint, plainRow.fingerprint);
  assert.match(sealedRow.result, /^wfe1\./);
  const replay = await service.execute('materials.create', { title: 'Once', content: 'NEEDLE-IDEMPOTENT', requestId: 'req-1' });
  assert.equal(replay.id, first.id);
  await assert.rejects(service.execute('materials.create', { title: 'Different', requestId: 'req-1' }), error => error.code === 'idempotency_conflict');
  await service.execute('materials.create', { title: 'Twice', requestId: 'req-2' });
  assert.equal((await service.execute('materials.create', { title: 'Twice', requestId: 'req-2' })).title, 'Twice');
  await enc(service, 'encryption.disable', { acknowledgePlaintext: true });
  await assert.rejects(service.execute('materials.create', { title: 'Once', content: 'NEEDLE-IDEMPOTENT', requestId: 'req-1' }), error => error.code === 'already_committed');
  assert.equal((await service.execute('materials.list')).filter(item => item.title === 'Once').length, 1);
});

test('exports from an encrypted profile need explicit plaintext acknowledgement and say so', async t => {
  const directory = profile(t);
  const service = open(t, directory);
  await seed(service);
  await enc(service, 'encryption.enable', { acknowledgeKeyLoss: true, unlockMode: 'os' });
  const id = service.activeWorkspaceId;
  await assert.rejects(service.execute('workspaces.export', { id }), error => error.code === 'invalid_arguments' && /ENCRYPTED_EXPORT/.test(error.message));
  await assert.rejects(service.execute('workspaces.exportPackage', { id, name: 'pkg' }), error => /ENCRYPTED_EXPORT/.test(error.message));
  assert.equal(existsSync(join(directory, 'transfers', 'pkg')), false);
  const exported = await service.execute('workspaces.export', { id, acknowledgePlaintext: true });
  assert.ok(exported.limitations.some(item => /NOT encrypted/.test(item)));
  assert.ok(JSON.stringify(exported).includes('NEEDLE-NOTE-CONTENT'));
  const written = await service.execute('workspaces.exportPackage', { id, name: 'pkg', acknowledgePlaintext: true });
  assert.equal(written.plaintext, true);
  assert.ok(plaintextHits(join(directory, 'transfers'), ['NEEDLE-FILE-BODY', 'NEEDLE-CAPTURE-TEXT']).length >= 2, 'the package is a plaintext export');
  const imported = await service.execute('workspaces.importPackage', { name: 'pkg' });
  assert.equal((await service.execute('materials.list', { workspaceId: imported.id })).length, 2);
  // The imported copy is stored sealed like everything else.
  assert.deepEqual(plaintextHits(directory, NEEDLES).filter(hit => !hit.startsWith('/transfers')), []);
  const status = await enc(service, 'encryption.status', { inventory: true });
  assert.deepEqual(status.plaintextCopies.map(item => [item.kind, item.path, item.removable]), [['export_package', 'transfers/pkg', false]]);
});

test('encrypted backups stay encrypted with their keyring; restores reuse or require the matching key', async t => {
  const directory = profile(t);
  const service = open(t, directory);
  const { note } = await seed(service);
  const plainBackup = await service.execute('backups.create', { note: 'plaintext' });
  const { recoveryKey } = await enc(service, 'encryption.enable', { acknowledgeKeyLoss: true, unlockMode: 'manual', passphrase: 'correct horse battery staple' });
  const backup = await service.execute('backups.create', { note: 'encrypted' });
  assert.equal(backup.status, 'verified');
  assert.equal(backup.encrypted, true);
  const folder = join(directory, 'backups', backup.id);
  assert.ok(existsSync(join(folder, KEYRING_FILE)));
  assert.deepEqual(plaintextHits(folder, NEEDLES), []);
  const manifest = JSON.parse(readFileSync(join(folder, 'manifest.json'), 'utf8'));
  assert.equal(manifest.formatVersion, 2);
  assert.ok(manifest.files.some(file => file.path === KEYRING_FILE));
  await service.execute('materials.update', { id: note.id, changes: { content: 'changed after backup' } });
  const preview = await service.execute('backups.restore', { id: backup.id, dryRun: true });
  assert.deepEqual(preview.changes.encryption, { current: 'encrypted', restored: 'encrypted' });
  const restored = await service.execute('backups.restore', { id: backup.id });
  assert.equal(restored.encryption, 'encrypted');
  assert.equal((await service.execute('materials.get', { id: note.id })).content, 'NEEDLE-NOTE-CONTENT and more');
  // After a wrapping rotation the session's profile key no longer opens the older backup's keyring: restore locks and the old recovery key unlocks.
  const { recoveryKey: newRecovery } = await enc(service, 'encryption.rotate', { target: 'wrapping' });
  assert.notEqual(newRecovery, recoveryKey);
  const lockedRestore = await service.execute('backups.restore', { id: backup.id });
  assert.equal(lockedRestore.encryption, 'locked');
  assert.equal(service.locked, true);
  await assert.rejects(enc(service, 'encryption.unlock', { method: 'recovery', secret: newRecovery }), error => error.code === 'key_invalid');
  await enc(service, 'encryption.unlock', { method: 'recovery', secret: recoveryKey });
  assert.equal((await service.execute('materials.get', { id: note.id })).content, 'NEEDLE-NOTE-CONTENT and more');
  // Restoring a plaintext backup makes the profile plaintext again and says so; the keyring is preserved with the replaced data.
  const plainPreview = await service.execute('backups.restore', { id: plainBackup.id, dryRun: true });
  assert.deepEqual(plainPreview.changes.encryption, { current: 'encrypted', restored: 'plaintext' });
  const plain = await service.execute('backups.restore', { id: plainBackup.id });
  assert.equal(plain.encryption, 'plaintext');
  assert.equal(service.storage.encrypted, false);
  assert.equal(existsSync(join(directory, KEYRING_FILE)), false);
  assert.ok(existsSync(join(directory, plain.preservedOriginal, KEYRING_FILE)));
  assert.equal((await enc(service, 'encryption.status')).enabled, false);
});

test('enabling lists plaintext copies and can overwrite them; export packages are kept', async t => {
  const directory = profile(t);
  const service = open(t, directory);
  await seed(service);
  const old = await service.execute('backups.create', {});
  await service.execute('workspaces.exportPackage', { id: service.activeWorkspaceId, name: 'shared-copy' });
  const before = await enc(service, 'encryption.status', { inventory: true });
  assert.deepEqual(before.plaintextCopies.map(item => item.path).sort(), [`backups/${old.id}`, 'transfers/shared-copy']);
  const result = await enc(service, 'encryption.enable', { acknowledgeKeyLoss: true, unlockMode: 'os', removePlaintextCopies: true });
  assert.deepEqual(result.removedPlaintextCopies, [`backups/${old.id}`]);
  assert.deepEqual(result.plaintextCopies.map(item => item.path), ['transfers/shared-copy']);
  assert.equal(existsSync(join(directory, 'backups', old.id)), false);
  assert.deepEqual(plaintextHits(directory, NEEDLES).filter(hit => !hit.startsWith('/transfers/')), []);
});

test('data-key rotation re-encrypts every value and component and retires the old key; wrapping rotation retires the old recovery key', async t => {
  const directory = profile(t);
  const service = open(t, directory);
  const { note, capture } = await seed(service);
  for (let i = 0; i < 30; i++) await service.execute('context.create', { title: `Finding ${i}`, content: `body ${i}`, requestId: `ctx-${i}` });
  const { recoveryKey } = await enc(service, 'encryption.enable', { acknowledgeKeyLoss: true, unlockMode: 'os' });
  const rotated = await enc(service, 'encryption.rotate', { target: 'dataKey' });
  assert.deepEqual({ rotated: rotated.rotated, from: rotated.from, keyVersion: rotated.keyVersion }, { rotated: 'dataKey', from: 1, keyVersion: 2 });
  assert.ok(rotated.reencrypted > 30);
  assert.ok(rows(directory, 'SELECT doc FROM records').every(row => row.doc.startsWith('wfe1.2.')));
  assert.ok(rows(directory, "SELECT result FROM requests WHERE result IS NOT NULL").every(row => row.result.startsWith('wfe1.2.')));
  for (const { sha256: id } of rows(directory, 'SELECT DISTINCT sha256 FROM component_refs')) assert.equal(readFileSync(join(directory, 'components', id.slice(0, 2), id)).readUInt32BE(4), 2);
  const keyring = JSON.parse(readFileSync(join(directory, KEYRING_FILE), 'utf8'));
  assert.deepEqual(keyring.dataKeys.map(entry => entry.version), [2]);
  assert.equal(keyring.rotation, undefined);
  assert.equal((await service.execute('materials.get', { id: note.id })).content, 'NEEDLE-NOTE-CONTENT and more');
  assert.equal((await service.execute('artifacts.get', { id: capture.id, versionId: capture.versions[0].id })).pngBase64, PNG);
  assert.equal((await service.execute('context.create', { title: 'Finding 3', content: 'body 3', requestId: 'ctx-3' })).title, 'Finding 3', 'replay still works');
  assert.equal((await enc(service, 'encryption.checkRecoveryKey', { recoveryKey })).valid, true, 'data-key rotation keeps the recovery key');
  const { recoveryKey: next } = await enc(service, 'encryption.rotate', { target: 'wrapping' });
  assert.equal((await enc(service, 'encryption.checkRecoveryKey', { recoveryKey })).valid, false);
  assert.equal((await enc(service, 'encryption.checkRecoveryKey', { recoveryKey: next })).valid, true);
});

test('a failed keyring save during rotation leaves the live keys unchanged and new writes readable after reopening', async t => {
  const directory = profile(t);
  const safeStorage = fakeSafeStorage();
  const service = open(t, directory, { safeStorage });
  await seed(service);
  const { recoveryKey } = await enc(service, 'encryption.enable', { acknowledgeKeyLoss: true, unlockMode: 'os' });
  const keyringPath = join(directory, KEYRING_FILE);
  const saved = readFileSync(keyringPath);
  // Make the keyring path a non-empty directory so the durable rename fails.
  const blockSave = () => { rmSync(keyringPath); mkdirSync(join(keyringPath, 'blocked'), { recursive: true }); };
  const allowSave = () => { rmSync(keyringPath, { recursive: true, force: true }); writeFileSync(keyringPath, saved); };
  blockSave();
  await assert.rejects(enc(service, 'encryption.rotate', { target: 'dataKey' }));
  assert.equal(service.encryption.keys.currentVersion, 1, 'data-key rotation did not switch the live key');
  assert.equal(service.encryption.keyring.rotation, undefined);
  await assert.rejects(enc(service, 'encryption.rotate', { target: 'wrapping' }));
  const after = await service.execute('materials.create', { title: 'Written after the failed saves', content: 'AFTER-FAILURE-BODY' });
  assert.ok(rows(directory, 'SELECT doc FROM records').every(row => row.doc.startsWith('wfe1.1.')), 'nothing is sealed under an unsaved key');
  allowSave();
  await service.close();
  const reopened = open(t, directory, { safeStorage });
  assert.equal((await reopened.execute('materials.get', { id: after.id })).content, 'AFTER-FAILURE-BODY');
  assert.equal((await enc(reopened, 'encryption.checkRecoveryKey', { recoveryKey })).valid, true, 'the saved recovery key still unlocks');
});

test('disabling encryption rewrites plaintext, restores the on-disk index and removes the keyring', async t => {
  const directory = profile(t);
  const service = open(t, directory);
  const { file, capture } = await seed(service);
  await enc(service, 'encryption.enable', { acknowledgeKeyLoss: true, unlockMode: 'os' });
  await assert.rejects(enc(service, 'encryption.disable', {}), error => Array.isArray(error.issues));
  const result = await enc(service, 'encryption.disable', { acknowledgePlaintext: true });
  assert.equal(result.enabled, false);
  assert.equal(existsSync(join(directory, KEYRING_FILE)), false);
  assert.ok(rows(directory, 'SELECT doc FROM records').every(row => row.doc.startsWith('{')));
  assert.equal(rows(directory, "SELECT name FROM sqlite_master WHERE name = 'search_fts'").length, 1);
  assert.ok(existsSync(join(directory, 'components', sha256(Buffer.from('NEEDLE-FILE-BODY')).slice(0, 2), sha256(Buffer.from('NEEDLE-FILE-BODY')))));
  assert.equal(Buffer.from((await service.execute('materials.get', { id: file.id })).fileBase64, 'base64').toString(), 'NEEDLE-FILE-BODY');
  assert.equal((await service.execute('search.query', { query: 'searchable' }))[0].id, capture.id);
  assert.equal(statSync(join(directory, 'workspace.sqlite')).isFile(), true);
});
