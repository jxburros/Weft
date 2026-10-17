import { BrowserWindow, ipcMain, nativeTheme } from 'electron';
import { fileURLToPath } from 'node:url';

/**
 * Browser-owned credential entry (ADR-017). A person types a secret into this
 * separate, sandboxed window, never into the main GUI renderer or a command
 * argument. The value goes once over this window's own IPC channel to the main
 * process, which hands it to the credential broker and drops it; the window is
 * destroyed immediately. DevTools are disabled for this window.
 */
const PAGE = new URL('./credential-entry.html', import.meta.url).href;
const PRELOAD = fileURLToPath(new URL('./credential-entry-preload.cjs', import.meta.url));
let current = null;
let installed = false;

function owner(event) {
  if (!current || current.window.isDestroyed() || event.sender !== current.window.webContents || event.senderFrame !== current.window.webContents.mainFrame || event.senderFrame.url !== PAGE) {
    throw new Error('Unauthorized IPC sender');
  }
  return current;
}

export function installCredentialEntry() {
  if (installed) return;
  installed = true;
  ipcMain.handle('weft:credential-entry:info', event => ({ ...owner(event).info, theme: nativeTheme.shouldUseDarkColors ? 'dark' : 'light' }));
  ipcMain.handle('weft:credential-entry:submit', (event, value) => {
    const entry = owner(event);
    if (entry.info.kind === 'payment_card') {
      // Card details (ADR 019): format checks only; the broker validates the number and expiry again before sealing.
      const number = typeof value?.number === 'string' ? value.number.replace(/[\s-]/g, '') : '';
      const expiry = /^(\d{1,2})\s*\/\s*(\d{2}|\d{4})$/.exec(typeof value?.expiry === 'string' ? value.expiry.trim() : '');
      const cvc = typeof value?.cvc === 'string' ? value.cvc.trim() : '';
      const name = typeof value?.name === 'string' ? value.name.slice(0, 100) : '';
      if (!/^\d{12,19}$/.test(number) || !expiry || !/^\d{3,4}$/.test(cvc)) return false;
      entry.finish({ number, expMonth: Number(expiry[1]), expYear: Number(expiry[2]), cvc, name });
      return true;
    }
    const username = typeof value?.username === 'string' ? value.username : '';
    const password = typeof value?.password === 'string' ? value.password : '';
    if (!password || password.length > 4096 || username.length > 512) return false;
    entry.finish({ username, password });
    return true;
  });
  ipcMain.handle('weft:credential-entry:cancel', event => { owner(event).finish(null); return true; });
}

/** Resolves {username, password} (or card details for kind payment_card) or null when the person cancels or closes the window. One entry at a time. */
export function promptCredentialSecret(parent, { label, origins, kind = 'login' }) {
  installCredentialEntry();
  if (current) return Promise.reject(Object.assign(new Error('Another credential entry window is already open'), { code: 'tab_busy' }));
  return new Promise(resolve => {
    const window = new BrowserWindow({ parent: parent && !parent.isDestroyed() ? parent : undefined, modal: Boolean(parent), width: 500, height: 520, resizable: false,
      minimizable: false, maximizable: false, fullscreenable: false, show: false, title: kind === 'payment_card' ? 'Weft — save a payment card' : 'Weft — save a sign-in', backgroundColor: nativeTheme.shouldUseDarkColors ? '#252329' : '#F4F1EA',
      webPreferences: { preload: PRELOAD, sandbox: true, contextIsolation: true, nodeIntegration: false, spellcheck: false, devTools: false } });
    window.setMenu?.(null);
    window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    window.webContents.on('will-navigate', event => event.preventDefault());
    window.webContents.on('will-attach-webview', event => event.preventDefault());
    const finish = value => {
      if (current?.window !== window) return;
      current = null;
      resolve(value);
      if (!window.isDestroyed()) window.destroy();
    };
    current = { window, finish, info: { kind: kind === 'payment_card' ? 'payment_card' : 'login', label: String(label).slice(0, 120), origins: (origins ?? []).map(String).slice(0, 10) } };
    window.once('closed', () => finish(null));
    window.once('ready-to-show', () => window.show());
    window.loadURL(PAGE).catch(() => finish(null));
  });
}
