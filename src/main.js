import { app, BrowserWindow, dialog, ipcMain, net, powerMonitor, safeStorage, screen, shell, nativeImage } from 'electron';
import { execFile, spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { Browser, applyEngineHardening } from './browser.js';
import { PrivateWindows } from './private-window.js';
import { PasswordService } from './passwords.js';
import { commands, CommandError } from './commands.js';
import { createApiServer, EventLog, sanitizeEvent, registerEventType } from './server.js';
import { Transfers } from './transfers.js';
import { Retrieval } from './retrieval.js';
import { WorkspaceService } from './workspace.js';
import { createKeyProtector } from './encryption.js';
import { IdleAutoLock } from './auto-lock.js';
import { AutomationAdmission } from './admission.js';
import { ClientGrants, bootstrapToken } from './clients.js';
import { cleanImportScratch } from './browsing-import.js';
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
import { WindowManager } from './windows.js';
import { ExternalOpener, externalItemsFromArgv } from './external-open.js';

// Lock and unlock are published as metadata-only events so connected agents can pause instead of retrying.
registerEventType('encryption');
import { DisplayController, displayEnvironment, profileFingerprint } from './display.js';

let browser;
let privateWindows;
let passwords;
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
let windows;
let external;
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

// Links and files other applications ask Weft to open (#99). They wait until the window is ready (and the
// profile unlocked); a second launch hands its links to this session. Every one is untrusted data.
const earlyExternal = primary ? externalItemsFromArgv(process.argv.slice(app.isPackaged ? 1 : 2)) : [];
const receiveExternal = (items, source) => { if (external) external.receive(items, source); else earlyExternal.push(...items); };
app.on('open-url', (event, url) => { event.preventDefault(); receiveExternal([{ kind: 'url', url }], 'open-url'); });
app.on('open-file', (event, path) => { event.preventDefault(); receiveExternal([{ kind: 'file', path }], 'open-file'); });

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

/** Only the trusted GUI document of one of Weft's own windows may call the app; returns that window's id (#100). */
function trusted(event) {
  const id = windows ? windows.windowIdFor(event.sender) : window && !window.isDestroyed() && event.sender === window.webContents ? 1 : null;
  if (!id || event.senderFrame !== event.sender.mainFrame || event.senderFrame.url !== guiUrl) throw new Error('Unauthorized IPC sender');
  return id;
}

/** A trusted GUI window: the same preload, isolation and navigation lockdown for the main and every second window. */
function createGuiWindow({ show = true, ...bounds } = {}) {
  const created = new BrowserWindow({
    width: 1480, height: 960, ...bounds, minWidth: 1000, minHeight: 640,
    title: 'Weft', backgroundColor: '#F4F1EA', show,
    icon: fileURLToPath(new URL('../assets/logo/icons/app-icon-plum-512.png', import.meta.url)),
    webPreferences: {
      preload: fileURLToPath(new URL('./preload.cjs', import.meta.url)),
      nodeIntegration: false, contextIsolation: true, sandbox: true,
    },
  });
  created.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  created.webContents.on('will-navigate', event => event.preventDefault());
  created.webContents.on('will-attach-webview', event => event.preventDefault());
  return created;
}
/** Commands from a second window default to the workspace and tab that window shows. */
function windowDefaults(windowId, name, args) {
  if (windowId === 1 || !args || typeof args !== 'object' || Array.isArray(args) || !browser.windows.has(windowId)) return args;
  const state = browser.windowState(windowId);
  const fields = commands[name]?.inputSchema?.properties ?? {};
  const result = { ...args };
  if (Object.hasOwn(fields, 'workspaceId') && result.workspaceId == null && name !== 'workspace.snapshot') result.workspaceId = browser.shownWorkspace(state);
  if (Object.hasOwn(fields, 'tabId') && result.tabId == null && state.activeId != null && (name.startsWith('page.') || name.startsWith('tabs.') || name === 'artifacts.capture')) result.tabId = state.activeId;
  return result;
}
const guiWindows = () => (windows ? windows.all() : window && !window.isDestroyed() ? [window] : []);

if (primary) app.whenReady().then(async () => {
  const port = Number(process.env.WEFT_PORT ?? 9222);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('WEFT_PORT must be between 1 and 65535');
  // A weak WEFT_TOKEN is refused: it grants full automation (ADR 005); client tokens use a separate per-profile key.
  const { token, generated, file: tokenFile } = bootstrapToken(process.env);
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
  // An import interrupted by a crash may have left a copied history database behind; remove it before anything else runs.
  cleanImportScratch(directory);
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
  // The main window reopens where it was; a display that is gone falls back to the primary one (#100).
  const windowStatePath = join(app.getPath('userData'), 'window-state.json');
  const savedMain = launchHeadless ? null : new WindowManager({ browser: null, workspace, mainWindow: null, createWindow: null, screen, statePath: windowStatePath }).mainBounds();
  window = createGuiWindow({ show: !launchHeadless, ...(savedMain && { x: savedMain.x, y: savedMain.y, width: savedMain.width, height: savedMain.height }) });
  if (savedMain?.maximized) window.maximize();
  browser = new Browser({ window, workspaceService: workspace, admission });
  windows = new WindowManager({ browser, workspace, mainWindow: window, screen, statePath: windowStatePath, headless: () => launchHeadless && !display?.visible,
    createWindow: bounds => { const created = createGuiWindow(bounds); void created.loadURL(guiUrl); return created; },
    audit: entry => activity.append(entry),
    onChange: () => { for (const target of guiWindows()) target.webContents.send('weft:windows', { changed: true }); } });
  browser.onWindowEmptied = id => windows.windowFor(id)?.close();
  browser.onAudit = entry => activity.append(entry);
  browser.onEvent = event => events.emit('event', event);
  // Browser-owned keys pressed inside a page return keyboard focus to the trusted chrome (#31).
  // A permission prompt or password offer appeared: the trusted GUI refreshes at once.
  browser.onSitePrompt = () => { if (!window.isDestroyed()) window.webContents.send('weft:site-prompt'); };
  // Short browser-owned notices (a context-menu link a site rule refused, for example).
  browser.onNotice = message => { if (!window.isDestroyed()) window.webContents.send('weft:notice', String(message).slice(0, 500)); };
  // The keys go to the window that shows the page's workspace (#100).
  browser.onChromeShortcut = ({ shortcut, tabId }) => {
    const tab = tabId != null ? browser.tabs.get(tabId) : null;
    const target = (tab && windows.windowFor(browser.ownerOf(tab.workspaceId).id)) || window;
    if (target && !target.isDestroyed()) { target.webContents.focus(); target.webContents.send('weft:chrome', shortcut); }
  };
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
  // The person's own saved passwords (#95, ADR-020): a separate OS-protected vault outside workspace-data, human-only.
  passwords = new PasswordService({ directory: join(app.getPath('userData'), 'passwords'), protector: safeStorageProtector(safeStorage), browser, workspace,
    audit: entry => activity.append(entry),
    confirmReveal: async ({ origin, username }) => (await dialog.showMessageBox(window, { type: 'warning', buttons: ['Cancel', 'Show password'], defaultId: 0, cancelId: 0, noLink: true,
      title: 'Show saved password', message: `Show the saved password for ${username || 'this account'} on ${origin}?`, detail: 'Anyone who can see your screen will see it.' })).response === 1 });
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
  dispatch = createDispatcher({ workspace, browser, providers, clients, authority, lists, extensions, plugins, updates, credentials, payments, knowledge, admission, transfers, eventLog, display, windows, onEvent: event => events.emit('event', event) });
  // Links from other applications open as data in the configured workspace, never as agent instructions (#99).
  external = new ExternalOpener({
    locked: () => workspace.locked,
    destination: () => (workspace.locked ? 'everything' : workspace.data.settings.externalLinks?.destination ?? 'everything'),
    lastUsed: () => workspace.activeWorkspaceId,
    workspaceOpen: id => !workspace.locked && workspace.data.workspaces.some(item => item.id === id && !item.archived),
    openUrl: async (url, workspaceId) => {
      if (display.visible) await windows.show(workspaceId);
      return browser.newTab(url, workspaceId);
    },
    importFile: (file, workspaceId) => workspace.execute('materials.create', { workspaceId, title: file.filename, kind: 'file', filename: file.filename, mimeType: file.mimeType,
      fileBase64: file.bytes.toString('base64') }, { actor: 'human', source: 'external-app' }),
    audit: entry => activity.append(entry),
    notify: event => { if (window && !window.isDestroyed()) window.webContents.send('weft:external', event); },
  });
  external.receive(earlyExternal.splice(0), 'launch');
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
    beforeLock: async ({ persist = true } = {}) => { windows.closeAll(); standby.close(); learning.close(); await dispatch.tasks.suspendForLock(); providers.stopAll?.('cancelled'); plugins.close?.(); transfers.discardAll(); eventLog.reset('locked'); await browser.suspend({ persist }); events.emit('event', { type: 'encryption', status: 'locked', createdAt: new Date().toISOString() }); },
    afterUnlock: async () => {
      if (!extensionsRestored) { await extensions.restore(); extensionsRestored = true; }
      await browser.resume();
      await windows.restore().catch(error => console.warn(`Weft windows: ${error.message}`));
      await startTasks();
      events.emit('event', { type: 'encryption', status: 'unlocked', createdAt: new Date().toISOString() });
      void retrieval.drain().catch(() => {});
      void external.flush();
    },
  };
  // Idle auto-lock (off unless a person set it in encryption.configure): OS idle time, never agent activity, keeps it unlocked.
  const autoLock = new IdleAutoLock({ settings: workspace.autoLock, idleSeconds: () => powerMonitor.getSystemIdleTime(), isUnlocked: () => workspace.encryption.enabled && !workspace.locked,
    lock: reason => workspace.lockProfile({ reason }) });
  autoLock.start();
  for (const signal of ['lock-screen', 'suspend']) powerMonitor.on(signal, () => { void autoLock.screenLocked().catch(error => console.error('Weft auto-lock:', error.message)); });
  // Launching Weft again attaches a person to this session; a second headless launch changes nothing.
  app.on('second-instance', (_event, argv, cwd, data) => {
    // Links and files on the second launch's command line open here as data (#99).
    const items = externalItemsFromArgv(argv.slice(1), { cwd });
    if (items.length) external.receive(items, 'second-instance');
    if (data?.show === false || argv.includes('--headless')) return;
    void display.show({ source: 'relaunch' }).catch(error => console.error('Weft display:', error.message));
  });
  // Closing the window of a session started headless detaches the person; Weft keeps running.
  window.on('close', event => {
    // Closing the main window quits Weft (#100): second windows close with it and reopen at the next launch.
    if (!launchHeadless || quitting) { windows.closeAll(); return; }
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
  relay.on('frame', frame => { for (const target of guiWindows()) target.webContents.send('weft:turn', frame); });
  ipcMain.handle('weft:commands', event => { trusted(event); return commands; });
  ipcMain.handle('weft:layout', (event, bounds) => browser.setLayout(bounds, trusted(event)));
  ipcMain.handle('weft:focusPage', event => browser.focusPage(trusted(event)));
  // Window arrangement (#100): what this window shows, and human-only moves between windows.
  ipcMain.handle('weft:window', event => windows.info(trusted(event)));
  ipcMain.handle('weft:windows', async (event, request) => {
    const id = trusted(event);
    const { action, workspaceId = null, windowId = null, x = null, y = null } = request && typeof request === 'object' ? request : {};
    if (action === 'list') return windows.list();
    if (action === 'show') return windows.show(String(workspaceId));
    if (action === 'move') return windows.moveWorkspace(String(workspaceId), windowId == null ? { newWindow: true, x: Number(x), y: Number(y) } : { windowId: Number(windowId) });
    if (action === 'focus') return windows.focus(Number(windowId));
    if (action === 'showHere') return browser.showInWindow(id, String(workspaceId));
    throw new Error('Unknown window action');
  });
  // Links waiting for a person to choose a workspace, and opt-in default-browser registration (#99).
  ipcMain.handle('weft:external', async (event, request) => {
    trusted(event);
    const { action, id = null, workspaceId = null } = request && typeof request === 'object' ? request : {};
    if (action === 'list') return external.list();
    if (action === 'choose') return external.choose(String(id), workspaceId === null ? null : String(workspaceId));
    throw new Error('Unknown action');
  });
  ipcMain.handle('weft:defaultBrowser', (event, action) => { trusted(event); return defaultBrowser(action, entry => activity.append(entry)); });
  // People-only browser chrome (#88, #93, #96): find bar, print dialog, zoom steps, hard reload, DevTools and page source.
  // Not in the command catalog, so no agent surface can reach them.
  ipcMain.handle('weft:chromeAction', async (event, action, args) => {
    trusted(event);
    try { return { result: await browser.chromeAction(String(action), args && typeof args === 'object' ? args : {}) }; }
    catch (error) { return { error: { message: error.message, code: error.code ?? 'failed' } }; }
  });
  // A person opens a private window from the trusted GUI (menu or Ctrl/Cmd+Shift+N); no command or agent can.
  ipcMain.handle('weft:openPrivateWindow', event => { trusted(event); return privateWindows.open(); });
  // A person picks a file or folder to link in a native dialog; only the chosen path returns to the trusted GUI.
  ipcMain.handle('weft:pickPath', async (event, kind) => {
    trusted(event);
    // 'save' picks where a person-requested export (saved passwords) is written.
    if (kind === 'save') { const saved = await dialog.showSaveDialog(window, { title: 'Export to a file', defaultPath: 'weft-passwords.csv', properties: ['showOverwriteConfirmation', 'dontAddToRecent'] }); return saved.canceled ? null : saved.filePath ?? null; }
    const result = await dialog.showOpenDialog(window, { title: kind === 'folder' ? 'Link a folder' : kind === 'import' ? 'Choose a password export (CSV)' : 'Link a file', properties: [kind === 'folder' ? 'openDirectory' : 'openFile', 'dontAddToRecent'] });
    return result.canceled ? null : result.filePaths[0] ?? null;
  });
  ipcMain.handle('weft:execute', (event, name, args) => {
    const id = trusted(event);
    return dispatch(name, windowDefaults(id, name, args), { actor: 'human', source: 'gui' });
  });
  await browser.restore();
  browser.startResourceScheduler();
  await window.loadURL(guiUrl);
  await windows.restore().catch(error => console.warn(`Weft windows: ${error.message}`));
  void external.setReady(true);
  server = createApiServer({ execute: (name, args, context) => dispatch(name, args, context), token, authenticate: supplied => clients.authenticate(supplied), authorizeStream: (identity, request) => authority.streamAccess(identity, request), executeReturnsOutcome: true, turns: relay, eventLog, subscribe: listener => { events.on('event', listener); return () => events.off('event', listener); } });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', resolve);
  });
  server.on('error', error => { console.error('Weft API error:', error.message); app.quit(); });
  console.log(`Weft API: http://127.0.0.1:${port}`);
  if (tokenFile) console.log(`Generated WEFT_TOKEN written to ${tokenFile} (readable only by you)`);
  else if (generated) console.log(`Generated WEFT_TOKEN (local access only): ${token}`);
  if (launchHeadless) console.log(`Weft is running headless (profile ${profileFingerprint(app.getPath('userData'))}). Attach with "weft attach" or by launching Weft again.`);
  // Health check for the first launches of a new version: GUI loaded, API listening, store open.
  updates?.confirmHealthy({ gui: !window.isDestroyed() && window.webContents.getURL() === guiUrl, api: server.listening, workspace: workspace.locked || Boolean(workspace.data) });
  updates?.startBackground();
}).catch(error => {
  console.error('Weft startup failed:', error.message);
  try { updates?.reportUnhealthy(`Startup failed: ${error.message}`); } catch { /* keep the original failure visible */ }
  app.exit(1);
});

/**
 * Opt-in, reversible default-browser registration (#99). Never done silently; source runs cannot register
 * (they would register the Electron binary). Linux and Windows may still require choosing Weft in the
 * system's default-apps settings, and Linux cannot remove a registration programmatically.
 */
function defaultBrowser(action, audit) {
  const supported = app.isPackaged;
  const status = () => ({ supported, reason: supported ? null : 'Only an installed Weft build can become the default browser.',
    http: supported && app.isDefaultProtocolClient('http'), https: supported && app.isDefaultProtocolClient('https'), canRemove: supported && process.platform !== 'linux', platform: process.platform,
    notice: process.platform === 'win32' ? 'Windows asks you to confirm the default browser in Settings > Apps > Default apps.' : process.platform === 'linux' ? 'To stop using Weft as the default browser on Linux, choose another browser in your desktop settings.' : null });
  if (action === 'status') return status();
  if (!supported) throw Object.assign(new Error(status().reason), { code: 'unsupported' });
  if (action === 'set') {
    app.setAsDefaultProtocolClient('http'); app.setAsDefaultProtocolClient('https');
    if (process.platform === 'win32') void shell.openExternal('ms-settings:defaultapps');
  } else if (action === 'unset') {
    if (process.platform === 'linux') throw Object.assign(new Error(status().notice), { code: 'unsupported' });
    app.removeAsDefaultProtocolClient('http'); app.removeAsDefaultProtocolClient('https');
  } else throw new Error('Unknown action');
  audit({ type: 'policy', reason: action === 'set' ? 'default_browser_registered' : 'default_browser_removed', outcome: 'completed', actor: 'human' });
  return status();
}

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
  passwords?.close();
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
