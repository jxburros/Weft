import electron from 'electron';
import { AutomationAdmission } from './admission.js';
import { OBSERVATION_WORLD, MASK_CSS, SENSITIVE_FOCUS_SCRIPT, observationScript, pageString, pngSize } from './page-observation.js';

import { randomUUID } from 'node:crypto';
import { mkdirSync, openSync, closeSync, chmodSync } from 'node:fs';
import { basename, join, resolve, sep } from 'node:path';
import { SiteStoragePolicy } from './site-storage.js';
import { ThreatIntel } from './threat-intel.js';
import { DownloadSafety, NEVER_LAUNCH, applyOriginMetadata, fileCategory, hashFile } from './download-safety.js';
import { ruleSource } from './site-rules.js';
import { sanitizeUrl } from './workspace.js';
import { RECORDING_WORLD, recordingScript } from './recording-script.js';
import { CAPTURE_LIMITS, resourceSettings } from './resources.js';
import { keyName, matchShortcut } from './shortcuts.js';
import { SitePermissions, topOrigin } from './site-permissions.js';
import { MAX_PANES } from './panes.js';
import { HUMAN_GESTURE_MS, MAX_CHECKED_FRAMES, NOT_LAUNCHES, POPUP_GESTURE_MS, REVEAL_CHECKED, SPLIT_GAP, SUSPENDED_OK, SUSPENSION_CHECK, TERMINAL_TASK, bounded, cardGuardedCommands, delay, elementFailure, failure, humanOnlyBrowserCommands, inputCommands, isHuman, mutatingCommands, navigationCommands, rawInputCommands, safeUrl, stale, validPaneRect } from './browser-support.js';
import { browserCommands, pageCommands } from './browser-commands.js';
import { browserChromeMethods } from './browser-chrome.js';
import { browserCredentialMethods } from './browser-credentials.js';
import { browserCaptureMethods } from './browser-captures.js';
export { SPLIT_GAP, chromeShortcut, applyEngineHardening, safeUrl } from './browser-support.js';

export class Browser {
  constructor({ window, session, workspaceService, admission = new AutomationAdmission(), electronApi = electron, siteStorage, threatIntel, downloadSafety, dataDirectory, protectedCooldownMs = 1500 } = {}) {
    this.electron = electronApi;
    this.protectedCooldownMs = protectedCooldownMs;
    const directory = dataDirectory ?? workspaceService?.directory;
    this.directory = directory ?? null;
    this.siteStorage = siteStorage ?? (workspaceService ? new SiteStoragePolicy({ workspaceService, journalPath: directory && join(directory, 'temporary-storage-journal.json'), sessionFor: id => this.partition(id) }) : null);
    this.threats = threatIntel ?? new ThreatIntel({ path: directory && join(directory, 'threat-intel.json') });
    this.downloadSafety = downloadSafety ?? new DownloadSafety({ path: directory && join(directory, 'download-safety.json') });
    this.launches = new Map();
    this.nextLaunchId = 1;
    // Per-site permission prompts and popup allowances (#90, #97): a policy file outside workspace records.
    this.permissions = new SitePermissions({ path: directory && join(directory, 'site-permissions.json'), browser: this, audit: entry => this.onAudit?.(entry) });
    // Tab ids reserved by private windows (#94): never reachable through tab commands.
    this.privateTabIds = new Set();
    this.openExternal = url => this.electron.shell.openExternal(url);
    // Browser chrome for people (#88, #89, #92, #93, #96). Recently closed tabs and remembered zoom are per workspace.
    this.keyNonce = `weft-key-${randomUUID()}:`;
    this.closedTabs = [];
    this.siteZoom = {};
    this.printContents = contents => new Promise(resolve => contents.print({ silent: false, printBackground: true }, (printed, reason) => resolve({ printed: Boolean(printed), reason: printed ? null : String(reason || 'cancelled') })));
    this.popupMenu = (template, tab) => this.electron.Menu.buildFromTemplate(template).popup({ window: this.window ?? undefined });
    this.admission = admission;
    // Per-window display state (#100): the main window is id 1; further windows are added with addWindow().
    this.main = { id: 1, window, viewport: null, attachedViews: new Set(), activeId: null, workspaces: null, current: null, focusedPaneKey: null };
    this.windows = new Map([[1, this.main]]);
    this.nextWindowId = 2;
    this.workspaceService = workspaceService;
    this.sessions = new Map();
    this.tabs = new Map();
    this.downloads = new Map();
    this.downloadGrants = new Map();
    this.nextTabId = 1;
    this.nextDownloadId = 1;
    // Display state (#11): a hidden window renders new pages offscreen so captures keep working.
    this.hidden = false;
    this.offscreen = false;
    this.renderingFor = new Set();
    // Optional: total page-renderer memory in MiB, used for memory-pressure suspension (#30).
    this.rendererMemoryMb = null;
    // System memory-pressure sampler (src/memory-pressure.js), set by the app; null disables the OS signal.
    this.systemMemory = null;
    // Set by WorkspaceExtensions; without it, extension-originated requests are cancelled.
    this.extensionRequestAllowed = null;
    // A locked encrypted profile has no active workspace yet: sessions are created after unlock.
    this.suspended = Boolean(workspaceService?.locked);
    this.session = session ?? (this.suspended ? null : this.sessionFor(this.workspaceId));
    if (session) this.configureSession(session, this.workspaceId);
    this.onResize = () => this.layout();
    window?.on('resize', this.onResize);
  }

  get workspaceId() { return this.workspaceService?.locked ? 'general' : this.workspaceService?.activeWorkspaceId ?? 'general'; }

  /** Read-only lookup on live state; copying every record per command made large workspaces slow (#30). */
  workspaceExists(workspaceId) {
    const workspaces = this.workspaceService?.data?.workspaces ?? this.workspaceService?.snapshot().workspaces ?? [];
    return workspaces.some(workspace => workspace.id === workspaceId);
  }

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
    // Web permissions get a browser-owned prompt only a person can answer (#90); everything else is denied.
    // External-protocol launches become pending browser-owned requests; repeated or deceptive prompts never reach the person.
    session.setPermissionRequestHandler((contents, permission, callback, details) => {
      if (permission === 'openExternal') { this.requestLaunch(contents, details?.externalURL, details?.isMainFrame === false ? 'subframe' : 'main-frame', details?.requestingUrl); callback(false); return; }
      this.permissions.request(this.tabFor(contents), permission, details, callback);
    });
    session.setPermissionCheckHandler((contents, permission, requestingOrigin, details) => {
      try { return this.permissions.check(contents && this.tabFor(contents), permission, requestingOrigin, details); } catch { return false; }
    });
    // Screen sharing: the person picks a screen or window in Weft's prompt; no system picker, no audio loopback.
    session.setDisplayMediaRequestHandler?.((request, callback) => { void this.requestDisplay(request, callback); }, { useSystemPicker: false });
    const onDownload = (_event, item, contents) => this.trackDownload(item, workspaceId, contents);
    session.on('will-download', onDownload);
    // Chromium's request interception covers navigations, redirects, frames and
    // ordinary background requests. It is not a firewall for external tools.
    session.webRequest?.onBeforeRequest((details, callback) => {
      // Extension service-worker/page requests: the destination must be a host granted to that
      // extension, and any block rule (not only navigation rules) or security finding applies; no
      // human visit exception covers them.
      const extensionRequest = typeof details.initiatorOrigin === 'string' && details.initiatorOrigin.startsWith('chrome-extension://') && /^https?:/i.test(details.url);
      if (extensionRequest) {
        let allowed = false;
        try { allowed = this.extensionRequestAllowed?.(workspaceId, details) === true; } catch { allowed = false; }
        if (!allowed) { callback({ cancel: true }); return; }
      }
      const navigation = ['mainFrame', 'subFrame'].includes(details.resourceType);
      const tab = [...this.tabs.values()].find(candidate => candidate.view.webContents.id === details.webContentsId);
      const overridden = tab && tab.allowUrl === this.overrideKey(details.url);
      let answered = false;
      const finish = findings => {
        if (answered) return;
        answered = true;
        const security = findings.find(finding => finding.action === 'block');
        if (security && (extensionRequest || !(overridden && tab.allowSecurity))) {
          if (details.resourceType === 'mainFrame' && tab?.navigating === details.url) this.block(tab, details.url, null, security);
          callback({ cancel: true });
          return;
        }
        const rule = this.workspaceService?.matchSiteRule(details.url, workspaceId);
        if (extensionRequest) { callback({ cancel: !!rule && rule.behavior === 'block' }); return; }
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
    session.webRequest?.onBeforeSendHeaders?.((details, callback) => {
      try {
        const purpose = Object.entries(details.requestHeaders ?? {}).find(([key]) => ['sec-purpose', 'purpose'].includes(key.toLowerCase()))?.[1];
        if (/prefetch|prerender/i.test(String(purpose ?? ''))) { this.siteStorage?.count(details.webContentsId, 'speculativeLoadsCancelled'); callback({ cancel: true }); return; }
        callback(this.siteStorage?.beforeSendHeaders(details, workspaceId) ?? {});
      } catch { callback({ cancel: true }); }
    });
    session.webRequest?.onHeadersReceived?.((details, callback) => {
      try { callback(this.siteStorage?.headersReceived(details, workspaceId) ?? {}); } catch { callback({ cancel: true }); }
    });
    // Per-tab request outcomes for archive manifests: failed and error responses are reported as resource failures.
    const logResource = (details, outcome) => {
      const tab = [...this.tabs.values()].find(candidate => candidate.view.webContents.id === details.webContentsId);
      if (!tab || details.resourceType === 'mainFrame') return;
      tab.resourceLog ??= new Map();
      if (tab.resourceLog.size >= 3000) tab.resourceLog.delete(tab.resourceLog.keys().next().value);
      tab.resourceLog.set(details.url, { url: details.url, resourceType: details.resourceType, ...outcome });
    };
    session.webRequest?.onCompleted?.(details => logResource(details, { statusCode: details.statusCode, fromCache: Boolean(details.fromCache) }));
    session.webRequest?.onErrorOccurred?.(details => logResource(details, { error: details.error }));
    const detachStorage = this.siteStorage?.attach(session, workspaceId);
    this.sessions.set(workspaceId, { session, onDownload, detachStorage });
  }

  tabFor(contents) { return [...this.tabs.values()].find(candidate => candidate.view.webContents === contents) ?? null; }

  /** getDisplayMedia: requires a user gesture and a visible tab; the source is chosen in the browser-owned prompt. */
  async requestDisplay(request, callback) {
    let answered = false;
    const respond = value => { if (answered) return; answered = true; try { callback(value && typeof value === 'object' ? value : {}); } catch { /* the page went away */ } };
    let contents = null;
    try { contents = this.electron.webContents?.fromFrame?.(request.frame) ?? null; } catch { contents = null; }
    const tab = contents ? this.tabFor(contents) : null;
    if (!tab || !request.videoRequested || !request.userGesture) { this.permissions.denied(tab, ['display-capture'], 'auto'); return respond({}); }
    let sources = [];
    try { sources = await this.electron.desktopCapturer.getSources({ types: ['screen', 'window'], thumbnailSize: { width: 240, height: 150 } }); } catch { sources = []; }
    if (!sources.length) { this.permissions.denied(tab, ['display-capture'], 'auto'); return respond({}); }
    this.permissions.request(tab, 'display-capture', { requestingUrl: request.securityOrigin || request.frame?.origin }, respond, { sources, display: true });
  }

  recentHumanInput(tab, within = HUMAN_GESTURE_MS) { return Boolean(tab?.lastHumanInput && Date.now() - tab.lastHumanInput < within); }

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
    this.onAudit?.({ type: 'block', reason: refused ? 'external_launch_refused' : 'external_launch_pending', outcome: 'recorded', workspaceId: record.workspaceId, tabId: record.tabId ?? undefined,
      summary: { scheme, frame, launchId: id, source: record.sourceUrl } });
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
    this.onAudit?.(finding
      ? { type: 'block', reason: 'security_finding', outcome: 'recorded', workspaceId: tab.workspaceId, tabId: tab.id, version: tab.version,
        summary: { url, category: finding.category, source: finding.source, listId: finding.listId, stale: Boolean(finding.stale) } }
      : { type: 'block', reason: 'site_rule', outcome: 'recorded', workspaceId: tab.workspaceId, tabId: tab.id, version: tab.version, targetId: rule.id,
        summary: { hostname: rule.hostname, scope: rule.scope, mode: rule.mode, source: ruleSource(rule) } });
    // Metadata only: never the URL, rule reason or finding text.
    this.onEvent?.({ type: 'navigation', status: 'blocked', workspaceId: tab.workspaceId, tabId: tab.id, version: tab.version });
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

  // ---- Windows and panes (#100, #101) ---------------------------------------------------
  // Each window has its own viewport, attached views and active tab. The main window (id 1) shows the
  // workspace that is active in the workspace service; every other window shows the workspaces moved into
  // it. A workspace is shown in at most one window. Windows and panes are display state only: they never
  // change which workspace or tab an agent is allowed to reach.
  get window() { return this.main.window; }
  get viewport() { return this.main.viewport; }
  set viewport(value) { this.main.viewport = value; }
  get attachedViews() { return this.main.attachedViews; }
  get activeId() { return this.main.activeId; }
  set activeId(value) { this.main.activeId = value; }

  /** The workspace a window currently shows. */
  shownWorkspace(state) { return state === this.main ? this.workspaceId : state.current; }
  /** The window whose rail holds a workspace (the main window unless the workspace was moved out). */
  ownerOf(workspaceId) {
    for (const state of this.windows.values()) if (state !== this.main && state.workspaces.has(workspaceId)) return state;
    return this.main;
  }
  /** The window that is showing a workspace right now, or null. */
  shownIn(workspaceId) {
    const state = this.ownerOf(workspaceId);
    return this.shownWorkspace(state) === workspaceId ? state : null;
  }
  isAttached(view) { return [...this.windows.values()].some(state => state.attachedViews.has(view)); }
  detachView(view) {
    for (const state of this.windows.values()) if (state.attachedViews.has(view)) {
      if (state.window && !state.window.isDestroyed()) state.window.contentView.removeChildView(view);
      state.attachedViews.delete(view);
    }
  }
  windowState(windowId = 1) {
    const state = this.windows.get(windowId);
    if (!state) throw failure('not_found', 'Window not found');
    return state;
  }
  /** Remembered tab for a workspace (resume record), else its first tab. */
  rememberedTab(workspaceId) {
    const remembered = this.workspaceService?.locked ? null : this.workspaceService?.data?.resumeStates?.find(item => item.workspaceId === workspaceId)?.activeTabId;
    return (this.tabs.get(remembered)?.workspaceId === workspaceId ? this.tabs.get(remembered) : null) ?? [...this.tabs.values()].find(tab => tab.workspaceId === workspaceId) ?? null;
  }

  /** A second window shows the given workspaces; their tabs keep running and their views move without reloading. */
  addWindow(window, workspaceIds, current = workspaceIds[0]) {
    if (this.hidden) throw failure('unsupported', 'Headless sessions show one window; attach a display first');
    const id = this.nextWindowId++;
    const state = { id, window, viewport: null, attachedViews: new Set(), activeId: null, workspaces: new Set(), current: null, focusedPaneKey: null };
    this.windows.set(id, state);
    state.onResize = () => this.layout();
    window?.on?.('resize', state.onResize);
    for (const workspaceId of workspaceIds) this.moveWorkspace(workspaceId, id, { show: workspaceId === current });
    return state;
  }
  /** Close a second window: its workspaces return to the main window's rail. No tab is closed or reloaded. */
  removeWindow(windowId) {
    const state = this.windowState(windowId);
    if (state === this.main) throw failure('invalid_arguments', 'The main window cannot be removed');
    for (const view of [...state.attachedViews]) this.detachView(view);
    state.window?.removeListener?.('resize', state.onResize);
    this.windows.delete(windowId);
    this.layout();
    return { closed: windowId, returned: [...state.workspaces] };
  }
  /**
   * Move a workspace into a window's rail (windowId 1 returns it to the main window). The receiving window
   * shows it when `show` is set or when it has nothing else to show; a second window left with no
   * workspaces is reported as emptied so the caller can close it.
   */
  moveWorkspace(workspaceId, windowId, { show = true } = {}) {
    const target = this.windowState(windowId);
    const source = this.ownerOf(workspaceId);
    if (source !== this.main) {
      source.workspaces.delete(workspaceId);
      if (source.current === workspaceId) {
        source.current = [...source.workspaces][0] ?? null;
        source.activeId = source.current ? this.rememberedTab(source.current)?.id ?? null : null;
      }
    }
    if (target !== this.main) {
      target.workspaces.add(workspaceId);
      if (show || !target.current) {
        target.current = workspaceId;
        const tab = this.rememberedTab(workspaceId);
        target.activeId = tab?.id ?? null;
        if (tab?.suspended) void this.resumeTab(tab, 'shown').catch(() => {});
      }
    }
    this.layout();
    this.persist();
    return { workspaceId, windowId: target.id, emptied: source !== this.main && source !== target && !source.workspaces.size ? source.id : null };
  }
  /** Show one of a second window's workspaces in it. */
  showInWindow(windowId, workspaceId) {
    const state = this.windowState(windowId);
    if (state === this.main) throw failure('invalid_arguments', 'Switch the main window with workspaces.switch');
    if (!state.workspaces.has(workspaceId)) throw failure('invalid_arguments', 'That workspace is not in this window');
    state.current = workspaceId;
    const tab = this.rememberedTab(workspaceId);
    state.activeId = tab?.id ?? null;
    if (tab?.suspended) void this.resumeTab(tab, 'activated').catch(() => {});
    this.layout();
    return { windowId, workspaceId, activeTabId: state.activeId };
  }
  describeWindows() {
    const live = window => Boolean(window && !window.isDestroyed?.());
    return [...this.windows.values()].map(state => ({ windowId: state.id, main: state === this.main, workspaceId: this.shownWorkspace(state) ?? null,
      workspaceIds: state === this.main ? null : [...state.workspaces], activeTabId: state.activeId ?? null,
      bounds: live(state.window) ? state.window.getBounds?.() ?? null : null, focused: live(state.window) && Boolean(state.window.isFocused?.()) }));
  }

  setLayout(bounds, windowId = 1) {
    const state = this.windowState(windowId);
    if (!bounds || typeof bounds !== 'object' || Array.isArray(bounds)
      || Object.keys(bounds).some(key => !['x', 'y', 'width', 'height', 'visible', 'splitTabId', 'focusedPane', 'panes', 'focusedTabId'].includes(key))
      || (bounds.focusedPane != null && !['primary', 'secondary'].includes(bounds.focusedPane))
      || typeof bounds.visible !== 'boolean'
      || !['x', 'y', 'width', 'height'].every(key => Number.isInteger(bounds[key]) && bounds[key] >= 0 && bounds[key] <= 20000)
      || (bounds.splitTabId != null && (!Number.isInteger(bounds.splitTabId) || bounds.splitTabId < 1))
      || (bounds.focusedTabId != null && (!Number.isInteger(bounds.focusedTabId) || bounds.focusedTabId < 1))
      || (bounds.panes != null && (!Array.isArray(bounds.panes) || bounds.panes.length > MAX_PANES || !bounds.panes.every(validPaneRect)))) {
      throw new Error('Invalid native page bounds');
    }
    const shown = this.shownWorkspace(state);
    if (bounds.splitTabId != null && this.tab(bounds.splitTabId).workspaceId !== shown) throw new Error('Split tabs must belong to this workspace');
    // A pane can show only a tab of the workspace this window shows, and each tab in one pane only.
    const paneTabs = (bounds.panes ?? []).filter(pane => pane.tabId != null).map(pane => pane.tabId);
    if (new Set(paneTabs).size !== paneTabs.length) throw new Error('A tab can be shown in one pane only');
    for (const tabId of paneTabs) if (this.tab(tabId).workspaceId !== shown) throw new Error('Pane tabs must belong to this workspace');
    state.viewport = { ...bounds, ...(bounds.panes && { panes: bounds.panes.map(pane => ({ ...pane })) }) };
    this.layoutWindow(state);
    return { success: true };
  }

  layout() {
    for (const state of this.windows.values()) this.layoutWindow(state);
  }

  /** Tabs a window should show: the pane tabs, or the active tab plus the legacy split tab. */
  wantedTabs(state) {
    const requested = state.viewport;
    const shown = this.shownWorkspace(state);
    const usable = tab => tab && !tab.blocked && tab.workspaceId === shown;
    if (requested?.panes) return requested.panes.filter(pane => pane.tabId != null).map(pane => this.tabs.get(pane.tabId)).filter(usable);
    const active = this.tabs.get(state.activeId);
    const split = this.tabs.get(requested?.splitTabId);
    return usable(active) ? [active, ...(usable(split) && split.id !== active.id ? [split] : [])] : [];
  }

  layoutWindow(state) {
    const window = state.window;
    if (!window || window.isDestroyed()) return;
    if (state === this.main && this.hidden) return this.layoutHidden();
    const [width, height] = window.getContentSize();
    const requested = state.viewport ?? { x: 0, y: 112, width: Math.max(1, width - 360), height: Math.max(1, height - 112), visible: true };
    const fit = rect => {
      const x = Math.min(rect.x, Math.max(0, width - 1));
      const y = Math.min(rect.y, Math.max(0, height - 1));
      return { x, y, width: Math.max(1, Math.min(rect.width, width - x)), height: Math.max(1, Math.min(rect.height, height - y)) };
    };
    const showing = requested.visible && requested.width > 0 && requested.height > 0;
    const wanted = showing ? this.wantedTabs(state) : [];
    const previewHere = this.preview && (this.preview.workspaceId == null ? state === this.main : this.ownerOf(this.preview.workspaceId) === state) ? this.preview : null;
    // Suspended tabs reload first; pages rendered offscreen while headless are re-created on screen when shown.
    if (!previewHere || requested.panes) for (const tab of wanted) {
      if (tab.suspended) void this.resumeTab(tab, 'shown').catch(() => {});
      else if (tab.renderMode === 'offscreen') void this.convertRenderMode(tab, 'display attached').catch(() => {});
    }
    const live = wanted.filter(tab => !tab.suspended && !tab.view.placeholder && tab.renderMode !== 'offscreen');
    const placed = [];
    if (requested.panes) {
      // Pane layout (#101): each pane rectangle comes from the trusted GUI; the archive preview may occupy one pane.
      for (const pane of requested.panes) {
        const item = pane.preview ? previewHere : live.find(tab => tab.id === pane.tabId);
        if (showing && item) placed.push([item, fit(pane)]);
      }
    } else if (previewHere && showing) placed.push([previewHere, fit(requested)]);
    else {
      // The offline archive preview replaces the live tabs while it is open; split panes leave a thin gap the GUI draws (#36).
      const bounds = fit(requested);
      const gap = live.length === 2 ? SPLIT_GAP : 0;
      live.forEach((tab, index) => {
        const half = Math.floor((bounds.width - gap) / live.length);
        placed.push([tab, { ...bounds, x: bounds.x + index * (half + gap), width: index === live.length - 1 ? bounds.width - index * (half + gap) : half }]);
      });
    }
    for (const view of [...state.attachedViews]) if (!placed.some(([item]) => item.view === view)) {
      window.contentView.removeChildView(view);
      state.attachedViews.delete(view);
    }
    for (const [item, rect] of placed) {
      // A view shown in another window moves here without reloading (#100).
      if (!state.attachedViews.has(item.view)) { this.detachView(item.view); window.contentView.addChildView(item.view); state.attachedViews.add(item.view); }
      item.view.setBounds(rect);
    }
    // The focused pane receives keyboard focus once when it changes, never on every layout.
    let focusKey = null, focusTab = null;
    if (requested.panes && placed.length > 1) {
      focusTab = placed.find(([item]) => item.id === requested.focusedTabId)?.[0] ?? null;
      focusKey = focusTab ? `${placed.map(([item]) => item.id ?? 'preview').join(':')}:${focusTab.id}` : null;
    } else if (!requested.panes && placed.length === 2) {
      const pane = requested.focusedPane ?? 'primary';
      focusTab = placed[pane === 'secondary' ? 1 : 0][0];
      focusKey = `${placed[0][0].id}:${placed[1][0].id}:${pane}`;
    }
    if (focusKey && focusKey !== state.focusedPaneKey) focusTab.view.webContents.focus?.();
    state.focusedPaneKey = focusKey;
  }

  /** Hidden window: keep the active tab (and any tab being captured) attached so offscreen rendering has a size. */
  layoutHidden() {
    const state = this.main;
    const [width, height] = state.window.getContentSize();
    const keep = new Set(this.renderingFor);
    const active = this.tabs.get(state.activeId);
    if (active && active.workspaceId === this.workspaceId && !active.blocked) keep.add(active);
    const views = [...keep].filter(tab => !tab.suspended && !tab.view.placeholder).map(tab => tab.view);
    for (const view of [...state.attachedViews]) if (!views.includes(view)) { state.window.contentView.removeChildView(view); state.attachedViews.delete(view); }
    for (const view of views) {
      if (!state.attachedViews.has(view)) { this.detachView(view); state.window.contentView.addChildView(view); state.attachedViews.add(view); }
      view.setBounds({ x: 0, y: 0, width: Math.max(1, width), height: Math.max(1, height) });
    }
  }

  /** Move keyboard focus from the trusted chrome into the visible page (the focused pane). */
  focusPage(windowId = 1) {
    const state = this.windowState(windowId);
    const panes = [...state.attachedViews];
    if (!panes.length || (state === this.main && this.hidden)) return { focused: false, reason: 'No page is shown' };
    const viewport = state.viewport;
    const active = this.tabs.get(state.activeId);
    const shown = tab => tab && panes.includes(tab.view);
    const preview = this.preview && panes.includes(this.preview.view) ? this.preview : null;
    let target;
    if (viewport?.panes) {
      const focusedTab = viewport.focusedTabId != null ? this.tabs.get(viewport.focusedTabId) : null;
      target = shown(focusedTab) ? focusedTab : preview ?? (shown(active) ? active : null);
    } else {
      const split = viewport?.splitTabId != null ? this.tabs.get(viewport.splitTabId) : null;
      target = preview ?? (viewport?.focusedPane === 'secondary' && shown(split) ? split : shown(active) ? active : null);
    }
    if (!target) return { focused: false, reason: 'No page is shown' };
    target.view.webContents.focus();
    return { focused: true, tabId: target.id ?? null };
  }

  /** Tabs visible in any window right now (active, split or pane tabs); suspension never takes these (#101). */
  visibleTabIds() {
    const ids = new Set();
    for (const state of this.windows.values()) {
      if (state.activeId != null && this.tabs.get(state.activeId)?.workspaceId === this.shownWorkspace(state)) ids.add(state.activeId);
      if (state.viewport?.splitTabId != null) ids.add(state.viewport.splitTabId);
      for (const pane of state.viewport?.panes ?? []) if (pane.tabId != null) ids.add(pane.tabId);
    }
    return ids;
  }

  tab(tabId = this.activeId) {
    const tab = this.tabs.get(tabId);
    if (!tab && this.privateTabIds.has(tabId)) throw failure('permission_required', 'That page is in a private window. Private windows are never available to agents, automation or tab commands.', { authority: { decision: 'deny', reason: 'private_window' } });
    if (!tab) throw new Error('Tab not found');
    return tab;
  }

  describe(tab) {
    const contents = tab.view.webContents;
    const rule = this.workspaceService?.matchSiteRule(contents.getURL() || tab.url, tab.workspaceId);
    return { id: tab.id, workspaceId: tab.workspaceId, url: tab.blocked?.url || contents.getURL() || tab.url || 'about:blank',
      title: pageString(contents.getTitle() || tab.title || 'New tab', 1000), active: this.shownIn(tab.workspaceId)?.activeId === tab.id,
      // Informational only (#100): which window shows this tab's workspace. It is never a grant.
      windowId: this.ownerOf(tab.workspaceId).id,
      pinned: !!tab.pinned, controller: tab.controller ?? 'available', controlMode: this.controlMode(tab), assistant: tab.assistant ?? null,
      rawInput: !!tab.rawInput, version: tab.version ?? 1,
      activity: tab.inFlight ? { command: tab.inFlight.command, actor: tab.inFlight.actor, startedAt: tab.inFlight.startedAt } : null,
      queued: (tab.inputQueue ?? []).map(({ actor, command, since }) => ({ actor, command, since })),
      stateBoundary: tab.inspectionEpoch ? { epoch: tab.inspectionEpoch, reason: tab.inspectionReason ?? 'state changed' } : null, lastBoundary: tab.lastBoundary ?? null,
      loading: contents.isLoading?.() ?? false, canGoBack: contents.navigationHistory?.canGoBack() ?? false,
      canGoForward: contents.navigationHistory?.canGoForward() ?? false, zoom: contents.getZoomFactor?.() ?? 1,
      blocked: tab.blocked ?? null, error: tab.error ?? null, warning: rule?.behavior === 'warn' ? `${rule.hostname}: ${rule.reason}` : null,
      groupId: tab.groupId ?? null, opener: tab.openerTabId ? { tabId: tab.openerTabId, openedBy: tab.openedBy ?? null, scriptable: Boolean(tab.popup) } : null, renderMode: tab.suspended ? null : tab.renderMode ?? 'onscreen',
      suspended: tab.suspended ? { at: tab.suspended.at, reason: tab.suspended.reason, scrollX: tab.suspended.scrollX, scrollY: tab.suspended.scrollY, zoom: tab.suspended.zoom } : null,
      restored: tab.restoredFrom ?? null, lastActiveAt: tab.lastActiveAt ? new Date(tab.lastActiveAt).toISOString() : null,
      communityLabels: this.communityLabels(contents.getURL() || tab.url, tab.workspaceId), protection: this.protection(tab), protectedOperation: this.protectedReason(tab),
      devtools: Boolean(tab.devtools), ...(tab.viewSource && { viewSource: true }) };
  }

  /** Informational community-list labels (never blocking); each names its list, claim kind and entry. */
  communityLabels(url, workspaceId) {
    try {
      return (this.workspaceService?.communityLists?.matchesForUrl(url, workspaceId) ?? []).filter(match => match.active && match.effectiveBehavior === 'label')
        .map(match => ({ list: match.listName, entryId: match.entryId, claimKind: match.claimKind, claim: match.claim.slice(0, 300), status: match.status }));
    } catch { return []; }
  }

  /** Quiet browser-owned indicator data: what was blocked in this tab. */
  protection(tab) {
    let hostname = null;
    try { hostname = new URL(tab.view.webContents.getURL() || tab.url).hostname || null; } catch { /* about:blank */ }
    return { storageMode: hostname && this.siteStorage ? this.siteStorage.modeFor(hostname, tab.workspaceId) : null,
      storageActivity: this.siteStorage?.activityFor(tab.view.webContents.id) ?? {}, blockedPopups: tab.blockedPopups ?? [],
      permissionDenials: tab.permissionDenials ?? {}, permissionUserDenials: tab.permissionUserDenials ?? {}, permissionPrompt: this.permissions.promptFor(tab.id),
      permissionUses: tab.permissionUses?.document === (tab.documentSerial ?? 0) ? tab.permissionUses.permissions : [], sharing: tab.sharing ?? null,
      popupsAllowed: this.permissions.popupsAllowed(tab), passwordOffer: this.passwords?.offerFor(tab.id) ?? null, savedLogins: this.passwords?.available(tab).length ?? 0, pendingLaunches: [...this.launches.values()].filter(item => item.tabId === tab.id && item.state === 'pending').length,
      securityWarning: tab.securityWarning ?? null, exception: tab.allowUrl ? { url: sanitizeUrl(tab.allowUrl) || null, security: Boolean(tab.allowSecurity) } : null };
  }

  persist() {
    // A locked encrypted profile cannot be written (ADR 014); the session saved before the lock remains.
    if (this.closing || this.restoring || this.suspended || this.workspaceService?.locked) return;
    this.workspaceService?.persistSession({ tabs: [...this.tabs.values()].filter(tab => !tab.viewSource).map(tab => this.describe(tab)), activeId: this.activeId,
      closed: this.closedTabs, zoom: this.siteZoom });
  }

  async restore() {
    // Temporary site data left by a crash is erased before any tab can load it again.
    await this.siteStorage?.cleanup('startup').catch(error => { this.storageRecoveryError = error.message; });
    // Locked encrypted profile: tabs are restored by resume() after a person unlocks.
    if (this.workspaceService?.locked) { this.suspended = true; return; }
    const saved = this.workspaceService?.snapshot().browserSession;
    this.closedTabs = Array.isArray(saved?.closed) ? saved.closed.filter(item => this.workspaceExists(item.workspaceId)) : [];
    this.siteZoom = saved?.zoom && typeof saved.zoom === 'object' ? saved.zoom : {};
    this.restoring = true;
    try {
      for (const record of saved?.tabs ?? []) {
        if (!this.workspaceExists(record.workspaceId)) continue;
        try { await this.newTab(record.url, record.workspaceId, record); } catch { /* Keep a recoverable tab after a failed restore. */ }
      }
      const selected = this.tabs.get(saved?.activeId);
      if (selected?.workspaceId === this.workspaceId) this.activate(selected.id);
      else await this.switchWorkspace(this.workspaceId);
    } finally { this.restoring = false; this.persist(); }
  }

  /**
   * Workspace encryption lock: save the tab list while it can still be written,
   * then close every tab without persisting, so no workspace page stays loaded.
   */
  async suspend({ persist = true } = {}) {
    if (this.suspended) return;
    if (persist) { try { this.persist(); } catch { /* the saved session from the last change remains */ } }
    this.suspended = true;
    // The offline archive preview holds decrypted archive bodies in memory; it closes with the lock.
    if (this.preview) { try { this.closeArchivePreview(); } catch { /* closing anyway */ } }
    for (const id of [...this.tabs.keys()]) { try { this.closeTab(id); } catch { /* keep closing */ } }
    for (const state of this.windows.values()) state.activeId = null;
    this.layout();
  }
  /** After unlock: restore the saved tabs of the unlocked profile. */
  async resume() {
    if (!this.suspended || this.workspaceService?.locked) return;
    this.suspended = false;
    await this.restore();
  }

  async switchWorkspace(workspaceId) {
    if (this.preview && this.ownerOf(this.preview.workspaceId) === this.main) this.closeArchivePreview();
    // Resume the tab this workspace last showed (#24), else its first tab.
    const selected = this.rememberedTab(workspaceId);
    this.session = this.sessionFor(workspaceId);
    return selected ? this.activate(selected.id) : this.newTab('about:blank', workspaceId);
  }

  activate(tabId) {
    const tab = this.tab(tabId);
    // The tab becomes the active tab of the window that shows its workspace (#100).
    const state = this.shownIn(tab.workspaceId);
    if (!state && this.workspaceService) throw new Error('Switch to the tab workspace before activating it');
    (state ?? this.main).activeId = tabId;
    tab.lastActiveAt = Date.now();
    if (tab.suspended) void this.resumeTab(tab, 'activated').catch(() => {});
    this.layout();
    this.persist();
    return this.describe(tab);
  }

  async newTab(url = 'about:blank', workspaceId = this.workspaceId, restored = {}) {
    if (this.workspaceService && !this.workspaceExists(workspaceId)) throw new Error('Workspace not found');
    url = safeUrl(url);
    const id = Number.isSafeInteger(restored.id) && restored.id > 0 && !this.tabs.has(restored.id) ? restored.id : this.nextTabId;
    this.nextTabId = Math.max(this.nextTabId, id + 1);
    // Human ownership persists across restarts; agent leases end with the agent's connection.
    const humanHeld = restored.controller === 'human';
    const group = typeof restored.groupId === 'string' ? this.workspaceService?.data?.tabGroups?.find(item => item.id === restored.groupId && item.workspaceId === workspaceId) : null;
    const tab = { id, workspaceId, view: null, url, title: restored.title, pinned: !!restored.pinned, version: restored.version || 1,
      controller: humanHeld ? 'human' : 'available', assistant: humanHeld && typeof restored.assistant === 'string' ? restored.assistant.slice(0, 200) : null,
      openerTabId: restored.openerTabId ?? null, openedBy: restored.openedBy ?? null, groupId: group?.id ?? null, lastActiveAt: Date.now() };
    this.tabs.set(tab.id, tab);
    if (restored.suspended && typeof restored.suspended === 'object') {
      // A tab suspended before restart stays unloaded until it is opened or used.
      const saved = restored.suspended;
      tab.suspended = { at: typeof saved.at === 'string' ? saved.at : new Date().toISOString(), reason: typeof saved.reason === 'string' ? saved.reason.slice(0, 60) : 'restart',
        scrollX: Number(saved.scrollX) || 0, scrollY: Number(saved.scrollY) || 0, zoom: Number(saved.zoom) || 1 };
      tab.view = this.placeholderView(tab);
      this.persist();
      return this.describe(tab);
    }
    // A source view (#96) is a read-only, unsaved tab created only from the trusted chrome.
    if (restored.viewSource === true) tab.viewSource = true;
    this.createView(tab);
    if (this.shownIn(workspaceId) && !restored.background) this.activate(tab.id);
    this.persist();
    try { const allowed = this.allowedUrl(url, workspaceId, tab); await tab.view.webContents.loadURL(tab.viewSource ? `view-source:${allowed}` : allowed); }
    catch (error) {
      tab.error = error.message; this.persist();
      const blocked = error.code === 'site_blocked' ? error : tab.blocked ? this.blockedError(tab.blocked) : null;
      throw Object.assign(new Error(`Navigation failed: ${(blocked ?? error).message}`), blocked ? { code: 'site_blocked', details: blocked.details } : {});
    }
    this.persist();
    return this.describe(tab);
  }

  /** Create and wire a page view for a tab, on screen or (while the window is hidden) offscreen. */
  createView(tab, adopted = null) {
    const offscreen = adopted ? false : this.offscreen;
    // A popup (#97) adopts the WebContents Chromium created for window.open, so it keeps its opener; it
    // inherits the opener's session partition and sandboxed, context-isolated preferences.
    const view = new this.electron.WebContentsView(adopted ? { webContents: adopted } : {
      webPreferences: {
        session: this.sessions.get(tab.workspaceId)?.session ?? this.sessionFor(tab.workspaceId), nodeIntegration: false, contextIsolation: true,
        sandbox: true, webSecurity: true, allowRunningInsecureContent: false, ...(offscreen ? { offscreen: true } : {}),
      },
    });
    tab.view = view;
    tab.renderMode = offscreen ? 'offscreen' : 'onscreen';
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
      // Agent coordinate/keyboard input is dispatched natively; it is neither human takeover nor a download gesture.
      if (this.consumeSynthetic(tab, input)) return;
      // Leaving the page for the browser chrome is not page input and not a takeover. A key a page may
      // claim (Ctrl+F in an editor) reaches the page first and runs only if the page did not handle it.
      const shortcut = matchShortcut(input, { loading: contents.isLoading?.() ?? false });
      if (shortcut && !(shortcut.claimable && this.pageMayClaim(tab))) { _event.preventDefault?.(); this.onChromeShortcut?.({ shortcut: shortcut.id, tabId: tab.id }); return; }
      if (shortcut) tab.pendingShortcut = { id: shortcut.id, key: keyName(input), at: Date.now() };
      // Any human interaction invalidates element refs and coordinates observed before it.
      if (['mouseDown', 'keyDown', 'rawKeyDown', 'mouseWheel'].includes(input.type)) tab.inputSerial = (tab.inputSerial ?? 0) + 1;
      if (['mouseDown', 'keyDown', 'rawKeyDown'].includes(input.type)) { this.downloadGrants.set(tab.id, Date.now() + HUMAN_GESTURE_MS); tab.lastHumanInput = Date.now(); tab.lastActiveAt = Date.now(); }
      if (tab.controller !== 'human' && tab.controller !== 'available') {
        // Real native input is a human takeover at the next input boundary.
        // Already executed page scripts cannot be rolled back.
        this.controlBoundary(tab, 'human input'); contents.stop(); this.persist();
      }
    };
    contents.on('before-input-event', humanInput);
    contents.on('before-mouse-event', humanInput);
    contents.on('dom-ready', () => this.watchKeys(tab, contents));
    contents.on('console-message', (...args) => {
      const message = typeof args[0]?.message === 'string' ? args[0].message : args[2];
      if (typeof message === 'string' && message.startsWith(this.keyNonce)) this.unclaimedKey(tab, message.slice(this.keyNonce.length));
    });
    contents.on('context-menu', (_event, params) => this.contextMenu(tab, params));
    contents.on('devtools-opened', () => { tab.devtools = true; this.persist(); });
    contents.on('devtools-closed', () => { tab.devtools = false; this.persist(); });
    // The person's own password manager (#95) offers to save a sign-in they submit; agents never see it.
    try { this.passwords?.watch(tab, contents); } catch { /* saving passwords is optional */ }
    contents.on('did-navigate', () => {
      // A new document: credential residue protections keyed to the filled document end here.
      tab.documentSerial = (tab.documentSerial ?? 0) + 1;
      this.permissions.documentChanged(tab);
      tab.version++; tab.popupAudits = 0; this.stateBoundary(tab, 'navigation'); tab.observations = null; tab.error = null; tab.blocked = null; tab.securityWarning = null;
      // A gesture authorizes downloads/popups for the document it happened in, not the next page.
      if (typeof this.downloadGrants.get(tab.id) === 'number') this.downloadGrants.delete(tab.id);
      tab.lastHumanInput = 0;
      // An exact-visit exception ends as soon as the tab commits any other destination.
      if (tab.allowUrl !== this.overrideKey(contents.getURL())) { tab.allowUrl = null; tab.allowSecurity = false; }
      this.applySiteZoom(tab);
      this.layout(); this.persist();
      this.onEvent?.({ type: 'navigation', status: 'committed', workspaceId: tab.workspaceId, tabId: tab.id, version: tab.version });
      try { this.onNavigate?.({ tabId: tab.id, url: contents.getURL() }); } catch { /* recording is best effort */ }
    });
    contents.on('did-navigate-in-page', (_event, _url, isMainFrame) => {
      if (isMainFrame === false) return;
      tab.version++; this.stateBoundary(tab, 'in-page navigation'); this.persist();
      this.onEvent?.({ type: 'navigation', status: 'in_page', workspaceId: tab.workspaceId, tabId: tab.id, version: tab.version });
    });
    contents.on('did-start-navigation', details => {
      if (!details?.isMainFrame || details.isSameDocument || (details.frame && details.frame !== contents.mainFrame)) return;
      tab.navigating = details.url;
      tab.resourceLog = new Map();
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
      // Native windows are never created. A page may open a tab only within Chromium's transient-activation
      // window after a human gesture in this tab, during an automation action in flight on it, or on a site
      // the person allowed popups for in this workspace (#97).
      const actor = this.recentHumanInput(tab, POPUP_GESTURE_MS) ? 'human' : tab.inFlight ? 'automation' : this.permissions.popupsAllowed(tab) ? 'site-allowed' : null;
      if (!actor) {
        const id = `pop_${this.nextPopupId = (this.nextPopupId ?? 0) + 1}`;
        // The unsanitized address stays in memory only, so "Allow once" can open exactly what the page asked for.
        (this.popupTargets ??= new Map()).set(id, String(target).slice(0, 16384));
        if (this.popupTargets.size > 400) this.popupTargets.delete(this.popupTargets.keys().next().value);
        tab.blockedPopups = [...(tab.blockedPopups ?? []), { id, url: sanitizeUrl(target) || String(target).slice(0, 200), disposition, at: new Date().toISOString(), reason: 'Opened without recent input in this tab' }].slice(-20);
        // Bounded per document so a popup-spamming page cannot flood durable activity.
        if ((tab.popupAudits = (tab.popupAudits ?? 0) + 1) <= 20) this.onAudit?.({ type: 'block', reason: 'popup_without_input', outcome: 'recorded', workspaceId: tab.workspaceId, tabId: tab.id, version: tab.version, summary: { url: sanitizeUrl(target) || null, disposition } });
        this.persist();
        return { action: 'deny' };
      }
      try { this.allowedUrl(target, tab.workspaceId); } catch (error) { tab.error = error.message; this.persist(); return { action: 'deny' }; }
      // Offscreen (headless) pages cannot adopt a popup renderer: the destination opens as an ordinary tab without an opener.
      if (this.offscreen || this.suspended) {
        void this.newTab(target, tab.workspaceId, { openerTabId: tab.id, openedBy: actor }).catch(error => { tab.error = error.message; });
        return { action: 'deny' };
      }
      return { action: 'allow', outlivesOpener: true, createWindow: options => this.adoptPopup(tab, target, options.webContents, actor, disposition) };
    });
    // A script-opened page that calls window.close() (for example a 3-D Secure or sign-in popup) closes its tab.
    contents.on('close', () => { if (tab.popup && this.tabs.get(tab.id) === tab) { try { this.closeTab(tab.id); } catch { /* already closed */ } } });
    return view;
  }

  /** Turn the WebContents Chromium created for window.open into a tab. It inherits no agent control. */
  adoptPopup(opener, url, webContents, actor, disposition) {
    if (!webContents) throw new Error('Popup contents unavailable');
    const id = this.nextTabId++;
    const tab = { id, workspaceId: opener.workspaceId, view: null, url: sanitizeUrl(url) || 'about:blank', title: undefined, pinned: false, version: 1,
      controller: 'available', assistant: null, openerTabId: opener.id, openedBy: actor, groupId: opener.groupId ?? null, lastActiveAt: Date.now(), popup: true };
    this.tabs.set(id, tab);
    this.createView(tab, webContents);
    if (disposition !== 'background-tab' && this.shownIn(tab.workspaceId)) this.activate(id);
    this.persist();
    return tab.view.webContents;
  }

  closeTab(tabId) {
    const tab = this.tab(tabId);
    this.detachView(tab.view);
    const orphaned = [...this.windows.values()].filter(state => state.activeId === tabId);
    for (const state of orphaned) state.activeId = null;
    this.renderingFor.delete(tab);
    this.cancelQueue(tab, 'tab closed');
    this.tabs.delete(tabId);
    this.permissions.documentChanged(tab, true);
    const contents = tab.view.webContents;
    if (contents && !contents.isDestroyed()) contents.close({ waitForBeforeUnload: false });
    // Each window that showed the closed tab moves to another tab of the workspace it shows.
    if (!this.closing && !this.suspended) for (const state of orphaned) {
      const shown = this.shownWorkspace(state);
      const next = [...this.tabs.values()].find(candidate => candidate.workspaceId === shown);
      if (next) this.activate(next.id);
    }
    this.persist();
    return { closed: tabId };
  }








  // ---- Suspension, restoration and render modes (#30, #11) ---------------------------
  /** Stand-in for a released renderer: the tab keeps its id, URL, title, version and ownership. */
  placeholderView(tab) {
    const contents = { id: -tab.id, placeholder: true, getURL: () => tab.url, getTitle: () => tab.title || '', isLoading: () => false,
      navigationHistory: { canGoBack: () => false, canGoForward: () => false }, getZoomFactor: () => tab.suspended?.zoom ?? 1,
      isDestroyed: () => true, isCurrentlyAudible: () => false, stop() {}, close() {}, on() {}, removeListener() {} };
    return { placeholder: true, webContents: contents, setBounds() {} };
  }

  /** Reasons a tab cannot be suspended now. Empty means a reload would lose nothing Weft can detect. */
  async suspensionBlockers(tab) {
    if (tab.suspended) return ['already_suspended'];
    const reasons = this.quickBlockers(tab);
    if (reasons.length) return reasons;
    const url = tab.view.webContents.getURL?.() || tab.url;
    if (tab.blocked || !url || url === 'about:blank') return [];
    return this.pageStateBlockers(tab.view.webContents);
  }

  /**
   * Media, edited form fields, focused editable text and fullscreen in every frame of a page. The top frame runs the
   * check in Weft's isolated world; subframes, including cross-origin ones, run it through their own webFrameMain
   * (Electron offers no isolated world there, so a hostile frame can only make its own tab look busier). A frame
   * that cannot be inspected (timeout, crashed, refused) counts as possibly holding unsaved input.
   */
  async pageStateBlockers(contents, timeoutMs = 2000) {
    const reasons = new Set();
    const add = state => {
      if (!state || typeof state !== 'object') throw new Error('No frame state');
      if (state.media) reasons.add('media');
      if (state.unsavedInput) reasons.add('unsaved_input');
      if (state.fullscreen) reasons.add('fullscreen');
    };
    try { add(await bounded(this.observe(contents, null, {}, SUSPENSION_CHECK), timeoutMs)); } catch { reasons.add('page_check_failed'); }
    let main = null;
    try { main = contents.mainFrame ?? null; } catch { main = null; }
    let subframes = [];
    try { subframes = (main?.framesInSubtree ?? []).filter(frame => frame && frame !== main); } catch { reasons.add('frame_not_inspected'); }
    if (subframes.length > MAX_CHECKED_FRAMES) reasons.add('frame_not_inspected');
    await Promise.all(subframes.slice(0, MAX_CHECKED_FRAMES).map(async frame => {
      try { if (frame.isDestroyed?.()) return; } catch { return; }
      try { add(await bounded(frame.executeJavaScript(SUSPENSION_CHECK), timeoutMs)); }
      catch { let gone = false; try { gone = Boolean(frame.isDestroyed?.()); } catch { gone = true; } if (!gone) reasons.add('frame_not_inspected'); }
    }));
    return [...reasons];
  }

  quickBlockers(tab) {
    const reasons = [];
    if ([...this.windows.values()].some(state => state.activeId === tab.id && tab.workspaceId === this.shownWorkspace(state))) reasons.push('active');
    if ([...this.windows.values()].some(state => state.viewport?.splitTabId === tab.id)) reasons.push('split_view');
    // A tab visible in a pane of any window is never suspended (#101); hidden tabs follow the usual rules.
    if ([...this.windows.values()].some(state => (state.viewport?.panes ?? []).some(pane => pane.tabId === tab.id))) reasons.push('visible_pane');
    if (this.renderingFor.has(tab)) reasons.push('capturing');
    if (tab.pinned) reasons.push('pinned');
    if (tab.controller && !['human', 'available'].includes(tab.controller)) reasons.push('agent_lease');
    if (tab.assistant) reasons.push('agent_assist');
    if (tab.inFlight || tab.inputQueue?.length) reasons.push('input_in_flight');
    // Never under a credential broker's protected operation or its cooldown (#6), during a capture (#16) or a workflow recording (#10).
    if (this.protectedReason(tab)) reasons.push('protected_operation');
    if (tab.capturing) reasons.push('capturing');
    if (tab.recording) reasons.push('recording');
    if (this.paymentHold?.(tab.id)) reasons.push('payment');
    if (tab.resuming || tab.converting) reasons.push('restoring');
    // A task references a tab through its tab list or, for runtime tasks (ADR 016), through a plan step's tabId.
    const usesTab = task => (Array.isArray(task.tabIds) && task.tabIds.includes(tab.id)) || (task.executor && (task.plan ?? []).some(step => step?.args?.tabId === tab.id));
    if (!this.workspaceService?.locked && (this.workspaceService?.data?.tasks ?? []).some(task => !TERMINAL_TASK.has(task.status) && usesTab(task))) reasons.push('active_task');
    if ([...this.downloads.values()].some(({ record }) => record.sourceTabId === tab.id && ['progressing', 'retrying'].includes(record.state))) reasons.push('download');
    try { if (tab.view.webContents.isCurrentlyAudible?.()) reasons.push('media'); } catch { /* destroyed contents are handled by the caller */ }
    return reasons;
  }

  /** Release a tab's renderer, keeping URL, title, scroll, zoom and every durable record. */
  async freeze(tab, reason) {
    const contents = tab.view.webContents;
    let scroll = { scrollX: 0, scrollY: 0 };
    try { const live = await bounded(this.observe(contents, 'viewport'), 2000); scroll = { scrollX: Number(live?.scrollX) || 0, scrollY: Number(live?.scrollY) || 0 }; } catch { /* restored at the top */ }
    tab.url = tab.blocked?.url || contents.getURL() || tab.url;
    tab.title = contents.getTitle() || tab.title;
    const zoom = contents.getZoomFactor?.() ?? 1;
    this.detachView(tab.view);
    tab.suspended = { at: new Date().toISOString(), reason, ...scroll, zoom };
    tab.view = this.placeholderView(tab);
    tab.observations = null;
    tab.version = (tab.version ?? 1) + 1;
    this.stateBoundary(tab, `renderer released (${reason})`);
    if (!contents.isDestroyed()) contents.close({ waitForBeforeUnload: false });
  }

  /** Suspend an idle background tab. Never suspends leased, task-bound, busy, playing or edited tabs. */
  async suspendTab(tab, reason = 'requested') {
    const blockedBy = await this.suspensionBlockers(tab);
    // State may change while the page check runs: re-check the fast conditions.
    if (!blockedBy.length) blockedBy.push(...this.quickBlockers(tab));
    if (blockedBy.length || !this.tabs.has(tab.id)) return { suspended: false, tabId: tab.id, blockedBy: blockedBy.length ? blockedBy : ['closed'] };
    await this.freeze(tab, reason);
    this.onAudit?.({ type: 'resource', reason: 'tab_suspended', outcome: 'recorded', workspaceId: tab.workspaceId, tabId: tab.id, version: tab.version, summary: { reason } });
    this.onEvent?.({ type: 'tab', status: 'suspended', workspaceId: tab.workspaceId, tabId: tab.id, version: tab.version });
    this.persist();
    return { suspended: true, tabId: tab.id, tab: this.describe(tab),
      notice: 'The page renderer was released. Opening or using the tab reloads its URL: sites may ask you to sign in again, and in-page state is not restored.' };
  }

  /** Reload a suspended tab from its checkpoint. Resolves when the page has loaded (or failed to). */
  resumeTab(tab, reason = 'activated') {
    if (tab.resuming) return tab.resuming;
    if (!tab.suspended) return Promise.resolve(this.describe(tab));
    const saved = tab.suspended;
    tab.suspended = null;
    this.createView(tab);
    const contents = tab.view.webContents;
    tab.version = (tab.version ?? 1) + 1;
    this.stateBoundary(tab, `restored (${reason}): the page reloaded from its URL`);
    tab.restoredFrom = { at: new Date().toISOString(), releasedAt: saved.at, releaseReason: saved.reason, reason,
      notice: 'Reloaded from its URL. Sites may require signing in again; unsent form input and in-page script state are not restored.' };
    tab.lastActiveAt = Date.now();
    this.onEvent?.({ type: 'tab', status: 'restored', workspaceId: tab.workspaceId, tabId: tab.id, version: tab.version });
    tab.resuming = (async () => {
      try {
        this.layout();
        this.persist();
        await contents.loadURL(this.allowedUrl(tab.url, tab.workspaceId, tab));
        if (saved.zoom && saved.zoom !== 1) contents.setZoomFactor(saved.zoom);
        if (saved.scrollX || saved.scrollY) await bounded(this.observe(contents, null, {}, `(() => { scrollTo(${Number(saved.scrollX) || 0}, ${Number(saved.scrollY) || 0}); return true; })()`), 2000).catch(() => {});
      } catch (error) { tab.error = `Restore failed: ${error.message}`; }
      finally { tab.resuming = null; this.layout(); this.persist(); }
      return this.describe(tab);
    })();
    return tab.resuming;
  }

  /** Re-create a tab's renderer in the current display mode (offscreen while hidden). The page reloads. */
  async convertRenderMode(tab, reason) {
    const target = this.offscreen ? 'offscreen' : 'onscreen';
    if (tab.suspended || tab.resuming || tab.converting || (tab.renderMode ?? 'onscreen') === target) return null;
    tab.converting = true;
    try {
      // Let an in-flight agent action finish before its renderer is replaced.
      for (let i = 0; i < 300 && tab.inFlight; i++) await delay(100);
      if (!this.tabs.has(tab.id) || tab.suspended) return null;
      // true: some frame held edited input; null: a frame could not be inspected, so it is unknown.
      let unsavedInput = null;
      try {
        const blockers = await this.pageStateBlockers(tab.view.webContents, 1500);
        unsavedInput = blockers.includes('unsaved_input') ? true : blockers.some(reason => ['page_check_failed', 'frame_not_inspected'].includes(reason)) ? null : false;
      } catch { /* unknown */ }
      await this.freeze(tab, reason);
      await this.resumeTab(tab, reason);
      return { tabId: tab.id, renderMode: target, unsavedInputLost: unsavedInput };
    } finally { tab.converting = false; }
  }

  /** Switch between a visible window and a hidden (headless) one. Returns per-tab transition details. */
  async setDisplayHidden(hidden, reason) {
    this.hidden = hidden;
    this.offscreen = hidden;
    this.layout();
    const converted = [];
    // Hidden: every live page must render offscreen to stay capturable. Shown: only what the person sees now; others convert when opened.
    const tabs = hidden ? [...this.tabs.values()] : [this.tabs.get(this.activeId), this.tabs.get(this.viewport?.splitTabId)].filter(Boolean);
    for (const tab of tabs) {
      const result = await this.convertRenderMode(tab, reason);
      if (result) converted.push(result);
    }
    this.layout();
    return { converted, pendingOnOpen: [...this.tabs.values()].filter(tab => !tab.suspended && (tab.renderMode ?? 'onscreen') !== (hidden ? 'offscreen' : 'onscreen')).map(tab => tab.id) };
  }

  /** Suspend background tabs idle beyond the configured time, then (with a memory budget) least recently used first until renderers fit. */
  async suspendIdle({ now = Date.now() } = {}) {
    // A locked encrypted profile has no tabs open and no settings to read (ADR 014).
    if (this.suspending || this.closing || this.workspaceService?.locked) return [];
    this.suspending = true;
    try {
      const limits = resourceSettings(this.workspaceService?.data?.settings);
      const results = [];
      const candidates = () => [...this.tabs.values()].filter(tab => !tab.suspended && !tab.resuming).sort((a, b) => (a.lastActiveAt ?? 0) - (b.lastActiveAt ?? 0));
      if (limits.idleSuspendMinutes > 0) {
        for (const tab of candidates()) if (now - (tab.lastActiveAt ?? now) >= limits.idleSuspendMinutes * 60000) results.push({ ...(await this.suspendTab(tab, 'idle')), trigger: 'idle' });
      }
      const status = { at: new Date().toISOString() };
      if (limits.memoryBudgetMb && typeof this.rendererMemoryMb === 'function') {
        let used = await this.rendererMemoryMb();
        for (const tab of candidates()) {
          if (used <= limits.memoryBudgetMb) break;
          const result = await this.suspendTab(tab, 'memory_pressure');
          results.push({ ...result, trigger: 'memory_pressure', rendererMemoryMb: Math.round(used) });
          if (result.suspended) used = await this.rendererMemoryMb();
        }
        Object.assign(status, { rendererMemoryMb: Math.round(used), budgetMb: limits.memoryBudgetMb, overBudget: used > limits.memoryBudgetMb });
      }
      // The operating system's own memory pressure (src/memory-pressure.js): a few idle background tabs per cycle,
      // more and sooner when it is critical. Every suspension blocker still applies.
      if (limits.systemMemoryPressure && typeof this.systemMemory === 'function') {
        let signal = await Promise.resolve().then(() => this.systemMemory()).catch(() => null);
        const initial = signal?.level ?? 'normal';
        if (initial !== 'normal') {
          const critical = initial === 'critical';
          const maxTabs = critical ? 4 : 2;
          const minIdleMs = (critical ? 1 : 5) * 60000;
          let released = 0;
          for (const tab of candidates()) {
            if (released >= maxTabs || (signal?.level ?? 'normal') === 'normal') break;
            if (now - (tab.lastActiveAt ?? now) < minIdleMs) continue;
            const result = await this.suspendTab(tab, 'memory_pressure');
            results.push({ ...result, trigger: 'system_memory_pressure', level: signal.level });
            if (result.suspended) { released++; signal = await Promise.resolve().then(() => this.systemMemory()).catch(() => signal); }
          }
        }
        status.system = signal ? { level: signal.level, initialLevel: initial, available: signal.available, sources: signal.sources, reasons: signal.reasons,
          ...(signal.availableMb !== undefined ? { availableMb: signal.availableMb, totalMb: signal.totalMb } : {}), ...(signal.psi ? { psi: signal.psi } : {}) } : { available: false, level: 'normal' };
      }
      if (Object.keys(status).length > 1) this.memoryStatus = status;
      return results;
    } finally { this.suspending = false; }
  }

  startResourceScheduler(intervalMs = 30000) {
    clearInterval(this.resourceTimer);
    this.resourceTimer = setInterval(() => { void this.suspendIdle().catch(() => {}); }, intervalMs);
    this.resourceTimer.unref?.();
  }

  /** Tab quick switcher: titles and URLs with group, ownership and task indicators as text. */
  searchTabs(query, workspaceIds) {
    const terms = String(query || '').toLowerCase().split(/\s+/).filter(Boolean);
    const data = this.workspaceService?.data ?? {};
    const groups = new Map((data.tabGroups ?? []).map(group => [group.id, group]));
    const names = new Map((data.workspaces ?? []).map(item => [item.id, item.name]));
    const tasks = (data.tasks ?? []).filter(task => !TERMINAL_TASK.has(task.status));
    const label = state => state.controlMode === 'you-drive' ? 'You drive' : state.controlMode === 'assist' ? `Assist: ${state.assistant === 'any-agent' || !state.assistant ? 'an agent' : state.assistant} observes`
      : state.controlMode === 'agent-drives' ? `Agent drives: ${state.controller}` : 'Available to agents';
    const results = [];
    for (const tab of this.tabs.values()) {
      if (!workspaceIds.includes(tab.workspaceId)) continue;
      const state = this.describe(tab);
      const group = groups.get(tab.groupId);
      let host = '';
      try { host = new URL(state.url).hostname; } catch { /* about:blank */ }
      // Page-controlled titles of protected tabs are withheld from search results while the protection lasts (#6).
      const title = state.protectedOperation ? '[protected operation]' : pageString(state.title, 300);
      const haystack = `${title}\n${state.url}\n${group?.name ?? ''}`.toLowerCase();
      if (!terms.every(term => haystack.includes(term))) continue;
      const score = (terms.length && title.toLowerCase().startsWith(terms[0]) ? 4 : 0) + (terms.every(term => title.toLowerCase().includes(term)) ? 2 : 0) + (state.active ? 1 : 0);
      results.push({ tabId: tab.id, workspaceId: tab.workspaceId, workspaceName: names.get(tab.workspaceId) ?? null, title, url: state.url, host, active: state.active, pinned: state.pinned,
        suspended: Boolean(state.suspended), group: group ? { id: group.id, name: group.name, color: group.color } : null,
        control: { mode: state.controlMode, controller: state.controller, label: label(state) }, activity: state.activity, queued: state.queued.length,
        tasks: tasks.filter(task => task.tabIds?.includes(tab.id)).map(task => ({ id: task.id, title: task.title, status: task.status })), score });
    }
    results.sort((a, b) => b.score - a.score || a.tabId - b.tabId);
    return { query: String(query || ''), count: results.length, contentTrust: 'untrusted', results: results.slice(0, 200).map(({ score, ...item }) => item) };
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
      this.onAudit?.({ type: 'block', reason: 'unsolicited_download', outcome: 'recorded', workspaceId, tabId: source?.id, summary: { url: details.url, downloadId: id, category: details.category ?? null } });
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
      if (['known-malicious', 'infected'].includes(record.scanStatus)) {
        this.downloadSafety.quarantine(path, directory); record.quarantined = true;
        this.onAudit?.({ type: 'block', reason: 'download_quarantined', outcome: 'recorded', workspaceId: record.workspaceId, tabId: record.sourceTabId ?? undefined,
          summary: { url: record.url, downloadId: record.id, scanStatus: record.scanStatus, sha256: record.sha256 } });
      }
    } catch (error) {
      record.scanStatus = record.scanStatus === 'scanning' || record.scanStatus === 'pending' ? 'scan-failed' : record.scanStatus;
      record.scanDetail = `Post-download inspection failed: ${String(error.message).slice(0, 200)}`;
    }
    return record.scanStatus;
  }

  async execute(name, args = {}, context = { actor: 'human' }) {
    this.admission.assertAutomationAdmitted(context.actor, name);
    const human = isHuman(context.actor);
    // Using a tab keeps it active; a suspended or still-restoring tab reloads before page work (#30).
    if (!human) this.assertNotProtected(name, args);
    const used = args.tabId != null ? this.tabs.get(args.tabId) : name.startsWith('page.') ? this.tabs.get(this.activeId) : null;
    if (used && (name.startsWith('page.') || name.startsWith('tabs.') || name === 'downloads.approve')) {
      used.lastActiveAt = Date.now();
      if ((used.suspended || used.resuming) && !SUSPENDED_OK.has(name)) await this.resumeTab(used, name);
    }
    const tab = mutatingCommands.has(name) ? this.tab(args.tabId) : null;
    const slot = tab ? await this.acquireInput(tab, name, context.actor, human) : null;
    const epoch = tab?.controlEpoch ?? 0;
    const blockedBefore = tab?.blocked ?? null;
    const started = Date.now();
    // Navigation or input that ends on a newly blocked destination fails with one structured
    // site_blocked error (same details on every path); a pre-existing block is not misattributed.
    const newlyBlocked = () => tab?.blocked && tab.blocked !== blockedBefore && (navigationCommands.has(name) || inputCommands.has(name));
    try {
      const result = await this.executeAdmitted(name, args, context);
      if (tab && !human && epoch !== (tab.controlEpoch ?? 0)) {
        throw failure('action_interrupted', 'Tab control changed during the action; inspect current state. Already submitted effects cannot be undone.',
          { command: name, boundary: tab.lastBoundary?.reason ?? null, cancellable: false });
      }
      if (newlyBlocked()) throw this.blockedError(tab.blocked);
      if (!human) this.noteInspection(result, context.actor);
      // Page-controlled titles of protected tabs are withheld from automation until the protection ends.
      if (!human && ['page.inspect', 'tabs.list'].includes(name)) for (const item of Array.isArray(result) ? result : [result]) if (item?.protectedOperation) item.title = '[protected operation]';
      return result;
    } catch (error) {
      // An engine abort caused by a rule is reported as a structured block, never a generic failure.
      if (newlyBlocked() && !['site_blocked', 'action_interrupted'].includes(error.code) && (tab.blocked.at ?? 0) >= started) throw this.blockedError(tab.blocked);
      throw error;
    } finally { if (slot) this.releaseInput(tab, slot); }
  }

  /** Per-tab input serialization: one input operation runs; others queue (configurable) or fail as busy. */
  async acquireInput(tab, command, actor, human) {
    const slot = { command, actor, startedAt: new Date().toISOString() };
    if (tab.inFlight && human) {
      // Human input pre-empts automation at the next boundary.
      if (!isHuman(tab.inFlight.actor)) this.controlBoundary(tab, 'human action during automation');
      tab.view.webContents.stop?.();
    } else if (tab.inFlight) {
      const { queueLimit, queueTimeoutMs } = this.automationSettings();
      tab.inputQueue ??= [];
      const busy = (message, extra = {}) => failure('tab_busy', message, { activity: { command: tab.inFlight?.command ?? null, actor: tab.inFlight?.actor ?? null }, queued: tab.inputQueue.length, ...extra });
      if (tab.inputQueue.length >= queueLimit) throw busy('Another action is still in flight on this tab');
      return new Promise((resolve, reject) => {
        const entry = { actor, command, since: slot.startedAt, resolve, reject };
        entry.timer = setTimeout(() => {
          tab.inputQueue = tab.inputQueue.filter(item => item !== entry);
          reject(busy(`Input waited ${queueTimeoutMs} ms without reaching the front of the tab queue`, { waitedMs: queueTimeoutMs }));
        }, queueTimeoutMs);
        tab.inputQueue.push(entry);
      });
    }
    tab.inFlight = slot;
    return slot;
  }

  releaseInput(tab, slot) {
    if (tab.inFlight !== slot) return;
    tab.inFlight = null;
    const next = tab.inputQueue?.shift();
    if (!next) return;
    clearTimeout(next.timer);
    // Hand the slot over synchronously so a newly arriving request cannot overtake the queue.
    tab.inFlight = { command: next.command, actor: next.actor, startedAt: new Date().toISOString(), queuedSince: next.since };
    next.resolve(tab.inFlight);
  }

  cancelQueue(tab, reason) {
    const cancelled = (tab.inputQueue ?? []).splice(0);
    for (const entry of cancelled) { clearTimeout(entry.timer); entry.reject(failure('cancelled', `Queued input was cancelled before it started: ${reason}`)); }
    return cancelled.map(({ actor, command, since }) => ({ actor, command, since }));
  }

  automationSettings() {
    const value = this.workspaceService?.data?.settings?.automation ?? {};
    return { inputConcurrency: value.inputConcurrency === 'exclusive' ? 'exclusive' : 'shared',
      queueLimit: Number.isInteger(value.queueLimit) ? value.queueLimit : 0, queueTimeoutMs: Number.isInteger(value.queueTimeoutMs) ? value.queueTimeoutMs : 5000 };
  }

  controlMode(tab) {
    if (tab.controller === 'human') return tab.assistant ? 'assist' : 'you-drive';
    return !tab.controller || tab.controller === 'available' ? 'available' : 'agent-drives';
  }

  /** Records the latest state boundary shown to people and in stale-state errors. */
  stateBoundary(tab, reason) {
    tab.inspectionEpoch = (tab.inspectionEpoch ?? 0) + 1;
    tab.inspectionReason = reason;
  }

  /**
   * Automation input requires that the actor itself has seen the current tab
   * version (page.inspect, page.snapshot, or a result describing that tab).
   * Versions are sequential, so a guessed expectedVersion is not an inspection.
   */
  noteInspection(result, actor) {
    if (!result || typeof result !== 'object' || Array.isArray(result)) return;
    const tab = this.tabs.get(result.snapshotId ? result.tabId : result.id);
    const version = result.snapshotId ? result.navigationVersion : result.controlMode !== undefined ? result.version : undefined;
    if (!tab || !Number.isInteger(version)) return;
    tab.inspected ??= new Map();
    tab.inspected.set(actor, version);
  }

  /** Explicit takeover boundary: revoke leases, cancel queued input and report what could not be cancelled. */
  controlBoundary(tab, reason, controller = 'human') {
    const interrupted = tab.inFlight && !isHuman(tab.inFlight.actor)
      ? [{ command: tab.inFlight.command, actor: tab.inFlight.actor, startedAt: tab.inFlight.startedAt, cancellable: false }] : [];
    const cancelledQueue = this.cancelQueue(tab, reason);
    const previousController = tab.controller ?? 'available';
    tab.controlEpoch = (tab.controlEpoch ?? 0) + 1;
    this.stateBoundary(tab, reason);
    tab.controller = controller; tab.assistant = null; tab.rawInput = false;
    tab.version = (tab.version ?? 1) + 1;
    tab.lastBoundary = { reason, at: new Date().toISOString(), previousController, interrupted, cancelledQueue,
      notice: interrupted.length ? 'Already submitted page input or scripts cannot be cancelled and may still take effect. Inspect current state before relying on the outcome.' : null };
    if (!['human', 'available'].includes(previousController) || interrupted.length) {
      // Durable activity and the live handoff event record that an agent lost control (metadata only).
      this.onAudit?.({ type: 'override', command: 'tabs.takeover', actor: controller === 'human' ? 'human' : String(controller), workspaceId: tab.workspaceId, tabId: tab.id, version: tab.version,
        decision: 'override', reason: 'control_boundary', outcome: 'recorded',
        summary: { boundary: String(reason).slice(0, 100), previousController: String(previousController).slice(0, 100), interrupted: interrupted.length, cancelledQueue: cancelledQueue.length } });
      if (this.workspaceService?.recordTakeover) {
        Promise.resolve().then(() => this.workspaceService.recordTakeover({ workspaceId: tab.workspaceId, reason, previousController, interrupted, cancelledQueue, tab: this.handoffTabState(tab) }))
          .then(record => { if (record?.id) this.onEvent?.({ type: 'handoff', status: 'takeover', actor: 'human', workspaceId: tab.workspaceId, handoffId: record.id, tabId: tab.id, version: tab.version }); })
          .catch(error => { tab.error = `Takeover record not saved: ${error.message}`; });
      }
    }
    return tab.lastBoundary;
  }

  /** Secret-free tab state for handoff records. */
  handoffTabState(tab, actor) {
    const state = this.describe(tab);
    return { tabId: tab.id, url: state.url, title: state.protectedOperation ? '[protected operation]' : pageString(state.title, 200), navigationVersion: tab.version ?? 1, stateEpoch: tab.inspectionEpoch ?? 0,
      controller: state.controller, controlMode: state.controlMode, latestSnapshotId: actor ? tab.observations?.latest.get(actor)?.id ?? null : null };
  }

  requireInspection(tabId, actor) {
    const tab = this.tabs.get(tabId);
    if (!tab || isHuman(actor)) return;
    // -1 never matches a tab version, so input waits for a fresh inspection.
    tab.inspected ??= new Map();
    tab.inspected.set(actor, -1);
  }









  async assertObservable(tab, name, context) {
    if (isHuman(context.actor)) return;
    const reason = this.protectedReason(tab);
    if (reason) throw failure('permission_required', `Page observation is unavailable to automation during a protected operation: ${reason}`, { credential: 'protected_operation' });
    if (tab.credentialFill?.document === (tab.documentSerial ?? 0) && REVEAL_CHECKED.has(name)) {
      let revealed = true;
      try { revealed = (await bounded(this.credentialFrameScript(tab.view.webContents, null, 'revealed'), 3000)) !== false; } catch { /* Unknown: refuse. */ }
      if (revealed) throw failure('permission_required', 'The page shows a brokered secret as plain text (revealed or copied field); automation snapshots, screenshots and PDFs are refused on this page', { credential: 'credential_revealed' });
    }
    if (['page.screenshot', 'page.pdf'].includes(name)) {
      let focused = false;
      try { focused = (await this.observe(tab.view.webContents, null, {}, SENSITIVE_FOCUS_SCRIPT)) === true; } catch { /* Unavailable pages are reported by capture. */ }
      if (focused) throw failure('permission_required', 'Automation screenshots and PDFs are refused while a password, payment-card or one-time-code field is focused');
    }
  }

  /** Run observation code in the isolated world when Chromium provides it. */
  observe(contents, op, args = {}, code = observationScript(op, args)) {
    const gesture = ['click', 'fill'].includes(op);
    return typeof contents.executeJavaScriptInIsolatedWorld === 'function'
      ? contents.executeJavaScriptInIsolatedWorld(OBSERVATION_WORLD, [{ code }], gesture) : contents.executeJavaScript(code, gesture);
  }

  recordObservation(tab, observation) {
    tab.observations ??= { latest: new Map(), byId: new Map() };
    if (observation.kind === 'snapshot') tab.observations.latest.set(observation.actor, observation);
    tab.observations.byId.set(observation.id, observation);
    if (tab.observations.byId.size > 50) tab.observations.byId.delete(tab.observations.byId.keys().next().value);
  }

  /** Index grounding: refs must come from this actor's latest snapshot at the current version. */
  assertRef(tab, args, actor) {
    const observation = tab.observations?.latest.get(actor);
    if (!observation) throw stale('snapshot_required', 'Element refs require a page.snapshot by this actor at the current version');
    if (args.snapshotId != null && args.snapshotId !== observation.id) throw stale('not_latest_snapshot', 'Element refs must come from your latest page.snapshot');
    if (observation.version !== tab.version) throw stale('snapshot_outdated', 'The tab changed after the snapshot; take a new page.snapshot');
    if (observation.inputSerial !== (tab.inputSerial ?? 0)) throw stale('human_input', 'A person interacted with the page after the snapshot; take a new page.snapshot');
    if (!observation.refs.has(args.ref)) throw stale('ref_not_in_snapshot', 'The ref is not in your latest page.snapshot');
  }

  assertObservation(tab, observationId, actor) {
    const observation = tab.observations?.byId.get(observationId);
    if (!observation || observation.actor !== actor) throw stale('observation_required', 'Coordinates require a current page.snapshot or page.screenshot observation by this actor');
    if (observation.version !== tab.version) throw stale('observation_outdated', 'The tab changed after the observation; observe again before coordinate input');
    if (observation.inputSerial !== (tab.inputSerial ?? 0)) throw stale('human_input', 'A person interacted with the page after the observation; observe again');
    return observation;
  }

  async assertGeometry(tab, observation) {
    const live = await this.observe(tab.view.webContents, 'viewport');
    if (!observation) return live;
    const changed = ['url', 'width', 'height', 'scrollX', 'scrollY', 'devicePixelRatio'].filter(key => live?.[key] !== observation.viewport?.[key]);
    if (changed.length) throw stale('geometry_changed', `Viewport state changed since the observation (${changed.join(', ')}); observe again`, { changed });
    return live;
  }

  sendSynthetic(tab, events) {
    const expires = Date.now() + 1000;
    tab.synthetic = [...(tab.synthetic ?? []).filter(item => item.expires > Date.now()),
      ...events.filter(event => event.type !== 'char').map(event => ({ type: event.type, x: event.x, y: event.y, expires }))];
    for (const event of events) tab.view.webContents.sendInputEvent(event);
  }

  consumeSynthetic(tab, input) {
    if (!tab.synthetic?.length) return false;
    tab.synthetic = tab.synthetic.filter(item => item.expires > Date.now());
    const type = input.type === 'rawKeyDown' ? 'keyDown' : input.type;
    const index = tab.synthetic.findIndex(item => item.type === type && (item.x == null || (Math.round(input.x) === Math.round(item.x) && Math.round(input.y) === Math.round(item.y))));
    if (index < 0) return false;
    tab.synthetic.splice(index, 1);
    return true;
  }

  /** Observe whether input started a main-frame navigation and whether a site rule blocked it. */
  watchNavigation(tab, blockedBefore) {
    const contents = tab.view.webContents;
    if (typeof contents.on !== 'function') return { wait: async () => null, cancel() {} };
    let started = null, finished = null, wake = () => {};
    const blocked = () => tab.blocked && tab.blocked !== blockedBefore;
    const settle = value => { finished ??= value; wake(); };
    const listeners = {
      'did-start-navigation': (event, url, isInPlace, isMainFrame) => {
        if ((event?.isMainFrame ?? isMainFrame) && !(event?.isSameDocument ?? isInPlace)) { started = { url: pageString(event?.url ?? url, 2048) }; wake(); }
      },
      'did-navigate': () => settle({ committed: true }),
      'did-fail-load': (_event, _code, description, _url, isMainFrame) => { if (isMainFrame) settle({ committed: false, error: pageString(description, 200) }); },
    };
    // A navigation that becomes a download never commits; stop waiting as soon as it is handed to the download manager.
    const onDownload = (_event, _item, source) => { if (source === contents) settle({ committed: false, download: true }); };
    for (const [event, listener] of Object.entries(listeners)) contents.on(event, listener);
    contents.session?.on?.('will-download', onDownload);
    const cancel = () => {
      for (const [event, listener] of Object.entries(listeners)) contents.removeListener(event, listener);
      contents.session?.removeListener?.('will-download', onDownload);
    };
    const until = (ms, done) => new Promise(resolve => {
      if (done()) return resolve();
      const timer = setTimeout(resolve, ms);
      const poll = setInterval(() => { if (done()) { clearTimeout(timer); clearInterval(poll); resolve(); } }, 25);
      wake = () => { if (done()) { clearTimeout(timer); clearInterval(poll); resolve(); } };
      setTimeout(() => clearInterval(poll), ms + 1);
    });
    return { cancel, wait: async ms => {
      // Blocks surface synchronously (will-navigate) or on request interception; commits can take longer.
      await until(ms, () => started || finished || blocked());
      if (started) await until(2000, () => finished || blocked());
      cancel();
      if (blocked()) return { blocked: true, url: pageString(tab.blocked.url, 2048) };
      return started ? { ...started, ...(finished ?? { committed: false, pending: true }) } : finished?.download ? { download: true } : null;
    } };
  }

  async withDebugger(tab, callback) {
    const contents = tab.view.webContents;
    const previous = tab.debuggerLock ?? Promise.resolve();
    let release;
    tab.debuggerLock = new Promise(resolve => { release = resolve; });
    await previous;
    try {
      if (contents.debugger.isAttached()) throw new Error('Debugger is already attached');
      contents.debugger.attach('1.3');
      try { return await callback(contents.debugger); } finally { contents.debugger.detach(); }
    } finally { release(); }
  }

  /** Human-only: open one blocked popup as a new tab, optionally allowing the site's popups from now on (#97). */
  async allowPopup(args, context) {
    if (!isHuman(context.actor)) throw failure('permission_required', 'popups.allow requires the trusted browser interface');
    const tab = this.tab(args.tabId);
    const entry = (tab.blockedPopups ?? []).find(item => item.id === args.popupId);
    const target = entry && this.popupTargets?.get(entry.id);
    if (!entry || !target) throw failure('not_found', 'Blocked popup not found; it may be from before Weft restarted');
    const site = topOrigin(tab.view.webContents.getURL?.() || tab.url);
    if (args.always) {
      if (!site) throw failure('invalid_arguments', 'Popups can be allowed only for http(s) sites');
      this.permissions.execute('permissions.set', { workspaceId: tab.workspaceId, origin: site, permission: 'popups', decision: 'allow' }, context);
    }
    tab.blockedPopups = tab.blockedPopups.filter(item => item !== entry);
    this.popupTargets.delete(entry.id);
    const opened = await this.newTab(target, tab.workspaceId, { openerTabId: tab.id, openedBy: 'human' });
    return { opened, always: args.always, origin: site,
      notice: 'Opened in a new tab. A popup opened from this list cannot message the page that tried to open it; once popups are allowed for the site, later ones can.' };
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
    if (this.workspaceService && !this.workspaceExists(workspaceId)) throw new Error('Workspace not found');
    const session = () => this.sessions.get(workspaceId)?.session ?? this.sessionFor(workspaceId);
    if (!human && ['cookies.list', 'cookies.set', 'cookies.clear', 'storage.clear'].includes(name)) throw new Error('Storage administration requires the trusted browser interface');
    if (name !== 'tabs.move' && args.tabId != null && args.workspaceId != null && this.tab(args.tabId).workspaceId !== args.workspaceId) throw new Error('Tab belongs to a different workspace');
    if (!human && name === 'page.allowOnce') throw new Error('Site exceptions require the trusted browser interface');
    if (!human && cardGuardedCommands.has(name)) await this.assertNoFilledCard(this.tab(args.tabId), name);
    if (mutatingCommands.has(name)) this.checkControl(this.tab(args.tabId), args, context, name);
    if (/^(storage\.(policy|setSiteMode|setDefaultMode)|threats\.|launches\.|downloads\.configureScanner$|siteRules\.explain$)/.test(name)) return this.executeSecurity(name, args, context, workspaceId);
    if (name.startsWith('permissions.')) return this.permissions.execute(name, { ...args, workspaceId }, context);
    if (name === 'popups.allow') return this.allowPopup(args, context);
    if (name.startsWith('passwords.')) {
      if (!this.passwords) throw failure('unavailable', 'Saved passwords are not available in this session');
      return this.passwords.execute(name, args, context);
    }

    if (Object.hasOwn(browserCommands, name)) return browserCommands[name](this, { name, args, context, human, workspaceId, session });
    if (!name.startsWith('page.')) throw new Error(`Unknown command: ${name}`);
    const tab = this.tab(args.tabId);
    const contents = tab.view.webContents;
    if (Object.hasOwn(pageCommands, name)) return pageCommands[name](this, { name, args, context, human, workspaceId, session, tab, contents });
    throw new Error(`Unknown command: ${name}`);
  }

  async maskSensitiveFields(contents) {
    if (typeof contents.insertCSS !== 'function') return null;
    try {
      const key = await contents.insertCSS(MASK_CSS, { cssOrigin: 'user' });
      await bounded(this.observe(contents, null, {}, 'new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve(true))))'), 2000).catch(() => {});
      return key;
    } catch { return null; }
  }

  /**
   * Viewport, full-page, element or region PNG with complete capture geometry. The human-set
   * resource limit caps every caller's resolution; while headless the tab renders offscreen.
   */
  async screenshot(tab, args, context) {
    const edge = resourceSettings(this.workspaceService?.data?.settings).maxCaptureEdge ?? CAPTURE_LIMITS.defaultMaxEdge;
    const limited = { ...args, maxWidth: Math.min(args.maxWidth ?? edge, edge), maxHeight: Math.min(args.maxHeight ?? edge, edge) };
    if (!this.hidden && !this.isAttached(tab.view)) throw new Error('Show the tab before capturing a screenshot');
    const before = tab.version;
    const release = await this.renderForCapture(tab);
    try {
      const result = await this.screenshotRendered(tab, limited, context);
      if (this.hidden) result.capture.limitations.push('Rendered offscreen while Weft has no visible window.');
      if (result.capture.navigationVersion !== before) result.capture.limitations.push('The tab reloaded to render offscreen before this capture.');
      return result;
    } finally { release(); }
  }

  async screenshotRendered(tab, args, context) {
    const contents = tab.view.webContents;
    if ([args.ref != null, args.rect != null, !!args.fullPage].filter(Boolean).length > 1) throw failure('invalid_arguments', 'Choose at most one of fullPage, ref or rect');
    await this.assertObservable(tab, 'page.screenshot', context);
    const mode = args.ref != null ? 'element' : args.rect ? 'region' : args.fullPage ? 'fullPage' : 'viewport';
    if (mode === 'element') this.assertRef(tab, args, context.actor);
    if (args.observationId != null) await this.assertGeometry(tab, this.assertObservation(tab, args.observationId, context.actor));
    const version = tab.version, inputSerial = tab.inputSerial ?? 0;
    const live = await this.observe(contents, 'viewport');
    const maxWidth = args.maxWidth ?? 4096, maxHeight = args.maxHeight ?? 4096, requestedScale = args.scale ?? 1;
    const pixelRatio = requestedScale * (live.devicePixelRatio || 1);
    const limitations = [];
    let clip = null, frame = 'f0', cropped = false;
    if (mode === 'element') {
      const target = await this.observe(contents, 'box', { ref: args.ref });
      if (!target?.ok) throw elementFailure(target?.reason);
      clip = { x: target.box.x + live.scrollX, y: target.box.y + live.scrollY, width: target.box.width, height: target.box.height };
      frame = target.frame;
    } else if (mode === 'region') clip = { x: args.rect.x + live.scrollX, y: args.rect.y + live.scrollY, width: args.rect.width, height: args.rect.height };
    else if (mode === 'fullPage') clip = { x: 0, y: 0, width: live.documentWidth, height: live.documentHeight };
    if (clip) {
      const x = Math.max(0, clip.x), y = Math.max(0, clip.y);
      const right = Math.min(live.documentWidth, clip.x + clip.width), bottom = Math.min(live.documentHeight, clip.y + clip.height);
      if (right - x < 1 || bottom - y < 1) throw failure('invalid_arguments', 'The requested region is empty or outside the page');
      if (x !== clip.x || y !== clip.y || right !== clip.x + clip.width || bottom !== clip.y + clip.height) { cropped = true; limitations.push('Region cropped to the page bounds.'); }
      clip = { x, y, width: right - x, height: bottom - y };
      if (clip.width * pixelRatio > maxWidth) { clip.width = Math.floor(maxWidth / pixelRatio); cropped = true; limitations.push(`Cropped to maxWidth ${maxWidth} px.`); }
      if (clip.height * pixelRatio > maxHeight) { clip.height = Math.floor(maxHeight / pixelRatio); cropped = true; limitations.push(`Cropped to maxHeight ${maxHeight} px; content below was not captured.`); }
    }
    const mask = await this.maskSensitiveFields(contents);
    let data, scale = requestedScale;
    try {
      if (mode === 'viewport') {
        // Let the page produce a frame first (bounded: frames never arrive for an occluded window), as offscreen captures do.
        await bounded(this.observe(contents, null, {}, 'new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve(true))))'), 1000).catch(() => {});
        // UnknownVizError means the compositor has no surface yet (e.g. a window still being mapped): transient, like an empty frame.
        const grab = () => bounded(contents.capturePage(undefined, { stayHidden: true, stayAwake: true }))
          .catch(error => { if (/UnknownVizError/.test(String(error?.message ?? error))) return null; throw error; });
        let image = await grab();
        // Right after a navigation or reload Chromium may not have painted a frame yet: ask for one and retry briefly.
        for (let attempt = 1; (!image || image.isEmpty()) && attempt <= 5; attempt++) {
          contents.invalidate();
          await delay(100 * attempt);
          image = await grab();
        }
        if (!image || image.isEmpty()) throw new Error('The page has no rendered image yet; show the tab and try again');
        const size = image.getSize();
        scale = Math.min(requestedScale, maxWidth / size.width, maxHeight / size.height);
        if (scale < requestedScale) limitations.push('Viewport image downscaled to the resolution limit.');
        if (scale !== 1) image = image.resize({ width: Math.max(1, Math.round(size.width * scale)), height: Math.max(1, Math.round(size.height * scale)), quality: 'good' });
        data = image.toPNG().toString('base64');
      } else {
        ({ data } = await this.withDebugger(tab, client => bounded(client.sendCommand('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true, clip: { ...clip, scale: requestedScale } }))));
      }
    } finally { if (mask) await contents.removeInsertedCSS(mask).catch(() => {}); }
    if (!mask) limitations.push('Sensitive form fields could not be masked in this capture.');
    if (tab.version !== version) limitations.push('The tab changed during capture.');
    limitations.push('Page text that repeats a secret outside form fields is not redacted.', 'Lazy-loaded, virtualized and cross-origin content may be missing.');
    const captureId = `cap_${randomUUID().slice(0, 12)}`;
    const capturedAt = new Date().toISOString();
    this.recordObservation(tab, { id: captureId, kind: 'screenshot', actor: context.actor, version, inputSerial, viewport: live, createdAt: capturedAt });
    return { data, mimeType: 'image/png', capture: { captureId, mode, tabId: tab.id, url: pageString(live.url, 16384), title: pageString(contents.getTitle(), 1000), capturedAt,
      navigationVersion: version, frame, viewport: { width: live.width, height: live.height }, devicePixelRatio: live.devicePixelRatio, zoom: contents.getZoomFactor?.() ?? 1,
      scroll: { x: live.scrollX, y: live.scrollY }, document: { width: live.documentWidth, height: live.documentHeight }, clip, image: pngSize(data), scale, cropped,
      redaction: { method: 'masked-sensitive-form-fields', applied: !!mask }, contentTrust: 'untrusted', limitations } };
  }

  /**
   * Workflow recording (#10): report a person's trusted clicks and committed field changes in one tab
   * from an isolated world. Values are never read. Returns a stop function, or null when unsupported.
   */
  startRecordingCapture(tabId, onEvent) {
    const tab = this.tab(tabId);
    const contents = tab.view?.webContents;
    if (typeof contents?.executeJavaScriptInIsolatedWorld !== 'function') return null;
    // A recording tab is never suspended (#30): its renderer holds the recording script.
    tab.recording = true;
    const nonce = randomUUID();
    const prefix = `weft-record:${nonce}:`;
    const inject = () => { if (!contents.isDestroyed?.()) contents.executeJavaScriptInIsolatedWorld(RECORDING_WORLD, [{ code: recordingScript(nonce) }]).catch(() => {}); };
    const onConsole = (event, _level, legacyMessage) => {
      const text = typeof event?.message === 'string' ? event.message : legacyMessage;
      if (typeof text !== 'string' || !text.startsWith(prefix) || text.length > 4096) return;
      try { onEvent(JSON.parse(text.slice(prefix.length))); } catch { /* malformed reports are ignored */ }
    };
    contents.on('console-message', onConsole);
    contents.on('dom-ready', inject);
    inject();
    const stop = () => { tab.recording = false; contents.removeListener('console-message', onConsole); contents.removeListener('dom-ready', inject); };
    stop.flush = () => new Promise(resolve => setTimeout(resolve, 50));
    return stop;
  }

  checkControl(tab, args, context, name) {
    // Every refusal here precedes any page effect: mark it not started so a one-time approval can be given back.
    try { this.precheckControl(tab, args, context, name); }
    catch (error) { if (error && typeof error === 'object') error.notStarted = true; throw error; }
    tab.version++;
    this.persist();
  }

  precheckControl(tab, args, context, name) {
    if (['page.click', 'page.fill'].includes(name) && (args.ref == null) === (args.selector == null)) throw failure('invalid_arguments', 'Provide exactly one of selector or ref');
    if (args.expectedVersion != null && args.expectedVersion !== tab.version) throw stale('version', 'Stale tab version; inspect current state');
    const human = isHuman(context.actor);
    if (!human) {
      if (tab.controller !== 'available' && tab.controller !== context.actor) throw new Error('Tab control is held by another actor; request handoff');
      if (args.expectedVersion == null) throw new Error('An expectedVersion is required for automation input; inspect current state');
      if (this.automationSettings().inputConcurrency === 'exclusive' && tab.controller !== context.actor) throw failure('lease_conflict', 'Exclusive input mode: claim this tab with tabs.claim before input');
      if (tab.inspected?.get(context.actor) !== tab.version) {
        throw stale('inspection_required', `Inspect current state with page.inspect or page.snapshot before input${tab.inspectionReason ? ` (last change: ${tab.inspectionReason})` : ''}`);
      }
      if (rawInputCommands.has(name) && !(tab.rawInput && tab.controller === context.actor)) {
        throw failure('permission_required', 'Coordinate and keyboard input from automation is refused unless a person lets this agent drive with raw input enabled and the agent holds the lease');
      }
      if (name === 'page.clickAt' && args.observationId == null) throw failure('invalid_arguments', 'Automation coordinates require observationId from a current page.snapshot or page.screenshot');
    } else if (tab.controller !== 'human' && tab.controller !== 'available') {
      throw new Error('Take over this tab before changing it');
    }
    if (args.ref != null) this.assertRef(tab, args, context.actor);
    if (args.observationId != null) this.assertObservation(tab, args.observationId, context.actor);
  }







  /** A deleted or archived workspace leaves any second window it was in; an emptied window is closed by the app (#100). */
  releaseWorkspace(workspaceId) {
    if (this.ownerOf(workspaceId) === this.main) return null;
    const result = this.moveWorkspace(workspaceId, 1, { show: false });
    if (result.emptied) this.onWindowEmptied?.(result.emptied);
    return result;
  }

  closeWorkspace(workspaceId) {
    for (const tab of [...this.tabs.values()]) if (tab.workspaceId === workspaceId) this.closeTab(tab.id);
    this.forgetClosed(workspaceId);
    const { [workspaceId]: _removed, ...zoom } = this.siteZoom;
    this.siteZoom = zoom;
  }

  close() {
    if (this.closing) return null;
    this.persist();
    this.closing = true;
    try { this.closeArchivePreview(); } catch { /* window already gone */ }
    clearInterval(this.resourceTimer);
    this.window?.removeListener('resize', this.onResize);
    for (const state of this.windows.values()) if (state !== this.main) state.window?.removeListener?.('resize', state.onResize);
    for (const id of [...this.tabs.keys()]) this.closeTab(id);
    for (const { item } of this.downloads.values()) item?.cancel();
    for (const { session, onDownload, detachStorage } of this.sessions.values()) {
      session.removeListener('will-download', onDownload);
      session.webRequest?.onBeforeRequest(null);
      session.webRequest?.onBeforeSendHeaders?.(null);
      session.webRequest?.onHeadersReceived?.(null);
      session.webRequest?.onCompleted?.(null);
      session.webRequest?.onErrorOccurred?.(null);
      detachStorage?.();
    }
    // Clean exit erases temporary site data; if the process dies first, the
    // durable journal makes the next startup erase it before restoring tabs.
    if (!this.siteStorage?.journal.entries.length) return null;
    return this.siteStorage.cleanup('exit').catch(() => null);
  }
}

// Methods split out of the class (#119) keep their names and `this`; installed as non-enumerable like class methods.
for (const methods of [browserChromeMethods, browserCredentialMethods, browserCaptureMethods]) {
  for (const [key, descriptor] of Object.entries(Object.getOwnPropertyDescriptors(methods))) Object.defineProperty(Browser.prototype, key, { ...descriptor, enumerable: false });
}
