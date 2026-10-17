import electron from 'electron';
import { AutomationAdmission } from './admission.js';

const mutatingCommands = new Set(['page.navigate', 'page.back', 'page.forward', 'page.reload', 'page.stop', 'page.evaluate', 'page.click', 'page.fill', 'page.zoom', 'page.allowOnce', 'tabs.close', 'tabs.move', 'tabs.pin']);
import { randomUUID } from 'node:crypto';
import { mkdirSync, openSync, closeSync, chmodSync } from 'node:fs';
import { basename, join, resolve, sep } from 'node:path';
import { SiteStoragePolicy, STORAGE_COVERAGE } from './site-storage.js';
import { ThreatIntel } from './threat-intel.js';
import { DownloadSafety, NEVER_LAUNCH, applyOriginMetadata, fileCategory, hashFile } from './download-safety.js';
import { ruleSource } from './site-rules.js';
import { sanitizeUrl } from './workspace.js';

const humanOnlyBrowserCommands = new Set(['storage.setSiteMode', 'storage.setDefaultMode', 'threats.install', 'threats.remove', 'threats.configureProvider', 'threats.update', 'downloads.configureScanner', 'launches.approve', 'launches.deny']);
const navigationCommands = new Set(['page.click', 'page.fill', 'page.navigate', 'page.forward', 'page.reload', 'page.allowOnce']);
const HUMAN_GESTURE_MS = 2000;
// Schemes that are navigation denials rather than external-application launches.
const NOT_LAUNCHES = new Set(['http', 'https', 'about', 'data', 'javascript', 'blob', 'file', 'filesystem', 'chrome', 'devtools', 'view-source']);

/** Engine switches that keep speculative connections from running ahead of site rules. */
export function applyEngineHardening(app) {
  app.commandLine.appendSwitch('dns-prefetch-disable');
  app.commandLine.appendSwitch('disable-features', 'PreconnectToSearch,SpeculationRulesPrefetch,Prerender2');
}

export function safeUrl(value) {
  const url = new URL(value);
  if (!['http:', 'https:'].includes(url.protocol) && url.href !== 'about:blank') {
    throw new Error('Only HTTP, HTTPS and about:blank URLs are allowed');
  }
  if (url.username || url.password) throw new Error('URLs must not contain credentials');
  return url.href;
}

function bounded(promise, timeout = 8000) {
  let timer;
  return Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('Page capture timed out; show the tab and try again')), timeout); })]).finally(() => clearTimeout(timer));
}

export class Browser {
  constructor({ window, session, workspaceService, admission = new AutomationAdmission(), electronApi = electron, siteStorage, threatIntel, downloadSafety, dataDirectory } = {}) {
    this.electron = electronApi;
    const directory = dataDirectory ?? workspaceService?.directory;
    this.siteStorage = siteStorage ?? (workspaceService ? new SiteStoragePolicy({ workspaceService, journalPath: directory && join(directory, 'temporary-storage-journal.json'), sessionFor: id => this.partition(id) }) : null);
    this.threats = threatIntel ?? new ThreatIntel({ path: directory && join(directory, 'threat-intel.json') });
    this.downloadSafety = downloadSafety ?? new DownloadSafety({ path: directory && join(directory, 'download-safety.json') });
    this.launches = new Map();
    this.nextLaunchId = 1;
    this.openExternal = url => this.electron.shell.openExternal(url);
    this.admission = admission;
    this.window = window;
    this.workspaceService = workspaceService;
    this.sessions = new Map();
    this.tabs = new Map();
    this.downloads = new Map();
    this.downloadGrants = new Map();
    this.nextTabId = 1;
    this.nextDownloadId = 1;
    this.activeId = null;
    this.viewport = null;
    this.attachedViews = new Set();
    this.session = session ?? this.sessionFor(this.workspaceId);
    if (session) this.configureSession(session, this.workspaceId);
    this.onResize = () => this.layout();
    window?.on('resize', this.onResize);
  }

  get workspaceId() { return this.workspaceService?.activeWorkspaceId ?? 'general'; }

  partition(workspaceId) {
    return this.sessions.get(workspaceId)?.session ?? this.electron.session.fromPartition(`persist:weft-${workspaceId}`);
  }

  sessionFor(workspaceId = this.workspaceId) {
    if (this.sessions.has(workspaceId)) return this.sessions.get(workspaceId).session;
    const session = this.electron.session.fromPartition(`persist:weft-${workspaceId}`);
    this.configureSession(session, workspaceId);
    return session;
  }

  configureSession(session, workspaceId) {
    // Every web permission is denied. External-protocol launches become pending
    // browser-owned requests; repeated or deceptive prompts never reach the person.
    session.setPermissionRequestHandler((contents, permission, callback, details) => {
      if (permission === 'openExternal') this.requestLaunch(contents, details?.externalURL, details?.isMainFrame === false ? 'subframe' : 'main-frame', details?.requestingUrl);
      else this.notePermission(contents, permission);
      callback(false);
    });
    session.setPermissionCheckHandler(() => false);
    const onDownload = (_event, item, contents) => this.trackDownload(item, workspaceId, contents);
    session.on('will-download', onDownload);
    // Chromium's request interception covers navigations, redirects, frames and
    // ordinary background requests. It is not a firewall for external tools.
    session.webRequest?.onBeforeRequest((details, callback) => {
      const navigation = ['mainFrame', 'subFrame'].includes(details.resourceType);
      const tab = [...this.tabs.values()].find(candidate => candidate.view.webContents.id === details.webContentsId);
      const overridden = tab && tab.allowUrl === this.overrideKey(details.url);
      let answered = false;
      const finish = findings => {
        if (answered) return;
        answered = true;
        const security = findings.find(finding => finding.action === 'block');
        if (security && !(overridden && tab.allowSecurity)) {
          if (details.resourceType === 'mainFrame' && tab?.navigating === details.url) this.block(tab, details.url, null, security);
          callback({ cancel: true });
          return;
        }
        const rule = this.workspaceService?.matchSiteRule(details.url, workspaceId);
        const cancel = !!rule && rule.behavior === 'block' && (rule.mode === 'connection' || navigation) && !overridden;
        // Only the tab's own committed-to navigation produces a stop page; speculative
        // main-frame requests are cancelled without changing what the tab shows.
        if (cancel && details.resourceType === 'mainFrame' && tab?.navigating === details.url) this.block(tab, details.url, rule);
        callback({ cancel });
      };
      let assessed;
      try { assessed = this.threats?.assess(details.url, { remote: navigation }) ?? []; } catch { assessed = []; }
      if (typeof assessed?.then === 'function') {
        assessed.then(finish, error => {
          // Provider lookups fail open, visibly; installed local lists were already checked.
          if (tab) { tab.securityWarning = `Reputation lookup unavailable: ${String(error.message).slice(0, 200)}`; this.persist(); }
          finish([]);
        });
      } else finish(assessed);
    });
    // Speculative prefetch/prerender requests (link rel=prefetch, speculation rules)
    // are cancelled outright: Chromium flags them with Sec-Purpose and Electron's
    // feature switches do not disable them. Site rules already saw them above.
    session.webRequest?.onBeforeSendHeaders((details, callback) => {
      try {
        const purpose = Object.entries(details.requestHeaders ?? {}).find(([key]) => ['sec-purpose', 'purpose'].includes(key.toLowerCase()))?.[1];
        if (/prefetch|prerender/i.test(String(purpose ?? ''))) { this.siteStorage?.count(details.webContentsId, 'speculativeLoadsCancelled'); callback({ cancel: true }); return; }
        callback(this.siteStorage?.beforeSendHeaders(details, workspaceId) ?? {});
      } catch { callback({ cancel: true }); }
    });
    session.webRequest?.onHeadersReceived((details, callback) => {
      try { callback(this.siteStorage?.headersReceived(details, workspaceId) ?? {}); } catch { callback({ cancel: true }); }
    });
    const detachStorage = this.siteStorage?.attach(session, workspaceId);
    this.sessions.set(workspaceId, { session, onDownload, detachStorage });
  }

  notePermission(contents, permission) {
    const tab = [...this.tabs.values()].find(candidate => candidate.view.webContents === contents);
    if (!tab) return;
    tab.permissionDenials ??= {};
    tab.permissionDenials[permission] = (tab.permissionDenials[permission] ?? 0) + 1;
  }

  recentHumanInput(tab) { return Boolean(tab?.lastHumanInput && Date.now() - tab.lastHumanInput < HUMAN_GESTURE_MS); }

  requestLaunch(contents, target, frame, requestingUrl) {
    let scheme;
    try { scheme = new URL(target).protocol.slice(0, -1).toLowerCase(); } catch { return null; }
    if (NOT_LAUNCHES.has(scheme)) return null;
    const tab = [...this.tabs.values()].find(candidate => candidate.view.webContents === contents);
    const targetUrl = String(target).slice(0, 2048);
    const existing = [...this.launches.values()].find(item => ['pending', 'refused'].includes(item.state) && item.tabId === (tab?.id ?? null) && item.targetUrl === targetUrl);
    if (existing) { existing.attempts++; existing.lastAttemptAt = new Date().toISOString(); return existing; }
    const id = this.nextLaunchId++;
    const refused = NEVER_LAUNCH.has(scheme);
    const record = { id, workspaceId: tab?.workspaceId ?? this.workspaceId, tabId: tab?.id ?? null, scheme, targetUrl, frame,
      sourceUrl: sanitizeUrl(contents?.getURL?.() || '') || null, sourceTitle: String(contents?.getTitle?.() || '').slice(0, 300),
      requestingUrl: sanitizeUrl(requestingUrl || '') || null, recentHumanInput: this.recentHumanInput(tab), attempts: 1,
      state: refused ? 'refused' : 'pending', createdAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 300000).toISOString(),
      reason: refused ? `The ${scheme}: scheme is never launched from web content.` : 'External application launches require a person to approve this exact request in Weft.' };
    this.launches.set(id, record);
    if (this.launches.size > 200) this.launches.delete(this.launches.keys().next().value);
    return record;
  }

  overrideKey(value) {
    try { const url = new URL(value); url.hash = ''; return url.href; } catch { return ''; }
  }

  block(tab, url, rule, finding = null) {
    tab.blocked = finding
      ? { url, kind: 'security', category: finding.category, source: finding.source, listId: finding.listId, publisher: finding.publisher,
        reference: finding.reference, freshness: finding.freshness, stale: finding.stale, reason: `Security finding: known ${finding.category} destination`, at: Date.now() }
      : { url, kind: 'preference', ruleId: rule.id, hostname: rule.hostname, reason: rule.reason, source: ruleSource(rule),
        scope: rule.scope, mode: rule.mode, note: rule.note || '', provenance: rule.provenance ?? null, at: Date.now() };
    tab.error = finding ? `Blocked by security intelligence: ${finding.category}` : `Blocked by site rule: ${rule.hostname}`;
    this.layout();
    this.persist();
  }

  /** Structured result for agents: what stopped the request and how a human may proceed. */
  blockedError(blocked) {
    const error = new Error(blocked.kind === 'security' ? `Blocked by security intelligence (${blocked.category}); a person may proceed with an explicit risk acknowledgement`
      : `Blocked by site rule: ${blocked.hostname}${blocked.reason ? ` — ${blocked.reason}` : ''}`);
    error.code = 'site_blocked';
    error.details = { url: sanitizeUrl(blocked.url) || null, kind: blocked.kind, ruleId: blocked.ruleId ?? null, hostname: blocked.hostname ?? null, source: blocked.source ?? null,
      mode: blocked.mode ?? null, reason: blocked.reason ?? null, category: blocked.category ?? null, stale: blocked.stale ?? null,
      exception: 'human-only: page.allowOnce from the trusted browser interface', explain: 'siteRules.explain' };
    return error;
  }

  allowedUrl(value, workspaceId, tab) {
    const url = safeUrl(value);
    const overridden = tab && tab.allowUrl === this.overrideKey(url);
    const security = this.threats?.checkUrl(url).find(finding => finding.action === 'block');
    if (security && !(overridden && tab.allowSecurity)) {
      if (tab) this.block(tab, url, null, security);
      throw this.blockedError(tab?.blocked ?? { url, kind: 'security', category: security.category, source: security.source, stale: security.stale, reason: 'Security finding' });
    }
    const rule = this.workspaceService?.matchSiteRule(url, workspaceId);
    if (rule?.behavior === 'block' && !overridden) {
      if (tab) this.block(tab, url, rule);
      throw this.blockedError(tab?.blocked ?? { url, kind: 'preference', ruleId: rule.id, hostname: rule.hostname, reason: rule.reason, source: ruleSource(rule), mode: rule.mode });
    }
    return url;
  }

  setLayout(bounds) {
    if (!bounds || typeof bounds !== 'object' || Array.isArray(bounds)
      || Object.keys(bounds).some(key => !['x', 'y', 'width', 'height', 'visible', 'splitTabId'].includes(key))
      || typeof bounds.visible !== 'boolean'
      || !['x', 'y', 'width', 'height'].every(key => Number.isInteger(bounds[key]) && bounds[key] >= 0 && bounds[key] <= 20000)
      || (bounds.splitTabId != null && (!Number.isInteger(bounds.splitTabId) || bounds.splitTabId < 1))) {
      throw new Error('Invalid native page bounds');
    }
    if (bounds.splitTabId != null && this.tab(bounds.splitTabId).workspaceId !== this.workspaceId) throw new Error('Split tabs must belong to this workspace');
    this.viewport = { ...bounds };
    this.layout();
    return { success: true };
  }

  layout() {
    if (!this.window || this.window.isDestroyed()) return;
    const [width, height] = this.window.getContentSize();
    const requested = this.viewport ?? { x: 0, y: 112, width: Math.max(1, width - 360), height: Math.max(1, height - 112), visible: true };
    const x = Math.min(requested.x, Math.max(0, width - 1));
    const y = Math.min(requested.y, Math.max(0, height - 1));
    const bounds = { x, y, width: Math.max(1, Math.min(requested.width, width - x)), height: Math.max(1, Math.min(requested.height, height - y)) };
    const active = this.tabs.get(this.activeId);
    const split = this.tabs.get(requested.splitTabId);
    const visible = requested.visible && requested.width > 0 && requested.height > 0 && !active?.blocked && active?.workspaceId === this.workspaceId
      ? [active, ...(split && !split.blocked && split.id !== active.id && split.workspaceId === this.workspaceId ? [split] : [])] : [];
    for (const view of this.attachedViews) if (!visible.some(tab => tab.view === view)) {
      this.window.contentView.removeChildView(view);
      this.attachedViews.delete(view);
    }
    visible.forEach((tab, index) => {
      if (!this.attachedViews.has(tab.view)) { this.window.contentView.addChildView(tab.view); this.attachedViews.add(tab.view); }
      const half = Math.floor(bounds.width / visible.length);
      tab.view.setBounds({ ...bounds, x: bounds.x + index * half, width: index === visible.length - 1 ? bounds.width - index * half : half });
    });
  }

  tab(tabId = this.activeId) {
    const tab = this.tabs.get(tabId);
    if (!tab) throw new Error('Tab not found');
    return tab;
  }

  describe(tab) {
    const contents = tab.view.webContents;
    const rule = this.workspaceService?.matchSiteRule(contents.getURL() || tab.url, tab.workspaceId);
    return { id: tab.id, workspaceId: tab.workspaceId, url: tab.blocked?.url || contents.getURL() || tab.url || 'about:blank',
      title: String(contents.getTitle() || tab.title || 'New tab').slice(0, 1000), active: tab.id === this.activeId,
      pinned: !!tab.pinned, controller: tab.controller ?? 'available', version: tab.version ?? 1,
      loading: contents.isLoading?.() ?? false, canGoBack: contents.navigationHistory?.canGoBack() ?? false,
      canGoForward: contents.navigationHistory?.canGoForward() ?? false, zoom: contents.getZoomFactor?.() ?? 1,
      blocked: tab.blocked ?? null, error: tab.error ?? null, warning: rule?.behavior === 'warn' ? `${rule.hostname}: ${rule.reason}` : null,
      protection: this.protection(tab) };
  }

  /** Quiet browser-owned indicator data: what was blocked in this tab. */
  protection(tab) {
    let hostname = null;
    try { hostname = new URL(tab.view.webContents.getURL() || tab.url).hostname || null; } catch { /* about:blank */ }
    return { storageMode: hostname && this.siteStorage ? this.siteStorage.modeFor(hostname, tab.workspaceId) : null,
      storageActivity: this.siteStorage?.activityFor(tab.view.webContents.id) ?? {}, blockedPopups: tab.blockedPopups ?? [],
      permissionDenials: tab.permissionDenials ?? {}, pendingLaunches: [...this.launches.values()].filter(item => item.tabId === tab.id && item.state === 'pending').length,
      securityWarning: tab.securityWarning ?? null, exception: tab.allowUrl ? { url: sanitizeUrl(tab.allowUrl) || null, security: Boolean(tab.allowSecurity) } : null };
  }

  persist() {
    if (this.closing || this.restoring) return;
    this.workspaceService?.persistSession({ tabs: [...this.tabs.values()].map(tab => this.describe(tab)), activeId: this.activeId });
  }

  async restore() {
    // Temporary site data left by a crash is erased before any tab can load it again.
    await this.siteStorage?.cleanup('startup').catch(error => { this.storageRecoveryError = error.message; });
    const saved = this.workspaceService?.snapshot().browserSession;
    this.restoring = true;
    try {
      for (const record of saved?.tabs ?? []) {
        if (!this.workspaceService.snapshot().workspaces.some(workspace => workspace.id === record.workspaceId)) continue;
        try { await this.newTab(record.url, record.workspaceId, record); } catch { /* Keep a recoverable tab after a failed restore. */ }
      }
      const selected = this.tabs.get(saved?.activeId);
      if (selected?.workspaceId === this.workspaceId) this.activate(selected.id);
      else await this.switchWorkspace(this.workspaceId);
    } finally { this.restoring = false; this.persist(); }
  }

  async switchWorkspace(workspaceId) {
    const selected = [...this.tabs.values()].find(tab => tab.workspaceId === workspaceId);
    this.session = this.sessionFor(workspaceId);
    return selected ? this.activate(selected.id) : this.newTab('about:blank', workspaceId);
  }

  activate(tabId) {
    const tab = this.tab(tabId);
    if (tab.workspaceId !== this.workspaceId && this.workspaceService) throw new Error('Switch to the tab workspace before activating it');
    this.activeId = tabId;
    this.layout();
    this.persist();
    return this.describe(tab);
  }

  async newTab(url = 'about:blank', workspaceId = this.workspaceId, restored = {}) {
    if (this.workspaceService && !this.workspaceService.snapshot().workspaces.some(workspace => workspace.id === workspaceId)) throw new Error('Workspace not found');
    url = safeUrl(url);
    const view = new this.electron.WebContentsView({
      webPreferences: {
        session: this.sessions.get(workspaceId)?.session ?? this.sessionFor(workspaceId), nodeIntegration: false, contextIsolation: true,
        sandbox: true, webSecurity: true, allowRunningInsecureContent: false,
      },
    });
    const id = Number.isSafeInteger(restored.id) && restored.id > 0 && !this.tabs.has(restored.id) ? restored.id : this.nextTabId;
    this.nextTabId = Math.max(this.nextTabId, id + 1);
    const tab = { id, workspaceId, view, url, title: restored.title, pinned: !!restored.pinned, version: restored.version || 1, controller: 'available', openerTabId: restored.openerTabId ?? null, openedBy: restored.openedBy ?? null };
    this.tabs.set(tab.id, tab);
    const contents = view.webContents;
    const guard = (event, target) => {
      try { this.allowedUrl(target, tab.workspaceId, tab); } catch (error) {
        event.preventDefault();
        const launch = this.requestLaunch(contents, target, 'main-frame', contents.getURL());
        tab.error = launch ? `External application launch blocked (${launch.scheme}:); review it in Downloads & launches` : error.message;
        this.persist();
      }
    };
    contents.on('will-navigate', guard);
    contents.on('will-redirect', guard);
    contents.on('will-attach-webview', event => event.preventDefault());
    const humanInput = (_event, input) => {
      if (['mouseMove', 'mouseEnter', 'mouseLeave'].includes(input.type)) return;
      if (['mouseDown', 'keyDown', 'rawKeyDown'].includes(input.type)) { this.downloadGrants.set(tab.id, Date.now() + HUMAN_GESTURE_MS); tab.lastHumanInput = Date.now(); }
      if (tab.controller !== 'human' && tab.controller !== 'available') {
        // Real native input is a human takeover at the next input boundary.
        // Already executed page scripts cannot be rolled back.
        tab.controller = 'human'; tab.controlEpoch = (tab.controlEpoch ?? 0) + 1; tab.version++; contents.stop(); this.persist();
      }
    };
    contents.on('before-input-event', humanInput);
    contents.on('before-mouse-event', humanInput);
    contents.on('did-navigate', () => {
      tab.version++; tab.error = null; tab.blocked = null; tab.securityWarning = null;
      // A gesture authorizes downloads/popups for the document it happened in, not the next page.
      if (typeof this.downloadGrants.get(tab.id) === 'number') this.downloadGrants.delete(tab.id);
      tab.lastHumanInput = 0;
      // An exact-visit exception ends as soon as the tab commits any other destination.
      if (tab.allowUrl !== this.overrideKey(contents.getURL())) { tab.allowUrl = null; tab.allowSecurity = false; }
      this.layout(); this.persist();
    });
    contents.on('did-navigate-in-page', () => { tab.version++; this.persist(); });
    contents.on('did-start-navigation', details => {
      if (!details?.isMainFrame || details.isSameDocument || (details.frame && details.frame !== contents.mainFrame)) return;
      tab.navigating = details.url;
      this.siteStorage?.resetActivity(contents.id);
    });
    contents.on('did-redirect-navigation', details => { if (details?.isMainFrame && (!details.frame || details.frame === contents.mainFrame)) tab.navigating = details.url; });
    contents.on('page-title-updated', () => this.persist());
    contents.on('did-finish-load', () => {
      this.workspaceService?.recordVisit({ workspaceId: tab.workspaceId, url: contents.getURL(), title: contents.getTitle().slice(0, 1000), tabId: tab.id });
      this.persist();
    });
    contents.on('did-fail-load', (_event, code, description, failedUrl, isMainFrame) => {
      if (isMainFrame && code !== -3) { tab.error = description; this.persist(); }
    });
    contents.setWindowOpenHandler(({ url: target, disposition }) => {
      // Native windows are never created. A page may open a tab only during a
      // human gesture in this tab or an automation action in flight on it.
      const actor = this.recentHumanInput(tab) ? 'human' : tab.inFlight ? 'automation' : null;
      if (!actor) {
        tab.blockedPopups = [...(tab.blockedPopups ?? []), { url: sanitizeUrl(target) || String(target).slice(0, 200), disposition, at: new Date().toISOString(), reason: 'Opened without recent input in this tab' }].slice(-20);
        this.persist();
        return { action: 'deny' };
      }
      try {
        this.allowedUrl(target, tab.workspaceId);
        void this.newTab(target, tab.workspaceId, { openerTabId: tab.id, openedBy: actor }).catch(error => { tab.error = error.message; });
      } catch (error) { tab.error = error.message; }
      return { action: 'deny' };
    });
    if (workspaceId === this.workspaceId) this.activate(tab.id);
    this.persist();
    try { await contents.loadURL(this.allowedUrl(url, workspaceId, tab)); }
    catch (error) {
      tab.error = error.message; this.persist();
      const blocked = error.code === 'site_blocked' ? error : tab.blocked ? this.blockedError(tab.blocked) : null;
      throw Object.assign(new Error(`Navigation failed: ${(blocked ?? error).message}`), blocked ? { code: 'site_blocked', details: blocked.details } : {});
    }
    this.persist();
    return this.describe(tab);
  }

  closeTab(tabId) {
    const tab = this.tab(tabId);
    if (this.attachedViews.has(tab.view)) {
      if (this.window && !this.window.isDestroyed()) this.window.contentView.removeChildView(tab.view);
      this.attachedViews.delete(tab.view);
    }
    if (this.activeId === tabId) this.activeId = null;
    this.tabs.delete(tabId);
    const contents = tab.view.webContents;
    if (contents && !contents.isDestroyed()) contents.close({ waitForBeforeUnload: false });
    if (!this.closing && this.activeId === null) {
      const next = [...this.tabs.values()].find(candidate => candidate.workspaceId === this.workspaceId);
      if (next) this.activate(next.id);
    }
    this.persist();
    return { closed: tabId };
  }

  async captureArtifact({ tabId, kind, workspaceId }, context = { actor: 'human' }) {
    const tab = this.tab(tabId);
    if (tab.workspaceId !== (workspaceId ?? context.workspaceId ?? this.workspaceId)) throw new Error('Capture tab belongs to a different workspace');
    const version = tab.version;
    const readable = await this.execute('page.readable', { tabId: tab.id }, context);
    let screenshot;
    let captureError;
    if (kind !== 'text') {
      try { screenshot = await this.execute('page.screenshot', { tabId: tab.id }, context); }
      catch (error) { if (kind === 'screenshot') throw error; captureError = error.message; }
    }
    return { ...readable, pngBase64: screenshot?.data, navigationVersion: version,
      limitations: ['Reference capture is not an offline replay. Dynamic, authenticated, and cross-origin embedded content may be incomplete.',
        ...(captureError ? [`Screenshot unavailable: ${captureError}`] : []),
        ...(version !== tab.version ? ['The page changed during capture.'] : [])] };
  }

  trackDownload(item, workspaceId = this.workspaceId, contents) {
    const source = [...this.tabs.values()].find(tab => tab.view.webContents === contents);
    const grant = source && this.downloadGrants.get(source.id);
    const permitted = source && (typeof grant === 'number' ? grant >= Date.now() : grant?.expires >= Date.now() && grant.url === item.getURL());
    if (source) this.downloadGrants.delete(source.id);
    // Source page, file type and redirect chain are shown with every record so a
    // person can judge the request; Chromium's own gesture flag is informational only.
    const filename = basename(item.getFilename()).replace(/[^\p{L}\p{N}._-]/gu, '_').slice(0, 160) || 'download';
    const mimeType = String(item.getMimeType?.() || '').slice(0, 200);
    const details = { workspaceId, sourceTabId: source?.id ?? null, url: item.getURL(), filename, mimeType, ...fileCategory(filename, mimeType),
      sourcePage: sanitizeUrl(contents?.getURL?.() || '') || null, sourceTitle: String(contents?.getTitle?.() || '').slice(0, 300),
      redirectHosts: [...new Set((item.getURLChain?.() ?? []).map(value => { try { return new URL(value).host; } catch { return ''; } }).filter(Boolean))].slice(0, 10),
      engineUserGesture: item.hasUserGesture?.() ?? null, totalBytes: item.getTotalBytes(), receivedBytes: 0, startedAt: new Date().toISOString() };
    if (!permitted) {
      item.cancel();
      const now = Date.now();
      // Repeated attempts collapse into one record; a burst of distinct unsolicited
      // downloads from one tab is counted instead of flooding the list.
      const existing = [...this.downloads.values()].find(({ record }) => record.state === 'blocked' && record.sourceTabId === details.sourceTabId && record.url === details.url);
      if (existing) { existing.record.attempts++; existing.record.lastAttemptAt = new Date(now).toISOString(); return; }
      const recent = [...this.downloads.values()].filter(({ record }) => record.state === 'blocked' && record.sourceTabId === details.sourceTabId && now - Date.parse(record.startedAt) < 60000);
      if (recent.length >= 5) { const last = recent.at(-1).record; last.suppressedAttempts = (last.suppressedAttempts ?? 0) + 1; return; }
      const id = this.nextDownloadId++;
      this.downloads.set(id, { item: null, record: { id, ...details, state: 'blocked', attempts: 1, scanStatus: 'unscanned',
        reason: 'Download needs human approval. No recent browser input in this tab authorized this request.' } });
      return;
    }
    const id = this.nextDownloadId++;
    const directory = join(this.electron.app.getPath('downloads'), 'Weft');
    let path;
    try {
      // Downloads stay in a dedicated data folder, never beside application code.
      const appPath = this.electron.app.getAppPath?.();
      if (appPath && (resolve(directory) + sep).startsWith(resolve(appPath) + sep)) throw new Error('Download folder is inside the application directory');
      mkdirSync(directory, { recursive: true });
      path = join(directory, `${randomUUID()}-${filename}`);
      closeSync(openSync(path, 'wx', 0o600));
      item.setSavePath(path);
    } catch {
      item.cancel();
      return;
    }
    const record = { id, ...details, scanStatus: 'pending', state: 'progressing', attempts: 1 };
    this.downloads.set(id, { item, record });
    item.on('updated', (_event, state) => {
      Object.assign(record, { state, receivedBytes: item.getReceivedBytes(), totalBytes: item.getTotalBytes() });
    });
    item.once('done', (_event, state) => {
      Object.assign(record, { state, receivedBytes: item.getReceivedBytes(), totalBytes: item.getTotalBytes() });
      if (this.downloads.has(id)) this.downloads.get(id).item = null;
      if (state === 'completed') record.inspection = this.inspectDownload(record, path, directory);
      else record.scanStatus = 'unscanned';
    });
  }

  /** Post-download handling. Files are never opened or executed by Weft. */
  async inspectDownload(record, path, directory) {
    try {
      try { chmodSync(path, 0o600); } catch { /* Windows has no POSIX execute bits. */ }
      record.sha256 = await hashFile(path);
      record.originMetadata = await applyOriginMetadata(path, { url: record.url, referrer: record.sourcePage });
      const known = this.threats?.checkHash(record.sha256) ?? [];
      if (known.length) Object.assign(record, { scanStatus: 'known-malicious', scanDetail: `SHA-256 listed by ${known[0].listId} (${known[0].category})`, securityFinding: known[0] });
      else { record.scanStatus = 'scanning'; Object.assign(record, await this.downloadSafety.scan(path)); }
      if (['known-malicious', 'infected'].includes(record.scanStatus)) { this.downloadSafety.quarantine(path, directory); record.quarantined = true; }
    } catch (error) {
      record.scanStatus = record.scanStatus === 'scanning' || record.scanStatus === 'pending' ? 'scan-failed' : record.scanStatus;
      record.scanDetail = `Post-download inspection failed: ${String(error.message).slice(0, 200)}`;
    }
    return record.scanStatus;
  }

  async execute(name, args = {}, context = { actor: 'human' }) {
    this.admission.assertAutomationAdmitted(context.actor, name);
    const human = ['human', 'admin'].includes(context.actor);
    const tab = mutatingCommands.has(name) ? this.tab(args.tabId) : null;
    if (tab?.inFlight && !human) throw Object.assign(new Error('Another action is still in flight on this tab'), { code: 'tab_busy' });
    if (tab?.inFlight && human) {
      tab.controlEpoch = (tab.controlEpoch ?? 0) + 1;
      tab.controller = 'human';
      tab.view.webContents.stop();
    }
    const token = tab ? Symbol(name) : null;
    const epoch = tab?.controlEpoch ?? 0;
    if (tab) tab.inFlight = token;
    const started = Date.now();
    try {
      const result = await this.executeAdmitted(name, args, context);
      if (tab && !human && epoch !== (tab.controlEpoch ?? 0)) throw Object.assign(new Error('Tab control changed during the action; inspect current state. Already submitted effects cannot be undone.'), { code: 'action_interrupted' });
      if (tab?.blocked && navigationCommands.has(name)) throw this.blockedError(tab.blocked);
      return result;
    } catch (error) {
      // An engine abort caused by a rule is reported as a structured block, never a generic failure.
      if (tab?.blocked && navigationCommands.has(name) && error.code !== 'site_blocked' && tab.blocked.at >= started) throw this.blockedError(tab.blocked);
      throw error;
    } finally { if (tab?.inFlight === token) tab.inFlight = null; }
  }

  async executeSecurity(name, args, context, workspaceId) {
    const human = ['human', 'admin'].includes(context.actor);
    if (!human && humanOnlyBrowserCommands.has(name)) throw new Error(`${name} requires the trusted browser interface`);
    if (name.startsWith('storage.')) {
      if (!this.siteStorage) throw new Error('Site storage modes require workspace storage');
      return this.siteStorage.execute(name, { ...args, workspaceId }, context);
    }
    if (name === 'threats.status') return { ...this.threats.status(), downloadScanner: this.downloadSafety.status() };
    if (name.startsWith('threats.')) return this.threats.execute(name, args);
    if (name === 'downloads.configureScanner') return this.downloadSafety.configure(args);
    if (name === 'siteRules.explain') {
      if (!this.workspaceService) throw new Error('Site-rule explanation requires workspace storage');
      const url = safeUrl(args.url);
      const tab = args.tabId != null ? this.tab(args.tabId) : null;
      if (tab && tab.workspaceId !== workspaceId) throw new Error('Tab belongs to a different workspace');
      const exception = tab?.allowUrl && tab.allowUrl === this.overrideKey(url) ? { kind: 'exact-visit', tabId: tab.id, url: sanitizeUrl(url), coversSecurityFinding: Boolean(tab.allowSecurity),
        expires: 'When this tab commits another destination, closes, or Weft restarts. Redirects, embedded resources and other tabs are never covered.' } : null;
      return this.workspaceService.explainSiteRules(url, workspaceId, { exception, security: this.threats.checkUrl(url) });
    }
    if (name === 'launches.list') return [...this.launches.values()].filter(item => item.workspaceId === workspaceId).map(item => ({ ...item }));
    const launch = this.launches.get(args.launchId);
    if (!launch) throw new Error('Launch request not found');
    if (name === 'launches.deny') { if (launch.state === 'pending') launch.state = 'denied'; return { ...launch }; }
    if (launch.state !== 'pending') throw new Error(`Launch request is ${launch.state}`);
    if (Date.parse(launch.expiresAt) < Date.now()) { launch.state = 'expired'; throw new Error('Launch request expired; trigger it again from the page'); }
    if (NEVER_LAUNCH.has(launch.scheme)) { launch.state = 'refused'; throw new Error(`The ${launch.scheme}: scheme is never launched`); }
    launch.state = 'approved';
    launch.approvedAt = new Date().toISOString();
    await this.openExternal(launch.targetUrl);
    launch.state = 'launched';
    return { ...launch, notice: 'Handed to the operating system once. Weft cannot see or undo what the external application does.' };
  }

  async executeAdmitted(name, args = {}, context = { actor: 'human' }) {
    const human = ['human', 'admin'].includes(context.actor);
    const workspaceId = args.workspaceId ?? this.workspaceId;
    if (this.workspaceService && !this.workspaceService.snapshot().workspaces.some(workspace => workspace.id === workspaceId)) throw new Error('Workspace not found');
    const session = () => this.sessions.get(workspaceId)?.session ?? this.sessionFor(workspaceId);
    if (!human && ['cookies.list', 'cookies.set', 'cookies.clear', 'storage.clear'].includes(name)) throw new Error('Storage administration requires the trusted browser interface');
    if (name !== 'tabs.move' && args.tabId != null && args.workspaceId != null && this.tab(args.tabId).workspaceId !== args.workspaceId) throw new Error('Tab belongs to a different workspace');
    if (!human && name === 'page.allowOnce') throw new Error('Site exceptions require the trusted browser interface');
    if (mutatingCommands.has(name)) this.checkControl(this.tab(args.tabId), args, context);
    if (/^(storage\.(policy|setSiteMode|setDefaultMode)|threats\.|launches\.|downloads\.configureScanner$|siteRules\.explain$)/.test(name)) return this.executeSecurity(name, args, context, workspaceId);

    switch (name) {
      case 'browser.emergencyStop': {
        if (!human) throw new Error('Emergency stop requires the trusted browser interface');
        this.admission.stop();
        for (const tab of this.tabs.values()) { tab.controlEpoch = (tab.controlEpoch ?? 0) + 1; tab.controller = 'human'; tab.version++; tab.view.webContents.stop(); }
        this.downloadGrants.clear();
        for (const { item } of this.downloads.values()) item?.cancel();
        for (const task of this.workspaceService?.snapshot().tasks ?? []) if (task.status === 'running') await this.workspaceService.execute('tasks.transition', { id: task.id, status: 'paused', cause: 'Human emergency stop' }, context);
        this.persist();
        return { stopped: true, automation: this.admission.status, tabs: this.tabs.size, notice: 'Future agent input requires a human handoff. Already executed page actions cannot be undone.' };
      }
      case 'browser.resumeAutomation': return { automation: this.admission.resume(context.actor), notice: 'Automation resumed. Existing human tab leases remain in place.' };
      case 'downloads.approve': {
        if (!human) throw new Error('Download approval requires the trusted browser interface');
        const download = this.downloads.get(args.downloadId);
        if (!download || download.record.state !== 'blocked') throw new Error('Blocked download not found');
        const tab = this.tab(download.record.sourceTabId);
        const url = this.allowedUrl(download.record.url, tab.workspaceId, tab);
        this.downloadGrants.set(tab.id, { expires: Date.now() + 30000, url });
        tab.view.webContents.downloadURL(url);
        download.record.state = 'retrying';
        return { approved: args.downloadId };
      }
      case 'browser.info':
        return { name: 'Weft', automation: this.admission.status, electron: process.versions.electron, chromium: process.versions.chrome, node: process.versions.node };
      case 'tabs.list': return [...this.tabs.values()].filter(tab => tab.workspaceId === workspaceId).map(tab => this.describe(tab));
      case 'tabs.new': return this.newTab(args.url, workspaceId);
      case 'tabs.activate': return this.activate(args.tabId);
      case 'tabs.close': return this.closeTab(args.tabId);
      case 'tabs.duplicate': { const tab = this.tab(args.tabId); return this.newTab(this.describe(tab).url, tab.workspaceId); }
      case 'tabs.pin': { const tab = this.tab(args.tabId); tab.pinned = args.pinned; tab.version++; this.persist(); return this.describe(tab); }
      case 'tabs.move': {
        const old = this.tab(args.tabId);
        const replacement = await this.newTab(this.describe(old).url, workspaceId, { pinned: old.pinned });
        this.closeTab(old.id);
        return { ...replacement, movedFrom: old.id, notice: 'Opened in the destination workspace storage container.' };
      }
      case 'tabs.claim': {
        const tab = this.tab(args.tabId);
        if (args.expectedVersion != null && args.expectedVersion !== tab.version) throw new Error('Stale tab version; inspect current state');
        if (!human && tab.controller !== 'available' && tab.controller !== context.actor) throw new Error('Tab control is already held');
        tab.controller = human ? (args.controller ?? 'human') : context.actor;
        tab.controlEpoch = (tab.controlEpoch ?? 0) + 1;
        tab.version++; this.persist(); return this.describe(tab);
      }
      case 'tabs.takeover': {
        if (!human) throw new Error('Human takeover requires the trusted browser interface');
        const tab = this.tab(args.tabId); tab.controlEpoch = (tab.controlEpoch ?? 0) + 1; tab.controller = 'human'; tab.version++; tab.view.webContents.stop(); this.persist(); return this.describe(tab);
      }
      case 'tabs.release': {
        const tab = this.tab(args.tabId);
        if (!human && tab.controller !== context.actor) throw new Error('Tab control is not held by this actor');
        tab.controlEpoch = (tab.controlEpoch ?? 0) + 1;
        tab.controller = 'available'; tab.version++; this.persist(); return this.describe(tab);
      }
      case 'storage.info': return { workspaceId, isolated: true, persistent: true, defaults: this.siteStorage?.defaults(workspaceId) ?? null, coverage: {
        workspaceIsolation: 'Separate Chromium session partition, cookies, localStorage, IndexedDB, caches and service workers.',
        clearSite: 'Origin-scoped Chromium storage; cookies for the hostname are removed. Domain cookies shared with subdomains may also be removed.',
        blocking: 'Site storage modes (block, session, remember) are available through storage.policy, storage.setSiteMode and storage.setDefaultMode; see the coverage matrix.',
        matrix: STORAGE_COVERAGE,
        limitations: 'Clearing does not revoke server-side sessions, delete downloaded files, or prevent fingerprinting.' } };
      case 'storage.clear': {
        const origin = args.url ? new URL(safeUrl(args.url)).origin : undefined;
        if (origin === 'null') throw new Error('Storage clearing requires an HTTP(S) origin');
        await session().clearStorageData(origin ? { origin, storages: ['filesystem', 'indexdb', 'localstorage', 'shadercache', 'websql', 'serviceworkers', 'cachestorage'] } : {});
        if (origin) {
          const hostname = new URL(origin).hostname;
          for (const cookie of await session().cookies.get({ domain: hostname })) {
            const domain = cookie.domain.replace(/^\./, '');
            if (hostname === domain || hostname.endsWith(`.${domain}`)) await session().cookies.remove(`${cookie.secure ? 'https' : 'http'}://${hostname}${cookie.path}`, cookie.name);
          }
          await session().clearData?.({ dataTypes: ['cache'], origins: [origin] }).catch(() => {});
        } else await session().clearCache();
        return { success: true, workspaceId, origin: origin ?? null, notice: 'Site data cleared. Existing pages may recreate data; reload or close them. Server sessions are not revoked.' };
      }
      case 'cookies.list':
        return session().cookies.get(args.url ? { url: safeUrl(args.url) } : {});
      case 'cookies.set':
        await session().cookies.set({ url: safeUrl(args.url), name: args.name, value: args.value, ...(args.httpOnly != null ? { httpOnly: args.httpOnly } : {}), ...(args.secure != null ? { secure: args.secure } : {}) });
        return { success: true };
      case 'cookies.clear':
        await session().clearStorageData({ storages: ['cookies'] });
        return { success: true };
      case 'downloads.list': return [...this.downloads.values()].filter(({ record }) => record.workspaceId === workspaceId).map(({ record }) => ({ ...record }));
      case 'downloads.cancel': {
        const download = this.downloads.get(args.downloadId);
        if (!download) throw new Error('Download not found');
        if (download.item) download.item.cancel();
        else download.record.state = 'cancelled';
        return { cancelled: args.downloadId };
      }
      case 'browser.close':
        setTimeout(() => this.electron.app.quit(), 150);
        return { closing: true };
    }
    if (!name.startsWith('page.')) throw new Error(`Unknown command: ${name}`);
    const tab = this.tab(args.tabId);
    const contents = tab.view.webContents;
    switch (name) {
      case 'page.allowOnce': {
        if (!human) throw new Error('Site exceptions require the trusted browser interface');
        if (!tab.blocked) throw new Error('This tab has no blocked destination');
        // Security findings are not ordinary preferences: proceeding needs an explicit acknowledgement.
        if (tab.blocked.kind === 'security' && args.acknowledgeSecurityRisk !== true) throw Object.assign(new Error('This destination is a security finding; proceeding requires acknowledgeSecurityRisk: true'), { code: 'human_required' });
        const target = tab.blocked.url;
        tab.allowUrl = this.overrideKey(target);
        tab.allowSecurity = tab.blocked.kind === 'security';
        tab.blocked = null;
        tab.error = null;
        this.layout();
        await contents.loadURL(this.allowedUrl(target, tab.workspaceId, tab));
        return this.describe(tab);
      }
      case 'page.navigate':
        if (tab.allowUrl !== this.overrideKey(args.url)) tab.allowUrl = null;
        await contents.loadURL(this.allowedUrl(args.url, tab.workspaceId, tab));
        return this.describe(tab);
      case 'page.back':
        if (tab.blocked) { tab.blocked = null; tab.allowUrl = null; tab.error = null; this.layout(); this.persist(); return this.describe(tab); }
        if (contents.navigationHistory.canGoBack()) contents.navigationHistory.goBack();
        return this.describe(tab);
      case 'page.forward':
        if (contents.navigationHistory.canGoForward()) contents.navigationHistory.goForward();
        return this.describe(tab);
      case 'page.reload': contents.reload(); return { success: true };
      case 'page.stop': contents.stop(); return { success: true };
      case 'page.inspect': return this.describe(tab);
      case 'page.readable': return contents.executeJavaScript(`(() => {
        const root = (document.querySelector('main, article, [role="main"]') || document.body)?.cloneNode(true);
        root?.querySelectorAll('input, textarea, select, [contenteditable], script, style, template').forEach(element => element.remove());
        return {url: location.href, title: document.title.slice(0, 1000), text: root?.textContent.slice(0, 500000) || '',
          links: [...document.querySelectorAll('a[href]')].slice(0, 100).map(a => ({text: a.innerText.slice(0, 200), url: a.href.slice(0, 16384)}))};
      })()`);
      case 'page.find':
        if (!args.text) { contents.stopFindInPage('clearSelection'); return { stopped: true }; }
        return { requestId: contents.findInPage(args.text, { forward: args.forward ?? true, findNext: args.findNext ?? false }) };
      case 'page.zoom': contents.setZoomFactor(args.factor); this.persist(); return { factor: contents.getZoomFactor() };
      case 'page.title': return contents.getTitle().slice(0, 1000);
      case 'page.content': return contents.executeJavaScript(`(() => {
        const root = document.documentElement.cloneNode(true);
        root.querySelectorAll('input, textarea, select, [contenteditable], script, style, template').forEach(element => element.remove());
        root.querySelectorAll('*').forEach(element => { for (const attribute of [...element.attributes]) if (/^on/i.test(attribute.name) || /value|token|password|secret/i.test(attribute.name)) element.removeAttribute(attribute.name); });
        return root.outerHTML.slice(0, 500000);
      })()`);
      case 'page.evaluate': {
        const result = await contents.executeJavaScript(args.expression, true);
        return result === undefined ? null : JSON.parse(JSON.stringify(result));
      }
      case 'page.click':
        if (human) { this.downloadGrants.set(tab.id, Date.now() + HUMAN_GESTURE_MS); tab.lastHumanInput = Date.now(); }
        return contents.executeJavaScript(`(() => {
          const element = document.querySelector(${JSON.stringify(args.selector)});
          if (!element) throw new Error('Element not found');
          element.click();
          return {submitted: true, outcome: 'unverified', notice: 'Input submitted; inspect the page to verify its effect.'};
        })()`, true);
      case 'page.fill':
        return contents.executeJavaScript(`(() => {
          const element = document.querySelector(${JSON.stringify(args.selector)});
          if (!element) throw new Error('Element not found');
          const value = ${JSON.stringify(args.value)};
          if (element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement || element instanceof HTMLSelectElement) {
            const prototype = element instanceof HTMLInputElement ? HTMLInputElement.prototype :
              element instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLSelectElement.prototype;
            Object.getOwnPropertyDescriptor(prototype, 'value').set.call(element, value);
          } else if (element.isContentEditable) {
            element.textContent = value;
          } else throw new Error('Element is not editable');
          element.dispatchEvent(new Event('input', {bubbles: true}));
          element.dispatchEvent(new Event('change', {bubbles: true}));
          return {submitted: true, outcome: 'unverified', notice: 'Input submitted; inspect the page to verify its effect.'};
        })()`, true);
      case 'page.screenshot': {
        if (!this.attachedViews.has(tab.view)) throw new Error('Show the tab before capturing a screenshot');
        if (!args.fullPage) {
          const image = await bounded(contents.capturePage(undefined, { stayHidden: true, stayAwake: true }));
          if (image.isEmpty()) throw new Error('The page has no rendered image yet; show the tab and try again');
          return { data: image.toPNG().toString('base64'), mimeType: 'image/png' };
        }
        if (contents.debugger.isAttached()) throw new Error('Debugger is already attached');
        contents.debugger.attach('1.3');
        try {
          const options = { format: 'png', captureBeyondViewport: false };
          if (args.fullPage) {
            const { cssContentSize } = await bounded(contents.debugger.sendCommand('Page.getLayoutMetrics'));
            options.captureBeyondViewport = true;
            options.clip = { x: 0, y: 0, width: cssContentSize.width, height: cssContentSize.height, scale: 1 };
          }
          const { data } = await bounded(contents.debugger.sendCommand('Page.captureScreenshot', options));
          return { data, mimeType: 'image/png' };
        } finally { contents.debugger.detach(); }
      }
      case 'page.pdf':
        return { data: (await contents.printToPDF({})).toString('base64'), mimeType: 'application/pdf' };
      default: throw new Error(`Unknown command: ${name}`);
    }
  }

  checkControl(tab, args, context) {
    if (args.expectedVersion != null && args.expectedVersion !== tab.version) throw new Error('Stale tab version; inspect current state');
    const human = ['human', 'admin'].includes(context.actor);
    if (!human) {
      if (tab.controller !== 'available' && tab.controller !== context.actor) throw new Error('Tab control is held by another actor; request handoff');
      if (args.expectedVersion == null) throw new Error('An expectedVersion is required for automation input; inspect current state');
    } else if (tab.controller !== 'human' && tab.controller !== 'available') {
      throw new Error('Take over this tab before changing it');
    }
    tab.version++;
    this.persist();
  }

  closeWorkspace(workspaceId) {
    for (const tab of [...this.tabs.values()]) if (tab.workspaceId === workspaceId) this.closeTab(tab.id);
  }

  close() {
    if (this.closing) return null;
    this.persist();
    this.closing = true;
    this.window?.removeListener('resize', this.onResize);
    for (const id of [...this.tabs.keys()]) this.closeTab(id);
    for (const { item } of this.downloads.values()) item?.cancel();
    for (const { session, onDownload, detachStorage } of this.sessions.values()) {
      session.removeListener('will-download', onDownload);
      session.webRequest?.onBeforeRequest(null);
      session.webRequest?.onBeforeSendHeaders(null);
      session.webRequest?.onHeadersReceived(null);
      detachStorage?.();
    }
    // Clean exit erases temporary site data; if the process dies first, the
    // durable journal makes the next startup erase it before restoring tabs.
    if (!this.siteStorage?.journal.entries.length) return null;
    return this.siteStorage.cleanup('exit').catch(() => null);
  }
}
