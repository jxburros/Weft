import test from 'node:test';
import assert from 'node:assert/strict';
import { createKeyProtector, createKeyring, unlockKeyring, parseRecoveryKey, generateRecoveryKey, rewrapKeyring, rotateWrapping, beginDataKeyRotation, finishDataKeyRotation, checkRecoveryKey, keysFromProfileKey } from '../src/encryption.js';

import { fakeSafeStorage, kdfParams } from './encryption-helpers.js';

test('safeStorage abstraction reports the backend and refuses basic_text or unavailable stores', () => {
  const libsecret = createKeyProtector({ safeStorage: fakeSafeStorage(), platform: 'linux' }).describe();
  assert.deepEqual({ ...libsecret, reason: null }, { available: true, backend: 'gnome_libsecret', protects: true, reason: null });
  const basic = createKeyProtector({ safeStorage: fakeSafeStorage({ backend: 'basic_text' }), platform: 'linux' });
  assert.equal(basic.describe().protects, false);
  assert.match(basic.describe().reason, /hard-coded key/);
  assert.throws(() => basic.wrap(Buffer.alloc(32, 1)), error => error.code === 'unavailable');
  assert.equal(createKeyProtector({ safeStorage: fakeSafeStorage({ backend: 'unknown' }), platform: 'linux' }).describe().protects, false);
  assert.equal(createKeyProtector({ safeStorage: fakeSafeStorage({ available: false }), platform: 'win32' }).describe().protects, false);
  assert.deepEqual(createKeyProtector({ safeStorage: fakeSafeStorage(), platform: 'darwin' }).describe().backend, 'keychain');
  assert.deepEqual(createKeyProtector({ safeStorage: fakeSafeStorage(), platform: 'win32' }).describe().backend, 'dpapi');
  assert.equal(createKeyProtector({}).describe().available, false);
  // A wrapped key from another OS account cannot be unwrapped: typed unavailable, never a plaintext fallback.
  const wrapped = createKeyProtector({ safeStorage: fakeSafeStorage({ account: 'alice' }), platform: 'linux' }).wrap(Buffer.alloc(32, 7));
  assert.throws(() => createKeyProtector({ safeStorage: fakeSafeStorage({ account: 'mallory' }), platform: 'linux' }).unwrap(wrapped), error => error.code === 'unavailable');
  assert.deepEqual(createKeyProtector({ safeStorage: fakeSafeStorage({ account: 'alice' }), platform: 'linux' }).unwrap(wrapped), Buffer.alloc(32, 7));
});

test('recovery keys are high-entropy, checksummed and tolerant of case, spacing and look-alike digits', () => {
  const key = generateRecoveryKey();
  assert.match(key, /^(?:[A-Z2-7]{4}-){9}[A-Z2-7]{4}$/);
  assert.notEqual(generateRecoveryKey(), key);
  assert.equal(parseRecoveryKey(key.toLowerCase().replaceAll('-', ' ')).length, 23);
  assert.deepEqual(parseRecoveryKey(key.replaceAll('O', '0').replaceAll('I', '1')), parseRecoveryKey(key));
  const typo = key.slice(0, 5) + (key[5] === 'A' ? 'B' : 'A') + key.slice(6);
  assert.throws(() => parseRecoveryKey(typo), error => error.code === 'key_invalid' && /typo/.test(error.message));
  assert.throws(() => parseRecoveryKey('too short'), error => error.code === 'key_invalid');
});

test('keyring unlocks with each configured method and rejects wrong or tampered secrets', () => {
  const protector = createKeyProtector({ safeStorage: fakeSafeStorage(), platform: 'linux' });
  const { keyring, keys, recoveryKey } = createKeyring({ protector, unlockMode: 'os', passphrase: 'a long enough passphrase', kdfParams });
  assert.deepEqual(Object.keys(keyring.wrappers).sort(), ['os', 'passphrase', 'recovery']);
  // The keyring holds only wrapped keys.
  for (const key of [keys.profileKey, keys.indexKey, keys.key(1)]) assert.ok(!JSON.stringify(keyring).includes(key.toString('base64')));
  for (const [method, secret] of [['os'], ['passphrase', 'a long enough passphrase'], ['recovery', recoveryKey]]) {
    const unlocked = unlockKeyring(keyring, { method, secret, protector });
    assert.deepEqual(unlocked.key(1), keys.key(1));
    assert.equal(unlocked.locator('a'.repeat(64)), keys.locator('a'.repeat(64)));
  }
  assert.throws(() => unlockKeyring(keyring, { method: 'passphrase', secret: 'wrong passphrase here', protector }), error => error.code === 'key_invalid');
  assert.throws(() => unlockKeyring(keyring, { method: 'recovery', secret: generateRecoveryKey(), protector }), error => error.code === 'key_invalid');
  // Changing the KDF parameters, or any wrapped byte, fails authentication instead of deriving a weaker key.
  const downgraded = structuredClone(keyring);
  downgraded.wrappers.passphrase.kdf.N = 2 ** 15;
  assert.throws(() => unlockKeyring(downgraded, { method: 'passphrase', secret: 'a long enough passphrase', protector }), error => error.code === 'key_invalid');
  const tampered = structuredClone(keyring);
  const bytes = Buffer.from(tampered.dataKeys[0].data, 'base64'); bytes[20] ^= 1; tampered.dataKeys[0].data = bytes.toString('base64');
  assert.throws(() => unlockKeyring(tampered, { method: 'recovery', secret: recoveryKey, protector }), error => error.code === 'component_integrity');
  // Locked keys are wiped from memory.
  const unlocked = unlockKeyring(keyring, { method: 'os', protector });
  const reference = unlocked.key(1);
  unlocked.wipe();
  assert.ok(reference.every(byte => byte === 0));
});

test('sealed records bind collection, id and revision; tampering and transplanting are detected', () => {
  const protector = createKeyProtector({ safeStorage: fakeSafeStorage(), platform: 'linux' });
  const { keys } = createKeyring({ protector, unlockMode: 'manual', kdfParams });
  const doc = JSON.stringify({ id: 'mate_1', revision: 3, content: 'private' });
  const sealed = keys.sealDoc('materials', 'mate_1', doc, 3);
  assert.match(sealed, /^wfe1\.1\.3\./);
  assert.ok(!sealed.includes('private'));
  assert.equal(keys.openDoc('materials', 'mate_1', sealed), doc);
  assert.throws(() => keys.openDoc('materials', 'mate_2', sealed), error => error.code === 'component_integrity');
  assert.throws(() => keys.openDoc('context', 'mate_1', sealed), error => error.code === 'component_integrity');
  assert.throws(() => keys.openDoc('materials', 'mate_1', sealed.replace('wfe1.1.3.', 'wfe1.1.2.')), error => error.code === 'component_integrity');
  const flipped = sealed.slice(0, -6) + (sealed.at(-6) === 'A' ? 'B' : 'A') + sealed.slice(-5);
  assert.throws(() => keys.openDoc('materials', 'mate_1', flipped), error => error.code === 'component_integrity');
  // A plaintext row inside an encrypted store is rejected, not trusted.
  assert.throws(() => keys.openDoc('materials', 'mate_1', doc), error => error.code === 'component_integrity');
  // Revision declared in the envelope must match the record.
  assert.throws(() => keys.openDoc('materials', 'mate_1', keys.sealDoc('materials', 'mate_1', doc, 4)), /revision mismatch/);
  const file = keys.sealComponent('c'.repeat(64), Buffer.from('capture bytes'));
  assert.equal(keys.openComponent('c'.repeat(64), file).toString(), 'capture bytes');
  assert.throws(() => keys.openComponent('d'.repeat(64), file), error => error.code === 'component_integrity');
  file[file.length - 1] ^= 1;
  assert.throws(() => keys.openComponent('c'.repeat(64), file), error => error.code === 'component_integrity');
});

test('rewrap, wrapping rotation and data-key rotation keep data readable and retire old secrets', () => {
  const protector = createKeyProtector({ safeStorage: fakeSafeStorage(), platform: 'linux' });
  const { keyring, keys, recoveryKey } = createKeyring({ protector, unlockMode: 'os', kdfParams });
  const before = keys.sealDoc('notes', 'n1', '{"id":"n1"}', 0);
  const manual = rewrapKeyring(keyring, keys, { protector, unlockMode: 'manual', passphrase: 'twelve chars min', kdfParams });
  assert.equal(manual.wrappers.os, undefined);
  assert.throws(() => unlockKeyring(manual, { method: 'os', protector }), error => error.code === 'unavailable');
  assert.ok(checkRecoveryKey(manual, recoveryKey));
  const wrapping = rotateWrapping(manual, keys, { protector, unlockMode: 'manual', kdfParams });
  const { keyring: rotated, recoveryKey: next } = wrapping;
  const oldProfileKey = Buffer.from(keys.profileKey);
  assert.ok(keys.profileKey.equals(oldProfileKey), 'rotation does not change the live key before the keyring is saved');
  wrapping.apply();
  assert.equal(checkRecoveryKey(rotated, recoveryKey), false);
  assert.equal(rotated.wrappers.passphrase, undefined, 'omitting the passphrase removes it');
  const reopened = unlockKeyring(rotated, { method: 'recovery', secret: next, protector });
  assert.equal(reopened.openDoc('notes', 'n1', before), '{"id":"n1"}');
  assert.equal(reopened.locator('e'.repeat(64)), keys.locator('e'.repeat(64)), 'component locators survive wrapping rotation');
  const begun = beginDataKeyRotation(rotated, keys);
  const rotating = begun.keyring;
  assert.equal(keys.currentVersion, 1, 'the live data key changes only when the caller applies it');
  begun.apply();
  assert.deepEqual(rotating.rotation.from, 1);
  assert.equal(rotating.currentVersion, 2);
  const during = keysFromProfileKey(rotating, Buffer.from(keys.profileKey));
  assert.equal(during.openDoc('notes', 'n1', before), '{"id":"n1"}', 'old values stay readable mid-rotation');
  const resealed = during.reseal(['record', 'notes', 'n1'], before, 'note');
  assert.match(resealed, /^wfe1\.2\./);
  const finished = finishDataKeyRotation(rotating, during);
  assert.deepEqual(finished.dataKeys.map(entry => entry.version), [2]);
  assert.throws(() => during.openDoc('notes', 'n1', before), error => error.code === 'component_integrity');
  assert.equal(during.openDoc('notes', 'n1', resealed), '{"id":"n1"}');
});
