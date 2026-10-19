import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Browser } from '../src/browser.js';
import { WorkspaceService } from '../src/workspace.js';
import { WindowManager, fitBounds } from '../src/windows.js';
import { EVERYTHING_ID } from '../src/everything.js';
import { PANE_LAYOUTS, fitLayout, paneCount, paneDividers, paneRects, panesFromSplit, sizeAt } from '../src/panes.js';

test('pane layouts tile the browse area without overlap and collapse when the window is too small (#101)', () => {
  const box = { x: 10, y: 20, width: 1200, height: 800 };
  for (const layout of Object.keys(PANE_LAYOUTS)) {
    const rects = paneRects(layout, box);
    assert.equal(rects.length, paneCount(layout), layout);
    for (const rect of rects) {
      assert.ok(rect.x >= box.x && rect.y >= box.y && rect.x + rect.width <= box.x + box.width && rect.y + rect.height <= box.y + box.height, `${layout} stays inside`);
    }
    for (let a = 0; a < rects.length; a++) for (let b = a + 1; b < rects.length; b++) {
      const [p, q] = [rects[a], rects[b]];
      const overlap = p.x < q.x + q.width && q.x < p.x + p.width && p.y < q.y + q.height && q.y < p.y + p.height;
      assert.equal(overlap, false, `${layout} panes ${a} and ${b} do not overlap`);
    }
  }
  // Dividers sit in the gaps and move with the keyboard or pointer.
  const [divider] = paneDividers('2-columns', box);
  assert.equal(divider.orientation, 'vertical');
  const sizes = sizeAt('2-columns', box, divider, { x: box.x + 300, y: 0 });
  assert.equal(sizes[0], 0.25);
  assert.equal(paneRects('2-columns', box, sizes)[0].width, Math.floor((1200 - 6) * 0.25));
  assert.deepEqual(sizeAt('2-columns', box, divider, { x: box.x, y: 0 }), [0.15], 'a pane cannot be dragged away');
  assert.deepEqual(fitLayout('4-grid', box), { layout: '4-grid', collapsed: false });
  assert.deepEqual(fitLayout('4-grid', { x: 0, y: 0, width: 700, height: 300 }), { layout: '2-columns', collapsed: true });
  assert.deepEqual(fitLayout('3-columns', { x: 0, y: 0, width: 400, height: 300 }), { layout: '1', collapsed: true });
  assert.deepEqual(panesFromSplit(4, { tabId: 9, focusedPane: 'secondary' }), { layout: '2-columns', items: [{ type: 'tab', id: 4 }, { type: 'tab', id: 9 }], focused: 1, sizes: [0.5] });
});

function fakeWindow(bounds = { x: 0, y: 0, width: 1400, height: 900 }) {
  const window = new EventEmitter();
  const children = new Set();
  Object.assign(window, { destroyed: false, focusCount: 0, bounds: { ...bounds },
    isDestroyed: () => window.destroyed, getContentSize: () => [window.bounds.width, window.bounds.height], getBounds: () => ({ ...window.bounds }), isMaximized: () => false,
    isMinimized: () => false, show() {}, focus() { window.focusCount++; }, getTitle: () => 'Weft', close() { window.destroy(); },
    destroy() { if (window.destroyed) return; window.destroyed = true; window.emit('closed'); },
    contentView: { children, addChildView: view => children.add(view), removeChildView: view => children.delete(view) } });
  return window;
}
function fakeView(id) {
  const contents = { id, getURL: () => `https://example.com/${id}`, getTitle: () => `Page ${id}`, isDestroyed: () => false, close() {}, focus() { contents.focused = (contents.focused ?? 0) + 1; }, stop() {} };
  return { webContents: contents, bounds: null, setBounds(rect) { this.bounds = rect; } };
}

test('a workspace moves to its own window and back without reloading its tabs; Everything stays in the main window (#100)', async t => {
  const directory = mkdtempSync(join(tmpdir(), 'weft-windows-'));
  const workspace = new WorkspaceService({ directory });
  const main = fakeWindow();
  const session = new EventEmitter();
  session.setPermissionRequestHandler = () => {}; session.setPermissionCheckHandler = () => {};
  const browser = new Browser({ window: main, session, workspaceService: workspace, electronApi: {} });
  // Scripted tabs only: switching shows the remembered tab without opening real pages.
  browser.switchWorkspace = async id => { const tab = browser.rememberedTab(id); return tab ? browser.activate(tab.id) : null; };
  workspace.attachBrowser(browser);
  t.after(() => { browser.close(); workspace.close(); rmSync(directory, { recursive: true, force: true }); });
  const home = workspace.activeWorkspaceId;
  const trip = await workspace.execute('workspaces.create', { name: 'Trip' });
  await workspace.execute('workspaces.switch', { id: home });
  const views = { 1: fakeView(1), 2: fakeView(2), 3: fakeView(3) };
  browser.tabs.set(1, { id: 1, workspaceId: home, version: 1, controller: 'available', url: 'https://example.com/1', view: views[1] });
  browser.tabs.set(2, { id: 2, workspaceId: trip.id, version: 1, controller: 'available', url: 'https://example.com/2', view: views[2] });
  browser.tabs.set(3, { id: 3, workspaceId: trip.id, version: 1, controller: 'available', url: 'https://example.com/3', view: views[3] });
  browser.activate(1);
  browser.setLayout({ x: 0, y: 100, width: 1000, height: 700, visible: true });
  assert.ok(main.contentView.children.has(views[1].webContents ? views[1] : null));
  const opened = [];
  const statePath = join(directory, 'window-state.json');
  const screen = { getAllDisplays: () => [{ workArea: { x: 0, y: 0, width: 1920, height: 1080 } }], getPrimaryDisplay: () => ({ workArea: { x: 0, y: 0, width: 1920, height: 1080 } }) };
  const manager = new WindowManager({ browser, workspace, mainWindow: main, screen, statePath, createWindow: bounds => { const window = fakeWindow(bounds); opened.push(window); return window; } });

  await assert.rejects(manager.moveWorkspace(EVERYTHING_ID, { newWindow: true }), /main window/);
  await assert.rejects(manager.execute('windows.moveWorkspace', { workspaceId: trip.id, newWindow: true }, { actor: 'automation' }), /Only a person/);
  const moved = await manager.moveWorkspace(trip.id, { newWindow: true });
  assert.equal(moved.windowId, 2);
  const second = opened[0];
  assert.equal(browser.ownerOf(trip.id).id, 2);
  assert.equal(browser.shownIn(trip.id).id, 2);
  // The second window has its own active tab; the main window keeps its own.
  assert.equal(browser.describe(browser.tabs.get(2)).active, true);
  assert.equal(browser.describe(browser.tabs.get(1)).active, true);
  assert.equal(browser.describe(browser.tabs.get(2)).windowId, 2);
  browser.setLayout({ x: 0, y: 100, width: 1000, height: 700, visible: true }, 2);
  assert.ok(second.contentView.children.has(views[2]));
  // Two panes in the second window: the native views get exactly the pane rectangles.
  browser.setLayout({ x: 0, y: 100, width: 1000, height: 700, visible: true, focusedTabId: 3, panes: [{ tabId: 2, x: 0, y: 132, width: 497, height: 668 }, { tabId: 3, x: 503, y: 132, width: 497, height: 668 }] }, 2);
  assert.deepEqual(views[3].bounds, { x: 503, y: 132, width: 497, height: 668 });
  assert.equal(views[3].webContents.focused, 1, 'the focused pane receives keyboard focus once');
  assert.ok(browser.quickBlockers(browser.tabs.get(3)).includes('visible_pane'), 'a visible pane is never suspended');
  assert.throws(() => browser.setLayout({ x: 0, y: 0, width: 10, height: 10, visible: true, panes: [{ tabId: 1, x: 0, y: 0, width: 5, height: 5 }] }, 2), /this workspace/);
  // The main window cannot switch to a workspace another window shows.
  await assert.rejects(workspace.execute('workspaces.switch', { id: trip.id }, { actor: 'human' }), /own window/);
  const list = manager.list();
  assert.deepEqual(list.map(item => [item.windowId, item.main, item.workspaceId]), [[1, true, home], [2, false, trip.id]]);
  // A scoped reader sees only its own workspaces in the window list.
  assert.deepEqual(manager.list({ workspaceIds: [home] }).map(item => item.workspaceId), [home, null]);
  manager.save();
  const saved = manager.read();
  // Closing the window returns the workspace to the main rail; its tab views were not recreated.
  second.destroy();
  assert.equal(browser.ownerOf(trip.id).id, 1);
  assert.equal(browser.windows.size, 1);
  assert.equal(browser.tabs.get(2).view, views[2]);
  // A closed window is forgotten; quitting keeps the arrangement, which reopens at the next launch.
  assert.equal(manager.read().windows.length, 0);
  assert.equal(saved.windows.length, 1);
  assert.deepEqual(saved.windows[0].workspaceIds, [trip.id]);
  const reopened = await manager.restore(saved);
  assert.equal(reopened.length, 1);
  assert.equal(browser.ownerOf(trip.id).id, reopened[0]);
  // Deleting the workspace closes its emptied window.
  browser.onWindowEmptied = id => manager.windowFor(id)?.close();
  await workspace.execute('workspaces.delete', { id: trip.id }, { actor: 'human' });
  assert.equal(browser.windows.size, 1);
});

test('saved window bounds stay on a connected display and fall back to the primary one (#100)', () => {
  const primary = { workArea: { x: 0, y: 0, width: 1920, height: 1080 } };
  const right = { workArea: { x: 1920, y: 0, width: 1280, height: 1024 } };
  assert.deepEqual(fitBounds({ x: 2000, y: 100, width: 1000, height: 800 }, [primary, right], primary), { x: 2000, y: 100, width: 1000, height: 800, displayMissing: false });
  assert.deepEqual(fitBounds({ x: 2000, y: 100, width: 1000, height: 800 }, [primary], primary), { x: 460, y: 140, width: 1000, height: 800, displayMissing: true });
  assert.deepEqual(fitBounds({ x: -500, y: -400, width: 3000, height: 2000 }, [primary], primary), { x: 0, y: 0, width: 1920, height: 1080, displayMissing: false });
  assert.equal(fitBounds(null, [primary], primary).displayMissing, false);
});
