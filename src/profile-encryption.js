import { existsSync, lstatSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from './sqlite.js';
import { ComponentStore, scrubFile } from './components.js';
import { COMPONENTS_DIR, MetadataStore, RECOVERY_DIR, STORE_FILE } from './store.js';
import { KDF_DEFAULTS, KEYRING_FILE, PASSPHRASE_MIN, beginDataKeyRotation, checkRecoveryKey, createKeyProtector, createKeyring, encryptionError, finishDataKeyRotation,
  keysFromProfileKey, readKeyring, removeKeyring, rewrapKeyring, rotateWrapping, unlockKeyring, writeKeyring } from './encryption.js';

const BACKUPS_DIR = 'backups';
const TRANSFERS_DIR = 'transfers';
/** What encryption covers and what it does not (shown in status and Settings; ADR 014). */
export const ENCRYPTION_COVERAGE = Object.freeze({
  encrypted: Object.freeze([
    'Project records: notes, context, tasks, conversations, turn manifests, workflows, site rules, handoffs, artifact metadata and annotations',
    'Captured page text, screenshots and stored files (component files, under keyed names)',
    'Workspace settings, browser tab list (URLs and titles) and visit history',
    'Retained request results; request fingerprints are keyed',
    'Backups made while encryption is on (they carry their own keyring)',
  ]),
  notEncrypted: Object.freeze([
    'Record identifiers, collection names, workspace identifiers, record counts and order, component sizes and file timestamps',
    'The full-text search index is never written to disk; it is rebuilt in memory after unlock',
    'Chromium sessions, cookies, caches, site storage and downloads (Chromium encrypts cookies with the OS key store on some platforms; Weft does not claim it)',
    'Durable activity log (command names, actors, identifiers, URL origins and paths, character counts; no record content), approval previews, agent grants, autonomy policy, model connection settings, plugin and extension state, threat-intelligence and download-safety files',
    'Plaintext copies made before encryption was turned on (older backups, recovery copies, export packages) until you remove them',
    'Exports you confirm as plaintext, OS swap/hibernation files, crash dumps and anything another program copies while Weft is unlocked',
  ]),
  threatModel: 'Protects data at rest from someone who obtains the powered-off disk, a copied profile or backup, or another local account without access to this account’s OS key store. It does not protect against malware or another program running as you, a compromised OS, or anyone using the computer while Weft is unlocked.',
});

function sizeOf(path) {
  const stat = lstatSync(path, { throwIfNoEntry: false });
  if (!stat) return 0;
  if (!stat.isDirectory()) return stat.size;
  return readdirSync(path).reduce((sum, name) => sum + sizeOf(join(path, name)), 0);
}
function scrubTree(path) {
  const stat = lstatSync(path, { throwIfNoEntry: false });
  if (!stat) return;
  if (stat.isDirectory()) { for (const name of readdirSync(path)) scrubTree(join(path, name)); rmSync(path, { recursive: true, force: true }); }
  else if (stat.isFile()) scrubFile(path);
  else rmSync(path, { force: true });
}
function databaseEncrypted(path) {
  try { return Boolean(MetadataStore.encryptionInfo(path)); } catch { return false; }
}
function vacuumDatabase(path) {
  const db = new DatabaseSync(path);
  try { db.exec('PRAGMA secure_delete = ON'); db.prepare('PRAGMA wal_checkpoint(TRUNCATE)').get(); db.exec('VACUUM'); db.prepare('PRAGMA wal_checkpoint(TRUNCATE)').get(); }
  finally { db.close(); }
}
/** Remove component files the committed database does not reference, without needing a key (names are plaintext). */
function sweepUnreferenced(directory, { scrub }) {
  const path = join(directory, STORE_FILE);
  if (!existsSync(path)) return 0;
  const db = new DatabaseSync(path);
  let referenced;
  try { referenced = new Set(db.prepare('SELECT DISTINCT sha256 FROM component_refs').all().map(row => row.sha256)); } finally { db.close(); }
  const components = new ComponentStore(join(directory, COMPONENTS_DIR));
  const { hashes, temporary } = components.list();
  components.removeTemporary(temporary, { scrub });
  let removed = 0;
  for (const id of hashes) if (!referenced.has(id)) { components.remove(id, { scrub }); removed++; }
  return removed;
}

/**
 * Profile encryption state: keyring on disk, unwrapped keys in memory while
 * unlocked. The WorkspaceService owns one and opens its store with `keys`.
 */
export class ProfileEncryption {
  constructor({ directory, protector = createKeyProtector(), kdfParams = KDF_DEFAULTS, clock = Date.now }) {
    this.directory = directory;
    this.protector = protector;
    this.kdfParams = kdfParams;
    this.clock = clock;
    this.keyring = null;
    this.keys = null;
    this.lockReason = null;
    this.rotationError = null;
  }
  get enabled() { return Boolean(this.keyring) && !this.keyring.pending; }
  reload() { this.keyring = readKeyring(this.directory); return this.keyring; }

  /**
   * Startup recovery that needs no key: finish or roll back an interrupted
   * enable/disable, and overwrite unreferenced (possibly plaintext) component
   * files of an encrypted store. Returns what was recovered.
   */
  recoverPending() {
    const keyring = this.reload();
    const path = join(this.directory, STORE_FILE);
    let marker = null;
    try { marker = existsSync(path) ? MetadataStore.encryptionInfo(path) : null; }
    catch (error) {
      // A damaged database is reported by the normal open path; with a keyring present nothing may be rolled back or removed.
      if (keyring) throw encryptionError('component_integrity', `STORE_CORRUPT: Workspace database is unreadable or damaged (${error.message}). It and ${KEYRING_FILE} have been preserved unchanged; restore a verified backup with Weft closed.`);
    }
    if (!keyring) {
      if (marker) throw encryptionError('component_integrity', `ENCRYPTION_KEYRING_MISSING: the workspace database is encrypted but ${KEYRING_FILE} is missing. Nothing was changed; restore the keyring or a verified backup (weft store restore).`);
      return null;
    }
    let recovered = null;
    if (keyring.pending?.operation === 'enable') {
      if (marker?.profileId !== keyring.profileId) { removeKeyring(this.directory); this.keyring = null; sweepUnreferenced(this.directory, { scrub: false }); return { operation: 'enable', outcome: 'rolled_back' }; }
      vacuumDatabase(path);
      const { pending, ...active } = keyring;
      writeKeyring(this.directory, active);
      this.keyring = active;
      recovered = { operation: 'enable', outcome: 'completed' };
    } else if (keyring.pending?.operation === 'disable') {
      if (marker) { const { pending, ...active } = keyring; writeKeyring(this.directory, active); this.keyring = active; recovered = { operation: 'disable', outcome: 'rolled_back' }; }
      else { vacuumDatabase(path); removeKeyring(this.directory); this.keyring = null; sweepUnreferenced(this.directory, { scrub: false }); return { operation: 'disable', outcome: 'completed' }; }
    } else if (!marker) {
      throw encryptionError('component_integrity', `ENCRYPTION_MISMATCH: ${KEYRING_FILE} exists but the workspace database is not encrypted. Nothing was changed; review the profile (a restored plaintext database?) before removing the keyring.`);
    } else if (marker.profileId !== keyring.profileId) {
      throw encryptionError('component_integrity', 'ENCRYPTION_MISMATCH: the keyring belongs to a different profile than the workspace database. Nothing was changed; restore the matching keyring or backup.');
    }
    // Plaintext component files left by an interrupted migration are overwritten before anything else runs.
    sweepUnreferenced(this.directory, { scrub: true });
    return recovered;
  }
  /** OS-key unlock at startup when the profile is configured for it. False leaves the profile locked. */
  tryAutoUnlock() {
    if (!this.enabled) return true;
    if (this.keyring.unlockMode !== 'os' || !this.keyring.wrappers.os) { this.lockReason = 'unlock_required'; return false; }
    try { this.keys = unlockKeyring(this.keyring, { method: 'os', protector: this.protector }); this.lockReason = null; return true; }
    catch { this.lockReason = 'os_key_unavailable'; return false; }
  }
  unlock(method, secret) {
    if (!this.enabled) throw encryptionError('invalid_arguments', 'This profile is not encrypted');
    this.keys = unlockKeyring(this.keyring, { method, secret, protector: this.protector });
    this.lockReason = null;
    return this.keys;
  }
  /** After a restore, reuse the in-memory profile key when the restored keyring accepts it. */
  adoptRestored(previousKeys) {
    const keyring = this.reload();
    if (!keyring) { previousKeys?.wipe(); this.keys = null; return 'plaintext'; }
    if (previousKeys) {
      try { this.keys = keysFromProfileKey(keyring, Buffer.from(previousKeys.profileKey)); previousKeys.wipe(); return 'unlocked'; } catch { previousKeys.wipe(); }
    }
    this.keys = null;
    return this.tryAutoUnlock() ? 'unlocked' : 'locked';
  }
  forget() { this.keys?.wipe(); this.keys = null; }

  status({ locked, inventory = false } = {}) {
    const os = this.protector.describe();
    const keyring = this.keyring;
    return {
      enabled: this.enabled, locked: Boolean(locked), lockReason: locked ? this.lockReason ?? 'locked' : null,
      unlockMode: keyring?.unlockMode ?? null, keyVersion: keyring?.currentVersion ?? null,
      rotation: keyring?.rotation ? { ...keyring.rotation, lastError: this.rotationError } : null,
      methods: { os: { configured: Boolean(keyring?.wrappers.os), available: os.available, backend: os.backend, protects: os.protects, reason: os.reason },
        recovery: { configured: Boolean(keyring?.wrappers.recovery) }, passphrase: { configured: Boolean(keyring?.wrappers.passphrase) } },
      algorithms: { content: 'AES-256-GCM', keyWrap: 'AES-256-GCM', passphraseKdf: 'scrypt', locators: 'HMAC-SHA-256', osKeyStore: 'Electron safeStorage' },
      coverage: ENCRYPTION_COVERAGE,
      ...(inventory && { plaintextCopies: this.plaintextCopies() }),
    };
  }
  /** Files in the profile that hold plaintext project content outside the encrypted store. */
  plaintextCopies() {
    const items = [];
    const recovery = join(this.directory, RECOVERY_DIR);
    for (const name of existsSync(recovery) ? readdirSync(recovery) : []) {
      const path = join(recovery, name);
      const stat = lstatSync(path);
      const database = stat.isDirectory() ? join(path, STORE_FILE) : path;
      if (/\.sqlite$/.test(name) || existsSync(database) && stat.isDirectory()) { if (databaseEncrypted(database)) continue; }
      items.push({ kind: 'recovery', path: `${RECOVERY_DIR}/${name}`, bytes: sizeOf(path), removable: true });
    }
    const backups = join(this.directory, BACKUPS_DIR);
    for (const name of existsSync(backups) ? readdirSync(backups) : []) {
      const manifest = join(backups, name, 'manifest.json');
      if (!existsSync(manifest)) continue;
      let encrypted = false;
      try { encrypted = Boolean(JSON.parse(readFileSync(manifest, 'utf8')).encryption); } catch { /* listed as plaintext */ }
      if (!encrypted) items.push({ kind: 'backup', path: `${BACKUPS_DIR}/${name}`, bytes: sizeOf(join(backups, name)), removable: true });
    }
    const transfers = join(this.directory, TRANSFERS_DIR);
    for (const name of existsSync(transfers) ? readdirSync(transfers) : []) items.push({ kind: 'export_package', path: `${TRANSFERS_DIR}/${name}`, bytes: sizeOf(join(transfers, name)), removable: false });
    return items;
  }
  /** Overwrite then remove plaintext recovery copies and plaintext backups. Export packages are the person's explicit exports and stay. */
  removePlaintextCopies() {
    const removed = [];
    for (const item of this.plaintextCopies()) if (item.removable) { scrubTree(join(this.directory, ...item.path.split('/'))); removed.push(item.path); }
    return removed;
  }

  // ---- Lifecycle operations (called by WorkspaceService inside its queue) -------------
  enable(storage, { passphrase = null, unlockMode = 'os', onStep = () => {} }) {
    if (this.keyring) throw encryptionError('invalid_arguments', 'This profile is already encrypted');
    if (passphrase !== null && String(passphrase).length < PASSPHRASE_MIN) throw encryptionError('invalid_arguments', `Use a passphrase of at least ${PASSPHRASE_MIN} characters`);
    if (unlockMode === 'os' && !this.protector.describe().protects) throw encryptionError('unavailable', `OS key storage cannot protect the key here (${this.protector.describe().reason}). Choose “Unlock with passphrase or recovery key at startup”.`);
    const { keyring, keys, recoveryKey } = createKeyring({ protector: this.protector, unlockMode, passphrase, kdfParams: this.kdfParams, clock: this.clock });
    writeKeyring(this.directory, { ...keyring, pending: { operation: 'enable', startedAt: new Date(this.clock()).toISOString() } });
    onStep('keyring-pending');
    let plaintext;
    try { plaintext = storage.encryptInPlace(keys, { onStep }); }
    catch (error) {
      // Nothing committed: the plaintext store is unchanged; remove the keyring and sealed copies.
      if (!databaseEncrypted(storage.path)) { removeKeyring(this.directory); keys.wipe(); }
      throw error;
    }
    writeKeyring(this.directory, keyring);
    onStep('keyring-active');
    const plain = new ComponentStore(storage.components.root);
    for (const hash of plaintext) plain.remove(hash, { scrub: true });
    onStep('plaintext-scrubbed');
    this.keyring = keyring;
    this.keys = keys;
    return recoveryKey;
  }
  disable(storage, { onStep = () => {} }) {
    writeKeyring(this.directory, { ...this.keyring, pending: { operation: 'disable', startedAt: new Date(this.clock()).toISOString() } });
    onStep('keyring-pending');
    let sealed;
    try { sealed = storage.decryptInPlace({ onStep }); }
    catch (error) { if (databaseEncrypted(storage.path)) writeKeyring(this.directory, this.keyring); throw error; }
    removeKeyring(this.directory);
    onStep('keyring-removed');
    const store = new ComponentStore(storage.components.root);
    for (const id of sealed) store.remove(id);
    this.forget();
    this.keyring = null;
  }
  configure({ unlockMode, passphrase }) {
    if (passphrase !== undefined && passphrase !== null && String(passphrase).length < PASSPHRASE_MIN) throw encryptionError('invalid_arguments', `Use a passphrase of at least ${PASSPHRASE_MIN} characters`);
    const mode = unlockMode ?? this.keyring.unlockMode;
    if (mode === 'os' && !this.protector.describe().protects) throw encryptionError('unavailable', `OS key storage cannot protect the key here (${this.protector.describe().reason}).`);
    const next = rewrapKeyring(this.keyring, this.keys, { protector: this.protector, unlockMode: mode, passphrase, kdfParams: this.kdfParams, clock: this.clock });
    writeKeyring(this.directory, next);
    this.keyring = next;
  }
  rotateWrapping({ passphrase = null }) {
    if (passphrase !== null && String(passphrase).length < PASSPHRASE_MIN) throw encryptionError('invalid_arguments', `Use a passphrase of at least ${PASSPHRASE_MIN} characters`);
    const unlockMode = this.keyring.unlockMode === 'os' && this.protector.describe().protects ? 'os' : 'manual';
    const { keyring, recoveryKey } = rotateWrapping(this.keyring, this.keys, { protector: this.protector, unlockMode, passphrase, kdfParams: this.kdfParams, clock: this.clock });
    writeKeyring(this.directory, keyring);
    this.keyring = keyring;
    return recoveryKey;
  }
  beginDataKeyRotation() {
    const next = beginDataKeyRotation(this.keyring, this.keys, { clock: this.clock });
    writeKeyring(this.directory, next);
    this.keyring = next;
    this.rotationError = null;
  }
  finishDataKeyRotation() {
    const next = finishDataKeyRotation(this.keyring, this.keys, { clock: this.clock });
    writeKeyring(this.directory, next);
    this.keyring = next;
  }
  checkRecoveryKey(recoveryKey) { return checkRecoveryKey(this.keyring, recoveryKey); }
}
