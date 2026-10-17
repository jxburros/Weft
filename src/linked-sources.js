import { createHash, randomUUID } from 'node:crypto';
import { createReadStream, mkdirSync, readFileSync } from 'node:fs';
import { lstat, open, readdir, realpath, stat } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, normalize, relative, resolve, sep } from 'node:path';
import { fileStamp, writeVerifiedJson } from './storage-safety.js';

/**
 * Permission-scoped linked files/folders and refreshable service references (#22).
 *
 * A person chooses a file or folder; Weft records a link (real path, size, mtime,
 * inode, SHA-256 or folder manifest hash) instead of copying it. Status checks report
 * available, changed, moved, missing or inaccessible without granting any other
 * filesystem access. Agents read linked content only through the link record:
 * bounded, inside the linked root, with symlink escapes refused.
 *
 * Service references use adapters with explicit authorization status, refresh
 * timestamps, cached-versus-live content, source versions and revoked-access
 * behavior. Credentials live only in OS-protected storage and are never exported.
 */
export const HASH_LIMIT = 256 * 1024 * 1024;
export const READ_LIMIT = 1024 * 1024;
const FOLDER_LIMIT = { entries: 5000, depth: 8 };
const SEARCH_LIMIT = { entries: 5000, depth: 3 };
const SERVICE_LIMIT = 2 * 1024 * 1024;
const SERVICE_TIMEOUT = 15000;
export const LINK_STATUSES = Object.freeze(['available', 'changed', 'moved', 'missing', 'inaccessible', 'unlinked']);
export const SERVICE_AUTHORIZATION = Object.freeze(['none', 'authorized', 'unauthorized', 'revoked']);
const fail = (code, message) => Object.assign(new Error(message), { code });

async function hashFile(path, limit = HASH_LIMIT) {
  const info = await stat(path);
  if (info.size > limit) return null;
  const hash = createHash('sha256');
  await new Promise((done, reject) => createReadStream(path).on('data', chunk => hash.update(chunk)).on('error', reject).on('end', done));
  return hash.digest('hex');
}

/** Bounded folder walk that never follows symbolic links. */
async function walk(root, { entries = FOLDER_LIMIT.entries, depth = FOLDER_LIMIT.depth, onEntry = () => {} } = {}) {
  const listing = [];
  let truncated = false;
  const visit = async (folder, level) => {
    if (level > depth) { truncated = true; return; }
    let names;
    try { names = await readdir(folder, { withFileTypes: true }); } catch { return; }
    names.sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0);
    for (const entry of names) {
      if (listing.length >= entries) { truncated = true; return; }
      const path = join(folder, entry.name);
      let info;
      try { info = await lstat(path, { bigint: true }); } catch { continue; }
      const item = { path: relative(root, path).split(sep).join('/'), type: info.isSymbolicLink() ? 'link' : info.isDirectory() ? 'folder' : info.isFile() ? 'file' : 'other',
        size: Number(info.size), mtimeMs: Number(info.mtimeMs), inode: String(info.ino), dev: String(info.dev) };
      listing.push(item);
      if (await onEntry(item, path) === true) return;
      if (item.type === 'folder') await visit(path, level + 1);
    }
  };
  await visit(root, 1);
  return { listing, truncated };
}

/** Fingerprint a linked path. Throws filesystem errors (ENOENT, EACCES) for status detection. */
export async function fingerprint(path, kind) {
  const info = await lstat(path, { bigint: true });
  if (info.isSymbolicLink()) throw fail('ELINK', 'The linked path is now a symbolic link; Weft does not follow it');
  if (kind === 'file' && !info.isFile()) throw fail('EKIND', 'The linked path is no longer a regular file');
  if (kind === 'folder' && !info.isDirectory()) throw fail('EKIND', 'The linked path is no longer a folder');
  const base = { size: Number(info.size), mtimeMs: Number(info.mtimeMs), inode: String(info.ino), dev: String(info.dev) };
  if (kind === 'file') { const sha256 = await hashFile(path); return { ...base, sha256, ...(sha256 === null && { hashSkipped: 'larger than 256 MiB' }) }; }
  const { listing, truncated } = await walk(path);
  const manifest = listing.map(item => `${item.type}\u0000${item.path}\u0000${item.size}\u0000${Math.trunc(item.mtimeMs)}`).join('\n');
  return { ...base, entries: listing.length, truncated, sha256: createHash('sha256').update(manifest).digest('hex'), hashKind: 'manifest' };
}

const inside = (child, parent) => child === parent || child.startsWith(parent.endsWith(sep) ? parent : parent + sep);
/** Weft's own profile (database, credentials, browser sessions) is never linkable or readable through a link. */
async function assertUnprotected(real, protectedPaths = []) {
  for (const path of protectedPaths.filter(Boolean)) {
    let guarded;
    try { guarded = await realpath(path); } catch { guarded = resolve(path); }
    if (inside(real, guarded)) throw fail('permission_required', 'PERMISSION_REQUIRED: Weft profile data (database, credentials, browser sessions) cannot be linked or read through a link');
  }
}

/** Resolve a person-chosen path into a link record. The path must exist and must not be a symbolic link. */
export async function createLink(path, kind, { protectedPaths = [] } = {}) {
  if (typeof path !== 'string' || !isAbsolute(path) || path.includes('\0')) throw fail('invalid_arguments', 'Choose an absolute file or folder path');
  let real;
  try { real = await realpath(path); } catch (error) { throw fail(error.code === 'ENOENT' ? 'not_found' : 'permission_required', `${error.code === 'ENOENT' ? 'Not found' : 'Not accessible'}: ${basename(path)}`); }
  await assertUnprotected(real, protectedPaths);
  const info = await stat(real);
  const actual = info.isDirectory() ? 'folder' : info.isFile() ? 'file' : null;
  if (!actual) throw fail('invalid_arguments', 'Only regular files and folders can be linked');
  if (kind && kind !== actual) throw fail('invalid_arguments', `The chosen path is a ${actual}, not a ${kind}`);
  const print = await fingerprint(real, actual);
  const now = new Date().toISOString();
  return { kind: actual, path: real, name: basename(real), status: 'available', fingerprint: print, verifiedAt: now, checkedAt: now,
    versions: [{ number: 1, sha256: print.sha256, size: print.size, mtimeMs: print.mtimeMs, verifiedAt: now }] };
}

/** Look for a moved file/folder near its old location by inode or content hash. */
async function findMoved(link) {
  const folder = async path => { try { return (await stat(path)).isDirectory(); } catch { return false; } };
  // Search the old parent's parent (the same folder tree) when it exists; never a filesystem root.
  let root = dirname(dirname(link.path));
  if (root === dirname(root) || !await folder(root)) root = dirname(link.path);
  if (root === dirname(root) || !await folder(root)) return null;
  let found = null;
  const want = link.fingerprint;
  await walk(root, { ...SEARCH_LIMIT, onEntry: async (item, path) => {
    if (found) return true;
    if (item.type !== link.kind || path === link.path) return false;
    if (item.inode === want.inode && item.dev === want.dev) { found = { path, by: 'inode' }; return true; }
    if (link.kind === 'file' && want.sha256 && item.size === want.size) {
      try { if (await hashFile(path) === want.sha256) { found = { path, by: 'sha256' }; return true; } } catch { /* unreadable */ }
    }
    return false;
  } }).catch(() => null);
  return found;
}

/** Detect the current state of a link without accepting any change. */
export async function detectStatus(link) {
  const checkedAt = new Date().toISOString();
  if (!link?.path) return { status: 'unlinked', checkedAt, detail: 'No local path is linked; a person must relink this source.' };
  let current;
  try { current = await fingerprint(link.path, link.kind); }
  catch (error) {
    if (['ENOENT', 'ENOTDIR'].includes(error.code)) {
      const moved = await findMoved(link);
      return moved ? { status: 'moved', checkedAt, candidate: { path: moved.path, name: basename(moved.path), matchedBy: moved.by }, detail: `Not at the linked location; a ${link.kind} with the same ${moved.by === 'inode' ? 'file identity' : 'content'} was found nearby.` }
        : { status: 'missing', checkedAt, detail: 'The linked file or folder no longer exists at its location.' };
    }
    if (['EACCES', 'EPERM'].includes(error.code)) return { status: 'inaccessible', checkedAt, detail: 'Weft cannot read the linked location (permission denied).' };
    if (['ELINK', 'EKIND'].includes(error.code)) return { status: 'inaccessible', checkedAt, detail: error.message };
    return { status: 'inaccessible', checkedAt, detail: `Unreadable: ${error.code || error.message}` };
  }
  const recorded = link.fingerprint || {};
  const changed = current.sha256 && recorded.sha256 ? current.sha256 !== recorded.sha256 : current.size !== recorded.size || current.mtimeMs !== recorded.mtimeMs;
  return { status: changed ? 'changed' : 'available', checkedAt, current, ...(changed && { detail: 'The source changed since it was last verified. Refresh to accept the new version; citations to the old version are flagged.' }) };
}

const SAFE_SEGMENT = /^[^\0]{1,255}$/;
/** Resolve a caller-supplied relative path inside a linked folder; refuses traversal and symlink escapes. */
export async function resolveInside(root, child) {
  if (typeof child !== 'string' || !child || child.length > 1024 || isAbsolute(child) || /^[a-zA-Z]:/.test(child) || child.includes('\0')) throw fail('invalid_arguments', 'Use a relative path inside the linked folder');
  const parts = child.split(/[\\/]+/).filter(Boolean);
  if (!parts.length || parts.some(part => part === '..' || part === '.' || !SAFE_SEGMENT.test(part))) throw fail('invalid_arguments', 'Relative paths cannot contain . or .. segments');
  const rootReal = await realpath(root);
  const target = resolve(rootReal, normalize(parts.join(sep)));
  let real;
  try { real = await realpath(target); } catch (error) { throw fail(error.code === 'ENOENT' ? 'not_found' : 'permission_required', 'That path does not exist or is not readable inside the linked folder'); }
  if (real !== rootReal && !real.startsWith(rootReal.endsWith(sep) ? rootReal : rootReal + sep)) throw fail('permission_required', 'PERMISSION_REQUIRED: the path resolves outside the linked folder (symbolic link escape refused)');
  return real;
}

/** Bounded read of linked content through a link record only. */
export async function readLinked(link, { path: child, offset = 0, maxBytes = 65536, protectedPaths = [] } = {}) {
  if (!link?.path) throw fail('not_found', 'This source is not linked to a local path');
  const limit = Math.min(Math.max(1, maxBytes), READ_LIMIT);
  let target = link.path;
  if (link.kind === 'folder') {
    if (!child) {
      const { listing, truncated } = await walk(link.path, { entries: 500, depth: 1 });
      return { kind: 'listing', entries: listing.map(({ path, type, size, mtimeMs }) => ({ path, type, size, modifiedAt: new Date(mtimeMs).toISOString() })), truncated };
    }
    target = await resolveInside(link.path, child);
  } else if (child) throw fail('invalid_arguments', 'A linked file has no inner paths');
  else {
    const info = await lstat(target).catch(error => { throw fail(error.code === 'ENOENT' ? 'not_found' : 'permission_required', 'The linked file is missing or unreadable; check its status'); });
    if (info.isSymbolicLink()) throw fail('permission_required', 'PERMISSION_REQUIRED: the linked file is now a symbolic link; a person must relink it');
  }
  await assertUnprotected(await realpath(target), protectedPaths);
  const info = await stat(target);
  if (!info.isFile()) throw fail('invalid_arguments', 'Only files can be read; folders return a listing');
  const handle = await open(target, 'r');
  try {
    const length = Math.max(0, Math.min(limit, info.size - offset));
    const buffer = Buffer.alloc(length);
    const { bytesRead } = length ? await handle.read(buffer, 0, length, offset) : { bytesRead: 0 };
    const bytes = buffer.subarray(0, bytesRead);
    const binary = bytes.subarray(0, 8192).includes(0);
    let text = null;
    if (!binary) { try { text = new TextDecoder('utf-8', { fatal: true }).decode(bytes); } catch { text = null; } }
    return { kind: 'file', ...(link.kind === 'folder' && { path: relative(await realpath(link.path), target).split(sep).join('/') }), size: info.size, offset, bytes: bytesRead,
      truncated: offset + bytesRead < info.size, modifiedAt: info.mtime.toISOString(), encoding: text === null ? 'base64' : 'utf8', content: text ?? bytes.toString('base64') };
  } finally { await handle.close(); }
}

// ---- Service references ---------------------------------------------------------------
const loopback = hostname => ['localhost', '127.0.0.1', '::1', '[::1]'].includes(hostname);
export function validateServiceUrl(value) {
  let url;
  try { url = new URL(value); } catch { throw fail('invalid_arguments', 'Enter an HTTPS URL'); }
  if (url.username || url.password) throw fail('invalid_arguments', 'URLs must not contain credentials; store a credential separately');
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && loopback(url.hostname))) throw fail('invalid_arguments', 'Service references use HTTPS (plain HTTP only for this computer)');
  url.hash = '';
  return url.href;
}

/**
 * Adapter contract: describe() and fetch({url, credential, previous, fetchImpl, signal}).
 * fetch resolves to {outcome: 'updated'|'not_modified'|'unauthorized'|'redirected'|'failed', httpStatus?, bytes?, contentType?, etag?, lastModified?, detail?}.
 * Adapters never follow redirects with a credential and never fall back to another source.
 */
export const httpAdapter = Object.freeze({
  id: 'http',
  describe: () => ({ id: 'http', name: 'Authenticated HTTP(S) document', authorization: 'optional header credential', content: 'cached copy; refresh fetches the live document', redirects: 'not followed' }),
  async fetch({ url, credential, previous, fetchImpl = globalThis.fetch, signal }) {
    const headers = { accept: 'text/*, application/json, application/xml;q=0.9, */*;q=0.5' };
    if (credential) headers[credential.header.toLowerCase()] = credential.value;
    if (previous?.etag) headers['if-none-match'] = previous.etag;
    if (previous?.lastModified) headers['if-modified-since'] = previous.lastModified;
    const response = await fetchImpl(url, { method: 'GET', headers, redirect: 'manual', signal, credentials: 'omit', cache: 'no-store' });
    const httpStatus = response.status;
    if (httpStatus === 304) return { outcome: 'not_modified', httpStatus };
    if ([301, 302, 303, 307, 308].includes(httpStatus) || response.type === 'opaqueredirect') return { outcome: 'redirected', httpStatus, detail: 'The service redirected; Weft does not follow redirects for service references. Update the URL if the new location is trusted.' };
    if ([401, 403].includes(httpStatus)) return { outcome: 'unauthorized', httpStatus, detail: credential ? 'The service refused the stored credential; access may have been revoked or expired.' : 'The service requires authorization.' };
    if (!response.ok) return { outcome: 'failed', httpStatus, detail: `HTTP ${httpStatus}` };
    const declared = Number(response.headers.get('content-length'));
    if (Number.isFinite(declared) && declared > SERVICE_LIMIT) return { outcome: 'failed', httpStatus, detail: 'Response exceeds the 2 MiB service reference limit' };
    const chunks = [];
    let size = 0;
    for await (const chunk of response.body ?? []) {
      size += chunk.length;
      if (size > SERVICE_LIMIT) return { outcome: 'failed', httpStatus, detail: 'Response exceeds the 2 MiB service reference limit' };
      chunks.push(Buffer.from(chunk));
    }
    return { outcome: 'updated', httpStatus, bytes: Buffer.concat(chunks), contentType: String(response.headers.get('content-type') || 'application/octet-stream').slice(0, 200),
      etag: response.headers.get('etag')?.slice(0, 500) || null, lastModified: response.headers.get('last-modified')?.slice(0, 100) || null };
  },
});
export const serviceAdapters = Object.freeze({ http: httpAdapter });
/**
 * Optional integrations evaluated in ADR-013 (ByAuthorX, Vixl, AI Server Studio, QAI-ality) are not built in:
 * ordinary files and documented HTTP APIs work without them. A future adapter implements the same contract.
 */
export const EVALUATED_ADAPTERS = Object.freeze(['byauthorx', 'vixl', 'ai-server-studio', 'qai-ality']);

export async function fetchService(service, { credential, fetchImpl, timeout = SERVICE_TIMEOUT, signal = null } = {}) {
  const adapter = serviceAdapters[service.adapter];
  if (!adapter) return { outcome: 'failed', detail: `Adapter ${service.adapter} is not installed` };
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeout);
  // A caller deadline or cancellation (ADR 018) stops the request; nothing is recorded for a stopped refresh.
  const stop = () => controller.abort();
  if (signal?.aborted) stop(); else signal?.addEventListener('abort', stop, { once: true });
  const stopped = () => Object.assign(new Error('Service refresh stopped before a response was recorded; nothing changed'), { code: 'cancelled' });
  try {
    if (signal?.aborted) throw stopped();
    return await adapter.fetch({ url: service.url, credential, previous: service.versions?.at(-1), fetchImpl, signal: controller.signal });
  }
  catch (error) {
    if (signal?.aborted) throw stopped();
    return { outcome: 'failed', detail: controller.signal.aborted ? 'Timed out' : String(error.message || error).slice(0, 300) };
  }
  finally { clearTimeout(timer); signal?.removeEventListener?.('abort', stop); }
}

const HEADER_NAMES = ['Authorization', 'X-API-Key'];
/** Service credentials in OS-protected storage only (Electron safeStorage); never in project data or exports. */
export class ServiceCredentials {
  constructor({ directory = null, safeStorage = null } = {}) {
    this.safeStorage = safeStorage;
    this.items = {};
    if (!directory) return;
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    this.path = join(directory, 'service-credentials.json');
    this.stamp = fileStamp(this.path);
    try {
      const saved = JSON.parse(readFileSync(this.path, 'utf8'));
      if (saved.version !== 1 || !saved.items || typeof saved.items !== 'object') throw new Error('Invalid service credential store');
      this.items = saved.items;
    } catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
  available() { return Boolean(this.safeStorage?.isEncryptionAvailable?.() && this.safeStorage?.getSelectedStorageBackend?.() !== 'basic_text'); }
  save() { if (this.path) this.stamp = writeVerifiedJson(this.path, JSON.stringify({ version: 1, items: this.items }), this.stamp); }
  set(referenceId, header, value) {
    if (!HEADER_NAMES.includes(header)) throw fail('invalid_arguments', `Credential header must be one of ${HEADER_NAMES.join(', ')}`);
    if (!this.available()) throw fail('unavailable', 'OS-protected credential storage is unavailable; Weft does not store service credentials in plain text');
    const before = this.items[referenceId];
    this.items[referenceId] = { id: `cred_${randomUUID()}`, header, encrypted: this.safeStorage.encryptString(value).toString('base64'), createdAt: new Date().toISOString() };
    try { this.save(); } catch (error) { if (before) this.items[referenceId] = before; else delete this.items[referenceId]; throw error; }
    return { id: this.items[referenceId].id, header };
  }
  get(referenceId) {
    const item = this.items[referenceId];
    if (!item) return null;
    if (!this.available()) throw fail('unavailable', 'OS-protected credential storage is unavailable');
    return { header: item.header, value: this.safeStorage.decryptString(Buffer.from(item.encrypted, 'base64')) };
  }
  has(referenceId) { return Boolean(this.items[referenceId]); }
  delete(referenceId) { if (!this.items[referenceId]) return false; delete this.items[referenceId]; this.save(); return true; }
}
