import { createHash, randomUUID } from 'node:crypto';
import { closeSync, copyFileSync, constants, existsSync, fsyncSync, lstatSync, mkdirSync, openSync, readdirSync, readFileSync, renameSync, rmSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
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
 * Immutable, content-addressed capture/file bytes kept outside the metadata
 * database. Names are SHA-256 digests; writes are verified temporary files
 * renamed into place; every read re-verifies the digest.
 */
export class ComponentStore {
  // Directories are created on first write so a refused open leaves no files behind.
  constructor(root) { this.root = root; }
  path(hash) { return componentPath(this.root, hash); }
  has(hash) {
    try { const stat = lstatSync(this.path(hash)); return stat.isFile(); } catch { return false; }
  }
  put(bytes) {
    if (bytes.length > MAX_COMPONENT_BYTES) throw failure('COMPONENT_SIZE_LIMIT', `Stored components are limited to ${MAX_COMPONENT_BYTES / 1024 / 1024} MiB`);
    const hash = sha256(bytes);
    const target = this.path(hash);
    if (existsSync(target)) {
      // An existing file must still be correct; repair a damaged copy from the bytes in hand.
      try { if (statSync(target).size === bytes.length && sha256(readFileSync(target)) === hash) return { sha256: hash, size: bytes.length }; } catch { /* rewrite below */ }
    }
    mkdirSync(dirname(target), { recursive: true, mode: 0o700 });
    const temp = `${target}.${randomUUID()}.tmp`;
    try {
      writeFileSync(temp, bytes, { flag: 'wx', mode: 0o600 });
      fsyncFile(temp);
      if (sha256(readFileSync(temp)) !== hash) throw failure('STORE_VERIFY_FAILED', 'Component verification failed before replacement');
      renameSync(temp, target);
      syncDirectory(dirname(target));
    } finally { if (existsSync(temp)) unlinkSync(temp); }
    return { sha256: hash, size: bytes.length };
  }
  read(hash, size) {
    let bytes;
    try { bytes = readFileSync(this.path(hash)); }
    catch (error) { if (error.code === 'ENOENT') throw failure('COMPONENT_MISSING', `Stored component ${hash.slice(0, 12)} is missing; restore from a verified backup`); throw error; }
    if ((size !== undefined && bytes.length !== size) || sha256(bytes) !== hash) throw failure('COMPONENT_INTEGRITY', `Stored component ${hash.slice(0, 12)} failed SHA-256 verification; restore from a verified backup`);
    return bytes;
  }
  remove(hash) { try { unlinkSync(this.path(hash)); } catch (error) { if (error.code !== 'ENOENT') throw error; } }
  /** Verified copy into another component directory, using copy-on-write clones where the filesystem supports them. */
  copyTo(hash, root, size) {
    const target = componentPath(root, hash);
    if (existsSync(target)) { try { if (sha256(readFileSync(target)) === hash) return; } catch { /* replace */ } }
    mkdirSync(dirname(target), { recursive: true, mode: 0o700 });
    const temp = `${target}.${randomUUID()}.tmp`;
    try {
      this.read(hash, size);
      copyFileSync(this.path(hash), temp, constants.COPYFILE_FICLONE);
      fsyncFile(temp);
      if (sha256(readFileSync(temp)) !== hash) throw failure('STORE_VERIFY_FAILED', 'Component copy verification failed');
      renameSync(temp, target);
    } finally { if (existsSync(temp)) unlinkSync(temp); }
  }
  /** Every stored digest and abandoned temporary file, for orphan recovery. */
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
  removeTemporary(paths) { for (const path of paths) rmSync(path, { force: true }); }
}
