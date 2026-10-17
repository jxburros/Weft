import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WorkspaceService } from '../src/workspace.js';
import { DatabaseSync } from '../src/sqlite.js';
import { createKeyProtector } from '../src/encryption.js';
import { Providers } from '../src/providers.js';
import { Retrieval } from '../src/retrieval.js';
import { Transfers } from '../src/transfers.js';
import { Knowledge } from '../src/knowledge.js';
import { ServiceCredentials } from '../src/linked-sources.js';
import { AutomationAdmission } from '../src/admission.js';
import { createDispatcher } from '../src/dispatch.js';
import { EventLog } from '../src/server.js';
import { PaymentService } from '../src/payments.js';
import { fakeSafeStorage, kdfParams } from './encryption-helpers.js';
import { fakeEndpoint, json } from './model-test-helpers.js';
import { closeAfter, closeQuietly, removeAfter } from './temp-profile.js';

/**
 * Encryption (ADR 014) reconciled with features it was not written against: embedding vectors
 * (ADR 018), resource archives (ADR 012), linked sources, services, collections, citations and
 * origins (ADR 013) and chunked uploads (ADR 018). Nothing of them may stay on disk in plaintext.
 */
const human = { actor: 'human', source: 'gui' };
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
function profile(t) {
  const directory = mkdtempSync(join(tmpdir(), 'weft-encryption-integration-'));
  removeAfter(t, directory);
  return directory;
}
function open(t, directory) {
  const service = new WorkspaceService({ directory, onWarning() {}, keyProtector: createKeyProtector({ safeStorage: fakeSafeStorage(), platform: 'linux' }), encryption: { kdf: kdfParams } });
  closeAfter(t, service, closeQuietly);
  return service;
}
const enc = (service, name, args = {}, context = human) => service.executeEncryption(name, args, context);
const enable = service => enc(service, 'encryption.enable', { acknowledgeKeyLoss: true, unlockMode: 'os', passphrase: 'correct horse battery staple' });
function plaintextHits(directory, needles) {
  const hits = [];
  const walk = path => {
    for (const entry of readdirSync(path, { withFileTypes: true })) {
      const file = join(path, entry.name);
      if (entry.isDirectory()) walk(file);
      else { const bytes = readFileSync(file); for (const needle of needles) if (bytes.includes(needle)) hits.push(`${file.slice(directory.length)}: ${typeof needle === 'string' ? needle : 'bytes'}`); }
    }
  };
  walk(directory);
  return hits;
}
function rows(directory, sql) {
  const db = new DatabaseSync(join(directory, 'workspace.sqlite'));
  try { return db.prepare(sql).all(); } finally { db.close(); }
}

test('(a) embedding vectors of an encrypted profile are sealed at rest: enabling, locking and unlocking re-embed nothing', async t => {
  const directory = profile(t);
  const service = open(t, directory);
  const inputs = [];
  const server = await fakeEndpoint(t, (req, res, body) => { inputs.push(...body.input); json(res, { model: body.model, embeddings: body.input.map(text => [/sedan|automobile/i.test(text) ? 1 : 0, 0.1]) }); });
  const providers = await new Providers({ directory, workspace: service, env: {} }).init();
  closeAfter(t, providers);
  const connection = await providers.execute('models.save', { name: 'Local', provider: 'ollama', endpoint: server.base, model: 'chat' });
  const retrieval = new Retrieval({ workspace: service, providers, intervalMs: 0 });
  service.attachRetrieval(retrieval);
  closeAfter(t, retrieval);
  const note = await service.execute('materials.create', { title: 'NEEDLE-VECTOR-NOTE', content: 'The sedan needs tires.' });
  await service.execute('materials.create', { title: 'Second note', content: 'Bicycle chain oil.' });
  await service.execute('search.configureEmbeddings', { enabled: true, modelId: connection.id, embeddingModel: 'fake-embed' }, human);
  await retrieval.drain();
  const contentRequests = () => inputs.filter(text => text !== 'Weft embedding check' && text !== 'automobile');
  const embedded = contentRequests().length;
  assert.ok(embedded >= 2);
  const plain = rows(directory, 'SELECT text_sha256, vector FROM vector_chunks ORDER BY rowid');
  assert.ok(plain.length >= 2, 'a plaintext profile stores vectors in the database');

  await enable(service);
  await retrieval.drain();
  assert.equal(contentRequests().length, embedded, 'enabling encryption seals existing vectors instead of re-embedding them');
  const sealed = rows(directory, 'SELECT text_sha256, vector FROM vector_chunks ORDER BY rowid');
  assert.equal(sealed.length, plain.length, 'vectors stay on disk, sealed');
  for (const [index, row] of sealed.entries()) {
    assert.notEqual(row.text_sha256, plain[index].text_sha256, 'the text digest on disk is keyed');
    assert.equal(Buffer.from(row.vector).includes(Buffer.from(plain[index].vector)), false, 'the vector bytes are not on disk in the clear');
  }
  assert.deepEqual(plaintextHits(directory, ['NEEDLE-VECTOR-NOTE', ...plain.map(row => Buffer.from(row.vector)), ...plain.map(row => row.text_sha256)]), []);
  const hits = await service.execute('search.query', { query: 'automobile', mode: 'hybrid' }, human);
  assert.equal(hits[0].id, note.id, 'sealed vectors are opened for search');

  // Lock and unlock: vectors are decrypted on demand; no text goes to the endpoint again.
  await enc(service, 'encryption.lock');
  await retrieval.drain();
  await assert.rejects(service.execute('search.query', { query: 'automobile' }, human), error => error.code === 'locked');
  await enc(service, 'encryption.unlock', { method: 'passphrase', secret: 'correct horse battery staple' });
  await retrieval.drain();
  assert.equal(contentRequests().length, embedded, 'unlocking causes zero embedding requests for unchanged content');
  assert.equal((await service.execute('search.query', { query: 'automobile', mode: 'hybrid' }, human))[0].id, note.id);
  assert.equal(retrieval.status(service.activeWorkspaceId).vector.pending, 0);

  // A changed record re-embeds only its own changed chunk.
  await service.execute('materials.update', { id: note.id, changes: { content: 'The automobile needs new tires.' } });
  await retrieval.drain();
  assert.equal(contentRequests().length, embedded + 1);

  // A sealed vector moved to another row fails authentication instead of being used.
  const db = new DatabaseSync(join(directory, 'workspace.sqlite'));
  try {
    const [first, second] = db.prepare('SELECT rowid, vector FROM vector_chunks ORDER BY rowid LIMIT 2').all();
    db.prepare('UPDATE vector_chunks SET vector = ? WHERE rowid = ?').run(first.vector, second.rowid);
  } finally { db.close(); }
  service.storage.vectors.cache.clear();
  await assert.rejects(service.execute('search.query', { query: 'automobile', mode: 'hybrid' }, human), error => error.code === 'component_integrity');
  // Reindexing replaces the damaged chunk (its text is embedded again); intact chunks are reused.
  await service.execute('search.reindex', {}, human);
  const count = contentRequests().length;
  assert.equal(count, embedded + 2);
  assert.equal((await service.execute('search.query', { query: 'automobile', mode: 'hybrid' }, human))[0].id, note.id);

  // Turning encryption off opens the vectors back into plaintext rows; still nothing is re-embedded.
  await enc(service, 'encryption.disable', { acknowledgePlaintext: true });
  await retrieval.drain();
  assert.equal(contentRequests().length, count);
  const reopened = rows(directory, 'SELECT text_sha256 FROM vector_chunks');
  assert.ok(reopened.every(row => /^[0-9a-f]{64}$/.test(row.text_sha256)));
  await service.execute('materials.update', { id: note.id, changes: { title: 'NEEDLE-VECTOR-NOTE renamed' } });
  await retrieval.drain();
  assert.ok(contentRequests().length <= count + 1, 'unchanged chunks are still reused after disabling');
});

test('(b) resource archive bodies and manifests are sealed components and records; verification still works', async t => {
  const directory = profile(t);
  const service = open(t, directory);
  const body = Buffer.from('<html><body>NEEDLE-ARCHIVE-BODY</body></html>');
  service.attachBrowser({ async captureArtifact() {
    return { text: 'NEEDLE-ARCHIVE-TEXT', title: 'Archived', url: 'https://needle-archive.example/page',
      archive: { format: 'weft-archive', formatVersion: 1, documentUrl: 'https://needle-archive.example/page', status: 'complete', complete: true, counts: { stored: 1 },
        resources: [{ url: 'https://needle-archive.example/page', role: 'document', mimeType: 'text/html', size: body.length, sha256: sha(body), status: 'stored', bodyBase64: body.toString('base64') }] },
      capture: { complete: true, incomplete: [] } };
  } });
  const capture = await service.execute('artifacts.capture', { kind: 'archive', title: 'Archived' }, human);
  assert.ok(plaintextHits(directory, ['NEEDLE-ARCHIVE-BODY']).length > 0, 'fixture starts with a plaintext archive component');
  await enable(service);
  assert.deepEqual(plaintextHits(directory, ['NEEDLE-ARCHIVE-BODY', 'NEEDLE-ARCHIVE-TEXT', 'needle-archive.example']), []);
  const verified = await service.execute('artifacts.verify', { id: capture.id }, human);
  assert.equal(JSON.stringify(verified).includes('mismatch'), false, JSON.stringify(verified));
  // Purging a sealed archive version removes its content; the sealed component is released.
  await service.execute('artifacts.purgeContent', { id: capture.id, versionId: capture.versions[0].id }, human);
  assert.deepEqual(plaintextHits(directory, ['NEEDLE-ARCHIVE-BODY']), []);
});

test('(c) linked-source paths, cached service content, collections, citations and origins are sealed', async t => {
  const directory = profile(t);
  const files = mkdtempSync(join(tmpdir(), 'weft-encryption-linked-'));
  removeAfter(t, files);
  const folder = join(files, 'NEEDLE-LINKED-FOLDER');
  mkdirSync(folder);
  writeFileSync(join(folder, 'brief.txt'), 'linked text');
  const service = open(t, directory);
  const fetchImpl = async () => new Response('NEEDLE-SERVICE-BODY', { status: 200, headers: { 'content-type': 'text/plain', etag: '"v1"' } });
  const knowledge = new Knowledge({ workspace: service, credentials: new ServiceCredentials({ directory, safeStorage: { isEncryptionAvailable: () => false } }), fetchImpl });
  const dispatch = createDispatcher({ workspace: service, knowledge, browser: { tabs: new Map(), async execute() { return {}; } }, providers: { close() {} }, admission: new AutomationAdmission() });
  const run = async (command, args) => { const outcome = await dispatch(command, args, human); assert.equal(outcome.error, null, `${command}: ${JSON.stringify(outcome.error)}`); return outcome.result; };
  const workspaceId = service.activeWorkspaceId;
  await run('sources.link', { workspaceId, path: folder });
  const reference = await run('services.create', { workspaceId, title: 'Policy', url: 'http://127.0.0.1:9/NEEDLE-SERVICE-PATH' });
  await run('services.refresh', { id: reference.id });
  const capture = await run('artifacts.create', { workspaceId, title: 'Quoted', text: 'Intro. NEEDLE-QUOTE-TEXT appears here. End.' });
  const finding = await run('context.create', { workspaceId, title: 'Finding', content: 'Supported.', origin: { model: 'NEEDLE-ORIGIN-MODEL' },
    citations: [{ type: 'capture', captureId: capture.id, exact: 'NEEDLE-QUOTE-TEXT' }] });
  assert.equal(finding.citations[0].status, 'verified');
  const shared = await run('collections.create', { workspaceId, name: 'Needle collection name' });
  await run('collections.addItem', { id: shared.id, type: 'context', itemId: finding.id });
  await run('conflicts.create', { workspaceId, subjects: [{ collection: 'context', id: finding.id }], note: 'NEEDLE-CONFLICT-NOTE' });
  const needles = ['NEEDLE-LINKED-FOLDER', 'NEEDLE-SERVICE-BODY', 'NEEDLE-SERVICE-PATH', 'NEEDLE-QUOTE-TEXT', 'NEEDLE-ORIGIN-MODEL', 'Needle collection name', 'NEEDLE-CONFLICT-NOTE'];
  assert.ok(plaintextHits(directory, needles).length >= 5, 'fixture starts with plaintext knowledge data');
  await enable(service);
  // The durable activity log is outside encryption by design (ADR 014): it keeps URL origins and paths, so the service path may appear there only.
  const outside = hits => hits.filter(hit => !(hit.startsWith('/activity-log.jsonl') && hit.endsWith('NEEDLE-SERVICE-PATH')));
  assert.deepEqual(outside(plaintextHits(directory, needles)), []);
  // Still usable after encryption: cached service content and citation checks read decrypted state.
  assert.match(JSON.stringify(await run('services.read', { id: reference.id })), /NEEDLE-SERVICE-BODY/);
  const checked = await run('citations.check', { workspaceId, id: finding.id });
  assert.equal(checked.checked, 1);
  assert.deepEqual(outside(plaintextHits(directory, needles)), []);
});

test('(d) chunked upload parts stay in memory for encrypted profiles and locking discards them and the event log', async t => {
  const directory = profile(t);
  const service = open(t, directory);
  await enable(service);
  const transfers = new Transfers({ workspace: service });
  const bytes = Buffer.from('NEEDLE-UPLOAD-BODY '.repeat(100));
  const session = transfers.begin({ purpose: 'artifact', mimeType: 'text/plain', size: bytes.length, sha256: sha(bytes) }, human);
  transfers.append({ transferId: session.transferId, offset: 0, dataBase64: bytes.subarray(0, 1000).toString('base64') }, human);
  assert.deepEqual(plaintextHits(directory, ['NEEDLE-UPLOAD-BODY']), [], 'no part file on disk');
  transfers.append({ transferId: session.transferId, offset: 1000, dataBase64: bytes.subarray(1000).toString('base64') }, human);
  const committed = await transfers.commit({ transferId: session.transferId, title: 'Uploaded' }, human);
  assert.equal(committed.verified, true);
  assert.deepEqual(plaintextHits(directory, ['NEEDLE-UPLOAD-BODY']), [], 'the committed artifact is sealed');
  // Locking discards unfinished uploads and the retained events; a replay from before reports the lock.
  const pending = transfers.begin({ purpose: 'material', size: 4, sha256: sha(Buffer.from('abcd')) }, human);
  const log = new EventLog();
  const before = log.append({ type: 'command', status: 'succeeded' });
  log.append({ type: 'command', status: 'succeeded' });
  service.encryptionHooks = { beforeLock: async () => { transfers.discardAll(); log.reset('locked'); }, afterUnlock: async () => {} };
  await enc(service, 'encryption.lock');
  assert.throws(() => transfers.session(pending.transferId, human), error => error.code === 'not_found');
  log.append({ type: 'command', status: 'succeeded' });
  assert.equal(log.since(before.id).gap.reason, 'locked');
  // Export packages stay explicit plaintext exports.
  await enc(service, 'encryption.unlock', { method: 'passphrase', secret: 'correct horse battery staple' });
  await assert.rejects(service.execute('workspaces.exportPackage', { id: service.activeWorkspaceId, name: 'pkg' }, human), error => /acknowledgePlaintext|plaintext/i.test(error.message));
});

test('(e) payment records are sealed with the profile keys, follow enable, rotation, lock, restore and disable, and are unreadable while locked', async t => {
  const root = profile(t);
  const directory = join(root, 'workspace-data');
  mkdirSync(directory);
  const service = open(t, directory);
  const payments = new PaymentService({ directory: join(root, 'payments'), workspace: service });
  const file = () => JSON.parse(readFileSync(join(root, 'payments', 'payments.json'), 'utf8'));
  const record = (id, status) => ({ id, status, workspaceId: service.activeWorkspaceId, tabId: 1, attempt: 1, merchant: { name: 'Needle Shop', origin: 'https://needle-merchant.example' },
    destination: { url: 'https://needle-merchant.example/needle-checkout' }, purpose: 'NEEDLE-PAYMENT-PURPOSE', currency: 'USD', ceilingMinor: 6000, recurrence: { type: 'none' },
    observed: { totalMinor: 4999 }, attempts: [{ status: 'attempted', at: new Date().toISOString() }], history: [] });
  payments.init();
  payments.commit(() => { payments.records.push(record('pay_00000000-0000-4000-8000-000000000001', 'proposed')); });
  assert.equal(file().version, 1, 'a plaintext profile keeps plaintext payment records');
  const needles = ['needle-merchant.example', 'NEEDLE-PAYMENT-PURPOSE', 'needle-checkout'];
  assert.ok(plaintextHits(join(root, 'payments'), needles).length > 0);

  await enable(service);
  assert.equal(file().version, 2);
  assert.match(file().sealed, /^wfe1\.1\.0\./, 'one AES-GCM envelope under data key version 1');
  assert.deepEqual(plaintextHits(join(root, 'payments'), needles), [], 'no plaintext payment data remains in the payments folder');
  assert.equal(payments.records.length, 1);
  // An attempt in flight when the profile locks becomes uncertain at the next unlock (the sweep needs the key).
  payments.commit(() => { payments.records.push(record('pay_00000000-0000-4000-8000-000000000002', 'submitting')); });
  await enc(service, 'encryption.lock');
  assert.throws(() => payments.records, error => error.code === 'locked', 'payment reads are blocked while locked');
  assert.equal(payments.holdsTab(1), false);
  assert.throws(() => new PaymentService({ directory: join(root, 'payments'), workspace: service }).records, error => error.code === 'locked');
  await enc(service, 'encryption.unlock', { method: 'passphrase', secret: 'correct horse battery staple' });
  assert.equal(payments.records.find(item => item.id.endsWith('2')).status, 'uncertain');
  const backup = await service.execute('backups.create', { note: 'before rotation' });

  // Data-key rotation re-seals the file before the old key is dropped.
  await enc(service, 'encryption.rotate', { target: 'dataKey' });
  assert.match(file().sealed, /^wfe1\.2\.0\./);
  payments.records = null;
  assert.equal(payments.records.length, 2);
  // Restoring a backup whose keyring predates the rotation: the records held in memory are sealed under the restored keys.
  await service.execute('backups.restore', { id: backup.id });
  assert.match(file().sealed, /^wfe1\.1\.0\./);
  payments.records = null;
  assert.equal(payments.records.length, 2);

  // Tampering is detected, never silently accepted.
  const saved = file();
  const tampered = Buffer.from(saved.sealed.split('.').pop(), 'base64');
  tampered[20] ^= 1;
  writeFileSync(join(root, 'payments', 'payments.json'), JSON.stringify({ ...saved, sealed: `${saved.sealed.split('.').slice(0, 3).join('.')}.${tampered.toString('base64')}` }));
  payments.records = null;
  assert.throws(() => payments.records, error => error.code === 'component_integrity');
  writeFileSync(join(root, 'payments', 'payments.json'), JSON.stringify(saved));
  payments.records = null;

  // A plaintext file found in an encrypted profile (an interrupted enable or disable) is sealed at the next load.
  writeFileSync(join(root, 'payments', 'payments.json'), JSON.stringify({ version: 1, records: payments.records }));
  payments.records = null;
  assert.equal(payments.records.length, 2);
  assert.equal(file().version, 2);
  assert.deepEqual(plaintextHits(join(root, 'payments'), needles), []);

  // Turning encryption off writes plaintext payment records again.
  await enc(service, 'encryption.disable', { acknowledgePlaintext: true });
  assert.equal(file().version, 1);
  assert.equal(file().records.length, 2);
  payments.records = null;
  assert.equal(payments.records.length, 2);
});
