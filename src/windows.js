import { existsSync, readFileSync } from 'node:fs';
import { z } from 'zod';
import { writeJsonDurable } from './atomic-json.js';
import { isEverything, everythingRefusal } from './everything.js';

/**
 * Multiple windows (#100). The main window hosts the Everything workspace and every workspace that was not
 * moved out; a person can move any other workspace into its own window (by dragging it out of the rail or
 * with "Move to new window") and back. A workspace is shown in at most one window. Each window has its own
 * rail, address bar, active tab and pane layout; tabs keep running when their workspace changes window.
 *
 * Windows are display state only. Agents stay scoped by workspace: the windowId on tabs and windows.list
 * is informational and never a grant, and only a person can move or focus windows.
 */
const workspaceId = z.string().min(1).max(128).describe('Workspace identifier.');
const windowId = z.number().int().positive().describe('Window identifier from windows.list.');
export const windowCommandDefinitions = {
  'windows.list': ['List Weft windows, the workspaces each one shows and its active tab (informational; windows grant nothing)', {}],
  'windows.moveWorkspace': ['Human moves a workspace into a new window, another window, or back to the main window (the built-in Everything workspace stays in the main window)', {
    workspaceId, windowId: windowId.optional().describe('Destination window; omit with newWindow to open one. Window 1 is the main window.'),
    newWindow: z.boolean().optional().describe('Open a new window for this workspace.') }],
  'windows.focus': ['Human brings a Weft window to the front', { windowId }],
};
const schemas = Object.fromEntries(Object.entries(windowCommandDefinitions).map(([name, [, shape]]) => [name, z.strictObject(shape)]));
const human = context => ['human', 'admin'].includes(context.actor);
const refuse = (code, message) => Object.assign(new Error(message), { code });

/** Keep saved bounds on a connected display; a window whose display is gone opens centered on the primary one. */
export function fitBounds(bounds, displays, primary, fallback = { width: 1280, height: 860 }) {
  const area = display => display.workArea ?? display.bounds;
  const valid = bounds && ['x', 'y', 'width', 'height'].every(key => Number.isFinite(bounds[key])) && bounds.width >= 400 && bounds.height >= 300;
  if (valid) {
    const centerX = bounds.x + bounds.width / 2, centerY = bounds.y + bounds.height / 2;
    const host = displays.find(display => { const a = area(display); return centerX >= a.x && centerX < a.x + a.width && centerY >= a.y && centerY < a.y + a.height; });
    if (host) {
      const a = area(host);
      const width = Math.min(bounds.width, a.width), height = Math.min(bounds.height, a.height);
      return { x: Math.round(Math.min(Math.max(bounds.x, a.x), a.x + a.width - width)), y: Math.round(Math.min(Math.max(bounds.y, a.y), a.y + a.height - height)), width: Math.round(width), height: Math.round(height), displayMissing: false };
    }
  }
  const a = area(primary);
  const width = Math.min(valid ? bounds.width : fallback.width, a.width), height = Math.min(valid ? bounds.height : fallback.height, a.height);
  return { x: Math.round(a.x + (a.width - width) / 2), y: Math.round(a.y + (a.height - height) / 2), width: Math.round(width), height: Math.round(height), displayMissing: Boolean(valid) };
}

export class WindowManager {
  /**
   * @param {object} options
   * @param {object} options.browser  the shared Browser (per-window view state lives there)
   * @param {object} options.workspace  WorkspaceService
   * @param {object} options.mainWindow  the main BrowserWindow
   * @param {(bounds: object) => object} options.createWindow  opens a trusted GUI window (same preload, policy and URL)
   * @param {{getAllDisplays: Function, getPrimaryDisplay: Function}} [options.screen]
   * @param {string} [options.statePath]  window-state.json in the profile
   * @param {() => boolean} [options.headless]
   * @param {(windowId: number) => void} [options.onChange]  tells every GUI that window assignments changed
   * @param {(entry: object) => void} [options.audit]
   */
  constructor({ browser, workspace, mainWindow, createWindow, screen = null, statePath = null, headless = () => false, onChange = () => {}, audit = () => {} }) {
    Object.assign(this, { browser, workspace, mainWindow, createWindow, screen, statePath, headless, onChange, audit });
    this.windows = new Map();
    this.shuttingDown = false;
    this.saveTimer = null;
    mainWindow?.on?.('move', () => this.scheduleSave());
    mainWindow?.on?.('resize', () => this.scheduleSave());
  }

  /** The trusted GUI window that sent an IPC message, or null when the sender is not one of Weft's windows. */
  windowIdFor(contents) {
    if (this.mainWindow && !this.mainWindow.isDestroyed() && contents === this.mainWindow.webContents) return 1;
    for (const [id, window] of this.windows) if (!window.isDestroyed() && contents === window.webContents) return id;
    return null;
  }
  windowFor(id) { return id === 1 ? this.mainWindow : this.windows.get(id) ?? null; }
  all() { return [this.mainWindow, ...this.windows.values()].filter(window => window && !window.isDestroyed()); }

  /** What a GUI renderer needs to know about its own window. */
  info(id) {
    const state = this.browser.windowState(id);
    return { windowId: id, main: id === 1, workspaceId: this.browser.shownWorkspace(state) ?? null, workspaceIds: id === 1 ? null : [...state.workspaces],
      assignments: Object.fromEntries([...this.browser.windows.values()].filter(item => item.id !== 1).flatMap(item => [...item.workspaces].map(ws => [ws, item.id]))) };
  }

  list(context = {}) {
    const visible = id => !context.workspaceIds || context.workspaceIds.includes(id);
    return this.browser.describeWindows().map(item => ({ ...item, workspaceId: visible(item.workspaceId) ? item.workspaceId : null,
      workspaceIds: item.workspaceIds ? item.workspaceIds.filter(visible) : null, activeTabId: visible(item.workspaceId) ? item.activeTabId : null,
      title: this.windowFor(item.windowId)?.getTitle?.() ?? null }));
  }

  async execute(command, input, context = {}) {
    const args = schemas[command].parse(input);
    if (command === 'windows.list') return { windows: this.list(context), notice: 'Windows are informational: agents are scoped by workspace, never by window.' };
    if (!human(context)) throw refuse('human_required', 'Only a person can arrange Weft windows');
    if (command === 'windows.focus') return this.focus(args.windowId);
    if (args.newWindow && args.windowId != null) throw refuse('invalid_arguments', 'Use either newWindow or windowId');
    return this.moveWorkspace(args.workspaceId, args.newWindow || args.windowId == null ? { newWindow: true } : { windowId: args.windowId });
  }

  focus(id) {
    const window = this.windowFor(id);
    if (!window || window.isDestroyed()) throw refuse('not_found', 'Window not found');
    if (window.isMinimized?.()) window.restore?.();
    window.show?.(); window.focus?.();
    return { focused: id };
  }

  /** Bring forward the window that holds a workspace; a workspace in the main rail becomes the main window's workspace. */
  async show(workspaceId) {
    const owner = this.browser.ownerOf(workspaceId);
    if (owner.id === 1) {
      if (this.workspace.activeWorkspaceId !== workspaceId) await this.workspace.execute('workspaces.switch', { id: workspaceId }, { actor: 'human', source: 'gui' });
    } else if (owner.current !== workspaceId) this.browser.showInWindow(owner.id, workspaceId);
    this.focus(owner.id);
    this.changed();
    return { windowId: owner.id, workspaceId };
  }

  /**
   * Move a workspace into a new window ({newWindow: true, x, y}), another window ({windowId}) or back to the
   * main window ({windowId: 1}). The main window, if it was showing the workspace, switches to another one first.
   */
  async moveWorkspace(workspaceId, { newWindow = false, windowId = null, x = null, y = null } = {}) {
    if (this.headless()) throw refuse('unsupported', 'Headless sessions show one window; attach a display first');
    const record = this.workspace.workspace(workspaceId);
    if (record.archived) throw refuse('invalid_arguments', 'Restore this workspace before opening it in a window');
    const targetId = newWindow ? null : windowId;
    if (isEverything(workspaceId) && targetId !== 1) throw everythingRefusal('window');
    if (targetId != null && !this.windowFor(targetId)) throw refuse('not_found', 'Window not found');
    const source = this.browser.ownerOf(workspaceId);
    if (targetId === source.id) return { workspaceId, windowId: source.id, moved: false };
    // The main window cannot keep showing a workspace another window now owns.
    if (source.id === 1 && this.workspace.activeWorkspaceId === workspaceId) {
      const next = this.workspace.data.workspaces.find(item => item.id !== workspaceId && !item.archived && this.browser.ownerOf(item.id).id === 1);
      await this.workspace.execute('workspaces.switch', { id: next.id }, { actor: 'human', source: 'gui' });
    }
    let destination = targetId;
    if (destination == null) {
      const main = this.mainWindow?.getBounds?.() ?? { x: 80, y: 80, width: 1280, height: 860 };
      const wanted = Number.isFinite(x) && Number.isFinite(y) ? { x: Math.round(x - 120), y: Math.round(y - 20), width: main.width, height: main.height } : { x: main.x + 40, y: main.y + 40, width: main.width, height: main.height };
      const window = this.open(wanted);
      destination = this.browser.addWindow(window, [workspaceId]).id;
      this.windows.set(destination, window);
      this.watch(destination, window);
    } else {
      const result = this.browser.moveWorkspace(workspaceId, destination);
      if (result.emptied) this.windowFor(result.emptied)?.close();
    }
    // A workspace moved back into the main rail is shown there.
    if (destination === 1) await this.workspace.execute('workspaces.switch', { id: workspaceId }, { actor: 'human', source: 'gui' });
    this.audit({ type: 'display', reason: 'workspace_window', outcome: 'completed', actor: 'human', workspaceId, summary: { windowId: destination } });
    this.focus(destination);
    this.changed();
    return { workspaceId, windowId: destination, moved: true };
  }

  open(bounds) {
    const fitted = this.screen ? fitBounds(bounds, this.screen.getAllDisplays(), this.screen.getPrimaryDisplay()) : bounds;
    return this.createWindow({ x: fitted.x, y: fitted.y, width: fitted.width, height: fitted.height });
  }

  watch(id, window) {
    window.on('move', () => this.scheduleSave());
    window.on('resize', () => this.scheduleSave());
    // Page views are detached before the window is destroyed, so closing a window never closes its tabs.
    window.on('close', () => { if (this.browser.windows.has(id)) this.browser.removeWindow(id); });
    window.on('closed', () => {
      this.windows.delete(id);
      // Closing a window returns its workspaces to the main window; quitting or locking keeps the arrangement for next time.
      if (this.browser.windows.has(id)) this.browser.removeWindow(id);
      if (!window.weftKeepArrangement && !this.shuttingDown) { this.changed(); this.save(); }
    });
  }

  changed() { this.scheduleSave(); try { this.onChange(); } catch { /* every window refreshes on its own poll as well */ } }

  scheduleSave() {
    if (this.shuttingDown || !this.statePath) return;
    clearTimeout(this.saveTimer);
    this.saveTimer = setTimeout(() => this.save(), 500);
    this.saveTimer.unref?.();
  }

  snapshot() {
    const bounds = window => ({ bounds: window.isMaximized?.() ? window.getNormalBounds?.() ?? window.getBounds() : window.getBounds(), maximized: Boolean(window.isMaximized?.()) });
    return { version: 1,
      main: this.mainWindow && !this.mainWindow.isDestroyed() ? bounds(this.mainWindow) : null,
      windows: [...this.windows].filter(([, window]) => !window.isDestroyed()).map(([id, window]) => {
        const state = this.browser.windows.get(id);
        return { ...bounds(window), workspaceIds: state ? [...state.workspaces] : [], current: state?.current ?? null };
      }).filter(item => item.workspaceIds.length) };
  }

  save() {
    clearTimeout(this.saveTimer);
    if (!this.statePath || this.headless()) return;
    try { writeJsonDurable(this.statePath, this.snapshot()); } catch (error) { console.warn(`Weft windows: ${error.message}`); }
  }

  read() {
    if (!this.statePath || !existsSync(this.statePath)) return null;
    try { const value = JSON.parse(readFileSync(this.statePath, 'utf8')); return value?.version === 1 ? value : null; } catch { return null; }
  }

  /** Saved main-window bounds fitted to the connected displays, or null. */
  mainBounds(saved = this.read()) {
    if (!saved?.main?.bounds || !this.screen) return null;
    return { ...fitBounds(saved.main.bounds, this.screen.getAllDisplays(), this.screen.getPrimaryDisplay()), maximized: Boolean(saved.main.maximized) };
  }

  /** Reopen saved windows (after launch and after each unlock). Missing, archived and built-in workspaces stay in the main window. */
  async restore(saved = this.read()) {
    if (this.headless() || this.workspace.locked || !saved?.windows?.length) return [];
    const placed = new Set([...this.browser.windows.values()].filter(state => state.id !== 1).flatMap(state => [...state.workspaces]));
    const plan = [];
    for (const entry of saved.windows.slice(0, 20)) {
      const ids = (Array.isArray(entry.workspaceIds) ? entry.workspaceIds : []).filter(id => typeof id === 'string' && !placed.has(id) && !isEverything(id)
        && this.workspace.data.workspaces.some(item => item.id === id && !item.archived));
      if (!ids.length) continue;
      ids.forEach(id => placed.add(id));
      plan.push({ entry, ids });
    }
    // The main window must not keep showing a workspace that reopens in its own window.
    if (placed.has(this.workspace.activeWorkspaceId)) {
      const next = this.workspace.data.workspaces.find(item => !item.archived && !placed.has(item.id));
      await this.workspace.execute('workspaces.switch', { id: next.id }, { actor: 'human', source: 'gui' });
    }
    const opened = [];
    for (const { entry, ids } of plan) {
      const window = this.open(entry.bounds ?? {});
      if (entry.maximized) window.maximize?.();
      const state = this.browser.addWindow(window, ids, ids.includes(entry.current) ? entry.current : ids[0]);
      this.windows.set(state.id, window);
      this.watch(state.id, window);
      opened.push(state.id);
    }
    if (opened.length) this.changed();
    return opened;
  }

  /** Close every second window without forgetting the arrangement (quit or lock). */
  closeAll() {
    this.save();
    for (const [id, window] of [...this.windows]) {
      window.weftKeepArrangement = true;
      if (this.browser.windows.has(id)) this.browser.removeWindow(id);
      if (!window.isDestroyed()) window.destroy();
    }
    this.windows.clear();
  }
}
