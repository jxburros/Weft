import { app, BrowserWindow, ipcMain, net, safeStorage, shell } from 'electron';
import { execFile, spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { Browser } from './browser.js';
import { commands } from './commands.js';
import { createApiServer } from './server.js';
import { WorkspaceService } from './workspace.js';
import { AutomationAdmission } from './admission.js';
import { ClientGrants } from './clients.js';
import { CommunityLists } from './community-lists.js';
import { createDispatcher } from './dispatch.js';
import { Providers } from './providers.js';
import { UpdateService, createElectronTransport, createWindowsSignatureVerifier, detectInstall } from './updater.js';
import { WEFT_VERSION } from './version.js';

let browser;
let workspace;
let providers;
let server;
let window;
let dispatch;
let updates;
const admission = new AutomationAdmission();
const events = new EventEmitter();
const guiUrl = new URL('./gui.html', import.meta.url).href;
// Disable speculative connections; site rules are enforced on actual Chromium requests.
app.commandLine.appendSwitch('dns-prefetch-disable');
app.commandLine.appendSwitch('disable-features', 'PreconnectToSearch,SpeculationRulesPrefetch,Prerender2');
// Packaged builds keep the same profile folder as source runs ("weft"), whatever the product name.
if (app.isPackaged && !app.commandLine.hasSwitch('user-data-dir')) app.setPath('userData', join(app.getPath('appData'), 'weft'));

function createUpdates() {
  const install = detectInstall({ isPackaged: app.isPackaged, platform: process.platform, arch: process.arch, env: process.env, resourcesPath: process.resourcesPath });
  return new UpdateService({
    directory: join(app.getPath('userData'), 'updates'), currentVersion: WEFT_VERSION, install,
    // Source runs and tests never receive a transport, so they cannot generate update traffic.
    transport: install.supported ? createElectronTransport(net) : null,
    verifySignature: process.platform === 'win32' ? createWindowsSignatureVerifier(execFile) : null,
    launcher: {
      execPath: process.execPath,
      spawnDetached: (path, args) => new Promise((resolve, reject) => {
        const child = spawn(path, args, { detached: true, stdio: 'ignore' });
        child.once('error', reject);
        child.once('spawn', () => { child.unref(); resolve(); });
      }),
      openPath: path => shell.openPath(path),
      relaunch: execPath => { app.relaunch({ execPath }); app.exit(0); },
      quit: () => setTimeout(() => app.quit(), 500),
    },
  });
}

function trusted(event) {
  if (!window || window.isDestroyed() || event.sender !== window.webContents || event.senderFrame !== window.webContents.mainFrame || event.senderFrame.url !== guiUrl) {
    throw new Error('Unauthorized IPC sender');
  }
}

app.whenReady().then(async () => {
  const port = Number(process.env.WEFT_PORT ?? 9222);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('WEFT_PORT must be between 1 and 65535');
  const token = process.env.WEFT_TOKEN || randomBytes(32).toString('hex');
  let launch = {};
  // Update bookkeeping must never block local use; failures leave updates unavailable.
  try { updates = createUpdates(); launch = updates.beginLaunch(); }
  catch (error) { updates = null; console.error('Weft updates unavailable:', error.message); }
  if (launch.automaticRollback) {
    // This version failed its health check repeatedly; restore the retained AppImage.
    try { await updates.rollback({ automatic: true }); return; }
    catch (error) { console.error('Weft automatic rollback failed:', error.message); }
  }
  const directory = join(app.getPath('userData'), 'workspace-data');
  workspace = new WorkspaceService({ directory });
  providers = new Providers({ directory, workspace, safeStorage, admission,
    readPage: async ({ tabId, workspaceId }) => {
      if (!browser || !Number.isSafeInteger(tabId) || browser.tab(tabId).workspaceId !== workspaceId) throw new Error('The selected tab is outside this conversation workspace');
      return browser.execute('page.readable', { tabId, workspaceId }, { actor: 'model-reader', workspaceId });
    },
    searchWorkspace: ({ workspaceId, query }) => {
      admission.assertAutomationAdmitted('model-reader', 'search.query');
      return workspace.execute('search.query', { workspaceId, query, limit: 20 }, { actor: 'model-reader', workspaceId, assertAuthorized: () => admission.assertAutomationAdmitted('model-reader', 'search.query') });
    },
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
  browser = new Browser({ window, workspaceService: workspace, admission });
  workspace.attachBrowser(browser);
  const clients = new ClientGrants({ directory, masterToken: token, workspace });
  dispatch = createDispatcher({ workspace, browser, providers, clients, lists: new CommunityLists({ workspace }), updates, admission, onEvent: event => events.emit('event', event) });
  browser.setLayout({ x: 0, y: 0, width: 1, height: 1, visible: false });
  ipcMain.handle('weft:commands', event => { trusted(event); return commands; });
  ipcMain.handle('weft:layout', (event, bounds) => { trusted(event); return browser.setLayout(bounds); });
  ipcMain.handle('weft:execute', (event, name, args) => {
    trusted(event);
    return dispatch(name, args, { actor: 'human', source: 'gui' });
  });
  await browser.restore();
  await window.loadURL(guiUrl);
  server = createApiServer({ execute: (name, args, context) => dispatch(name, args, context), token, authenticate: supplied => clients.authenticate(supplied), executeReturnsOutcome: true, subscribe: listener => { events.on('event', listener); return () => events.off('event', listener); } });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', resolve);
  });
  server.on('error', error => { console.error('Weft API error:', error.message); app.quit(); });
  console.log(`Weft API: http://127.0.0.1:${port}`);
  if (!process.env.WEFT_TOKEN) console.log(`Generated WEFT_TOKEN (local access only): ${token}`);
  // Health check for the first launches of a new version: GUI loaded, API listening, store open.
  updates?.confirmHealthy({ gui: !window.isDestroyed() && window.webContents.getURL() === guiUrl, api: server.listening, workspace: Boolean(workspace.data) });
  updates?.startBackground();
}).catch(error => {
  console.error('Weft startup failed:', error.message);
  try { updates?.reportUnhealthy(`Startup failed: ${error.message}`); } catch { /* keep the original failure visible */ }
  app.exit(1);
});

app.on('window-all-closed', () => app.quit());
app.on('before-quit', () => {
  updates?.stopBackground();
  server?.close();
  providers?.close();
  browser?.close();
  browser = null;
  workspace?.close();
});
