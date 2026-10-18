// Fast KDF parameters for tests only; production uses N = 2^17 (passphrase) and 2^15 (recovery key).
export const kdfParams = { passphrase: { N: 2 ** 14, r: 8, p: 1 }, recovery: { N: 2 ** 14, r: 8, p: 1 } };
/** Injectable stand-in for Electron safeStorage: reversible but opaque blobs bound to one "OS account". */
export function fakeSafeStorage({ backend = 'gnome_libsecret', available = true, account = 'alice' } = {}) {
  return {
    isEncryptionAvailable: () => available,
    getSelectedStorageBackend: () => backend,
    encryptString: text => Buffer.from(`${account}:${Buffer.from(text).toString('hex')}`),
    decryptString: blob => { const [owner, hex] = blob.toString().split(':'); if (owner !== account) throw new Error('Error while decrypting the ciphertext provided to safeStorage.decryptString.'); return Buffer.from(hex, 'hex').toString(); },
  };
}

