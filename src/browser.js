import electron from 'electron';
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

export class Browser {
  constructor({ window, session, electronApi = electron } = {}) {
    this.electron = electronApi;
    this.window = window;
    this.session = session ?? electronApi.session.fromPartition('persist:weft');
    this.tabs = new Map();
    this.downloads = new Map();
    this.nextTabId = 1;
    this.nextDownloadId = 1;
    this.activeId = null;
    this.session.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
    this.session.setPermissionCheckHandler(() => false);
    this.onDownload = (_event, item) => this.trackDownload(item);
    this.session.on('will-download', this.onDownload);
    this.onResize = () => this.layout();
    window?.on('resize', this.onResize);
  }

  layout() {
    const tab = this.tabs.get(this.activeId);
    if (!tab || !this.window || this.window.isDestroyed()) return;
    const [width, height] = this.window.getContentSize();
    tab.view.setBounds({ x: 0, y: 112, width: Math.max(1, width - 360), height: Math.max(1, height - 112) });
  }

  tab(tabId = this.activeId) {
    const tab = this.tabs.get(tabId);
    if (!tab) throw new Error('Tab not found');
    return tab;
  }

  describe(tab) {
    const contents = tab.view.webContents;
    return { id: tab.id, url: contents.getURL(), title: contents.getTitle(), active: tab.id === this.activeId };
  }

  activate(tabId) {
    const tab = this.tab(tabId);
    const previous = this.tabs.get(this.activeId);
    if (previous && this.window && !this.window.isDestroyed()) this.window.contentView.removeChildView(previous.view);
    this.activeId = tabId;
    if (this.window && !this.window.isDestroyed()) this.window.contentView.addChildView(tab.view);
    this.layout();
    return this.describe(tab);
  }

  async newTab(url = 'about:blank') {
    url = safeUrl(url);
    const view = new this.electron.WebContentsView({
      webPreferences: {
        session: this.session, nodeIntegration: false, contextIsolation: true,
        sandbox: true, webSecurity: true, allowRunningInsecureContent: false,
      },
    });
    const tab = { id: this.nextTabId++, view };
    this.tabs.set(tab.id, tab);
    const contents = view.webContents;
    const guard = (event, target) => {
      try { safeUrl(target); } catch { event.preventDefault(); }
    };
    contents.on('will-navigate', guard);
    contents.on('will-redirect', guard);
    contents.on('will-attach-webview', event => event.preventDefault());
    contents.setWindowOpenHandler(({ url: target }) => {
      try {
        safeUrl(target);
        void this.newTab(target).catch(error => console.error('Popup navigation failed:', error.message));
      } catch { /* Unsupported popup schemes are blocked. */ }
      return { action: 'deny' };
    });
    this.activate(tab.id);
    try {
      await contents.loadURL(url);
    } catch (error) {
      // A tab remains usable after a failed network navigation.
      throw new Error(`Navigation failed: ${error.message}`);
    }
    return this.describe(tab);
  }

  closeTab(tabId) {
    const tab = this.tab(tabId);
    if (this.activeId === tabId) {
      if (this.window && !this.window.isDestroyed()) this.window.contentView.removeChildView(tab.view);
      this.activeId = null;
    }
    this.tabs.delete(tabId);
    const contents = tab.view.webContents;
    if (contents && !contents.isDestroyed()) contents.close({ waitForBeforeUnload: false });
    if (!this.closing && this.activeId === null && this.tabs.size) this.activate(this.tabs.keys().next().value);
    return { closed: tabId };
  }

  trackDownload(item) {
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
    const record = { id, url: item.getURL(), filename, state: 'progressing', receivedBytes: 0, totalBytes: item.getTotalBytes() };
    this.downloads.set(id, { item, record });
    item.on('updated', (_event, state) => {
      Object.assign(record, { state, receivedBytes: item.getReceivedBytes(), totalBytes: item.getTotalBytes() });
    });
    item.once('done', (_event, state) => {
      Object.assign(record, { state, receivedBytes: item.getReceivedBytes(), totalBytes: item.getTotalBytes() });
      this.downloads.get(id).item = null;
    });
  }

  async execute(name, args = {}) {
    switch (name) {
      case 'browser.info':
        return { name: 'Weft', electron: process.versions.electron, chromium: process.versions.chrome, node: process.versions.node };
      case 'tabs.list': return [...this.tabs.values()].map(tab => this.describe(tab));
      case 'tabs.new': return this.newTab(args.url);
      case 'tabs.activate': return this.activate(args.tabId);
      case 'tabs.close': return this.closeTab(args.tabId);
      case 'cookies.list':
        return this.session.cookies.get(args.url ? { url: safeUrl(args.url) } : {});
      case 'cookies.set':
        await this.session.cookies.set({ ...args, url: safeUrl(args.url) });
        return { success: true };
      case 'cookies.clear':
        await this.session.clearStorageData({ storages: ['cookies'] });
        return { success: true };
      case 'downloads.list': return [...this.downloads.values()].map(({ record }) => ({ ...record }));
      case 'downloads.cancel': {
        const download = this.downloads.get(args.downloadId);
        if (!download) throw new Error('Download not found');
        if (download.item) download.item.cancel();
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
      case 'page.navigate':
        await contents.loadURL(safeUrl(args.url));
        return this.describe(tab);
      case 'page.back':
        if (contents.navigationHistory.canGoBack()) contents.navigationHistory.goBack();
        return this.describe(tab);
      case 'page.forward':
        if (contents.navigationHistory.canGoForward()) contents.navigationHistory.goForward();
        return this.describe(tab);
      case 'page.reload': contents.reload(); return { success: true };
      case 'page.stop': contents.stop(); return { success: true };
      case 'page.title': return contents.getTitle();
      case 'page.content': return contents.executeJavaScript('document.documentElement.outerHTML');
      case 'page.evaluate': {
        const result = await contents.executeJavaScript(args.expression, true);
        return result === undefined ? null : JSON.parse(JSON.stringify(result));
      }
      case 'page.click':
        return contents.executeJavaScript(`(() => {
          const element = document.querySelector(${JSON.stringify(args.selector)});
          if (!element) throw new Error('Element not found');
          element.click();
          return {success: true};
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
          return {success: true};
        })()`, true);
      case 'page.screenshot': {
        if (contents.debugger.isAttached()) throw new Error('Debugger is already attached');
        contents.debugger.attach('1.3');
        try {
          const options = { format: 'png', captureBeyondViewport: false };
          if (args.fullPage) {
            const { cssContentSize } = await contents.debugger.sendCommand('Page.getLayoutMetrics');
            options.captureBeyondViewport = true;
            options.clip = { x: 0, y: 0, width: cssContentSize.width, height: cssContentSize.height, scale: 1 };
          }
          const { data } = await contents.debugger.sendCommand('Page.captureScreenshot', options);
          return { data, mimeType: 'image/png' };
        } finally { contents.debugger.detach(); }
      }
      case 'page.pdf':
        return { data: (await contents.printToPDF({})).toString('base64'), mimeType: 'application/pdf' };
      default: throw new Error(`Unknown command: ${name}`);
    }
  }

  close() {
    this.closing = true;
    this.window?.removeListener('resize', this.onResize);
    for (const id of [...this.tabs.keys()]) this.closeTab(id);
    for (const { item } of this.downloads.values()) item?.cancel();
    this.session.removeListener('will-download', this.onDownload);
  }
}
