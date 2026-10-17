import { createHash, randomUUID } from 'node:crypto';
import { closeSync, copyFileSync, constants, existsSync, fsyncSync, lstatSync, mkdirSync, openSync, readdirSync, readFileSync, readSync, renameSync, rmSync, unlinkSync, writeFileSync, writeSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { syncDirectory } from './storage-safety.js';

export const MAX_COMPONENT_BYTES = 32 * 1024 * 1024;
export const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
const HEX = /^[0-9a-f]{64}$/;
const failure = (code, message) => Object.assign(new Error(`${code}: ${message}`), { code });
export const componentPath = (root, hash) => {
  if (!HEX.test(hash)) throw failure('COMPONENT_INTEGRITY', 'Invalid component digest');
  return join(root, hash.slice(0, 2), hash);
};
function fsyncFile(path) {
  const fd = openSync(path, 'r+');
  try { fsyncSync(fd); } finally { closeSync(fd); }
}
/**
 * Best-effort overwrite with zeros before unlinking. Copy-on-write
 * filesystems, SSD wear levelling, snapshots and external backups can still
 * retain earlier blocks; this never claims secure erasure (ADR 014).
 */
export function scrubFile(path) {
  let fd;
  try {
    const stat = lstatSync(path);
    if (!stat.isFile()) { rmSync(path, { force: true }); return; }
    fd = openSync(path, 'r+');
    const zeros = Buffer.alloc(Math.max(1, Math.min(stat.size, 1024 * 1024)));
    for (let offset = 0; offset < stat.size; offset += zeros.length) writeSync(fd, zeros, 0, Math.min(zeros.length, stat.size - offset), offset);
    fsyncSync(fd);
  } catch (error) { if (error.code !== 'ENOENT') throw error; } finally { if (fd !== undefined) closeSync(fd); }
  rmSync(path, { force: true });
}

/**
 * Immutable, content-addressed capture/file bytes kept outside the metadata
 * database. Writes are verified temporary files renamed into place; every
 * read re-verifies the SHA-256 digest of the content.
 *
 * Plaintext profiles name files by the content digest. Encrypted profiles
 * (a ProfileKeys object from src/encryption.js) name files by a keyed locator
 * (HMAC of the digest), so the digest of a known file cannot be confirmed
 * from disk, and store AES-256-GCM sealed bytes authenticated to that locator.
 * Callers address content by digest; `id(hash)` is the on-disk name that
 * component_refs records.
 */
export class ComponentStore {
  // Directories are created on first write so a refused open leaves no files behind.
  constructor(root, { keys = null } = {}) { this.root = root; this.keys = keys; }
  id(hash) {
    if (!HEX.test(hash)) throw failure('COMPONENT_INTEGRITY', 'Invalid component digest');
    return this.keys ? this.keys.locator(hash) : hash;
  }
  path(hash) { return componentPath(this.root, this.id(hash)); }
  pathOf(id) { return componentPath(this.root, id); }
  has(hash) {
    try { const stat = lstatSync(this.path(hash)); return stat.isFile(); } catch { return false; }
  }
  encode(id, bytes) { return this.keys ? this.keys.sealComponent(id, bytes) : bytes; }
  decode(id, file) { return this.keys ? this.keys.openComponent(id, file) : file; }
  put(bytes) {
    if (bytes.length > MAX_COMPONENT_BYTES) throw failure('COMPONENT_SIZE_LIMIT', `Stored components are limited to ${MAX_COMPONENT_BYTES / 1024 / 1024} MiB`);
    const hash = sha256(bytes);
    const id = this.id(hash);
    if (existsSync(this.pathOf(id))) {
      // An existing file must still be correct; repair a damaged copy from the bytes in hand.
      try { if (sha256(this.decode(id, readFileSync(this.pathOf(id)))) === hash) return { sha256: hash, size: bytes.length }; } catch { /* rewrite below */ }
    }
    this.writeFile(id, this.encode(id, bytes));
    return { sha256: hash, size: bytes.length };
  }
  writeFile(id, file) {
    const target = this.pathOf(id);
    mkdirSync(dirname(target), { recursive: true, mode: 0o700 });
    const temp = `${target}.${randomUUID()}.tmp`;
    try {
      writeFileSync(temp, file, { flag: 'wx', mode: 0o600 });
      fsyncFile(temp);
      if (!readFileSync(temp).equals(file)) throw failure('STORE_VERIFY_FAILED', 'Component verification failed before replacement');
      renameSync(temp, target);
      syncDirectory(dirname(target));
    } finally { if (existsSync(temp)) unlinkSync(temp); }
  }
  readFile(id, label = id) {
    try { return readFileSync(this.pathOf(id)); }
    catch (error) { if (error.code === 'ENOENT') throw failure('COMPONENT_MISSING', `Stored component ${label.slice(0, 12)} is missing; restore from a verified backup`); throw error; }
  }
  read(hash, size) {
    const id = this.id(hash);
    const bytes = this.decode(id, this.readFile(id, hash));
    if ((size !== undefined && bytes.length !== size) || sha256(bytes) !== hash) throw failure('COMPONENT_INTEGRITY', `Stored component ${hash.slice(0, 12)} failed SHA-256 verification; restore from a verified backup`);
    return bytes;
  }
  /** Verify a component by its on-disk name alone (digest name, or locator of the decrypted digest). */
  verifyId(id, size) {
    const bytes = this.decode(id, this.readFile(id));
    const hash = sha256(bytes);
    if ((size !== undefined && bytes.length !== size) || (this.keys ? this.keys.locator(hash) : hash) !== id) throw failure('COMPONENT_INTEGRITY', `Stored component ${id.slice(0, 12)} failed verification; restore from a verified backup`);
    return { sha256: hash, size: bytes.length };
  }
  /** Data-key rotation: re-seal one component under the current data key. False when already current or absent. */
  reseal(id) {
    if (!this.keys) return false;
    let file;
    try { file = readFileSync(this.pathOf(id)); } catch (error) { if (error.code === 'ENOENT') return false; throw error; }
    if (this.keys.componentVersion(file) === this.keys.currentVersion) return false;
    this.writeFile(id, this.keys.sealComponent(id, this.keys.openComponent(id, file)));
    return true;
  }
  /** Data-key version of a stored file (null for plaintext or missing files). */
  versionOf(id) {
    if (!this.keys) return null;
    let fd;
    try { fd = openSync(this.pathOf(id), 'r'); const header = Buffer.alloc(8); const read = readSyncSafe(fd, header); return this.keys.componentVersion(header.subarray(0, read)); }
    catch { return null; } finally { if (fd !== undefined) closeSync(fd); }
  }
  remove(id, { scrub = false } = {}) {
    if (scrub) { scrubFile(this.pathOf(id)); return; }
    try { unlinkSync(this.pathOf(id)); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
  /** Verified copy of the stored file (sealed bytes for encrypted profiles) into another directory, using copy-on-write clones where supported. Returns the file digest. */
  copyTo(id, root, size) {
    const expected = sha256(this.readFile(id));
    const target = componentPath(root, id);
    if (existsSync(target)) { try { if (sha256(readFileSync(target)) === expected) return expected; } catch { /* replace */ } }
    mkdirSync(dirname(target), { recursive: true, mode: 0o700 });
    const temp = `${target}.${randomUUID()}.tmp`;
    try {
      this.verifyId(id, size);
      copyFileSync(this.pathOf(id), temp, constants.COPYFILE_FICLONE);
      fsyncFile(temp);
      if (sha256(readFileSync(temp)) !== expected) throw failure('STORE_VERIFY_FAILED', 'Component copy verification failed');
      renameSync(temp, target);
    } finally { if (existsSync(temp)) unlinkSync(temp); }
    return expected;
  }
  /** Plaintext, digest-named copy for a transfer package (an explicit plaintext export). */
  exportTo(hash, root, size) {
    const bytes = this.read(hash, size);
    const target = componentPath(root, hash);
    mkdirSync(dirname(target), { recursive: true, mode: 0o700 });
    const temp = `${target}.${randomUUID()}.tmp`;
    try {
      writeFileSync(temp, bytes, { flag: 'wx', mode: 0o600 });
      fsyncFile(temp);
      renameSync(temp, target);
    } finally { if (existsSync(temp)) unlinkSync(temp); }
  }
  /** Every stored name and abandoned temporary file, for orphan recovery. */
  list() {
    const hashes = [];
    const temporary = [];
    for (const prefix of existsSync(this.root) ? readdirSync(this.root) : []) {
      const directory = join(this.root, prefix);
      if (!/^[0-9a-f]{2}$/.test(prefix) || !lstatSync(directory).isDirectory()) continue;
      for (const name of readdirSync(directory)) {
        if (HEX.test(name) && name.startsWith(prefix)) hashes.push(name);
        else if (name.endsWith('.tmp')) temporary.push(join(directory, name));
      }
    }
    return { hashes, temporary };
  }
  removeTemporary(paths, { scrub = false } = {}) { for (const path of paths) { if (scrub) scrubFile(path); else rmSync(path, { force: true }); } }
}
function readSyncSafe(fd, buffer) {
  let total = 0;
  for (let read; total < buffer.length && (read = readSync(fd, buffer, total, buffer.length - total, total)) > 0;) total += read;
  return total;
}
