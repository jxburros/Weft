import { app, BrowserWindow, dialog, ipcMain, net, safeStorage, shell, nativeImage } from 'electron';
import { execFile, spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { Browser, applyEngineHardening } from './browser.js';
import { commands, CommandError } from './commands.js';
import { createApiServer } from './server.js';
import { WorkspaceService } from './workspace.js';
import { AutomationAdmission } from './admission.js';
import { ClientGrants } from './clients.js';
import { CommunityLists } from './community-lists.js';
import { createDispatcher } from './dispatch.js';
import { Authority } from './authority.js';
import { ActivityLog } from './activity-log.js';
import { Providers } from './providers.js';
import { TurnRelay } from './turn-relay.js';
import { WorkspaceExtensions } from './extensions.js';
import { PluginRegistry } from './plugins/registry.js';
import { Knowledge } from './knowledge.js';
import { ServiceCredentials } from './linked-sources.js';
import { UpdateService, createElectronTransport, createWindowsSignatureVerifier, detectInstall } from './updater.js';
import { WEFT_VERSION } from './version.js';
import { CredentialService, safeStorageProtector } from './credentials.js';
import { promptCredentialSecret } from './credential-entry.js';

let browser;
let workspace;
let providers;
let server;
let window;
let dispatch;
let lists;
let listTimer;
let freshnessTimer;
let plugins;
let updates;
let credentials;
const admission = new AutomationAdmission();
const events = new EventEmitter();
const relay = new TurnRelay();
const guiUrl = new URL('./gui.html', import.meta.url).href;
// Disable speculative connections; site rules are enforced on actual Chromium requests.
applyEngineHardening(app);
let quitCleanupDone = false;
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
  // Verified automatic backups at startup and then daily, keeping the latest five.
  workspace = new WorkspaceService({ directory, backups: { automatic: true, intervalHours: 24, keep: 5 } });
  const activity = new ActivityLog({ directory, onPrune: options => { workspace.pruneActivity(options).catch(error => console.warn(`Weft activity retention: ${error.message}`)); } });
  // Update checks, downloads, installs and rollbacks are attributable activity (hosts, versions and outcomes only).
  if (updates) updates.audit = entry => activity.append(entry);
  // Internal model tools use the same dispatcher and gate as every other caller, as an observe-level identity scoped to one workspace.
  const modelTool = async (name, args, workspaceId) => {
    if (!dispatch) throw new Error('Model tools are not available yet');
    const outcome = await dispatch(name, args, { actor: 'model-reader', source: 'model', workspaceIds: [workspaceId] });
    if (outcome.error) throw new CommandError(outcome.error);
    return outcome.result;
  };
  providers = new Providers({ directory, workspace, safeStorage, admission, relay, audit: entry => activity.append(entry),
    onEvent: event => events.emit('event', event),
    // Downscale oversized PNGs locally before any image is sent to a model.
    resizeImage: (bytes, { maxEdge }) => {
      const image = nativeImage.createFromBuffer(bytes);
      const { width, height } = image.getSize();
      if (!width || !height) throw new Error('Unreadable image');
      const scale = Math.min(1, maxEdge / Math.max(width, height));
      return image.resize({ width: Math.max(1, Math.floor(width * scale)), height: Math.max(1, Math.floor(height * scale)), quality: 'good' }).toPNG();
    },
    readPage: ({ tabId, workspaceId }) => modelTool('page.readable', { tabId, workspaceId }, workspaceId),
    searchWorkspace: ({ workspaceId, query }) => modelTool('search.query', { workspaceId, query, limit: 20 }, workspaceId),
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
  browser.onAudit = entry => activity.append(entry);
  browser.onEvent = event => events.emit('event', event);
  workspace.attachBrowser(browser);
  // Third-party plugins are discovered from <userData>/plugins and never run until a person enables them.
  plugins = new PluginRegistry({ pluginsDirectory: join(app.getPath('userData'), 'plugins'), stateDirectory: directory });
  const extensions = new WorkspaceExtensions({ directory, workspace, browser });
  await extensions.restore();
  const clients = new ClientGrants({ directory, masterToken: token, workspace });
  lists = new CommunityLists({ workspace });
  // Opt-in only: runs source checks solely for subscriptions where a human enabled scheduledCheck; fetched releases wait for human preview.
  listTimer = setInterval(() => lists.runScheduledChecks().catch(() => {}), 15 * 60_000); listTimer.unref?.();
  const authority = new Authority({ directory, workspace, browser, clients, activity });
  // Credential vault and broker (ADR-017): outside workspace-data, so workspace exports and backups never include it.
  // The broker process starts at launch only when a vault already exists.
  credentials = new CredentialService({ directory: join(app.getPath('userData'), 'credentials'), protector: safeStorageProtector(safeStorage), browser, workspace,
    promptSecret: request => promptCredentialSecret(window, request) });
  credentials.start().catch(error => console.warn(`Weft credential vault: ${error.message}`));
  // Service credentials live only in OS-protected storage; scheduled freshness checks are opt-in per workspace.
  const knowledge = new Knowledge({ workspace, credentials: new ServiceCredentials({ directory, safeStorage }), audit: entry => activity.append(entry), protectedPaths: [app.getPath('userData')] });
  freshnessTimer = setInterval(() => { if (!admission.status.stopped) knowledge.runScheduled().catch(error => console.warn(`Weft freshness: ${error.message}`)); }, 15 * 60_000); freshnessTimer.unref?.();
  dispatch = createDispatcher({ workspace, browser, providers, clients, authority, lists, extensions, plugins, updates, credentials, knowledge, admission, onEvent: event => events.emit('event', event) });
  browser.setLayout({ x: 0, y: 0, width: 1, height: 1, visible: false });
  // Streamed model deltas reach only the trusted GUI frame.
  relay.on('frame', frame => { if (window && !window.isDestroyed()) window.webContents.send('weft:turn', frame); });
  ipcMain.handle('weft:commands', event => { trusted(event); return commands; });
  ipcMain.handle('weft:layout', (event, bounds) => { trusted(event); return browser.setLayout(bounds); });
  // A person picks a file or folder to link in a native dialog; only the chosen path returns to the trusted GUI.
  ipcMain.handle('weft:pickPath', async (event, kind) => {
    trusted(event);
    const result = await dialog.showOpenDialog(window, { title: kind === 'folder' ? 'Link a folder' : 'Link a file', properties: [kind === 'folder' ? 'openDirectory' : 'openFile', 'dontAddToRecent'] });
    return result.canceled ? null : result.filePaths[0] ?? null;
  });
  ipcMain.handle('weft:execute', (event, name, args) => {
    trusted(event);
    return dispatch(name, args, { actor: 'human', source: 'gui' });
  });
  await browser.restore();
  await window.loadURL(guiUrl);
  server = createApiServer({ execute: (name, args, context) => dispatch(name, args, context), token, authenticate: supplied => clients.authenticate(supplied), executeReturnsOutcome: true, turns: relay, subscribe: listener => { events.on('event', listener); return () => events.off('event', listener); } });
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
app.on('before-quit', event => {
  clearInterval(listTimer);
  clearInterval(freshnessTimer);
  updates?.stopBackground();
  server?.close();
  providers?.close();
  credentials?.close();
  relay.close();
  plugins?.close();
  const cleanup = browser?.close();
  browser = null;
  workspace?.close();
  // Erase temporary site data before exiting; a crash leaves the journal for the next startup.
  if (cleanup && !quitCleanupDone) {
    event.preventDefault();
    Promise.race([cleanup, new Promise(resolve => setTimeout(resolve, 5000))]).finally(() => { quitCleanupDone = true; app.quit(); });
  }
});
