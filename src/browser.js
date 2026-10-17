import electron from 'electron';
import { AutomationAdmission } from './admission.js';

const mutatingCommands = new Set(['page.navigate', 'page.back', 'page.forward', 'page.reload', 'page.stop', 'page.evaluate', 'page.click', 'page.fill', 'page.zoom', 'page.allowOnce', 'tabs.close', 'tabs.move', 'tabs.pin']);
import { randomUUID } from 'node:crypto';
import { mkdirSync, openSync, closeSync } from 'node:fs';
import { basename, join } from 'node:path';

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
  constructor({ window, session, workspaceService, admission = new AutomationAdmission(), electronApi = electron } = {}) {
    this.electron = electronApi;
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

  sessionFor(workspaceId = this.workspaceId) {
    if (this.sessions.has(workspaceId)) return this.sessions.get(workspaceId).session;
    const session = this.electron.session.fromPartition(`persist:weft-${workspaceId}`);
    this.configureSession(session, workspaceId);
    return session;
  }

  configureSession(session, workspaceId) {
    session.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
    session.setPermissionCheckHandler(() => false);
    const onDownload = (_event, item, contents) => this.trackDownload(item, workspaceId, contents);
    session.on('will-download', onDownload);
    // Chromium's request interception covers navigations, redirects, frames and
    // ordinary background requests. It is not a firewall for external tools.
    session.webRequest?.onBeforeRequest((details, callback) => {
      const rule = this.workspaceService?.matchSiteRule(details.url, workspaceId);
      const navigation = ['mainFrame', 'subFrame'].includes(details.resourceType);
      const tab = [...this.tabs.values()].find(candidate => candidate.view.webContents.id === details.webContentsId);
      const overridden = tab && tab.allowUrl === this.overrideKey(details.url);
      const cancel = !!rule && rule.behavior === 'block' && (rule.mode === 'connection' || navigation) && !overridden;
      if (cancel && details.resourceType === 'mainFrame' && tab) this.block(tab, details.url, rule);
      callback({ cancel });
    });
    this.sessions.set(workspaceId, { session, onDownload });
  }

  overrideKey(value) {
    try { const url = new URL(value); url.hash = ''; return url.href; } catch { return ''; }
  }

  block(tab, url, rule) {
    tab.blocked = { url, ruleId: rule.id, hostname: rule.hostname, reason: rule.reason,
      scope: rule.scope, mode: rule.mode, note: rule.note || '', provenance: rule.provenance ?? null };
    tab.error = `Blocked by site rule: ${rule.hostname}`;
    this.layout();
    this.persist();
  }

  allowedUrl(value, workspaceId, tab) {
    const url = safeUrl(value);
    const rule = this.workspaceService?.matchSiteRule(url, workspaceId);
    if (rule?.behavior === 'block' && (!tab || tab.allowUrl !== this.overrideKey(url))) {
      if (tab) this.block(tab, url, rule);
      const error = new Error(`Blocked by site rule: ${rule.hostname}${rule.reason ? ` — ${rule.reason}` : ''}`);
      error.code = 'SITE_BLOCKED';
      throw error;
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
      blocked: tab.blocked ?? null, error: tab.error ?? null, warning: rule?.behavior === 'warn' ? `${rule.hostname}: ${rule.reason}` : null };
  }

  persist() {
    if (this.closing || this.restoring) return;
    this.workspaceService?.persistSession({ tabs: [...this.tabs.values()].map(tab => this.describe(tab)), activeId: this.activeId });
  }

  async restore() {
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
    const tab = { id, workspaceId, view, url, title: restored.title, pinned: !!restored.pinned, version: restored.version || 1, controller: 'available' };
    this.tabs.set(tab.id, tab);
    const contents = view.webContents;
    const guard = (event, target) => {
      try { this.allowedUrl(target, tab.workspaceId, tab); } catch (error) { event.preventDefault(); tab.error = error.message; this.persist(); }
    };
    contents.on('will-navigate', guard);
    contents.on('will-redirect', guard);
    contents.on('will-attach-webview', event => event.preventDefault());
    const humanInput = (_event, input) => {
      if (['mouseMove', 'mouseEnter', 'mouseLeave'].includes(input.type)) return;
      if (['mouseDown', 'keyDown', 'rawKeyDown'].includes(input.type)) this.downloadGrants.set(tab.id, Date.now() + 2000);
      if (tab.controller !== 'human' && tab.controller !== 'available') {
        // Real native input is a human takeover at the next input boundary.
        // Already executed page scripts cannot be rolled back.
        tab.controller = 'human'; tab.controlEpoch = (tab.controlEpoch ?? 0) + 1; tab.version++; contents.stop(); this.persist();
      }
    };
    contents.on('before-input-event', humanInput);
    contents.on('before-mouse-event', humanInput);
    contents.on('did-navigate', () => { tab.version++; tab.error = null; tab.blocked = null; if (tab.allowUrl !== this.overrideKey(contents.getURL())) tab.allowUrl = null; this.layout(); this.persist(); });
    contents.on('did-navigate-in-page', () => { tab.version++; this.persist(); });
    contents.on('page-title-updated', () => this.persist());
    contents.on('did-finish-load', () => {
      this.workspaceService?.recordVisit({ workspaceId: tab.workspaceId, url: contents.getURL(), title: contents.getTitle().slice(0, 1000), tabId: tab.id });
      this.persist();
    });
    contents.on('did-fail-load', (_event, code, description, failedUrl, isMainFrame) => {
      if (isMainFrame && code !== -3) { tab.error = description; this.persist(); }
    });
    contents.setWindowOpenHandler(({ url: target }) => {
      try {
        this.allowedUrl(target, tab.workspaceId);
        void this.newTab(target, tab.workspaceId).catch(error => { tab.error = error.message; });
      } catch (error) { tab.error = error.message; }
      return { action: 'deny' };
    });
    if (workspaceId === this.workspaceId) this.activate(tab.id);
    this.persist();
    try { await contents.loadURL(this.allowedUrl(url, workspaceId, tab)); }
    catch (error) { tab.error = error.message; this.persist(); throw new Error(`Navigation failed: ${error.message}`); }
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
    if (!permitted) {
      const id = this.nextDownloadId++;
      this.downloads.set(id, { item: null, record: { id, workspaceId, sourceTabId: source?.id ?? null, url: item.getURL(), filename: basename(item.getFilename()), state: 'blocked', receivedBytes: 0, totalBytes: item.getTotalBytes(), scanStatus: 'Not scanned', reason: 'Download needs human approval. No recent browser input authorized this request.' } });
      item.cancel(); return;
    }
    const id = this.nextDownloadId++;
    const directory = join(this.electron.app.getPath('downloads'), 'Weft');
    const filename = basename(item.getFilename()).replace(/[^\p{L}\p{N}._-]/gu, '_').slice(0, 160) || 'download';
    try {
      mkdirSync(directory, { recursive: true });
      const path = join(directory, `${randomUUID()}-${filename}`);
      closeSync(openSync(path, 'wx', 0o600));
      item.setSavePath(path);
    } catch {
      item.cancel();
      return;
    }
    const record = { id, workspaceId, sourceTabId: source?.id ?? null, scanStatus: 'Not scanned', url: item.getURL(), filename, state: 'progressing', receivedBytes: 0, totalBytes: item.getTotalBytes() };
    this.downloads.set(id, { item, record });
    item.on('updated', (_event, state) => {
      Object.assign(record, { state, receivedBytes: item.getReceivedBytes(), totalBytes: item.getTotalBytes() });
    });
    item.once('done', (_event, state) => {
      Object.assign(record, { state, receivedBytes: item.getReceivedBytes(), totalBytes: item.getTotalBytes() });
      if (this.downloads.has(id)) this.downloads.get(id).item = null;
    });
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
    try {
      const result = await this.executeAdmitted(name, args, context);
      if (tab && !human && epoch !== (tab.controlEpoch ?? 0)) throw Object.assign(new Error('Tab control changed during the action; inspect current state. Already submitted effects cannot be undone.'), { code: 'action_interrupted' });
      if (tab?.blocked && ['page.click', 'page.fill', 'page.navigate', 'page.forward', 'page.reload'].includes(name)) throw Object.assign(new Error(tab.error || 'Blocked by site rule'), { code: 'site_blocked' });
      return result;
    } finally { if (tab?.inFlight === token) tab.inFlight = null; }
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
      case 'storage.info': return { workspaceId, isolated: true, persistent: true, coverage: {
        workspaceIsolation: 'Separate Chromium session partition, cookies, localStorage, IndexedDB, caches and service workers.',
        clearSite: 'Origin-scoped Chromium storage; cookies for the hostname are removed. Domain cookies shared with subdomains may also be removed.',
        blocking: 'Per-site storage denial and temporary lifetime policies are not implemented.',
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
        const target = tab.blocked.url;
        tab.allowUrl = this.overrideKey(target);
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
        if (human) this.downloadGrants.set(tab.id, Date.now() + 2000);
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
    if (this.closing) return;
    this.persist();
    this.closing = true;
    this.window?.removeListener('resize', this.onResize);
    for (const id of [...this.tabs.keys()]) this.closeTab(id);
    for (const { item } of this.downloads.values()) item?.cancel();
    for (const { session, onDownload } of this.sessions.values()) {
      session.removeListener('will-download', onDownload);
      session.webRequest?.onBeforeRequest(null);
    }
  }
}
