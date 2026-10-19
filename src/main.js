import { app, BrowserWindow, dialog, ipcMain, net, safeStorage, shell, nativeImage } from 'electron';
import { execFile, spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { Browser, applyEngineHardening } from './browser.js';
import { PrivateWindows } from './private-window.js';
import { commands, CommandError } from './commands.js';
import { createApiServer, EventLog, sanitizeEvent, registerEventType } from './server.js';
import { Transfers } from './transfers.js';
import { Retrieval } from './retrieval.js';
import { WorkspaceService } from './workspace.js';
import { createKeyProtector } from './encryption.js';
import { AutomationAdmission } from './admission.js';
import { ClientGrants } from './clients.js';
import { CommunityLists } from './community-lists.js';
import { Learning } from './learning.js';
import { Standby } from './standby.js';
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
import { PaymentService } from './payments.js';
import { createMemoryPressureSource } from './memory-pressure.js';

// Lock and unlock are published as metadata-only events so connected agents can pause instead of retrying.
registerEventType('encryption');
import { DisplayController, displayEnvironment, profileFingerprint } from './display.js';

let browser;
let privateWindows;
// Site rules without a workspace scope: only rules that apply to every workspace reach private windows.
const PRIVATE_SCOPE = 'weft-private-window';
let workspace;
let providers;
let server;
let window;
let dispatch;
let standby;
let learning;
let lists;
let listTimer;
let freshnessTimer;
let plugins;
let updates;
let credentials;
let retrieval;
let display;
let quitting = false;
const admission = new AutomationAdmission();
const events = new EventEmitter();
const relay = new TurnRelay();
const guiUrl = new URL('./gui.html', import.meta.url).href;
// Disable speculative connections; site rules are enforced on actual Chromium requests.
applyEngineHardening(app);
let quitCleanupDone = false;
// Packaged builds keep the same profile folder as source runs ("weft"), whatever the product name.
if (app.isPackaged && !app.commandLine.hasSwitch('user-data-dir')) app.setPath('userData', join(app.getPath('appData'), 'weft'));
// Headless sessions (#11, ADR 015): the same profile, GUI renderer, policies and commands with the window hidden.
const launchHeadless = process.argv.includes('--headless') || ['1', 'true'].includes(String(process.env.WEFT_HEADLESS || '').toLowerCase());
// One Weft process per profile. Launching again hands the request to the running session (display handoff)
// instead of opening a second, unrelated browser on the same profile.
const primary = app.requestSingleInstanceLock({ weft: 1, show: !launchHeadless });
if (!primary) {
  console.log(launchHeadless ? 'Weft is already running with this profile; nothing else was started.' : 'Weft is already running with this profile; its window was asked to show.');
  app.exit(0);
}

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

if (primary) app.whenReady().then(async () => {
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
  // Workspace encryption (ADR 014) wraps its profile key with Electron safeStorage when the OS key store protects it.
  workspace = new WorkspaceService({ directory, backups: { automatic: true, intervalHours: 24, keep: 5 }, keyProtector: createKeyProtector({ safeStorage }) });
  if (workspace.locked) console.log('Weft workspace data is encrypted and locked; unlock it in the Weft window.');
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
    // Page mode returns citations plus coverage and the verified-absence signal for "not found" answers.
    searchWorkspace: ({ workspaceId, query, limit = 20 }) => modelTool('search.query', { workspaceId, query, passageChars: 3000, page: { limit } }, workspaceId),
  });
  await providers.init();
  // Optional embeddings: inert until a person enables them for a workspace with an existing connection.
  retrieval = new Retrieval({ workspace, providers, audit: entry => activity.append(entry) });
  workspace.attachRetrieval(retrieval);
  const transfers = new Transfers({ workspace });
  // One retained, sanitized event log serves /v1/events replay and events.list for CLI/MCP.
  const eventLog = new EventLog();
  events.on('event', event => eventLog.append(sanitizeEvent(event)));
  window = new BrowserWindow({
    width: 1480, height: 960, minWidth: 1000, minHeight: 640,
    title: 'Weft', backgroundColor: '#F4F1EA', show: !launchHeadless,
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
  // Browser-owned keys pressed inside a page return keyboard focus to the trusted chrome (#31).
  browser.onChromeShortcut = ({ shortcut }) => { if (!window.isDestroyed()) { window.webContents.focus(); window.webContents.send('weft:chrome', shortcut); } };
  // A hidden window renders pages offscreen so captures keep working without a display (ADR 015).
  if (launchHeadless) { browser.hidden = true; browser.offscreen = true; }
  // Page renderer memory (the GUI renderer excluded) drives memory-pressure suspension when a budget is set (#30).
  browser.rendererMemoryMb = () => {
    const gui = window && !window.isDestroyed() ? window.webContents.getOSProcessId() : null;
    return app.getAppMetrics().filter(metric => metric.type === 'Tab' && metric.pid !== gui).reduce((sum, metric) => sum + (metric.memory?.workingSetSize ?? 0), 0) / 1024;
  };
  // The operating system's memory-pressure signal (Linux PSI and available memory, Windows available memory, a macOS free-page heuristic).
  browser.systemMemory = createMemoryPressureSource();
  workspace.attachBrowser(browser);
  // Private windows (#94): in-memory sessions outside every workspace; only global site rules and threat lists apply.
  privateWindows = new PrivateWindows({ browser, audit: entry => activity.append(entry), siteRuleFor: url => workspace.matchSiteRule(url, PRIVATE_SCOPE) });
  // Third-party plugins are discovered from <userData>/plugins and never run until a person enables them.
  plugins = new PluginRegistry({ pluginsDirectory: join(app.getPath('userData'), 'plugins'), stateDirectory: directory });
  const extensions = new WorkspaceExtensions({ directory, workspace, browser });
  // A locked profile restores extensions and tabs after a person unlocks it.
  let extensionsRestored = false;
  if (!workspace.locked) { await extensions.restore(); extensionsRestored = true; }
  const clients = new ClientGrants({ directory, masterToken: token, workspace });
  lists = new CommunityLists({ workspace });
  // Opt-in only: runs source checks solely for subscriptions where a human enabled scheduledCheck; fetched releases wait for human preview.
  listTimer = setInterval(() => { if (!workspace.locked) lists.runScheduledChecks().catch(() => {}); }, 15 * 60_000); listTimer.unref?.();
  const authority = new Authority({ directory, workspace, browser, clients, activity });
  // Credential vault and broker (ADR-017): outside workspace-data, so workspace exports and backups never include it.
  // The broker process starts at launch only when a vault already exists.
  credentials = new CredentialService({ directory: join(app.getPath('userData'), 'credentials'), protector: safeStorageProtector(safeStorage), browser, workspace,
    promptSecret: request => promptCredentialSecret(window, request) });
  credentials.start().catch(error => console.warn(`Weft credential vault: ${error.message}`));
  // Service credentials live only in OS-protected storage; scheduled freshness checks are opt-in per workspace.
  const knowledge = new Knowledge({ workspace, credentials: new ServiceCredentials({ directory, safeStorage }), audit: entry => activity.append(entry), protectedPaths: [app.getPath('userData')] });
  // Scheduled checks read workspace data: they wait while an encrypted profile is locked.
  freshnessTimer = setInterval(() => { if (!admission.status.stopped && !workspace.locked) knowledge.runScheduled().catch(error => console.warn(`Weft freshness: ${error.message}`)); }, 15 * 60_000); freshnessTimer.unref?.();
  const environment = displayEnvironment({ ozone: app.commandLine.getSwitchValue('ozone-platform') });
  if (!environment.supported) console.warn(`Weft display: ${environment.reason}`);
  display = new DisplayController({ window, browser, launchedHeadless: launchHeadless, userData: app.getPath('userData'), environment,
    pendingApprovals: () => authority.pendingApprovals(), locked: () => (workspace.locked ? workspace.encryption?.lockReason ?? 'locked' : null),
    audit: entry => activity.append(entry), onEvent: event => events.emit('event', event) });
  // Payment authorization (ADR 019): records outside workspace-data, sealed with the workspace keys when encryption is on; virtual cards stay off until a person configures them.
  const payments = new PaymentService({ directory: join(app.getPath('userData'), 'payments'), browser, workspace, credentials, protector: safeStorageProtector(safeStorage) });
  dispatch = createDispatcher({ workspace, browser, providers, clients, authority, lists, extensions, plugins, updates, credentials, payments, knowledge, admission, transfers, eventLog, display, onEvent: event => events.emit('event', event) });
  // A headless session of a locked encrypted profile waits for a person: say so where the operator can see it.
  if (workspace.locked && !display.visible) console.log('Weft (headless): the encrypted workspace data is locked. Run "weft attach" or launch Weft again, then unlock it in the window.');
  // Startup sweep before any caller can reach the runtime: interrupted local work pauses, unknown external outcomes become uncertain.
  // A locked encrypted profile sweeps after each unlock instead; nothing is scheduled while locked (ADR 014, ADR 016).
  // A payment click that was in flight becomes uncertain on its payment record; sealed payment records of a locked profile are swept at unlock.
  payments.init();
  standby = new Standby({ workspace, dispatch, admission });
  standby.start();
  learning = new Learning({ workspace, providers, admission }); learning.start();
  const startTasks = async () => { if (workspace.locked) return; standby.start(); learning.start(); await dispatch.tasks.init(); dispatch.tasks.start(); };
  await startTasks();
  workspace.encryptionHooks = {
    // Lock: stop model turns, plugin processes and upload sessions, then close tabs so no workspace page stays loaded.
    beforeLock: async ({ persist = true } = {}) => { standby.close(); learning.close(); await dispatch.tasks.suspendForLock(); providers.stopAll?.('cancelled'); plugins.close?.(); transfers.discardAll(); eventLog.reset('locked'); await browser.suspend({ persist }); events.emit('event', { type: 'encryption', status: 'locked', createdAt: new Date().toISOString() }); },
    afterUnlock: async () => {
      if (!extensionsRestored) { await extensions.restore(); extensionsRestored = true; }
      await browser.resume();
      await startTasks();
      events.emit('event', { type: 'encryption', status: 'unlocked', createdAt: new Date().toISOString() });
      void retrieval.drain().catch(() => {});
    },
  };
  // Launching Weft again attaches a person to this session; a second headless launch changes nothing.
  app.on('second-instance', (_event, argv, _cwd, data) => {
    if (data?.show === false || argv.includes('--headless')) return;
    void display.show({ source: 'relaunch' }).catch(error => console.error('Weft display:', error.message));
  });
  // Closing the window of a session started headless detaches the person; Weft keeps running.
  window.on('close', event => {
    if (!launchHeadless || quitting) return;
    event.preventDefault();
    void display.hide({ source: 'window closed' }).catch(error => console.error('Weft display:', error.message));
  });
  // A human decision needed while no window is visible is announced where the operator can see it.
  let announced = 0;
  events.on('event', event => {
    if (display.visible || event.type !== 'command' || event.status !== 'blocked') return;
    const pending = authority.pendingApprovals();
    if (pending > announced) console.log(`Weft (headless): ${pending} agent request${pending === 1 ? ' needs' : 's need'} a human decision. Run "weft attach" or launch Weft again to show the window.`);
    announced = pending;
  });
  browser.setLayout({ x: 0, y: 0, width: 1, height: 1, visible: false });
  // Streamed model deltas reach only the trusted GUI frame.
  relay.on('frame', frame => { if (window && !window.isDestroyed()) window.webContents.send('weft:turn', frame); });
  ipcMain.handle('weft:commands', event => { trusted(event); return commands; });
  ipcMain.handle('weft:layout', (event, bounds) => { trusted(event); return browser.setLayout(bounds); });
  ipcMain.handle('weft:focusPage', event => { trusted(event); return browser.focusPage(); });
  // A person opens a private window from the trusted GUI (menu or Ctrl/Cmd+Shift+N); no command or agent can.
  ipcMain.handle('weft:openPrivateWindow', event => { trusted(event); return privateWindows.open(); });
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
  browser.startResourceScheduler();
  await window.loadURL(guiUrl);
  server = createApiServer({ execute: (name, args, context) => dispatch(name, args, context), token, authenticate: supplied => clients.authenticate(supplied), executeReturnsOutcome: true, turns: relay, eventLog, subscribe: listener => { events.on('event', listener); return () => events.off('event', listener); } });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', resolve);
  });
  server.on('error', error => { console.error('Weft API error:', error.message); app.quit(); });
  console.log(`Weft API: http://127.0.0.1:${port}`);
  if (!process.env.WEFT_TOKEN) console.log(`Generated WEFT_TOKEN (local access only): ${token}`);
  if (launchHeadless) console.log(`Weft is running headless (profile ${profileFingerprint(app.getPath('userData'))}). Attach with "weft attach" or by launching Weft again.`);
  // Health check for the first launches of a new version: GUI loaded, API listening, store open.
  updates?.confirmHealthy({ gui: !window.isDestroyed() && window.webContents.getURL() === guiUrl, api: server.listening, workspace: workspace.locked || Boolean(workspace.data) });
  updates?.startBackground();
}).catch(error => {
  console.error('Weft startup failed:', error.message);
  try { updates?.reportUnhealthy(`Startup failed: ${error.message}`); } catch { /* keep the original failure visible */ }
  app.exit(1);
});

app.on('window-all-closed', () => app.quit());
// A headless session stopped from a terminal or service manager still exits cleanly (lock, temporary data).
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => app.quit());
app.on('before-quit', event => {
  quitting = true;
  clearInterval(listTimer);
  clearInterval(freshnessTimer);
  updates?.stopBackground();
  server?.close();
  providers?.close();
  credentials?.close();
  retrieval?.close();
  relay.close();
  privateWindows?.closeAll();
  plugins?.close();
  standby?.close();
  learning?.close();
  dispatch?.tasks?.close();
  const cleanup = browser?.close();
  browser = null;
  workspace?.close();
  // Erase temporary site data before exiting; a crash leaves the journal for the next startup.
  if (cleanup && !quitCleanupDone) {
    event.preventDefault();
    Promise.race([cleanup, new Promise(resolve => setTimeout(resolve, 5000))]).finally(() => { quitCleanupDone = true; app.quit(); });
  }
});
