import { createHash, randomUUID } from 'node:crypto';
import { closeSync, copyFileSync, constants, existsSync, fsyncSync, lstatSync, mkdirSync, openSync, readdirSync, readFileSync, readSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join, relative, resolve, sep } from 'node:path';
import { z } from 'zod';
import { DatabaseSync } from './sqlite.js';
import { componentPath } from './components.js';
import { COMPONENTS_DIR, RECOVERY_DIR, STORE_FILE, STORE_SCHEMA_VERSION } from './store.js';
import { syncDirectory } from './storage-safety.js';
import { KEYRING_FILE } from './encryption.js';

export const BACKUPS_DIR = 'backups';
export const RESTORE_JOURNAL = 'restore-journal.json';
export const BACKUP_KINDS = Object.freeze(['manual', 'automatic']);
const ID = /^\d{8}T\d{6}Z-(?:manual|automatic)-[0-9a-f]{8}$/;
const COMPONENT_FILE = /^components\/([0-9a-f]{2})\/([0-9a-f]{64})$/;
const MAX_MANIFEST = 64 * 1024 * 1024;
const failure = (code, message) => Object.assign(new Error(`${code}: ${message}`), { code });
const manifestSchema = z.strictObject({
  format: z.literal('weft-backup'), formatVersion: z.union([z.literal(1), z.literal(2)]), id: z.string().regex(ID), kind: z.enum(BACKUP_KINDS),
  // Format 2: an encrypted profile's backup. Sealed components keep their keyed names and the keyring travels with the backup.
  encryption: z.strictObject({ profileId: z.string().uuid(), keyVersions: z.array(z.number().int().min(1)).max(8) }).optional(),
  createdAt: z.string().max(40), note: z.string().max(500), storeSchemaVersion: z.number().int().min(1), dataSchemaVersion: z.number().int().min(1).nullable(),
  counts: z.record(z.string().max(200), z.number().int().min(0)), contentDigest: z.string().regex(/^[0-9a-f]{64}$/),
  files: z.array(z.strictObject({ path: z.string().max(200), size: z.number().int().min(0), sha256: z.string().regex(/^[0-9a-f]{64}$/) })).min(1).max(1000000),
});

export function hashFile(path) {
  const hash = createHash('sha256');
  const fd = openSync(path, 'r');
  const buffer = Buffer.allocUnsafe(1024 * 1024);
  let size = 0;
  try { for (let read; (read = readSync(fd, buffer, 0, buffer.length, null)) > 0;) { hash.update(buffer.subarray(0, read)); size += read; } } finally { closeSync(fd); }
  return { sha256: hash.digest('hex'), size };
}
function fsyncPath(path) { const fd = openSync(path, 'r'); try { fsyncSync(fd); } catch (error) { if (!['EISDIR', 'EPERM', 'EINVAL', 'EACCES'].includes(error.code)) throw error; } finally { closeSync(fd); } }
const stamp = time => new Date(time).toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
function regularFile(path) {
  const stat = lstatSync(path, { throwIfNoEntry: false });
  if (!stat) return null;
  if (stat.isSymbolicLink() || !stat.isFile()) throw failure('BACKUP_INVALID', 'Backup contains a link or non-file entry');
  return stat;
}
function inspectDatabase(path) {
  const db = new DatabaseSync(path, { readOnly: true });
  try {
    const integrity = db.prepare('PRAGMA integrity_check').all().map(row => row.integrity_check);
    const storeSchemaVersion = db.prepare('PRAGMA user_version').get().user_version;
    const counts = Object.fromEntries(db.prepare('SELECT collection, count(*) AS count FROM records GROUP BY collection ORDER BY collection').all().map(row => [row.collection, row.count]));
    const refs = db.prepare('SELECT sha256, min(size) AS size FROM component_refs GROUP BY sha256').all();
    const schema = db.prepare("SELECT value FROM state_meta WHERE key = 'schemaVersion'").get();
    const encryption = db.prepare("SELECT value FROM store_info WHERE key = 'encryption'").get();
    return { integrity, storeSchemaVersion, counts, refs, dataSchemaVersion: schema ? JSON.parse(schema.value) : null, encryption: encryption ? JSON.parse(encryption.value) : null };
  } finally { db.close(); }
}

/** Consistent database snapshot plus copies of every referenced component, with a SHA-256 manifest. */
export function createBackup(storage, { kind = 'manual', note = '', clock = Date.now } = {}) {
  if (!BACKUP_KINDS.includes(kind)) throw failure('BACKUP_INVALID', 'Unsupported backup kind');
  const root = join(storage.directory, BACKUPS_DIR);
  mkdirSync(root, { recursive: true, mode: 0o700 });
  const createdAt = new Date(clock()).toISOString();
  const id = `${stamp(clock())}-${kind}-${randomUUID().slice(0, 8)}`;
  const temp = join(root, `.tmp-${randomUUID()}`);
  mkdirSync(temp, { mode: 0o700 });
  try {
    const database = join(temp, STORE_FILE);
    storage.vacuumInto(database);
    const inspected = inspectDatabase(database);
    if (inspected.integrity.join() !== 'ok') throw failure('BACKUP_INVALID', 'Snapshot failed its integrity check');
    const files = [{ path: STORE_FILE, ...hashFile(database) }];
    for (const ref of inspected.refs) {
      storage.components.copyTo(ref.sha256, join(temp, COMPONENTS_DIR), ref.size);
      // Encrypted profiles store sealed files under keyed names: the manifest records the file's own digest and size.
      files.push({ path: `${COMPONENTS_DIR}/${ref.sha256.slice(0, 2)}/${ref.sha256}`, ...hashFile(join(temp, COMPONENTS_DIR, ref.sha256.slice(0, 2), ref.sha256)) });
    }
    let encryption;
    if (inspected.encryption) {
      copyFileSync(join(storage.directory, KEYRING_FILE), join(temp, KEYRING_FILE));
      fsyncPath(join(temp, KEYRING_FILE));
      const keyring = JSON.parse(readFileSync(join(temp, KEYRING_FILE), 'utf8'));
      if (keyring.profileId !== inspected.encryption.profileId) throw failure('BACKUP_INVALID', 'The keyring does not match the encrypted database');
      files.push({ path: KEYRING_FILE, ...hashFile(join(temp, KEYRING_FILE)) });
      encryption = { profileId: keyring.profileId, keyVersions: keyring.dataKeys.map(entry => entry.version) };
    }
    const manifest = { format: 'weft-backup', formatVersion: encryption ? 2 : 1, id, kind, createdAt, note: String(note).slice(0, 500), storeSchemaVersion: inspected.storeSchemaVersion,
      dataSchemaVersion: inspected.dataSchemaVersion, counts: inspected.counts, contentDigest: storage.contentDigest(), files, ...(encryption && { encryption }) };
    writeFileSync(join(temp, 'manifest.json'), JSON.stringify(manifest, null, 2), { flag: 'wx', mode: 0o600 });
    fsyncPath(join(temp, 'manifest.json'));
    for (const directory of new Set(files.map(file => file.path.split('/').slice(0, -1).join('/')))) fsyncPath(join(temp, directory));
    renameSync(temp, join(root, id));
    syncDirectory(root);
  } catch (error) { rmSync(temp, { recursive: true, force: true }); throw error; }
  return verifyBackup(storage.directory, id);
}

function readManifest(directory, id) {
  if (typeof id !== 'string' || !ID.test(id)) throw failure('BACKUP_INVALID', 'Unknown backup identifier');
  const folder = join(directory, BACKUPS_DIR, id);
  const stat = lstatSync(folder, { throwIfNoEntry: false });
  if (!stat) throw Object.assign(failure('BACKUP_NOT_FOUND', 'Backup not found'), { code: 'not_found' });
  if (stat.isSymbolicLink() || !stat.isDirectory()) throw failure('BACKUP_INVALID', 'Backup is not a directory');
  const manifestStat = regularFile(join(folder, 'manifest.json'));
  if (!manifestStat || manifestStat.size > MAX_MANIFEST) throw failure('BACKUP_INVALID', 'Backup manifest is missing or too large');
  let manifest;
  try { manifest = manifestSchema.parse(JSON.parse(readFileSync(join(folder, 'manifest.json'), 'utf8'))); }
  catch { throw failure('BACKUP_INVALID', 'Backup manifest is unreadable or unsupported'); }
  if (manifest.id !== id) throw failure('BACKUP_INVALID', 'Backup manifest does not match its folder');
  return { folder, manifest };
}

/** Recompute every file digest, check database integrity and component completeness. Never modifies the backup. */
export function verifyBackup(directory, id) {
  const { folder, manifest } = readManifest(directory, id);
  const problems = [];
  const seen = new Set();
  let bytes = 0;
  for (const file of manifest.files) {
    const component = COMPONENT_FILE.exec(file.path);
    const keyringEntry = file.path === KEYRING_FILE && Boolean(manifest.encryption);
    if ((file.path !== STORE_FILE && !component && !keyringEntry) || (component && (component[2].slice(0, 2) !== component[1] || (!manifest.encryption && component[2] !== file.sha256))) || seen.has(file.path)) { problems.push({ path: file.path, problem: 'invalid path' }); continue; }
    seen.add(file.path);
    try {
      const stat = regularFile(join(folder, ...file.path.split('/')));
      if (!stat) { problems.push({ path: file.path, problem: 'missing' }); continue; }
      const actual = hashFile(join(folder, ...file.path.split('/')));
      bytes += actual.size;
      if (actual.size !== file.size || actual.sha256 !== file.sha256) problems.push({ path: file.path, problem: 'digest mismatch' });
    } catch (error) { problems.push({ path: file.path, problem: error.code === 'BACKUP_INVALID' ? 'not a regular file' : 'unreadable' }); }
  }
  let inspected = null;
  if (!problems.some(item => item.path === STORE_FILE) && seen.has(STORE_FILE)) {
    try {
      inspected = inspectDatabase(join(folder, STORE_FILE));
      if (inspected.integrity.join() !== 'ok') problems.push({ path: STORE_FILE, problem: 'integrity check failed' });
      if (inspected.storeSchemaVersion > STORE_SCHEMA_VERSION) problems.push({ path: STORE_FILE, problem: 'written by a newer Weft version' });
      for (const ref of inspected.refs) if (!seen.has(`${COMPONENTS_DIR}/${ref.sha256.slice(0, 2)}/${ref.sha256}`)) problems.push({ path: `${COMPONENTS_DIR}/${ref.sha256.slice(0, 2)}/${ref.sha256}`, problem: 'referenced component not in manifest' });
      if (Boolean(inspected.encryption) !== Boolean(manifest.encryption) || (manifest.encryption && inspected.encryption.profileId !== manifest.encryption.profileId)) problems.push({ path: STORE_FILE, problem: 'encryption state does not match the manifest' });
      if (manifest.encryption && !seen.has(KEYRING_FILE)) problems.push({ path: KEYRING_FILE, problem: 'missing' });
      else if (manifest.encryption && !problems.some(item => item.path === KEYRING_FILE)) {
        try { if (JSON.parse(readFileSync(join(folder, KEYRING_FILE), 'utf8')).profileId !== manifest.encryption.profileId) problems.push({ path: KEYRING_FILE, problem: 'keyring belongs to a different profile' }); }
        catch { problems.push({ path: KEYRING_FILE, problem: 'unreadable' }); }
      }
    } catch { problems.push({ path: STORE_FILE, problem: 'database unreadable' }); }
  } else if (!seen.has(STORE_FILE)) problems.push({ path: STORE_FILE, problem: 'missing' });
  return { id, kind: manifest.kind, createdAt: manifest.createdAt, note: manifest.note, counts: inspected?.counts ?? manifest.counts, bytes, encrypted: Boolean(manifest.encryption),
    files: manifest.files.length, status: problems.length ? 'failed' : 'verified', problems: problems.slice(0, 1000), verifiedAt: new Date().toISOString() };
}

export function listBackups(directory) {
  const root = join(directory, BACKUPS_DIR);
  if (!existsSync(root)) return [];
  const items = [];
  for (const name of readdirSync(root)) {
    if (!ID.test(name)) continue;
    try {
      const { manifest } = readManifest(directory, name);
      items.push({ id: name, kind: manifest.kind, createdAt: manifest.createdAt, note: manifest.note, counts: manifest.counts, files: manifest.files.length, bytes: manifest.files.reduce((sum, file) => sum + file.size, 0), encrypted: Boolean(manifest.encryption), status: 'unverified' });
    } catch (error) { items.push({ id: name, kind: name.split('-')[1], createdAt: null, status: 'invalid', problem: error.message }); }
  }
  return items.sort((a, b) => b.id.localeCompare(a.id));
}
export function deleteBackup(directory, id) {
  readManifest(directory, id);
  const folder = join(directory, BACKUPS_DIR, id);
  const trash = join(directory, BACKUPS_DIR, `.tmp-${randomUUID()}`);
  renameSync(folder, trash);
  rmSync(trash, { recursive: true, force: true });
  return { id, deleted: true };
}
export function pruneBackups(directory, { kind = 'automatic', keep = 5 } = {}) {
  const removed = [];
  for (const backup of listBackups(directory).filter(item => item.kind === kind && item.status !== 'invalid').slice(keep)) { deleteBackup(directory, backup.id); removed.push(backup.id); }
  return removed;
}
/** Remove partially written backups. They never received a final name or manifest. */
export function cleanupBackupTemporary(directory) {
  const root = join(directory, BACKUPS_DIR);
  if (!existsSync(root)) return;
  for (const name of readdirSync(root)) if (/^\.tmp-[0-9a-f-]{36}$/.test(name)) rmSync(join(root, name), { recursive: true, force: true });
}

const journalSchema = z.strictObject({ format: z.literal('weft-restore-journal'), version: z.literal(1), backupId: z.string().regex(ID),
  recoveryDir: z.string().regex(/^recovery\/pre-restore-\d{8}T\d{6}Z-[0-9a-f]{8}$/), staging: z.string().regex(/^restore-staging-[0-9a-f-]{36}$/),
  state: z.enum(['preserving', 'staging', 'swapping']), startedAt: z.string().max(40) });
function writeJournal(directory, journal) {
  const path = join(directory, RESTORE_JOURNAL);
  const temp = `${path}.${randomUUID()}.tmp`;
  writeFileSync(temp, JSON.stringify(journalSchema.parse(journal)), { flag: 'wx', mode: 0o600 });
  fsyncPath(temp);
  renameSync(temp, path);
  syncDirectory(directory);
}
const LIVE = [STORE_FILE, `${STORE_FILE}-wal`, `${STORE_FILE}-shm`, `${STORE_FILE}-journal`, COMPONENTS_DIR, KEYRING_FILE];

/**
 * Journaled restore. The current database and components are moved, never
 * deleted, into recovery/pre-restore-*; the backup is staged and verified
 * before it replaces them. Every step can resume after interruption.
 * The caller must not hold the database open.
 */
export function restoreBackup(directory, id, { clock = Date.now, onStep = () => {} } = {}) {
  if (existsSync(join(directory, RESTORE_JOURNAL))) throw failure('RESTORE_PENDING', 'An interrupted restore must be recovered before starting another; restart Weft');
  const verification = verifyBackup(directory, id);
  if (verification.status !== 'verified') throw Object.assign(failure('BACKUP_INVALID', `Backup failed verification (${verification.problems.map(item => `${item.path}: ${item.problem}`).slice(0, 5).join('; ')}); nothing was changed`), { verification });
  const journal = { format: 'weft-restore-journal', version: 1, backupId: id, recoveryDir: `${RECOVERY_DIR}/pre-restore-${stamp(clock())}-${randomUUID().slice(0, 8)}`,
    staging: `restore-staging-${randomUUID()}`, state: 'preserving', startedAt: new Date(clock()).toISOString() };
  writeJournal(directory, journal);
  continueRestore(directory, journal, onStep);
  return { restored: id, preservedOriginal: journal.recoveryDir, verification };
}
function continueRestore(directory, journal, onStep) {
  const recoveryDir = join(directory, ...journal.recoveryDir.split('/'));
  const staging = join(directory, journal.staging);
  if (journal.state === 'preserving') {
    mkdirSync(recoveryDir, { recursive: true, mode: 0o700 });
    for (const name of LIVE) if (existsSync(join(directory, name))) renameSync(join(directory, name), join(recoveryDir, name));
    syncDirectory(directory);
    onStep('preserved');
    writeJournal(directory, { ...journal, state: 'staging' }); journal.state = 'staging';
  }
  if (journal.state === 'staging') {
    const { folder, manifest } = readManifest(directory, journal.backupId);
    rmSync(staging, { recursive: true, force: true });
    mkdirSync(staging, { mode: 0o700 });
    for (const file of manifest.files) {
      const source = join(folder, ...file.path.split('/'));
      const target = file.path === STORE_FILE || file.path === KEYRING_FILE ? join(staging, file.path) : componentPath(join(staging, COMPONENTS_DIR), file.path.split('/')[2]);
      mkdirSync(join(target, '..'), { recursive: true, mode: 0o700 });
      regularFile(source);
      copyFileSync(source, target, constants.COPYFILE_FICLONE);
      const actual = hashFile(target);
      if (actual.sha256 !== file.sha256 || actual.size !== file.size) throw failure('BACKUP_INVALID', `Backup file changed during restore: ${file.path}; originals remain preserved in ${journal.recoveryDir}`);
      fsyncPath(target);
    }
    onStep('staged');
    writeJournal(directory, { ...journal, state: 'swapping' }); journal.state = 'swapping';
  }
  if (journal.state === 'swapping') {
    for (const name of [COMPONENTS_DIR, KEYRING_FILE, STORE_FILE]) {
      if (!existsSync(join(staging, name))) continue;
      if (existsSync(join(directory, name))) renameSync(join(directory, name), join(recoveryDir, `${name}.unexpected-${randomUUID().slice(0, 8)}`));
      renameSync(join(staging, name), join(directory, name));
    }
    syncDirectory(directory);
    onStep('swapped');
    rmSync(staging, { recursive: true, force: true });
  }
  rmSync(join(directory, RESTORE_JOURNAL), { force: true });
  syncDirectory(directory);
}
/** Complete an interrupted restore at startup, before the database is opened. */
export function recoverInterruptedRestore(directory) {
  const path = join(directory, RESTORE_JOURNAL);
  if (!existsSync(path)) return null;
  let journal;
  try { journal = journalSchema.parse(JSON.parse(readFileSync(path, 'utf8'))); }
  catch { throw failure('RESTORE_INCOMPLETE', `Restore journal ${RESTORE_JOURNAL} is unreadable. Originals are preserved under ${RECOVERY_DIR}/; review the profile before removing the journal.`); }
  const recoveryDir = resolve(directory, ...journal.recoveryDir.split('/'));
  if (relative(resolve(directory), recoveryDir).startsWith(`..${sep}`)) throw failure('RESTORE_INCOMPLETE', 'Restore journal points outside the profile');
  try { continueRestore(directory, journal, () => {}); }
  catch (error) { throw failure('RESTORE_INCOMPLETE', `An interrupted restore could not be completed (${error.message}). Originals are preserved in ${journal.recoveryDir}.`); }
  return { recovered: journal.backupId, preservedOriginal: journal.recoveryDir };
}
