import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { readJson, writeJsonDurable } from './atomic-json.js';

const workspaceId = z.string().min(1).max(200).optional();
export const storageCommandDefinitions = {
  'storage.policy': ['Read site storage modes, scoped exceptions, temporary-data journal and the engine coverage matrix', { workspaceId }],
  'storage.setSiteMode': ['Human sets a revocable site storage exception: block, session (temporary), remember, or default to revoke', {
    workspaceId, hostname: z.string().trim().min(1).max(253), mode: z.enum(['block', 'session', 'remember', 'default']), includeSubdomains: z.boolean().default(true) }],
  'storage.setDefaultMode': ['Human sets the workspace default site storage mode and cross-site cookie policy', {
    workspaceId, mode: z.enum(['remember', 'session', 'block']).optional(), crossSiteCookies: z.enum(['block', 'allow']).optional() }],
};
const schemas = Object.fromEntries(Object.entries(storageCommandDefinitions).map(([name, [, shape]]) => [name, z.strictObject(shape)]));

export const DEFAULT_STORAGE_POLICY = Object.freeze({ mode: 'remember', crossSiteCookies: 'block' });
// Opaque-origin sandbox: Chromium itself refuses cookies, Web Storage, IndexedDB,
// Cache Storage and service workers for the document and the workers it creates.
export const STORAGE_SANDBOX = 'sandbox allow-scripts allow-forms allow-popups allow-popups-to-escape-sandbox allow-modals allow-downloads allow-pointer-lock allow-presentation allow-top-navigation-by-user-activation';
const STORAGE_TYPES = ['filesystem', 'indexdb', 'localstorage', 'shadercache', 'websql', 'serviceworkers', 'cachestorage'];

/** Published, test-backed coverage. "Covered" means enforced by Chromium or Weft as described, not a guarantee beyond it. */
export const STORAGE_COVERAGE = Object.freeze([
  { path: 'HTTP Set-Cookie (accepting cookies)', block: 'Prevented: Set-Cookie response headers are removed before Chromium stores them.', session: 'Accepted; erased at clean exit or next startup.', remember: 'Accepted and kept in the workspace container.' },
  { path: 'Cookie request header (sending cookies)', block: 'Prevented: Cookie request headers are removed.', session: 'Sent during the session.', remember: 'Sent.' },
  { path: 'Script cookies (document.cookie, CookieStore)', block: 'Prevented in documents served from the site: they load in an opaque-origin CSP sandbox and Chromium throws SecurityError. Cookies for the host created by any other path are deleted when Chromium reports them.', session: 'Allowed; erased with the session.', remember: 'Allowed.' },
  { path: 'localStorage and sessionStorage', block: 'Prevented by the opaque-origin sandbox (SecurityError).', session: 'Allowed; localStorage erased with the session.', remember: 'Allowed.' },
  { path: 'IndexedDB', block: 'Prevented by the opaque-origin sandbox (SecurityError).', session: 'Allowed; erased with the session.', remember: 'Allowed.' },
  { path: 'Cache Storage (caches API)', block: 'Prevented by the opaque-origin sandbox (SecurityError).', session: 'Allowed; erased with the session.', remember: 'Allowed.' },
  { path: 'Service worker registration and its storage', block: 'Prevented: registration fails in the sandbox and service-worker script fetches for the host are cancelled.', session: 'Allowed; registrations erased with the session.', remember: 'Allowed.' },
  { path: 'HTTP cache', block: 'Blocked documents are served with Cache-Control: no-store; entries already cached are erased when the site is blocked.', session: 'Erased per origin with the session.', remember: 'Kept.' },
  { path: 'Site embedded in another page (frame)', block: 'Frame documents from the site are sandboxed the same way; cookie headers are removed.', session: 'As the top-level case.', remember: 'As the top-level case.' },
  { path: 'Cross-site (third-party) cookies', block: 'Covered by the site mode.', session: 'An explicit session or remember exception for the embedded site allows its cross-site cookies.', remember: 'Default policy removes cookie headers on requests whose approximate registrable domain differs from the top page. Script cookie access inside cross-site frames is not blocked by this policy.' },
  { path: 'Unsupported / not covered', block: 'Not covered: data already held by pages that stay open (reload them), back/forward-cache pages, HSTS, DNS and socket pools, shared dictionaries, permissions, client hints, Private State Tokens, favicons, fingerprinting and anything retained by the server.', session: 'Same. A crash can leave data on disk until the next Weft startup; another program can copy it before then.', remember: 'Same.' },
]);

export function approximateSite(hostname) {
  const host = String(hostname).toLowerCase().replace(/\.$/, '');
  if (/^[\d.]+$/.test(host) || host.includes(':')) return host;
  const labels = host.split('.');
  if (labels.length < 3) return host;
  const second = labels.at(-2);
  // Without bundling the Public Suffix List, handle the common ccTLD second-level pattern.
  return labels.at(-1).length === 2 && ['co', 'com', 'net', 'org', 'gov', 'edu', 'ac', 'ne', 'or', 'go'].includes(second) ? labels.slice(-3).join('.') : labels.slice(-2).join('.');
}
const parse = value => { try { return new URL(value); } catch { return null; } };
const headerKey = (headers, name) => Object.keys(headers || {}).filter(key => key.toLowerCase() === name);

export class SiteStoragePolicy {
  constructor({ workspaceService, journalPath, sessionFor }) {
    this.workspaceService = workspaceService;
    this.journalPath = journalPath;
    this.sessionFor = sessionFor;
    this.seen = new Map();
    this.activity = new Map();
    this.recovery = null;
    this.deletedCookies = new Map();
    this.journal = journalPath ? readJson(journalPath, { version: 1, entries: [] }) : { version: 1, entries: [] };
    if (!Array.isArray(this.journal.entries)) this.journal = { version: 1, entries: [] };
    this.journalKeys = new Set(this.journal.entries.map(entry => this.key(entry)));
  }

  get records() { return this.workspaceService?.data.storagePolicies ?? []; }
  key(entry) { return `${entry.workspaceId}|${entry.origin ?? `host:${entry.hostname}`}`; }
  defaults(workspaceId) {
    const record = this.records.find(item => item.kind === 'default' && item.workspaceId === workspaceId);
    return { ...DEFAULT_STORAGE_POLICY, ...(record && { mode: record.mode, crossSiteCookies: record.crossSiteCookies }) };
  }
  siteRecord(hostname, workspaceId) {
    const host = String(hostname).toLowerCase().replace(/\.$/, '');
    return this.records.filter(item => item.kind === 'site' && item.workspaceId === workspaceId
      && (host === item.hostname || (item.includeSubdomains && host.endsWith(`.${item.hostname}`))))
      .sort((a, b) => b.hostname.length - a.hostname.length)[0] ?? null;
  }
  modeFor(hostname, workspaceId) {
    const record = this.siteRecord(hostname, workspaceId);
    return record ? { mode: record.mode, source: 'site', exceptionId: record.id, hostname: record.hostname } : { mode: this.defaults(workspaceId).mode, source: 'default', exceptionId: null, hostname: null };
  }
  count(contentsId, field) {
    if (!contentsId) return;
    const activity = this.activity.get(contentsId) ?? { cookieHeadersRemoved: 0, setCookieRemoved: 0, crossSiteCookiesBlocked: 0, documentsSandboxed: 0, serviceWorkersBlocked: 0, speculativeLoadsCancelled: 0 };
    activity[field]++;
    this.activity.set(contentsId, activity);
  }
  activityFor(contentsId) { return { ...(this.activity.get(contentsId) ?? {}) }; }
  resetActivity(contentsId) { this.activity.delete(contentsId); }

  topHostname(details) {
    if (details.resourceType === 'mainFrame') return null;
    try { const top = details.frame?.top?.url; if (top) return parse(top)?.hostname ?? null; } catch { /* Disposed frame. */ }
    try { return parse(details.webContents?.getURL?.())?.hostname || null; } catch { return null; }
  }
  crossSite(details, hostname) {
    const top = this.topHostname(details);
    return Boolean(top) && approximateSite(top) !== approximateSite(hostname);
  }
  crossSiteBlocked(hostname, workspaceId) {
    const record = this.siteRecord(hostname, workspaceId);
    return record ? record.mode === 'block' : this.defaults(workspaceId).crossSiteCookies === 'block';
  }

  note(workspaceId, url) {
    if (!['http:', 'https:'].includes(url.protocol)) return;
    const origins = this.seen.get(workspaceId) ?? new Set();
    if (origins.size < 5000) origins.add(url.origin);
    this.seen.set(workspaceId, origins);
  }
  /** Write-ahead: the entry is durable before the request that may create data proceeds. */
  remember(workspaceId, origin, hostname, reason) {
    const entry = { workspaceId, origin, hostname, reason, recordedAt: new Date().toISOString() };
    if (this.journalKeys.has(this.key(entry))) return;
    this.journal.entries.push(entry);
    this.journalKeys.add(this.key(entry));
    if (this.journalPath) writeJsonDurable(this.journalPath, this.journal);
  }
  forget(predicate) {
    const before = this.journal.entries.length;
    this.journal.entries = this.journal.entries.filter(entry => !predicate(entry));
    this.journalKeys = new Set(this.journal.entries.map(entry => this.key(entry)));
    if (before !== this.journal.entries.length && this.journalPath) writeJsonDurable(this.journalPath, this.journal);
  }

  /** Header hooks are composed by the browser; this attaches the cookie-store watcher. */
  attach(session, workspaceId) {
    const onCookie = (_event, cookie, _cause, removed) => { if (!removed) void this.cookieChanged(session, workspaceId, cookie).catch(() => {}); };
    session.cookies?.on?.('changed', onCookie);
    return () => session.cookies?.removeListener?.('changed', onCookie);
  }

  beforeSendHeaders(details, workspaceId) {
    const url = parse(details.url);
    if (!url || !['http:', 'https:', 'ws:', 'wss:'].includes(url.protocol)) return {};
    const hostname = url.hostname;
    const { mode } = this.modeFor(hostname, workspaceId);
    const headers = { ...details.requestHeaders };
    const cookieKeys = headerKey(headers, 'cookie');
    this.note(workspaceId, url);
    if (mode === 'block') {
      if (headerKey(headers, 'service-worker').some(key => String(headers[key]).toLowerCase() === 'script')) { this.count(details.webContentsId, 'serviceWorkersBlocked'); return { cancel: true }; }
      if (cookieKeys.length) { for (const key of cookieKeys) delete headers[key]; this.count(details.webContentsId, 'cookieHeadersRemoved'); return { requestHeaders: headers }; }
      return {};
    }
    if (mode === 'session' && ['http:', 'https:'].includes(url.protocol)) this.remember(workspaceId, url.origin, hostname, 'session');
    if (cookieKeys.length && this.crossSite(details, hostname) && this.crossSiteBlocked(hostname, workspaceId)) {
      for (const key of cookieKeys) delete headers[key];
      this.count(details.webContentsId, 'crossSiteCookiesBlocked');
      return { requestHeaders: headers };
    }
    return {};
  }

  headersReceived(details, workspaceId) {
    const url = parse(details.url);
    if (!url || !['http:', 'https:'].includes(url.protocol)) return {};
    const { mode } = this.modeFor(url.hostname, workspaceId);
    const headers = { ...(details.responseHeaders ?? {}) };
    let changed = false;
    const cookieKeys = headerKey(headers, 'set-cookie');
    if (cookieKeys.length && (mode === 'block' || (this.crossSite(details, url.hostname) && this.crossSiteBlocked(url.hostname, workspaceId)))) {
      for (const key of cookieKeys) delete headers[key];
      this.count(details.webContentsId, mode === 'block' ? 'setCookieRemoved' : 'crossSiteCookiesBlocked');
      changed = true;
    }
    if (mode === 'block' && ['mainFrame', 'subFrame'].includes(details.resourceType)) {
      headers['Content-Security-Policy'] = [...(headers['Content-Security-Policy'] ?? []), STORAGE_SANDBOX];
      for (const key of headerKey(headers, 'cache-control')) delete headers[key];
      headers['Cache-Control'] = ['no-store'];
      this.count(details.webContentsId, 'documentsSandboxed');
      changed = true;
    }
    return changed ? { responseHeaders: headers } : {};
  }

  async cookieChanged(session, workspaceId, cookie) {
    const hostname = String(cookie.domain || '').replace(/^\./, '');
    if (!hostname) return;
    const { mode } = this.modeFor(hostname, workspaceId);
    if (mode === 'block') {
      await session.cookies.remove(`${cookie.secure ? 'https' : 'http'}://${hostname}${cookie.path || '/'}`, cookie.name);
      this.deletedCookies.set(workspaceId, (this.deletedCookies.get(workspaceId) ?? 0) + 1);
    } else if (mode === 'session') this.remember(workspaceId, null, hostname, 'session-cookie');
  }

  originsFor(workspaceId, hostname, includeSubdomains = true) {
    const origins = new Set([`https://${hostname}`, `http://${hostname}`]);
    for (const origin of this.seen.get(workspaceId) ?? []) {
      const host = parse(origin)?.hostname;
      if (host === hostname || (includeSubdomains && host?.endsWith(`.${hostname}`))) origins.add(origin);
    }
    for (const entry of this.journal.entries) if (entry.workspaceId === workspaceId && entry.origin && (entry.hostname === hostname || (includeSubdomains && entry.hostname?.endsWith(`.${hostname}`)))) origins.add(entry.origin);
    return [...origins];
  }

  async clearOrigins(session, origins) {
    for (const origin of origins) {
      await session.clearStorageData({ origin, storages: STORAGE_TYPES });
      await session.clearData?.({ dataTypes: ['cache'], origins: [origin] }).catch?.(() => {});
    }
  }
  async clearCookies(session, hostname, includeSubdomains = false) {
    let removed = 0;
    for (const cookie of await session.cookies.get({})) {
      const domain = String(cookie.domain || '').replace(/^\./, '');
      if (domain === hostname || hostname.endsWith(`.${domain}`) || (includeSubdomains && domain.endsWith(`.${hostname}`))) {
        await session.cookies.remove(`${cookie.secure ? 'https' : 'http'}://${domain}${cookie.path || '/'}`, cookie.name);
        removed++;
      }
    }
    return removed;
  }
  async clearSite(session, workspaceId, hostname, includeSubdomains = true) {
    await this.clearOrigins(session, this.originsFor(workspaceId, hostname, includeSubdomains));
    const cookies = await this.clearCookies(session, hostname, includeSubdomains);
    await session.cookies.flushStore?.();
    session.flushStorageData?.();
    return { cookies };
  }

  /** Erase journaled temporary data. Runs at startup (crash recovery) and at clean exit. */
  async cleanup(reason) {
    const entries = [...this.journal.entries];
    const done = [];
    for (const entry of entries) {
      if (entry.hostname && this.workspaceService?.data.workspaces.some(item => item.id === entry.workspaceId) && this.modeFor(entry.hostname, entry.workspaceId).mode === 'remember') { done.push(entry); continue; }
      try {
        const session = this.sessionFor(entry.workspaceId);
        if (entry.origin) await this.clearOrigins(session, [entry.origin]);
        if (entry.hostname) await this.clearCookies(session, entry.hostname);
        await session.cookies.flushStore?.();
        session.flushStorageData?.();
        done.push(entry);
      } catch { /* Keep the entry so the next startup retries. */ }
    }
    const keys = new Set(done.map(entry => this.key(entry)));
    this.forget(entry => keys.has(this.key(entry)));
    const result = { reason, at: new Date().toISOString(), cleared: done.length, remaining: this.journal.entries.length };
    if (reason === 'startup') this.recovery = result;
    return result;
  }

  policy(workspaceId) {
    return { workspaceId, defaults: this.defaults(workspaceId),
      exceptions: this.records.filter(item => item.kind === 'site' && item.workspaceId === workspaceId).map(item => structuredClone(item)),
      lateCookiesDeleted: this.deletedCookies.get(workspaceId) ?? 0,
      temporaryData: { pendingEntries: this.journal.entries.filter(entry => entry.workspaceId === workspaceId).length, lastStartupRecovery: this.recovery },
      sessionLifetime: 'A session lasts from Weft startup until a clean exit. Temporary site data is erased at clean exit; if Weft crashes or is killed, it is erased at the next startup before tabs are restored.',
      coverage: STORAGE_COVERAGE,
      limitations: ['Storage controls do not depend on consent banners and Weft never clicks consent prompts.',
        'Clearing or blocking does not revoke server-side sessions, delete records held by a service, or prevent fingerprinting.',
        'Cross-site detection uses an approximate registrable domain without the full Public Suffix List.',
        'Open pages keep data already loaded in memory until they are reloaded or closed.'] };
  }

  execute(name, input, context = {}) {
    const service = this.workspaceService;
    const run = service.queue.then(() => this.dispatch(name, input, context));
    service.queue = run.catch(() => {});
    return run;
  }

  async dispatch(name, input, context) {
    const args = schemas[name].parse(input);
    const service = this.workspaceService;
    const workspace = args.workspaceId ?? context.workspaceId ?? service.activeWorkspaceId;
    service.workspace(workspace);
    if (name === 'storage.policy') return this.policy(workspace);
    if (!['human', 'admin'].includes(context.actor ?? 'human')) throw new Error('PERMISSION_REQUIRED: storage policy changes require the trusted browser interface');
    const timestamp = new Date().toISOString();
    try {
      service.data.storagePolicies ??= [];
      const records = service.data.storagePolicies;
      let effect;
      if (name === 'storage.setDefaultMode') {
        let record = records.find(item => item.kind === 'default' && item.workspaceId === workspace);
        if (!record) { record = { id: `storage_${randomUUID()}`, kind: 'default', workspaceId: workspace, ...DEFAULT_STORAGE_POLICY, createdAt: timestamp }; records.push(record); }
        Object.assign(record, { ...(args.mode && { mode: args.mode }), ...(args.crossSiteCookies && { crossSiteCookies: args.crossSiteCookies }), updatedAt: timestamp, actor: context.actor ?? 'human' });
        service.log(name, workspace, record.id, context.actor ?? 'human', `${record.mode}; cross-site cookies ${record.crossSiteCookies}`);
        effect = { mode: record.mode };
      } else {
        const probe = { hostname: args.hostname, path: '/' };
        service.validateRule(probe);
        const hostname = probe.hostname;
        const index = records.findIndex(item => item.kind === 'site' && item.workspaceId === workspace && item.hostname === hostname);
        if (args.mode === 'default') { if (index >= 0) records.splice(index, 1); }
        else if (index >= 0) Object.assign(records[index], { mode: args.mode, includeSubdomains: args.includeSubdomains, updatedAt: timestamp, actor: context.actor ?? 'human' });
        else records.push({ id: `storage_${randomUUID()}`, kind: 'site', workspaceId: workspace, hostname, includeSubdomains: args.includeSubdomains, mode: args.mode, actor: context.actor ?? 'human', createdAt: timestamp, updatedAt: timestamp });
        service.log(name, workspace, hostname, context.actor ?? 'human', args.mode === 'default' ? 'Exception revoked' : args.mode);
        effect = { hostname, mode: this.modeFor(hostname, workspace).mode, includeSubdomains: args.includeSubdomains };
      }
      service.save();
      const session = this.sessionFor(workspace);
      let cleared = null;
      if (effect.hostname) {
        if (effect.mode === 'block') cleared = await this.clearSite(session, workspace, effect.hostname, effect.includeSubdomains);
        else if (effect.mode === 'session') { for (const origin of this.originsFor(workspace, effect.hostname, effect.includeSubdomains)) this.remember(workspace, origin, parse(origin).hostname, 'session'); this.remember(workspace, null, effect.hostname, 'session-cookie'); }
        else if (effect.mode === 'remember') this.forget(entry => entry.workspaceId === workspace && (entry.hostname === effect.hostname || (effect.includeSubdomains && entry.hostname?.endsWith(`.${effect.hostname}`))));
      } else if (effect.mode !== 'session') this.forget(entry => entry.workspaceId === workspace && this.modeFor(entry.hostname, workspace).mode === 'remember');
      return { ...this.policy(workspace), changed: effect, cleared,
        notice: effect.hostname && effect.mode === 'block' ? 'Existing data for this site was erased. Reload open pages so the block applies to them. Server-side sessions are not revoked.'
          : effect.mode === 'block' ? 'Sites without an exception can no longer read or write supported storage after reload. Data already stored stays on disk, unused, until you clear workspace storage.'
          : effect.mode === 'session' ? 'Data for matching sites will be erased at clean exit or at the next startup after a crash.'
            : 'Site data is kept in this workspace container until you clear it.' };
    } catch (error) { service.rollback(); throw error; }
  }
}
