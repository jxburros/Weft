import { app, BrowserWindow, ipcMain, safeStorage } from 'electron';
import { EventEmitter } from 'node:events';
import { randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { Browser } from './browser.js';
import { commands, validateCommand } from './commands.js';
import { createApiServer } from './server.js';
import { WorkspaceService } from './workspace.js';
import { commandDefinitions as workspaceCommands } from './workspace-commands.js';
import { Providers } from './providers.js';

let browser;
let workspace;
let providers;
let server;
let window;
const events = new EventEmitter();
const guiUrl = new URL('./gui.html', import.meta.url).href;
// Disable speculative connections; site rules are enforced on actual Chromium requests.
app.commandLine.appendSwitch('dns-prefetch-disable');
app.commandLine.appendSwitch('disable-features', 'PreconnectToSearch,SpeculationRulesPrefetch,Prerender2');

function trusted(event) {
  if (!window || window.isDestroyed() || event.sender !== window.webContents || event.senderFrame !== window.webContents.mainFrame || event.senderFrame.url !== guiUrl) {
    throw new Error('Unauthorized IPC sender');
  }
}

async function dispatch(name, input, context) {
  let status = 'failure';
  try { const result = await executeCommand(name, input, context); status = 'success'; return result; }
  finally { events.emit('event', { type: 'command', command: Object.hasOwn(commands, name) ? name : 'unknown', actor: context.actor, status, workspaceId: workspace?.activeWorkspaceId, createdAt: new Date().toISOString() }); }
}

async function executeCommand(name, input, context) {
  const args = validateCommand(name, input);
  if (name.startsWith('models.') || name.startsWith('chat.')) {
    if (['models.save', 'models.delete'].includes(name) && context.actor !== 'human') throw new Error('Model configuration requires the trusted browser interface');
    return providers.execute(name, args, context);
  }
  if (Object.hasOwn(workspaceCommands, name)) {
    return workspace.execute(name, args, context);
  }
  const result = await browser.execute(name, args, context);
  if (name === 'browser.emergencyStop') providers.close();
  return result;
}

app.whenReady().then(async () => {
  const port = Number(process.env.WEFT_PORT ?? 9222);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('WEFT_PORT must be between 1 and 65535');
  const token = process.env.WEFT_TOKEN || randomBytes(32).toString('hex');
  const directory = join(app.getPath('userData'), 'workspace-data');
  workspace = new WorkspaceService({ directory });
  providers = new Providers({ directory, workspace, safeStorage,
    readPage: async ({ tabId, workspaceId }) => {
      if (!browser || !Number.isSafeInteger(tabId) || browser.tab(tabId).workspaceId !== workspaceId) throw new Error('The selected tab is outside this conversation workspace');
      return browser.execute('page.readable', { tabId, workspaceId }, { actor: 'model-reader', workspaceId });
    },
    searchWorkspace: ({ workspaceId, query }) => workspace.execute('search.query', { workspaceId, query, limit: 20 }, { actor: 'model-reader', workspaceId }),
  });
  await providers.init();
  window = new BrowserWindow({
    width: 1480, height: 960, minWidth: 1000, minHeight: 640,
    title: 'Weft', backgroundColor: '#F4F1EA',
    icon: fileURLToPath(new URL('../assets/logo/icons/app-icon-plum-512.png', import.meta.url)),
    webPreferences: {
      preload: fileURLToPath(new URL('./preload.cjs', import.meta.url)),
      nodeIntegration: false, contextIsolation: true, sandbox: true,
    },
  });
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  window.webContents.on('will-navigate', event => event.preventDefault());
  window.webContents.on('will-attach-webview', event => event.preventDefault());
  browser = new Browser({ window, workspaceService: workspace });
  workspace.attachBrowser(browser);
  browser.setLayout({ x: 0, y: 0, width: 1, height: 1, visible: false });
  ipcMain.handle('weft:commands', event => { trusted(event); return commands; });
  ipcMain.handle('weft:layout', (event, bounds) => { trusted(event); return browser.setLayout(bounds); });
  ipcMain.handle('weft:execute', (event, name, args) => {
    trusted(event);
    return dispatch(name, args, { actor: 'human', source: 'gui' });
  });
  await browser.restore();
  await window.loadURL(guiUrl);
  server = createApiServer({ execute: (name, args) => dispatch(name, args, { actor: 'automation', source: 'api' }), token, subscribe: listener => { events.on('event', listener); return () => events.off('event', listener); } });
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
  providers?.close();
  browser?.close();
  browser = null;
});
