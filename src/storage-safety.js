import { createHash, randomUUID } from 'node:crypto';
import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, readdirSync, realpathSync, renameSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { hostname } from 'node:os';

const locks = new Map();
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
function failure(code, message) { return Object.assign(new Error(`${code}: ${message}`), { code }); }

// Exclusive creation works on all supported Node platforms. Never steal a lock:
// PID reuse and network filesystems make automatic stale-lock recovery unsafe.
export function acquireProfileLock(directory) {
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const path = join(realpathSync(directory), '.workspace.lock');
  let lock = locks.get(path);
  if (!lock) {
    const contents = JSON.stringify({ pid: process.pid, host: hostname(), createdAt: new Date().toISOString(), nonce: randomUUID() });
    try { writeFileSync(path, contents, { flag: 'wx', mode: 0o600 }); }
    catch (error) {
      if (error.code !== 'EEXIST') throw error;
      throw failure('STORE_LOCKED', `Workspace is already locked (${path}). Close other Weft processes. After a crash, verify no process uses this profile before removing this lock file.`);
    }
    lock = { contents, count: 0 }; locks.set(path, lock);
  }
  lock.count++;
  let released = false;
  return {
    assertOwned() {
      if (released || !existsSync(path) || readFileSync(path, 'utf8') !== lock.contents) throw failure('STORE_LOCKED', 'Workspace lock was lost; restart before writing.');
    },
    release() {
      if (released) return;
      released = true;
      if (--lock.count === 0) { removeOwnedLock(path, lock); locks.delete(path); }
    },
  };
}
function removeOwnedLock(path, lock) {
  try { if (readFileSync(path, 'utf8') === lock.contents) unlinkSync(path); } catch { /* Preserve any replacement lock. */ }
}
process.once('exit', () => { for (const [path, lock] of locks) removeOwnedLock(path, lock); });

export function fileStamp(path) {
  try {
    const before = statSync(path, { bigint: true });
    if (before.size > 100n * 1024n * 1024n) throw failure('STORE_SIZE_LIMIT', 'Workspace state exceeds supported 100 MiB size; existing state preserved.');
    const bytes = readFileSync(path);
    const stat = statSync(path, { bigint: true });
    const metadata = value => `${value.dev}:${value.ino}:${value.mtimeNs}:${value.ctimeNs}:${value.size}`;
    if (metadata(before) !== metadata(stat)) throw failure('STORE_CONFLICT', 'Workspace changed while being inspected; retry after reviewing external changes.');
    return `${metadata(stat)}:${hash(bytes)}`;
  } catch (error) { if (error.code === 'ENOENT') return null; throw error; }
}
export function assertUnchanged(path, expectedStamp) {
  if (fileStamp(path) !== expectedStamp) throw failure('STORE_CONFLICT', 'Workspace changed on disk. Original preserved; restart and review external changes before retrying.');
}
export function syncDirectory(directory) {
  let fd;
  try { fd = openSync(directory, 'r'); fsyncSync(fd); }
  catch (error) {
    // Windows does not expose directory fsync through Node. Other errors matter.
    if (!(process.platform === 'win32' && ['EISDIR', 'EPERM', 'EINVAL', 'EACCES'].includes(error.code))) throw error;
  } finally { if (fd !== undefined) closeSync(fd); }
}
export function writeVerifiedJson(path, serialized, expectedStamp) {
  const temp = `${path}.${randomUUID()}.tmp`;
  try {
    assertUnchanged(path, expectedStamp);
    writeFileSync(temp, serialized, { flag: 'wx', mode: 0o600 });
    const fd = openSync(temp, 'r+');
    try { fsyncSync(fd); } finally { closeSync(fd); }
    const written = readFileSync(temp, 'utf8');
    JSON.parse(written);
    if (written !== serialized) throw failure('STORE_VERIFY_FAILED', 'Temporary workspace verification failed; original preserved.');
    assertUnchanged(path, expectedStamp);
    renameSync(temp, path);
    try { syncDirectory(dirname(path)); }
    catch (error) { throw failure('STORE_DURABILITY_UNCERTAIN', `Workspace replacement completed but directory flush failed (${error.code}). Restart and inspect state before retrying.`); }
    const stamp = fileStamp(path);
    if (!stamp?.endsWith(`:${hash(serialized)}`)) throw failure('STORE_CONFLICT', 'Workspace changed immediately after replacement. Restart and review external changes.');
    return stamp;
  } finally { if (existsSync(temp)) unlinkSync(temp); }
}

export function storageWarnings(directory, environment = process.env) {
  const resolved = existsSync(directory) ? realpathSync(directory) : resolve(directory);
  const normalized = resolved.replaceAll('\\', '/').toLowerCase();
  const knownFolder = normalized.split('/').some(part => /^(dropbox(?: \(.+\))?|onedrive(?: ?- ?.+)?|google drive|googledrive(?:-.+)?|icloud ?drive|mobile documents|com~apple~clouddocs)$/.test(part));
  const configuredFolder = ['OneDrive', 'OneDriveConsumer', 'OneDriveCommercial', 'DROPBOX_HOME', 'GOOGLE_DRIVE_HOME', 'ICLOUD_DRIVE_HOME'].some(key => {
    if (!environment[key]) return false;
    const root = resolve(environment[key]).replaceAll('\\', '/').toLowerCase().replace(/\/$/, '');
    return normalized === root || normalized.startsWith(`${root}/`);
  });
  const warnings = [];
  if (knownFolder || configuredFolder) warnings.push({ code: 'SYNC_FOLDER', message: 'This profile appears to be in a cloud-synced folder. Chromium sessions and the JSON workspace store are not sync-safe. Move the profile to a local folder with Weft closed.' });
  if (existsSync(directory)) {
    for (const name of readdirSync(directory)) {
      // OneDrive can append only a device name, without the word "conflict".
      if (name !== 'workspace-state.json' && /^workspace-state.*\.json$/i.test(name)) warnings.push({ code: 'SYNC_CONFLICT_COPY', file: name, message: `Possible conflicted workspace copy requires human review: ${name}. It has been preserved; Weft will not merge or overwrite it.` });
      if (/workspace-state/i.test(name) && /\.(icloud|placeholder)$/i.test(name)) warnings.push({ code: 'SYNC_PLACEHOLDER', file: name, message: `Workspace placeholder requires download and human review: ${name}.` });
    }
  }
  return warnings;
}
