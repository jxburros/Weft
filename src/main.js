import { app, BrowserWindow, ipcMain } from 'electron';
import { randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { Browser } from './browser.js';
import { commands, validateCommand } from './commands.js';
import { createApiServer } from './server.js';

let browser;
let server;
let window;
const guiUrl = new URL('./gui.html', import.meta.url).href;

function trusted(event) {
  if (event.sender !== window?.webContents || event.senderFrame !== window.webContents.mainFrame || event.senderFrame.url !== guiUrl) {
    throw new Error('Unauthorized IPC sender');
  }
}

app.whenReady().then(async () => {
  const port = Number(process.env.WEFT_PORT ?? 9222);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('WEFT_PORT must be between 1 and 65535');
  const token = process.env.WEFT_TOKEN || randomBytes(32).toString('hex');
  window = new BrowserWindow({
    width: 1380, height: 920, minWidth: 900, minHeight: 560,
    title: 'Weft', backgroundColor: '#101827',
    webPreferences: {
      preload: fileURLToPath(new URL('./preload.cjs', import.meta.url)),
      nodeIntegration: false, contextIsolation: true, sandbox: true,
    },
  });
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  window.webContents.on('will-navigate', event => event.preventDefault());
  window.webContents.on('will-attach-webview', event => event.preventDefault());
  browser = new Browser({ window });
  ipcMain.handle('weft:commands', event => { trusted(event); return commands; });
  ipcMain.handle('weft:execute', (event, name, args) => {
    trusted(event);
    return browser.execute(name, validateCommand(name, args));
  });
  await window.loadURL(guiUrl);
  await browser.execute('tabs.new', {});
  server = createApiServer({ execute: (name, args) => browser.execute(name, args), token });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', resolve);
  });
  server.on('error', error => { console.error('Weft API error:', error.message); app.quit(); });
  console.log(`Weft API: http://127.0.0.1:${port}`);
  if (!process.env.WEFT_TOKEN) console.log(`Generated WEFT_TOKEN (local access only): ${token}`);
}).catch(error => {
  console.error('Weft startup failed:', error.message);
  app.exit(1);
});

app.on('window-all-closed', () => app.quit());
app.on('before-quit', () => {
  server?.close();
  browser?.close();
  browser = null;
});
