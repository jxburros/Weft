import { createCipheriv, createDecipheriv, createHash, createHmac, hkdfSync, randomBytes, randomUUID, scryptSync, timingSafeEqual } from 'node:crypto';
import { existsSync, lstatSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';
import { writeJsonDurable } from './atomic-json.js';

/**
 * Profile encryption primitives (ADR 014). Established mechanisms only:
 * AES-256-GCM and HMAC-SHA256/HKDF from node:crypto, scrypt for human
 * secrets, and Electron safeStorage (Keychain, DPAPI, libsecret/KWallet)
 * for the OS-protected wrap. No custom algorithms.
 *
 * Key hierarchy:
 *   profile key (random 256-bit) — wrapped by the OS key, a recovery key and an optional passphrase
 *     ├─ data keys (random 256-bit, versioned) — encrypt records, settings, request results and components
 *     └─ index key (random 256-bit) — keyed component locators and request fingerprints (stable across data-key rotation)
 */
export const KEYRING_FILE = 'encryption-keyring.json';
export const SEALED_PREFIX = 'wfe1.';
const ALGORITHM = 'aes-256-gcm';
const NONCE = 12;
const TAG = 16;
const COMPONENT_MAGIC = Buffer.from('WFC1');
const COMPONENT_HEADER = COMPONENT_MAGIC.length + 4;
export const KDF_DEFAULTS = Object.freeze({ passphrase: { N: 2 ** 17, r: 8, p: 1 }, recovery: { N: 2 ** 15, r: 8, p: 1 } });
const KDF_LIMITS = { minN: 2 ** 14, maxN: 2 ** 20 };
export const PASSPHRASE_MIN = 12;
const RECOVERY_BYTES = 23;
const BASE32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
const SEALED = /^wfe1\.(\d{1,9})\.(\d{1,15})\.([A-Za-z0-9+/]+={0,2})$/;

export const encryptionError = (code, message, extra = {}) => Object.assign(new Error(message), { code, ...extra });
export const lockedError = (reason = 'locked') => encryptionError('locked', `LOCKED: Weft's encrypted workspace data is locked${reason === 'os_key_unavailable' ? ' (the OS key could not unlock it on this computer or account)' : ''}. A person must unlock it in the Weft window (Settings > Encryption) with the OS key, the passphrase or the recovery key. Agents cannot unlock it.`, { notStarted: true, details: { reason } });
const integrity = what => encryptionError('component_integrity', `ENCRYPTION_INTEGRITY: ${what} failed authentication (modified, damaged or written under a different key). Nothing was changed; restore from a verified backup.`);
const wipe = buffer => { if (Buffer.isBuffer(buffer)) buffer.fill(0); };

// ---- AEAD ------------------------------------------------------------------------------
export function seal(key, plaintext, aad) {
  const nonce = randomBytes(NONCE);
  const cipher = createCipheriv(ALGORITHM, key, nonce, { authTagLength: TAG });
  cipher.setAAD(Buffer.from(aad));
  const body = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  return Buffer.concat([nonce, body, cipher.getAuthTag()]);
}
/** Returns the plaintext or null when authentication fails. */
export function open(key, sealed, aad) {
  if (!Buffer.isBuffer(sealed) || sealed.length < NONCE + TAG) return null;
  try {
    const decipher = createDecipheriv(ALGORITHM, key, sealed.subarray(0, NONCE), { authTagLength: TAG });
    decipher.setAAD(Buffer.from(aad));
    decipher.setAuthTag(sealed.subarray(sealed.length - TAG));
    return Buffer.concat([decipher.update(sealed.subarray(NONCE, sealed.length - TAG)), decipher.final()]);
  } catch { return null; }
}
const hkdf = (key, info) => Buffer.from(hkdfSync('sha256', key, Buffer.alloc(0), Buffer.from(info), 32));
export const isSealed = value => typeof value === 'string' && value.startsWith(SEALED_PREFIX);

// ---- Recovery keys and KDF -------------------------------------------------------------
function base32(bytes) {
  let bits = 0; let value = 0; let output = '';
  for (const byte of bytes) { value = (value << 8) | byte; bits += 8; while (bits >= 5) { output += BASE32[(value >>> (bits - 5)) & 31]; bits -= 5; } }
  if (bits > 0) output += BASE32[(value << (5 - bits)) & 31];
  return output;
}
function unbase32(text) {
  let bits = 0; let value = 0; const output = [];
  for (const char of text) {
    const index = BASE32.indexOf(char);
    if (index < 0) return null;
    value = (value << 5) | index; bits += 5;
    if (bits >= 8) { output.push((value >>> (bits - 8)) & 255); bits -= 8; }
  }
  return Buffer.from(output);
}
/** 184 random bits plus a 16-bit checksum, as ten groups of four base32 characters. */
export function generateRecoveryKey() {
  const random = randomBytes(RECOVERY_BYTES);
  const check = createHash('sha256').update(random).digest().subarray(0, 2);
  return base32(Buffer.concat([random, check])).match(/.{4}/g).join('-');
}
/** Recovery key bytes, or a typed error for a mistyped key (the checksum catches most typos before the KDF runs). */
export function parseRecoveryKey(input) {
  const text = String(input ?? '').toUpperCase().replace(/[\s-]/g, '').replace(/0/g, 'O').replace(/1/g, 'I').replace(/8/g, 'B');
  const bytes = text.length === 40 ? unbase32(text) : null;
  if (!bytes || bytes.length !== RECOVERY_BYTES + 2 || !createHash('sha256').update(bytes.subarray(0, RECOVERY_BYTES)).digest().subarray(0, 2).equals(bytes.subarray(RECOVERY_BYTES))) {
    throw encryptionError('key_invalid', 'KEY_INVALID: That is not a valid recovery key (ten groups of four characters). Check for a typo.');
  }
  return bytes.subarray(0, RECOVERY_BYTES);
}
function derive(secret, salt, params) {
  if (!Number.isSafeInteger(params.N) || params.N < KDF_LIMITS.minN || params.N > KDF_LIMITS.maxN || (params.N & (params.N - 1)) !== 0 || params.r !== 8 || ![1, 2, 3, 4].includes(params.p)) {
    throw encryptionError('component_integrity', 'ENCRYPTION_INTEGRITY: the keyring uses unsupported key-derivation parameters');
  }
  return scryptSync(secret, salt, 32, { N: params.N, r: params.r, p: params.p, maxmem: 160 * params.N * params.r * params.p + 1024 * 1024 });
}

// ---- OS key protector (Electron safeStorage abstraction) -------------------------------
/**
 * Describe and use the OS credential store through Electron safeStorage.
 * On Linux, the `basic_text` backend means no secret service is running and
 * Chromium would use a hard-coded key: Weft refuses to treat that as protection.
 */
export function createKeyProtector({ safeStorage = null, platform = process.platform } = {}) {
  const describe = () => {
    const fallback = platform === 'darwin' ? 'keychain' : platform === 'win32' ? 'dpapi' : null;
    if (!safeStorage) return { available: false, backend: null, protects: false, reason: 'OS key storage is not available in this process.' };
    let available = false;
    try { available = Boolean(safeStorage.isEncryptionAvailable()); } catch { available = false; }
    let backend = fallback;
    if (platform === 'linux') { try { backend = safeStorage.getSelectedStorageBackend?.() ?? 'unknown'; } catch { backend = 'unknown'; } }
    if (backend === 'basic_text') return { available, backend, protects: false, reason: 'No OS secret service (libsecret or KWallet) is running, so Chromium would use a hard-coded key. Weft does not treat that as protection.' };
    if (!available) return { available: false, backend, protects: false, reason: 'The operating system did not provide a key store (Keychain, DPAPI, libsecret or KWallet).' };
    if (platform === 'linux' && !/^(gnome_libsecret|kwallet\d?)$/.test(String(backend))) return { available: true, backend, protects: false, reason: `Unrecognized OS key store backend (${String(backend).slice(0, 40)}).` };
    return { available: true, backend, protects: true, reason: null };
  };
  return {
    describe,
    wrap(secret) {
      const status = describe();
      if (!status.protects) throw encryptionError('unavailable', `OS key storage cannot protect the key: ${status.reason}`);
      return { backend: status.backend, data: Buffer.from(safeStorage.encryptString(secret.toString('base64'))).toString('base64') };
    },
    unwrap(record) {
      const status = describe();
      if (!status.protects) throw encryptionError('unavailable', `OS key storage is unavailable: ${status.reason}`);
      let text;
      try { text = safeStorage.decryptString(Buffer.from(record.data, 'base64')); }
      catch { throw encryptionError('unavailable', 'The OS key store could not unwrap the profile key (different computer or account, or access was denied).'); }
      const key = Buffer.from(String(text), 'base64');
      if (key.length !== 32) throw encryptionError('unavailable', 'The OS key store returned an unusable key.');
      return key;
    },
  };
}

// ---- Keyring ---------------------------------------------------------------------------
const b64 = z.string().max(4096).regex(/^[A-Za-z0-9+/]*={0,2}$/);
const kdf = z.strictObject({ N: z.number().int(), r: z.number().int(), p: z.number().int() });
const secretWrap = z.strictObject({ kdf, salt: b64, data: b64, createdAt: z.string().max(40) });
const keyringSchema = z.strictObject({
  format: z.literal('weft-keyring'), version: z.literal(1), profileId: z.string().uuid(), createdAt: z.string().max(40), updatedAt: z.string().max(40),
  unlockMode: z.enum(['os', 'manual']),
  wrappers: z.strictObject({ os: z.strictObject({ backend: z.string().max(40), data: b64, createdAt: z.string().max(40) }).optional(), recovery: secretWrap, passphrase: secretWrap.optional() }),
  indexKey: b64, dataKeys: z.array(z.strictObject({ version: z.number().int().min(1).max(1e9), data: b64, createdAt: z.string().max(40) })).min(1).max(8),
  currentVersion: z.number().int().min(1),
  rotation: z.strictObject({ from: z.number().int().min(1), to: z.number().int().min(1), startedAt: z.string().max(40) }).optional(),
  pending: z.strictObject({ operation: z.enum(['enable', 'disable']), startedAt: z.string().max(40) }).optional(),
});
const wrapAad = (profileId, kind, params) => `weft-keyring/v1\u0000${profileId}\u0000wrap\u0000${kind}\u0000${params ? `${params.N}/${params.r}/${params.p}` : ''}`;
const keyAad = (profileId, kind, version = 0) => `weft-keyring/v1\u0000${profileId}\u0000${kind}\u0000${version}`;

export function readKeyring(directory) {
  const path = join(directory, KEYRING_FILE);
  const stat = lstatSync(path, { throwIfNoEntry: false });
  if (!stat) return null;
  if (!stat.isFile() || stat.size > 256 * 1024) throw encryptionError('component_integrity', `ENCRYPTION_INTEGRITY: ${KEYRING_FILE} is not a regular keyring file`);
  try { return keyringSchema.parse(JSON.parse(readFileSync(path, 'utf8'))); }
  catch { throw encryptionError('component_integrity', `ENCRYPTION_INTEGRITY: ${KEYRING_FILE} is unreadable or unsupported. Restore it from a backup; without it the encrypted data cannot be read.`); }
}
export function writeKeyring(directory, keyring) { writeJsonDurable(join(directory, KEYRING_FILE), keyringSchema.parse(keyring)); }
export function removeKeyring(directory) { rmSync(join(directory, KEYRING_FILE), { force: true }); }
export const keyringExists = directory => existsSync(join(directory, KEYRING_FILE));

function wrapSecret(profileId, kind, profileKey, secret, params, clock) {
  const salt = randomBytes(16);
  const kek = derive(secret, salt, params);
  try { return { kdf: { ...params }, salt: salt.toString('base64'), data: seal(kek, profileKey, wrapAad(profileId, kind, params)).toString('base64'), createdAt: new Date(clock()).toISOString() }; }
  finally { wipe(kek); }
}
function unwrapSecret(profileId, kind, record, secret) {
  const kek = derive(secret, Buffer.from(record.salt, 'base64'), record.kdf);
  try { return open(kek, Buffer.from(record.data, 'base64'), wrapAad(profileId, kind, record.kdf)); }
  finally { wipe(kek); }
}

/** Unwrapped key material for an unlocked profile. Kept in memory only; wiped on lock. */
export class ProfileKeys {
  constructor({ profileId, profileKey, indexKey, dataKeys, currentVersion }) {
    this.profileId = profileId;
    this.profileKey = profileKey;
    this.indexKey = indexKey;
    this.dataKeys = dataKeys;
    this.currentVersion = currentVersion;
    this.locatorKey = hkdf(indexKey, 'weft component locator v1');
    this.fingerprintKey = hkdf(indexKey, 'weft request fingerprint v1');
    // Embedding vectors are derived from text, not record versions: sealed under the stable index key so a data-key rotation leaves them alone.
    this.vectorKey = hkdf(indexKey, 'weft embedding vector v1');
    this.vectorDigestKey = hkdf(indexKey, 'weft embedding digest v1');
  }
  key(version) {
    const key = this.dataKeys.get(version);
    if (!key) throw encryptionError('component_integrity', `ENCRYPTION_INTEGRITY: data was written under key version ${version}, which this keyring does not hold`);
    return key;
  }
  /** Keyed component name: plaintext SHA-256 digests never appear on disk for encrypted profiles. */
  locator(hash) { return createHmac('sha256', this.locatorKey).update(`component\u0000${hash}`).digest('hex'); }
  fingerprint(digest) { return createHmac('sha256', this.fingerprintKey).update(`request\u0000${digest}`).digest('hex'); }
  /** Keyed digest of an embedding chunk's text digest, so a guessed chunk text cannot be confirmed from disk. */
  vectorDigest(digest) { return createHmac('sha256', this.vectorDigestKey).update(`vector\u0000${digest}`).digest('hex'); }
  /** One sealed embedding chunk (text digest and float32 vector); AAD binds workspace, record, version, chunk, model and dimensions. */
  sealVector(aad, payload) { return seal(this.vectorKey, payload, `weft/vector\u0000${this.profileId}\u0000${aad}`); }
  openVector(aad, sealed) {
    const plaintext = open(this.vectorKey, Buffer.from(sealed), `weft/vector\u0000${this.profileId}\u0000${aad}`);
    if (!plaintext) throw integrity('an embedding vector');
    return plaintext;
  }
  sealText(domain, json, revision = 0, version = this.currentVersion) {
    const sealed = seal(this.key(version), Buffer.from(json, 'utf8'), `weft/${domain.join('\u0000')}\u0000${this.profileId}\u0000${version}\u0000${revision}`);
    return `${SEALED_PREFIX}${version}.${revision}.${sealed.toString('base64')}`;
  }
  openText(domain, stored, what) {
    const match = typeof stored === 'string' ? SEALED.exec(stored) : null;
    if (!match) throw integrity(`${what} is not encrypted although the profile is; it`);
    const version = Number(match[1]);
    const revision = Number(match[2]);
    const plaintext = open(this.key(version), Buffer.from(match[3], 'base64'), `weft/${domain.join('\u0000')}\u0000${this.profileId}\u0000${version}\u0000${revision}`);
    if (!plaintext) throw integrity(what);
    return { json: plaintext.toString('utf8'), version, revision };
  }
  /** Records: AAD binds collection, id and the revision declared in the envelope; the decrypted record must carry that revision. */
  sealDoc(collection, id, json, revision) { return this.sealText(['record', collection, id], json, Number.isSafeInteger(revision) && revision >= 0 ? revision : 0); }
  openDoc(collection, id, stored) {
    const { json, revision } = this.openText(['record', collection, id], stored, `${collection} record ${String(id).slice(0, 80)}`);
    if (revision) { let parsed; try { parsed = JSON.parse(json); } catch { parsed = null; } if (parsed?.revision !== revision) throw integrity(`${collection} record ${String(id).slice(0, 80)} (revision mismatch)`); }
    return json;
  }
  sealMeta(key, json) { return this.sealText(['state', key], json); }
  openMeta(key, stored) { return this.openText(['state', key], stored, `setting ${key}`).json; }
  sealResult(scope, requestId, json) { return this.sealText(['request', scope, requestId], json); }
  openResult(scope, requestId, stored) { return this.openText(['request', scope, requestId], stored, 'stored request result').json; }
  versionOf(stored) { const match = typeof stored === 'string' ? SEALED.exec(stored) : null; return match ? Number(match[1]) : null; }
  reseal(domain, stored, what) {
    const { json, revision, version } = this.openText(domain, stored, what);
    return version === this.currentVersion ? stored : this.sealText(domain, json, revision);
  }
  sealComponent(id, bytes, version = this.currentVersion) {
    const header = Buffer.alloc(COMPONENT_HEADER);
    COMPONENT_MAGIC.copy(header); header.writeUInt32BE(version, COMPONENT_MAGIC.length);
    return Buffer.concat([header, seal(this.key(version), bytes, `weft/component\u0000${this.profileId}\u0000${version}\u0000${id}`)]);
  }
  componentVersion(file) { return file.length >= COMPONENT_HEADER && file.subarray(0, 4).equals(COMPONENT_MAGIC) ? file.readUInt32BE(4) : null; }
  openComponent(id, file) {
    const version = this.componentVersion(file);
    if (version === null) throw integrity(`stored component ${id.slice(0, 12)} is not encrypted although the profile is; it`);
    const plaintext = open(this.key(version), file.subarray(COMPONENT_HEADER), `weft/component\u0000${this.profileId}\u0000${version}\u0000${id}`);
    if (!plaintext) throw integrity(`stored component ${id.slice(0, 12)}`);
    return plaintext;
  }
  wipe() {
    wipe(this.profileKey); wipe(this.indexKey); wipe(this.locatorKey); wipe(this.fingerprintKey); wipe(this.vectorKey); wipe(this.vectorDigestKey);
    for (const key of this.dataKeys.values()) wipe(key);
    this.dataKeys = new Map();
  }
}

/** Create a new keyring: random profile, index and data keys; recovery wrap always; OS and passphrase wraps as chosen. */
export function createKeyring({ protector, unlockMode = 'os', passphrase = null, kdfParams = KDF_DEFAULTS, clock = Date.now }) {
  const profileId = randomUUID();
  const profileKey = randomBytes(32);
  const indexKey = randomBytes(32);
  const dataKey = randomBytes(32);
  const recoveryKey = generateRecoveryKey();
  const now = new Date(clock()).toISOString();
  const keyring = { format: 'weft-keyring', version: 1, profileId, createdAt: now, updatedAt: now, unlockMode,
    wrappers: { recovery: wrapSecret(profileId, 'recovery', profileKey, parseRecoveryKey(recoveryKey), kdfParams.recovery, clock) },
    indexKey: seal(profileKey, indexKey, keyAad(profileId, 'index')).toString('base64'),
    dataKeys: [{ version: 1, data: seal(profileKey, dataKey, keyAad(profileId, 'data', 1)).toString('base64'), createdAt: now }], currentVersion: 1 };
  if (passphrase !== null) keyring.wrappers.passphrase = wrapSecret(profileId, 'passphrase', profileKey, Buffer.from(String(passphrase).normalize('NFC')), kdfParams.passphrase, clock);
  if (unlockMode === 'os') keyring.wrappers.os = { ...protector.wrap(profileKey), createdAt: now };
  const keys = new ProfileKeys({ profileId, profileKey, indexKey, dataKeys: new Map([[1, dataKey]]), currentVersion: 1 });
  return { keyring, keys, recoveryKey };
}

/** Unwrap the profile key with one method, then every data key it protects. Wrong secrets fail with key_invalid. */
export function unlockKeyring(keyring, { method, secret, protector }) {
  const { profileId } = keyring;
  let profileKey;
  if (method === 'os') {
    if (!keyring.wrappers.os) throw encryptionError('unavailable', 'This profile does not use the OS key store; unlock with the passphrase or recovery key.');
    profileKey = protector.unwrap(keyring.wrappers.os);
  } else if (method === 'recovery') {
    profileKey = unwrapSecret(profileId, 'recovery', keyring.wrappers.recovery, parseRecoveryKey(secret));
    if (!profileKey) throw encryptionError('key_invalid', 'KEY_INVALID: The recovery key does not unlock this profile.');
  } else if (method === 'passphrase') {
    if (!keyring.wrappers.passphrase) throw encryptionError('key_invalid', 'KEY_INVALID: No passphrase is set for this profile; use the recovery key.');
    profileKey = unwrapSecret(profileId, 'passphrase', keyring.wrappers.passphrase, Buffer.from(String(secret ?? '').normalize('NFC')));
    if (!profileKey) throw encryptionError('key_invalid', 'KEY_INVALID: The passphrase does not unlock this profile.');
  } else throw encryptionError('invalid_arguments', 'Unknown unlock method');
  return keysFromProfileKey(keyring, profileKey);
}
export function keysFromProfileKey(keyring, profileKey) {
  const { profileId } = keyring;
  const indexKey = open(profileKey, Buffer.from(keyring.indexKey, 'base64'), keyAad(profileId, 'index'));
  if (!indexKey) { wipe(profileKey); throw encryptionError('key_invalid', 'KEY_INVALID: The key does not match this keyring.'); }
  const dataKeys = new Map();
  for (const entry of keyring.dataKeys) {
    const key = open(profileKey, Buffer.from(entry.data, 'base64'), keyAad(profileId, 'data', entry.version));
    if (!key) { wipe(profileKey); throw integrity(`data key version ${entry.version}`); }
    dataKeys.set(entry.version, key);
  }
  return new ProfileKeys({ profileId, profileKey: Buffer.from(profileKey), indexKey, dataKeys, currentVersion: keyring.currentVersion });
}
/** Re-wrap the same profile key (passphrase change, OS key re-enrolment). */
export function rewrapKeyring(keyring, keys, { protector, unlockMode = keyring.unlockMode, passphrase, kdfParams = KDF_DEFAULTS, clock = Date.now }) {
  const next = structuredClone(keyring);
  next.unlockMode = unlockMode;
  next.updatedAt = new Date(clock()).toISOString();
  if (passphrase === null) delete next.wrappers.passphrase;
  else if (passphrase !== undefined) next.wrappers.passphrase = wrapSecret(keyring.profileId, 'passphrase', keys.profileKey, Buffer.from(String(passphrase).normalize('NFC')), kdfParams.passphrase, clock);
  if (unlockMode === 'os') next.wrappers.os = { ...protector.wrap(keys.profileKey), createdAt: next.updatedAt };
  else delete next.wrappers.os;
  return next;
}
/**
 * Wrapping-key rotation: a new profile key and a new recovery key; the data
 * and index keys are re-wrapped (no data is rewritten). The old recovery key
 * and passphrase stop working for this keyring (older backups keep their own).
 */
export function rotateWrapping(keyring, keys, { protector, unlockMode = keyring.unlockMode, passphrase = null, kdfParams = KDF_DEFAULTS, clock = Date.now }) {
  const profileKey = randomBytes(32);
  const recoveryKey = generateRecoveryKey();
  const now = new Date(clock()).toISOString();
  const { profileId } = keyring;
  const next = { ...structuredClone(keyring), updatedAt: now, unlockMode,
    wrappers: { recovery: wrapSecret(profileId, 'recovery', profileKey, parseRecoveryKey(recoveryKey), kdfParams.recovery, clock) },
    indexKey: seal(profileKey, keys.indexKey, keyAad(profileId, 'index')).toString('base64'),
    dataKeys: keyring.dataKeys.map(entry => ({ ...entry, data: seal(profileKey, keys.key(entry.version), keyAad(profileId, 'data', entry.version)).toString('base64') })) };
  if (passphrase !== null) next.wrappers.passphrase = wrapSecret(profileId, 'passphrase', profileKey, Buffer.from(String(passphrase).normalize('NFC')), kdfParams.passphrase, clock);
  if (unlockMode === 'os') next.wrappers.os = { ...protector.wrap(profileKey), createdAt: now };
  // `keys` is left untouched: the caller applies the new profile key only after the keyring is saved,
  // and calls `discard` instead if saving fails, so memory never holds a key that exists nowhere on disk.
  return { keyring: next, recoveryKey,
    apply() { wipe(keys.profileKey); keys.profileKey = profileKey; },
    discard() { wipe(profileKey); } };
}
/** Begin data-key rotation: add a new data key and make it current; existing data is re-encrypted by a resumable job. */
/**
 * Returns the next keyring plus `apply`/`discard`. `keys` is not changed here: the caller applies
 * the new data key only after the keyring is saved, so a failed save can never leave records
 * sealed under a key version that exists only in memory.
 */
export function beginDataKeyRotation(keyring, keys, { clock = Date.now } = {}) {
  if (keyring.rotation) return { keyring, apply() {}, discard() {} };
  const version = Math.max(...keyring.dataKeys.map(entry => entry.version)) + 1;
  const dataKey = randomBytes(32);
  const now = new Date(clock()).toISOString();
  const next = { ...structuredClone(keyring), updatedAt: now, currentVersion: version, rotation: { from: keyring.currentVersion, to: version, startedAt: now },
    dataKeys: [...keyring.dataKeys, { version, data: seal(keys.profileKey, dataKey, keyAad(keyring.profileId, 'data', version)).toString('base64'), createdAt: now }] };
  return { keyring: next,
    apply() { keys.dataKeys.set(version, dataKey); keys.currentVersion = version; },
    discard() { wipe(dataKey); } };
}
/** Finish rotation once nothing remains under older data keys. */
export function finishDataKeyRotation(keyring, keys, { clock = Date.now } = {}) {
  const next = structuredClone(keyring);
  next.dataKeys = next.dataKeys.filter(entry => entry.version === next.currentVersion);
  delete next.rotation;
  next.updatedAt = new Date(clock()).toISOString();
  for (const [version, key] of keys.dataKeys) if (version !== next.currentVersion) { wipe(key); keys.dataKeys.delete(version); }
  return next;
}
export function checkRecoveryKey(keyring, recoveryKey) {
  const key = unwrapSecret(keyring.profileId, 'recovery', keyring.wrappers.recovery, parseRecoveryKey(recoveryKey));
  if (!key) return false;
  wipe(key);
  return true;
}
export const sameKey = (a, b) => Buffer.isBuffer(a) && Buffer.isBuffer(b) && a.length === b.length && timingSafeEqual(a, b);
