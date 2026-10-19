import electron from 'electron';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { safeUrl } from './browser.js';

/**
 * Private (temporary) windows (#94, ADR-008 addendum). Each private session is an in-memory Chromium
 * partition (no "persist:" prefix, so nothing is written to the profile) shared by the windows it opened
 * and erased when the last of them closes. A private window belongs to no workspace: no tab records,
 * history, recently closed entries, captures or session restore, and no agent, automation or tab
 * command can reach it. Activity records only that a private window opened or closed.
 */
const CHROME_HEIGHT = 76;
const GESTURE_MS = 5000;
const SEARCH = 'https://duckduckgo.com/?q=';
export const PRIVATE_LIMITS = Object.freeze({ windows: 20 });
const chromeUrl = new URL('./private-window.html', import.meta.url).href;

/** Address bar input: a URL when it looks like one, otherwise a search. Only http(s) pages are opened. */
export function privateTarget(value) {
  const text = String(value ?? '').trim();
  if (!text) return 'about:blank';
  if (/^[a-z][a-z\d+.-]*:/i.test(text) && !/^https?:\/\//i.test(text) && text !== 'about:blank') throw new Error('Private windows open only http and https addresses');
  if (/^https?:\/\//i.test(text) || text === 'about:blank') return safeUrl(text);
  if (!/\s/.test(text) && /^[\w-]+(\.[\w-]+)+(:\d+)?(\/.*)?$/.test(text)) return safeUrl(`https://${text}`);
  return `${SEARCH}${encodeURIComponent(text)}`;
}

export class PrivateWindows {
  constructor({ browser, electronApi = electron, audit = () => {}, siteRuleFor = () => null } = {}) {
    Object.assign(this, { browser, electron: electronApi, audit, siteRuleFor });
    this.windows = new Map();
    this.sessions = new Map();
    const ipc = this.electron.ipcMain;
    const owner = event => [...this.windows.values()].find(item => item.window.webContents === event.sender && event.senderFrame?.url === chromeUrl);
    const handle = (channel, fn) => { ipc.removeHandler?.(channel); ipc.handle(channel, (event, ...args) => { const item = owner(event); if (!item) throw new Error('Unauthorized IPC sender'); return fn(item, ...args); }); };
    handle('weft-private:ready', item => this.state(item));
    handle('weft-private:navigate', (item, value) => this.navigate(item, value));
    handle('weft-private:control', (item, action) => this.control(item, action));
  }

  get count() { return this.windows.size; }

  /** Open a private window, optionally on an existing private session (a popup from a private page). */
  open(url = 'about:blank', { sessionKey = null } = {}) {
    if (this.windows.size >= PRIVATE_LIMITS.windows) throw Object.assign(new Error(`At most ${PRIVATE_LIMITS.windows} private windows can be open`), { code: 'resource_busy' });
    const key = sessionKey && this.sessions.has(sessionKey) ? sessionKey : `weft-private-${randomUUID()}`;
    const entry = this.sessions.get(key) ?? this.createSession(key);
    const window = new this.electron.BrowserWindow({ width: 1180, height: 820, minWidth: 600, minHeight: 400, title: 'Private window — Weft', backgroundColor: '#241b2f',
      webPreferences: { preload: fileURLToPath(new URL('./private-preload.cjs', import.meta.url)), nodeIntegration: false, contextIsolation: true, sandbox: true } });
    window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    window.webContents.on('will-navigate', event => event.preventDefault());
    const view = new this.electron.WebContentsView({ webPreferences: { session: entry.session, nodeIntegration: false, contextIsolation: true, sandbox: true, webSecurity: true, allowRunningInsecureContent: false } });
    // The id comes from the tab id space so that a guessed id is refused as private, never matched to another tab.
    const id = this.browser ? this.browser.nextTabId++ : this.windows.size + 1;
    this.browser?.privateTabIds.add(id);
    const item = { id, window, view, sessionKey: key, lastHumanInput: 0, error: null };
    this.windows.set(id, item);
    entry.windows.add(id);
    window.contentView.addChildView(view);
    const layout = () => { if (window.isDestroyed()) return; const [width, height] = window.getContentSize(); view.setBounds({ x: 0, y: CHROME_HEIGHT, width: Math.max(1, width), height: Math.max(1, height - CHROME_HEIGHT) }); };
    window.on('resize', layout);
    layout();
    this.wire(item);
    window.on('closed', () => this.closed(item));
    void window.loadURL(chromeUrl).catch(() => {});
    if (url && url !== 'about:blank') void this.navigate(item, url);
    this.audit({ type: 'display', reason: 'private_window_opened', outcome: 'recorded', summary: { open: this.windows.size } });
    return { id, private: true };
  }

  createSession(key) {
    const session = this.electron.session.fromPartition(key, { cache: false });
    // No prompts or grants: every web permission is denied in a private session.
    session.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
    session.setPermissionCheckHandler(() => false);
    session.setDisplayMediaRequestHandler?.((_request, callback) => callback({}));
    session.webRequest?.onBeforeRequest((details, callback) => {
      if (!/^https?:/i.test(details.url)) { callback({}); return; }
      let cancel = false;
      try {
        const security = this.browser?.threats?.checkUrl(details.url).find(finding => finding.action === 'block');
        const rule = this.siteRuleFor(details.url);
        cancel = Boolean(security) || (rule?.behavior === 'block' && (rule.mode === 'connection' || ['mainFrame', 'subFrame'].includes(details.resourceType)));
      } catch { cancel = true; }
      callback({ cancel });
    });
    // Downloads need a recent click or key press in that window and always ask where to save; they are never listed.
    session.on('will-download', (event, item, contents) => {
      const owner = [...this.windows.values()].find(candidate => candidate.view.webContents === contents);
      if (!owner || Date.now() - owner.lastHumanInput > GESTURE_MS) { event.preventDefault(); item.cancel?.(); return; }
      item.setSaveDialogOptions?.({ title: 'Save download from a private window' });
    });
    const entry = { session, windows: new Set() };
    this.sessions.set(key, entry);
    return entry;
  }

  wire(item) {
    const contents = item.view.webContents;
    const guard = (event, target) => {
      try { safeUrl(target); } catch (error) { event.preventDefault(); item.error = error.message; this.push(item); }
    };
    contents.on('will-navigate', guard);
    contents.on('will-redirect', guard);
    contents.on('will-attach-webview', event => event.preventDefault());
    const input = (event, data) => {
      if (['mouseMove', 'mouseEnter', 'mouseLeave'].includes(data.type)) return;
      if (['mouseDown', 'keyDown', 'rawKeyDown'].includes(data.type)) item.lastHumanInput = Date.now();
      if (!['keyDown', 'rawKeyDown'].includes(data.type)) return;
      const key = String(data.key || '').toLowerCase();
      const command = (data.control || data.meta) && !data.alt;
      if (command && data.shift && key === 'n') { event.preventDefault(); this.open(); }
      else if (command && !data.shift && key === 'l') { event.preventDefault(); item.window.webContents.focus(); item.window.webContents.send('weft-private:focus-address'); }
      else if (command && !data.shift && key === 'w') { event.preventDefault(); item.window.close(); }
    };
    contents.on('before-input-event', input);
    contents.on('before-mouse-event', input);
    // A popup needs a recent gesture in this window; it opens as another private window on the same session (no opener).
    contents.setWindowOpenHandler(({ url: target }) => {
      if (Date.now() - item.lastHumanInput < GESTURE_MS) { try { this.open(safeUrl(target), { sessionKey: item.sessionKey }); } catch { /* refused destination */ } }
      return { action: 'deny' };
    });
    for (const name of ['did-navigate', 'did-navigate-in-page', 'did-start-loading', 'did-stop-loading', 'page-title-updated']) contents.on(name, () => { item.error = null; this.push(item); });
    contents.on('did-fail-load', (_event, code, description, _url, isMainFrame) => { if (isMainFrame && code !== -3) { item.error = description; this.push(item); } });
  }

  state(item) {
    const contents = item.view.webContents;
    if (contents.isDestroyed()) return {};
    return { url: contents.getURL() || 'about:blank', title: String(contents.getTitle() || '').slice(0, 300), loading: contents.isLoading(),
      canGoBack: contents.navigationHistory?.canGoBack() ?? false, canGoForward: contents.navigationHistory?.canGoForward() ?? false, error: item.error };
  }

  push(item) { if (!item.window.isDestroyed()) item.window.webContents.send('weft-private:state', this.state(item)); }

  async navigate(item, value) {
    let target;
    try { target = privateTarget(value); } catch (error) { return { error: error.message }; }
    try { await item.view.webContents.loadURL(target); return { url: target }; }
    catch (error) { item.error = error.message; this.push(item); return { error: 'The page could not be opened' }; }
  }

  control(item, action) {
    const contents = item.view.webContents;
    if (action === 'back' && contents.navigationHistory.canGoBack()) contents.navigationHistory.goBack();
    else if (action === 'forward' && contents.navigationHistory.canGoForward()) contents.navigationHistory.goForward();
    else if (action === 'reload') contents.reload();
    else if (action === 'stop') contents.stop();
    else if (action === 'focus-page') contents.focus();
    else if (action === 'new-window') return this.open();
    else if (action === 'close') item.window.close();
    return this.state(item);
  }

  closed(item) {
    if (!this.windows.delete(item.id)) return;
    try { if (!item.view.webContents.isDestroyed()) item.view.webContents.close(); } catch { /* already gone */ }
    const entry = this.sessions.get(item.sessionKey);
    entry?.windows.delete(item.id);
    // The last window of a private session erases everything the session held in memory.
    if (entry && !entry.windows.size) {
      this.sessions.delete(item.sessionKey);
      void Promise.allSettled([entry.session.clearStorageData(), entry.session.clearCache(), entry.session.clearAuthCache?.(), entry.session.clearHostResolverCache?.()]);
    }
    this.audit({ type: 'display', reason: 'private_window_closed', outcome: 'recorded', summary: { open: this.windows.size } });
  }

  closeAll() { for (const item of [...this.windows.values()]) { try { item.window.destroy(); } catch { /* closing anyway */ } this.closed(item); } }
}
