import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { WorkspaceService } from '../src/workspace.js';
import { DatabaseSync } from '../src/sqlite.js';
import { createKeyProtector, KEYRING_FILE } from '../src/encryption.js';
import { fakeSafeStorage, kdfParams } from './encryption-helpers.js';
import { closeAfter, removeAfter } from './temp-profile.js';

// Real crashes: a child process runs the operation and SIGKILLs itself (TerminateProcess on Windows) at a named step.
const child = fileURLToPath(new URL('./fixtures/encryption-crash.mjs', import.meta.url));
const human = { actor: 'human', source: 'gui' };
const NEEDLES = ['CRASH-NOTE-CONTENT', 'CRASH-CAPTURE-TEXT', 'CRASH-FILE-BODY'];
function open(directory) {
  return new WorkspaceService({ directory, onWarning() {}, keyProtector: createKeyProtector({ safeStorage: fakeSafeStorage(), platform: 'linux' }), encryption: { kdf: kdfParams } });
}
async function seeded(t, count = 12) {
  const directory = mkdtempSync(join(tmpdir(), 'weft-encryption-crash-'));
  removeAfter(t, directory);
  const service = open(directory);
  await service.execute('materials.create', { title: 'Note', content: 'CRASH-NOTE-CONTENT' });
  await service.execute('materials.create', { title: 'File', kind: 'file', filename: 'f.txt', fileBase64: Buffer.from('CRASH-FILE-BODY').toString('base64') });
  await service.execute('artifacts.create', { title: 'Capture', text: 'CRASH-CAPTURE-TEXT crashsearch' });
  for (let i = 0; i < count; i++) await service.execute('context.create', { title: `Finding ${i}`, content: `finding body ${i}` });
  service.close();
  return directory;
}
function crashAt(directory, operation, step, unlockMode = 'os') {
  const result = spawnSync(process.execPath, [child, directory, operation, step, unlockMode], { encoding: 'utf8', timeout: 60000 });
  const output = `${result.stdout}${result.stderr}`;
  assert.equal(result.error, undefined, `the crash child at ${step} did not start or timed out: ${output}`);
  assert.ok(result.stderr.includes(`WEFT_CRASH_AT ${step}\n`), `expected a crash at ${step}: ${output}`);
  assert.ok(!result.stdout.includes('COMPLETED_WITHOUT_CRASH'), `expected a crash at ${step}: ${output}`);
  // POSIX reports the self-inflicted SIGKILL. Windows has no signals: libuv implements the kill as
  // TerminateProcess(handle, 1), which reports exit code 1 and no signal.
  if (process.platform === 'win32') assert.deepEqual({ status: result.status, signal: result.signal }, { status: 1, signal: null }, `expected a crash at ${step}: ${output}`);
  else assert.equal(result.signal, 'SIGKILL', `expected a crash at ${step}: ${output}`);
  // A killed process leaves its ownership lock; a person removes it after checking no Weft process runs.
  rmSync(join(directory, '.workspace.lock'), { force: true });
}
function plaintextHits(directory) {
  const hits = [];
  const walk = path => { for (const entry of readdirSync(path, { withFileTypes: true })) { const file = join(path, entry.name); if (entry.isDirectory()) walk(file); else for (const needle of NEEDLES) if (readFileSync(file).includes(needle)) hits.push(file.slice(directory.length).replaceAll(sep, '/')); } };
  walk(directory);
  return hits.filter(hit => !hit.startsWith('/backups/') && !hit.startsWith('/recovery/'));
}
function storedDocs(directory) {
  const db = new DatabaseSync(join(directory, 'workspace.sqlite'));
  try { return db.prepare('SELECT doc FROM records').all().map(row => row.doc); } finally { db.close(); }
}
async function assertIntact(service) {
  const materials = await service.execute('materials.list', {}, human);
  assert.deepEqual(materials.map(item => item.title).sort(), ['File', 'Note']);
  assert.equal(materials.find(item => item.title === 'Note').content, 'CRASH-NOTE-CONTENT');
  assert.equal(Buffer.from((await service.execute('materials.get', { id: materials.find(item => item.title === 'File').id }, human)).fileBase64, 'base64').toString(), 'CRASH-FILE-BODY');
  assert.equal((await service.execute('search.query', { query: 'crashsearch' }, human))[0]?.title, 'Capture');
  assert.equal((await service.execute('context.list', {}, human)).length, 12);
  assert.deepEqual(service.storage.verifyComponents(), []);
}

for (const step of ['keyring-pending', 'components-sealed', 'in-transaction']) {
  test(`a crash while enabling encryption before the commit (${step}) leaves the plaintext profile intact and retryable`, async t => {
    const directory = await seeded(t);
    crashAt(directory, 'enable', step);
    const service = open(directory);
    closeAfter(t, service);
    assert.equal(service.locked, false);
    assert.equal((await service.executeEncryption('encryption.status', {}, human)).enabled, false);
    assert.equal(existsSync(join(directory, KEYRING_FILE)), false);
    assert.ok(storedDocs(directory).every(doc => doc.startsWith('{')));
    await assertIntact(service);
    // Sealed copies written before the crash are unreferenced and were removed.
    const db = new DatabaseSync(join(directory, 'workspace.sqlite'));
    const refs = db.prepare('SELECT count(DISTINCT sha256) AS count FROM component_refs').get().count; db.close();
    assert.equal(readdirSync(join(directory, 'components')).flatMap(prefix => readdirSync(join(directory, 'components', prefix))).length, refs);
    const retried = await service.executeEncryption('encryption.enable', { acknowledgeKeyLoss: true, unlockMode: 'os' }, human);
    assert.equal(retried.enabled, true);
    await assertIntact(service);
    assert.deepEqual(plaintextHits(directory), []);
  });
}

for (const step of ['committed', 'compacted', 'keyring-active']) {
  test(`a crash while enabling encryption after the commit (${step}) completes the migration and removes plaintext`, async t => {
    const directory = await seeded(t);
    crashAt(directory, 'enable', step);
    const service = open(directory);
    closeAfter(t, service);
    if (step !== 'keyring-active') assert.deepEqual(service.recoveredEncryption, { operation: 'enable', outcome: 'completed' });
    assert.equal(service.locked, false);
    assert.equal(JSON.parse(readFileSync(join(directory, KEYRING_FILE), 'utf8')).pending, undefined);
    assert.ok(storedDocs(directory).every(doc => doc.startsWith('wfe1.')));
    assert.deepEqual(plaintextHits(directory), []);
    await assertIntact(service);
  });
}

test('a crash after the commit with manual unlock finishes recovery without the key, then a person unlocks', async t => {
  const directory = await seeded(t);
  crashAt(directory, 'enable', 'committed', 'manual');
  const service = open(directory);
  closeAfter(t, service);
  assert.equal(service.locked, true);
  // Plaintext component files were overwritten and removed before anyone unlocked.
  assert.deepEqual(plaintextHits(directory), []);
  await assert.rejects(service.execute('materials.list', {}, human), error => error.code === 'locked');
  await service.executeEncryption('encryption.unlock', { method: 'passphrase', secret: 'correct horse battery staple' }, human);
  await assertIntact(service);
});

for (const step of ['batch-1', 'batch-3']) {
  test(`data-key rotation killed mid-job (${step}) resumes at the next start and finishes`, async t => {
    const directory = await seeded(t);
    const first = open(directory);
    await first.executeEncryption('encryption.enable', { acknowledgeKeyLoss: true, unlockMode: 'os' }, human);
    first.close();
    crashAt(directory, 'rotate', step);
    const before = storedDocs(directory);
    assert.ok(before.some(doc => doc.startsWith('wfe1.1.')) && before.some(doc => doc.startsWith('wfe1.2.')), 'the crash left a half-rotated store');
    assert.ok(JSON.parse(readFileSync(join(directory, KEYRING_FILE), 'utf8')).rotation);
    const service = open(directory);
    closeAfter(t, service);
    const job = service.rotationRun;
    assert.ok(job, 'the rotation job resumes at startup');
    // Readable while the resumed job runs: both key versions are held until it finishes.
    await assertIntact(service);
    const result = await job;
    assert.equal(result.keyVersion, 2);
    assert.ok(storedDocs(directory).every(doc => doc.startsWith('wfe1.2.')));
    const keyring = JSON.parse(readFileSync(join(directory, KEYRING_FILE), 'utf8'));
    assert.deepEqual(keyring.dataKeys.map(entry => entry.version), [2]);
    assert.equal(keyring.rotation, undefined);
    await assertIntact(service);
  });
}

for (const [step, encrypted] of [['keyring-pending', true], ['components-opened', true], ['in-transaction', true], ['committed', false], ['keyring-removed', false]]) {
  test(`a crash while disabling encryption (${step}) leaves a consistent ${encrypted ? 'encrypted' : 'plaintext'} profile`, async t => {
    const directory = await seeded(t);
    const first = open(directory);
    await first.executeEncryption('encryption.enable', { acknowledgeKeyLoss: true, unlockMode: 'os' }, human);
    first.close();
    crashAt(directory, 'disable', step);
    const service = open(directory);
    closeAfter(t, service);
    assert.equal((await service.executeEncryption('encryption.status', {}, human)).enabled, encrypted);
    assert.equal(existsSync(join(directory, KEYRING_FILE)), encrypted);
    assert.ok(storedDocs(directory).every(doc => doc.startsWith(encrypted ? 'wfe1.' : '{')));
    // An aborted disable must not leave the plaintext component copies it had written.
    if (encrypted) assert.deepEqual(plaintextHits(directory), []);
    await assertIntact(service);
  });
}
