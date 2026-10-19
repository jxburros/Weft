import { randomUUID } from 'node:crypto';
import { lstatSync, readFileSync, realpathSync } from 'node:fs';
import { basename, extname, isAbsolute, resolve } from 'node:path';
import { EVERYTHING_ID, EXTERNAL_DESTINATIONS } from './everything.js';

/**
 * Links and files other applications ask Weft to open (#99). Every item is untrusted data, never an
 * instruction: it never starts an agent action, never downloads without the usual approval and never grants
 * an agent access to anything. URLs pass the same admission and site-rule checks as a typed URL when the tab
 * is opened; local files are copied into a workspace as materials (they never load as live file:// pages).
 * Items wait while the profile is locked or before the window is ready.
 */
export const FILE_TYPES = Object.freeze({ '.html': 'text/html', '.htm': 'text/html', '.pdf': 'application/pdf' });
export const MAX_FILE_BYTES = 10 * 1024 * 1024;
const MAX_PENDING = 20;
const MAX_URL = 16384;

/** Arguments a launch carries: URLs and existing files of a supported type; switches and the app path are ignored. */
export function externalItemsFromArgv(argv = [], { cwd = process.cwd(), skip = [] } = {}) {
  const items = [];
  for (const value of argv) {
    if (typeof value !== 'string' || !value || value.startsWith('-') || skip.includes(value)) continue;
    if (/^[a-z][a-z0-9+.-]*:/i.test(value) && !/^[a-z]:[\\/]/i.test(value)) { items.push({ kind: 'url', url: value }); continue; }
    const path = isAbsolute(value) ? value : resolve(cwd, value);
    if (Object.hasOwn(FILE_TYPES, extname(path).toLowerCase())) items.push({ kind: 'file', path });
  }
  return items;
}

/** Validate one item before it is queued. Returns a refusal reason, or null when it may be opened. */
export function refusalFor(item) {
  if (item.kind === 'url') {
    if (typeof item.url !== 'string' || item.url.length > MAX_URL) return 'URL is too long';
    let url;
    try { url = new URL(item.url); } catch { return 'Not a valid URL'; }
    if (!['http:', 'https:'].includes(url.protocol)) return `${url.protocol.replace(':', '')} links from other applications are not opened`;
    if (url.username || url.password) return 'Links that contain credentials are not opened';
    return null;
  }
  if (item.kind === 'file') {
    if (typeof item.path !== 'string' || !isAbsolute(item.path)) return 'Not an absolute file path';
    if (!Object.hasOwn(FILE_TYPES, extname(item.path).toLowerCase())) return 'Only .html, .htm and .pdf files can be opened';
    let stat;
    try { stat = lstatSync(item.path); } catch { return 'File not found'; }
    if (!stat.isFile()) return 'Not a regular file';
    if (stat.size > MAX_FILE_BYTES) return 'Files larger than 10 MiB are not opened';
    return null;
  }
  return 'Unsupported item';
}

export class ExternalOpener {
  /**
   * @param {object} options
   * @param {() => boolean} options.locked  whether the encrypted profile is locked
   * @param {() => string} options.destination  'everything' | 'ask' | 'last-used'
   * @param {() => string} options.lastUsed  the workspace the main window shows
   * @param {(workspaceId: string) => boolean} options.workspaceOpen  destination exists and is not archived
   * @param {(url: string, workspaceId: string) => Promise<object>} options.openUrl  opens a tab (admission + site rules)
   * @param {(file: object, workspaceId: string) => Promise<object>} options.importFile  stores a copied file material
   * @param {(entry: object) => void} [options.audit]
   * @param {(event: object) => void} [options.notify]  tells the trusted GUI what arrived or needs a choice
   */
  constructor({ locked = () => false, destination = () => 'everything', lastUsed = () => EVERYTHING_ID, workspaceOpen = () => true, openUrl, importFile, audit = () => {}, notify = () => {} }) {
    Object.assign(this, { locked, destination, lastUsed, workspaceOpen, openUrl, importFile, audit, notify });
    this.ready = false;
    this.waiting = [];
    this.pending = new Map();
    this.results = [];
  }

  /** Accept items from a launch, a second instance or an OS open event. Returns what was refused immediately. */
  receive(items, source = 'other-application') {
    const refused = [];
    for (const raw of items) {
      let path = raw.path;
      // A file reached through a symbolic link (common for downloads folders and aliases) is opened as its real file.
      if (raw.kind === 'file') { try { path = realpathSync(raw.path); } catch { /* reported as not found below */ } }
      const item = raw.kind === 'file' ? { kind: 'file', path } : { kind: 'url', url: String(raw.url ?? '') };
      const reason = refusalFor(item);
      const label = item.kind === 'url' ? item.url.slice(0, 200) : basename(item.path);
      if (reason) {
        refused.push({ ...item, reason });
        this.audit({ type: 'block', reason: 'external_open_refused', outcome: 'denied', actor: 'external-app', summary: { kind: item.kind, source }, detail: `${reason}: ${label}` });
        continue;
      }
      if (this.waiting.length + this.pending.size >= MAX_PENDING) { refused.push({ ...item, reason: 'Too many links are waiting' }); continue; }
      this.waiting.push({ ...item, id: `ext_${randomUUID()}`, source, receivedAt: new Date().toISOString() });
    }
    if (refused.length) this.notify({ type: 'refused', items: refused.map(({ kind, reason, url, path }) => ({ kind, reason, label: kind === 'url' ? url.slice(0, 200) : basename(path) })) });
    void this.flush();
    return refused;
  }

  /** Called when the window is ready and after each unlock. */
  setReady(ready = true) { this.ready = ready; return this.flush(); }

  async flush() {
    if (!this.ready || this.locked() || this.flushing) return;
    this.flushing = true;
    try {
      while (this.waiting.length && !this.locked()) {
        const item = this.waiting.shift();
        const destination = EXTERNAL_DESTINATIONS.includes(this.destination()) ? this.destination() : 'everything';
        if (destination === 'ask') { this.pending.set(item.id, item); this.notify({ type: 'choose', item: this.describe(item) }); continue; }
        const workspaceId = destination === 'last-used' && this.workspaceOpen(this.lastUsed()) ? this.lastUsed() : EVERYTHING_ID;
        await this.deliver(item, workspaceId);
      }
    } finally { this.flushing = false; }
  }

  describe(item) { return { id: item.id, kind: item.kind, label: item.kind === 'url' ? item.url.slice(0, 2048) : basename(item.path), source: item.source, receivedAt: item.receivedAt }; }

  list() { return [...this.pending.values()].map(item => this.describe(item)); }

  /** A person chose where a pending item opens (or dismissed it with workspaceId null). */
  async choose(id, workspaceId) {
    const item = this.pending.get(id);
    if (!item) throw Object.assign(new Error('That link is no longer waiting'), { code: 'not_found' });
    if (workspaceId === null) {
      this.pending.delete(id);
      this.audit({ type: 'decision', reason: 'external_open_dismissed', outcome: 'cancelled', actor: 'human', summary: { kind: item.kind, source: item.source } });
      return { dismissed: true };
    }
    if (typeof workspaceId !== 'string' || !this.workspaceOpen(workspaceId)) throw Object.assign(new Error('Choose an open workspace'), { code: 'invalid_arguments' });
    if (this.locked()) throw Object.assign(new Error('Unlock Weft first'), { code: 'locked' });
    this.pending.delete(id);
    return this.deliver(item, workspaceId);
  }

  async deliver(item, workspaceId) {
    const summary = { kind: item.kind, source: item.source };
    try {
      let result;
      if (item.kind === 'url') result = { tab: await this.openUrl(item.url, workspaceId) };
      else {
        const real = realpathSync(item.path);
        const reason = refusalFor({ kind: 'file', path: real });
        if (reason) throw new Error(reason);
        const bytes = readFileSync(real);
        if (bytes.length > MAX_FILE_BYTES) throw new Error('Files larger than 10 MiB are not opened');
        result = { material: await this.importFile({ filename: basename(real), mimeType: FILE_TYPES[extname(real).toLowerCase()], bytes }, workspaceId) };
      }
      this.audit({ type: 'record', reason: 'external_open', outcome: 'completed', actor: 'external-app', workspaceId, tabId: result.tab?.id, targetId: result.material?.id, summary,
        detail: 'Supplied by another application; opened as data, no agent action started' });
      const outcome = { id: item.id, kind: item.kind, workspaceId, ...result };
      this.results.push(outcome); this.results.splice(0, Math.max(0, this.results.length - 50));
      this.notify({ type: 'opened', id: item.id, kind: item.kind, workspaceId, tabId: result.tab?.id ?? null, materialId: result.material?.id ?? null });
      return outcome;
    } catch (error) {
      const message = String(error?.message || 'Could not open').slice(0, 300);
      this.audit({ type: 'block', reason: 'external_open_failed', outcome: 'failed', actor: 'external-app', workspaceId, summary, detail: message });
      this.notify({ type: 'failed', id: item.id, kind: item.kind, workspaceId, reason: message });
      return { id: item.id, kind: item.kind, workspaceId, error: message };
    }
  }
}
