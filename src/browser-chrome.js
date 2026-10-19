/**
 * People-only browser chrome: shortcuts, zoom memory, recently closed tabs, tab order, find, print, DevTools, page source and the context menu (#88, #89, #92, #93, #96).
 * Browser methods moved verbatim from src/browser.js (#119) and installed on Browser.prototype there, so
 * `this` is the Browser instance and every method keeps its name.
 */
import { contextMenuItems } from './context-menu.js';
import { keyLabel, nextZoom } from './shortcuts.js';
import { pageString } from './page-observation.js';
import { randomUUID } from 'node:crypto';
import { sanitizeUrl } from './workspace.js';
import { searchEngine, searchUrl } from './search-engines.js';
import { KEY_WORLD, bounded, failure, isHuman, keyWatcherScript } from './browser-support.js';

export const browserChromeMethods = {
  // ---- Browser chrome for people (#88, #89, #92, #93, #96) ---------------------------
  // Reached only from the trusted GUI (IPC) or from real input in a page; DevTools, print and source view are not in the command catalog.

  /** The tab people act on: the focused split pane, else the active tab. */
  focusedTab() {
    const active = this.tabs.get(this.activeId);
    const split = this.viewport?.splitTabId != null ? this.tabs.get(this.viewport.splitTabId) : null;
    return this.viewport?.focusedPane === 'secondary' && split ? split : active ?? null;
  },
  /** A claimable key goes to the page first only when the key watcher runs in this document and focus is in its top frame. */
  pageMayClaim(tab) {
    if (tab.keyWorld !== (tab.documentSerial ?? 0)) return false;
    const contents = tab.view.webContents;
    const focused = contents.focusedFrame;
    return !focused || !contents.mainFrame || (focused.processId === contents.mainFrame.processId && focused.routingId === contents.mainFrame.routingId);
  },
  watchKeys(tab, contents) {
    const document = tab.documentSerial ?? 0;
    if (tab.viewSource || typeof contents.executeJavaScriptInIsolatedWorld !== 'function') return;
    contents.executeJavaScriptInIsolatedWorld(KEY_WORLD, [{ code: keyWatcherScript(this.keyNonce) }])
      .then(() => { if ((tab.documentSerial ?? 0) === document) tab.keyWorld = document; }, () => {});
  },
  /** The page did not handle a claimable key: run the shortcut, only for the matching real key press. */
  unclaimedKey(tab, payload) {
    let key;
    try { key = JSON.parse(payload)?.key; } catch { return; }
    const pending = tab.pendingShortcut;
    tab.pendingShortcut = null;
    if (!pending || pending.key !== key || Date.now() - pending.at > 1500) return;
    this.onChromeShortcut?.({ shortcut: pending.id, tabId: tab.id });
  },
  /** Remembered per-origin zoom (#93): saved per workspace, applied when a page of that origin commits. */
  zoomOrigin(tab) {
    try { const url = new URL(tab.view.webContents.getURL() || tab.url); return /^https?:$/.test(url.protocol) ? url.origin : null; } catch { return null; }
  },
  rememberZoom(tab, factor) {
    const origin = this.zoomOrigin(tab);
    if (!origin || tab.viewSource) return;
    const saved = { ...(this.siteZoom[tab.workspaceId] ?? {}) };
    delete saved[origin];
    if (Math.abs(factor - 1) > 0.001) saved[origin] = Math.round(factor * 100) / 100;
    this.siteZoom = { ...this.siteZoom, [tab.workspaceId]: Object.fromEntries(Object.entries(saved).slice(-200)) };
  },
  applySiteZoom(tab) {
    const origin = this.zoomOrigin(tab);
    const factor = origin ? this.siteZoom[tab.workspaceId]?.[origin] ?? 1 : 1;
    const contents = tab.view.webContents;
    try { if (Math.abs((contents.getZoomFactor?.() ?? 1) - factor) > 0.001) contents.setZoomFactor(factor); } catch { /* destroyed */ }
  },
  /** Recently closed tabs (#92): what a reopen restores. Never agent control, grants or protected state. */
  rememberClosed(tab, scroll = {}) {
    const contents = tab.view.webContents;
    const url = tab.blocked?.url || contents.getURL?.() || tab.url;
    if (tab.viewSource || tab.private || !url || !/^https?:/i.test(url)) return;
    const record = { id: `closed_${randomUUID().slice(0, 12)}`, workspaceId: tab.workspaceId, url: sanitizeUrl(url) || url, title: pageString(contents.getTitle?.() || tab.title || '', 1000),
      pinned: Boolean(tab.pinned), groupId: tab.groupId ?? null, zoom: tab.suspended?.zoom ?? contents.getZoomFactor?.() ?? 1,
      scrollX: Number(scroll.scrollX ?? tab.suspended?.scrollX) || 0, scrollY: Number(scroll.scrollY ?? tab.suspended?.scrollY) || 0, closedAt: new Date().toISOString() };
    const others = this.closedTabs.filter(item => item.workspaceId !== tab.workspaceId);
    const mine = [...this.closedTabs.filter(item => item.workspaceId === tab.workspaceId), record].slice(-25);
    this.closedTabs = [...others, ...mine];
  },
  async closeTabRemembering(tabId) {
    const tab = this.tab(tabId);
    let scroll = {};
    if (!tab.suspended && !tab.view.placeholder) {
      try { const live = await bounded(this.observe(tab.view.webContents, 'viewport'), 600); scroll = { scrollX: live?.scrollX, scrollY: live?.scrollY }; } catch { /* reopened at the top */ }
    }
    if (!this.tabs.has(tabId)) return { closed: tabId };
    this.rememberClosed(tab, scroll);
    return this.closeTab(tabId);
  },
  closedList(workspaceId) {
    return this.closedTabs.filter(item => item.workspaceId === workspaceId).reverse().map(item => ({ ...item }));
  },
  forgetClosed(workspaceId) {
    this.closedTabs = this.closedTabs.filter(item => item.workspaceId !== workspaceId);
  },
  async reopenClosed(workspaceId, id) {
    const list = this.closedTabs.filter(item => item.workspaceId === workspaceId);
    const record = id ? list.find(item => item.id === id) : list.at(-1);
    if (!record) throw failure('not_found', id ? 'That closed tab is no longer in the list' : 'No recently closed tabs in this workspace');
    this.closedTabs = this.closedTabs.filter(item => item !== record);
    // Reopened unloaded at the saved scroll and zoom; showing it reloads the URL through every site rule.
    const reopened = await this.newTab(record.url, workspaceId, { title: record.title, pinned: record.pinned, groupId: record.groupId ?? undefined,
      suspended: { at: record.closedAt, reason: 'reopened', scrollX: record.scrollX, scrollY: record.scrollY, zoom: record.zoom } });
    const tab = this.tab(reopened.id);
    if (workspaceId === this.workspaceId) { this.activate(tab.id); await tab.resuming?.catch(() => {}); }
    tab.restoredFrom = null;
    this.persist();
    return { ...this.describe(tab), reopenedFrom: record.id, notice: 'Reopened from its address at the saved scroll position and zoom. Form input, sign-in state and in-page script state are not restored.' };
  },
  /** Move a tab to a new position among its workspace's tabs (#92); the order persists and is the order of tabs.list. */
  reorderTab(tabId, index) {
    const tab = this.tab(tabId);
    const mine = [...this.tabs.values()].filter(item => item.workspaceId === tab.workspaceId && item !== tab);
    mine.splice(Math.max(0, Math.min(index, mine.length)), 0, tab);
    let next = 0;
    const order = [...this.tabs.values()].map(item => (item.workspaceId === tab.workspaceId ? mine[next++] : item));
    this.tabs = new Map(order.map(item => [item.id, item]));
    // Position is not page state: the tab version (and agents' inspections) stay valid.
    this.persist();
    return { ...this.describe(tab), index: mine.indexOf(tab) };
  },
  /** People-only chrome actions from the trusted GUI (IPC). */
  async chromeAction(action, args = {}) {
    switch (action) {
      case 'find': return this.humanFind(args);
      case 'stop-find': { const tab = this.focusedTab(); if (tab && !tab.view.placeholder) tab.view.webContents.stopFindInPage('clearSelection'); return { stopped: true }; }
      case 'print': return this.printPage(args);
      case 'hard-reload': { const tab = this.chromeTab(args); this.humanControl(tab); tab.view.webContents.reloadIgnoringCache(); return { success: true }; }
      case 'devtools': return this.openDevTools(args);
      case 'view-source': return this.viewSource(args);
      case 'zoom': {
        const tab = this.chromeTab(args);
        const factor = nextZoom(tab.view.webContents.getZoomFactor?.() ?? 1, Number(args.direction) || 0);
        return this.executeAdmitted('page.zoom', { tabId: tab.id, factor }, { actor: 'human' });
      }
      default: throw failure('invalid_arguments', 'Unknown browser chrome action');
    }
  },
  chromeTab(args = {}) {
    const tab = args.tabId != null ? this.tab(args.tabId) : this.focusedTab();
    if (!tab || tab.view.placeholder || tab.suspended) throw failure('not_found', 'No page is shown');
    return tab;
  },
  humanControl(tab) {
    if (tab.controller !== 'human' && tab.controller !== 'available') throw failure('lease_conflict', 'An agent drives this tab; take control of it first');
  },
  humanFind(args = {}) {
    const tab = this.focusedTab();
    if (!tab || tab.view.placeholder || tab.suspended) return Promise.resolve({ matches: 0, activeMatchOrdinal: 0 });
    const contents = tab.view.webContents;
    const text = String(args.text ?? '').slice(0, 4096);
    if (!text) { contents.stopFindInPage('clearSelection'); return Promise.resolve({ matches: 0, activeMatchOrdinal: 0, tabId: tab.id }); }
    return new Promise(resolve => {
      let requestId = null;
      const done = result => { clearTimeout(timer); contents.removeListener('found-in-page', listener); resolve({ matches: result.matches ?? 0, activeMatchOrdinal: result.activeMatchOrdinal ?? 0, tabId: tab.id }); };
      const listener = (_event, result) => { if (result.requestId === requestId && result.finalUpdate) done(result); };
      const timer = setTimeout(() => done({ matches: 0, activeMatchOrdinal: 0 }), 3000);
      contents.on('found-in-page', listener);
      requestId = contents.findInPage(text, { forward: args.forward !== false, findNext: args.newSession === true, matchCase: args.matchCase === true });
    });
  },
  async printPage(args = {}) {
    const tab = this.chromeTab(args);
    if (this.protectedReason(tab)) throw failure('permission_required', 'This tab is in a protected sign-in or payment operation; print it after the operation ends');
    const result = await this.printContents(tab.view.webContents);
    this.onAudit?.({ type: 'command', reason: 'print', outcome: result.printed ? 'completed' : 'cancelled', workspaceId: tab.workspaceId, tabId: tab.id, summary: { dialog: 'system' } });
    return { ...result, tabId: tab.id };
  },
  /**
   * DevTools (#96) are human-only: never in the command catalog and never over CDP. They are refused for the offline archive
   * preview, during protected operations, and on a tab an agent drives (take control first). While they are open,
   * credentials are never filled into the tab and its ownership shows "DevTools open".
   */
  openDevTools(args = {}) {
    if (this.preview && args.tabId == null) throw failure('unsupported', 'DevTools are not available for offline previews: they could run script or reach the network');
    const tab = this.chromeTab(args);
    if (this.protectedReason(tab)) throw failure('permission_required', 'DevTools cannot open during a protected sign-in or payment operation');
    if ((tab.controller !== 'human' && tab.controller !== 'available') || (tab.inFlight && !isHuman(tab.inFlight.actor))) throw failure('lease_conflict', 'An agent drives this tab; take control of it before opening DevTools');
    const contents = tab.view.webContents;
    if (contents.isDevToolsOpened?.()) { contents.devToolsWebContents?.focus?.(); return { opened: true, tabId: tab.id, already: true }; }
    if (Number.isFinite(args.x) && Number.isFinite(args.y)) contents.inspectElement(Math.round(args.x), Math.round(args.y));
    else contents.openDevTools({ mode: 'detach', activate: true });
    tab.devtools = true;
    this.onAudit?.({ type: 'command', reason: 'devtools_opened', outcome: 'recorded', workspaceId: tab.workspaceId, tabId: tab.id, summary: {} });
    this.persist();
    return { opened: true, tabId: tab.id };
  },
  /** Read-only source of an http(s) page in a new, unsaved tab. URL admission is unchanged: view-source: stays refused everywhere else. */
  async viewSource(args = {}) {
    const tab = this.chromeTab(args);
    if (this.protectedReason(tab)) throw failure('permission_required', 'Page source is not shown during a protected sign-in or payment operation');
    const url = tab.blocked?.url || tab.view.webContents.getURL() || tab.url;
    let protocol = '';
    try { protocol = new URL(url).protocol; } catch { /* not a URL */ }
    if (tab.viewSource || !/^https?:$/.test(protocol)) throw failure('unsupported', 'Page source is available for web pages (http and https) only');
    return this.newTab(url, tab.workspaceId, { viewSource: true, openerTabId: tab.id, openedBy: 'human' });
  },
  /** Open a page-supplied link from the context menu: the same admission, site rules and security checks as any navigation. */
  async openFromPage(tab, url, { background = true } = {}) {
    try {
      this.allowedUrl(url, tab.workspaceId);
      return await this.newTab(url, tab.workspaceId, { openerTabId: tab.id, openedBy: 'human', background });
    } catch (error) {
      this.onNotice?.(`Not opened: ${error.message}`);
      return null;
    }
  },
  downloadFromPage(tab, url) {
    try {
      const allowed = this.allowedUrl(url, tab.workspaceId);
      this.downloadGrants.set(tab.id, { expires: Date.now() + 30000, url: allowed });
      tab.view.webContents.downloadURL(allowed);
    } catch (error) { this.onNotice?.(`Not downloaded: ${error.message}`); }
    return null;
  },
  contextState(tab) {
    const contents = tab.view.webContents;
    let sourceAvailable = false;
    try { sourceAvailable = !tab.viewSource && /^https?:$/.test(new URL(contents.getURL()).protocol); } catch { /* blank */ }
    const settings = this.workspaceService?.locked ? {} : this.workspaceService?.data?.settings;
    return { canGoBack: contents.navigationHistory?.canGoBack() ?? false, canGoForward: contents.navigationHistory?.canGoForward() ?? false,
      protectedOperation: this.protectedReason(tab), searchName: searchEngine(settings).name, sourceAvailable,
      devtoolsAllowed: tab.controller === 'human' || tab.controller === 'available', keyLabel: id => keyLabel(id) };
  },
  /** Chromium's context-menu event (#89): shown only after real human input (a right click, the menu key or Shift+F10). */
  contextMenu(tab, params) {
    if (!this.tabs.has(tab.id) || !this.recentHumanInput(tab)) return null;
    const items = contextMenuItems(params, this.contextState(tab));
    const document = tab.documentSerial ?? 0;
    const template = items.map(item => item.type === 'separator' ? { type: 'separator' } : {
      label: item.label, enabled: item.enabled !== false, ...(item.accelerator && { accelerator: item.accelerator, registerAccelerator: false }),
      click: () => { if (this.tabs.has(tab.id) && (tab.documentSerial ?? 0) === document) void this.contextAction(tab, params, item.id, item.argument).catch(error => this.onNotice?.(error.message)); },
    });
    this.popupMenu(template, tab, params);
    return items;
  },
  async contextAction(tab, params, id, argument) {
    const contents = tab.view.webContents;
    const clipboard = this.electron.clipboard;
    const settings = this.workspaceService?.locked ? {} : this.workspaceService?.data?.settings;
    switch (id) {
      case 'open-link': return this.openFromPage(tab, params.linkURL);
      case 'copy-link': clipboard.writeText(String(params.linkURL)); return null;
      case 'save-link': return this.downloadFromPage(tab, params.linkURL);
      case 'open-image': return this.openFromPage(tab, params.srcURL);
      case 'copy-image': contents.copyImageAt(params.x, params.y); return null;
      case 'copy-image-address': clipboard.writeText(String(params.srcURL)); return null;
      case 'save-image': return this.downloadFromPage(tab, params.srcURL);
      case 'cut': contents.cut(); return null;
      case 'copy': contents.copy(); return null;
      case 'paste': contents.paste(); return null;
      case 'select-all': contents.selectAll(); return null;
      case 'replace-misspelling': contents.replaceMisspelling(String(argument)); return null;
      case 'add-to-dictionary': contents.session?.addWordToSpellCheckerDictionary?.(String(argument)); return null;
      case 'search-selection': return this.openFromPage(tab, searchUrl(settings, String(params.selectionText).slice(0, 500)), { background: false });
      case 'send-selection': this.onChromeShortcut?.({ shortcut: 'capture-selection', tabId: tab.id }); return null;
      case 'save-page': this.onChromeShortcut?.({ shortcut: 'save-page', tabId: tab.id }); return null;
      case 'back': this.humanControl(tab); contents.navigationHistory.goBack(); return null;
      case 'forward': this.humanControl(tab); contents.navigationHistory.goForward(); return null;
      case 'reload': this.humanControl(tab); contents.reload(); return null;
      case 'print': return this.printPage({ tabId: tab.id });
      case 'view-source': return this.viewSource({ tabId: tab.id });
      case 'inspect': return this.openDevTools({ tabId: tab.id, x: params.x, y: params.y });
      default: return null;
    }
  },
};
