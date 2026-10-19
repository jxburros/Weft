// Everyday browser chrome in real Chromium (#88, #89, #91, #92, #93, #96): shortcuts from inside a page,
// the context menu, the find bar, zoom memory, recently closed tabs, tab order, DevTools and page source.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import electron from 'electron';
import { electronEnv } from '../scripts/electron-env.js';
import { matchShortcut, nextZoom } from '../src/shortcuts.js';
import { contextMenuItems } from '../src/context-menu.js';
import { searchUrl, templateProblem } from '../src/search-engines.js';
import { budget as scaled } from './time-budget.js';

const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(predicate, label = 'condition', timeoutMs = 8000) {
  for (let i = 0; i < timeoutMs / 25; i++) { if (await predicate()) return; await pause(25); }
  throw new Error(`Timed out waiting for ${label}`);
}
const PAGES = {
  '/': '<!doctype html><title>Chrome fixture</title><p>alpha beta alpha gamma Alpha</p><a id="blocked" href="/blocked">blocked link</a> <a id="ok" href="/second">second</a><textarea id="editor"></textarea><div style="height:4000px">tall</div>',
  '/second': '<!doctype html><title>Second page</title><p>second</p><div style="height:4000px">tall</div>',
  '/claims': '<!doctype html><title>Editor</title><script>addEventListener("keydown", e => { if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "f") { e.preventDefault(); document.title = "claimed"; } });</script><p>alpha</p>',
  '/blocked': '<!doctype html><title>Should not load</title>',
};
const fixture = () => createServer((request, response) => { response.setHeader('content-type', 'text/html'); response.end(PAGES[request.url] ?? PAGES['/']); });

async function browserLevel() {
  const { app, BrowserWindow } = electron;
  app.setPath('userData', process.env.WEFT_TEST_PROFILE);
  app.on('window-all-closed', () => {});
  await app.whenReady();
  const server = fixture();
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  const { WorkspaceService } = await import('../src/workspace.js');
  const { Browser } = await import('../src/browser.js');
  const workspace = new WorkspaceService({ directory: join(process.env.WEFT_TEST_PROFILE, 'workspace-data') });
  const home = workspace.activeWorkspaceId;
  await workspace.execute('siteRules.create', { workspaceId: home, hostname: '127.0.0.1', path: '/blocked', behavior: 'block', reason: 'Fixture rule' });
  const window = new BrowserWindow({ show: true, width: 1000, height: 800, webPreferences: { sandbox: true, contextIsolation: true } });
  const browser = new Browser({ window, workspaceService: workspace });
  workspace.attachBrowser(browser);
  browser.setLayout({ x: 0, y: 0, width: 1000, height: 800, visible: true });
  const shortcuts = [];
  const notices = [];
  const menus = [];
  browser.onChromeShortcut = event => shortcuts.push(event.shortcut);
  browser.onNotice = message => notices.push(message);
  browser.popupMenu = template => menus.push(template);
  try {
    const first = await browser.execute('tabs.new', { url: `${origin}/` });
    const tab = browser.tab(first.id);
    const contents = tab.view.webContents;
    await until(() => tab.keyWorld === (tab.documentSerial ?? 0), 'key watcher');
    contents.focus();
    const key = (keyCode, modifiers = []) => { contents.sendInputEvent({ type: 'keyDown', keyCode, modifiers }); contents.sendInputEvent({ type: 'keyUp', keyCode, modifiers }); };

    // Never-claimable keys leave the page at once; claimable keys run when the page leaves them alone.
    key('T', ['control']);
    await until(() => shortcuts.includes('tab-new'), 'Ctrl+T from the page');
    key('F', ['control']);
    await until(() => shortcuts.includes('find'), 'Ctrl+F the page did not claim');
    // Agent input is native but synthetic: it never triggers a browser shortcut (F12 would open DevTools).
    shortcuts.length = 0;
    browser.sendSynthetic(tab, [{ type: 'keyDown', keyCode: 'F12' }, { type: 'keyUp', keyCode: 'F12' }]);
    browser.sendSynthetic(tab, [{ type: 'keyDown', keyCode: 'F5' }, { type: 'keyUp', keyCode: 'F5' }]);
    await pause(400);
    assert.deepEqual(shortcuts, []);
    assert.equal(contents.isDevToolsOpened(), false);

    // A page that handles Ctrl+F itself keeps it.
    await browser.execute('page.navigate', { url: `${origin}/claims` });
    await until(() => tab.keyWorld === (tab.documentSerial ?? 0) && contents.getURL().endsWith('/claims'), 'claims page');
    contents.focus();
    key('F', ['control']);
    await until(() => contents.getTitle() === 'claimed', 'page claimed Ctrl+F');
    await pause(300);
    assert.ok(!shortcuts.includes('find'));
    await browser.execute('page.navigate', { url: `${origin}/` });
    await until(() => contents.getURL() === `${origin}/` && !contents.isLoading(), 'back to fixture');

    // Find bar data: match count and navigation; case is respected when asked.
    let found = await browser.chromeAction('find', { text: 'alpha', newSession: true });
    assert.equal(found.matches, 3);
    assert.equal(found.activeMatchOrdinal, 1);
    found = await browser.chromeAction('find', { text: 'alpha' });
    assert.equal(found.activeMatchOrdinal, 2);
    found = await browser.chromeAction('find', { text: 'alpha', newSession: true, matchCase: true });
    assert.equal(found.matches, 2);
    await browser.chromeAction('stop-find');

    // Zoom steps, remembered per origin and workspace across navigations.
    assert.equal((await browser.chromeAction('zoom', { direction: 1 })).factor.toFixed(2), '1.10');
    await browser.execute('page.navigate', { url: `${origin}/second` });
    await until(() => contents.getURL().endsWith('/second') && !contents.isLoading(), 'second page');
    assert.equal(contents.getZoomFactor().toFixed(2), '1.10');
    assert.equal(workspace.data.browserSession.zoom[home][origin], 1.1);
    await browser.chromeAction('zoom', { direction: 0 });
    assert.equal(workspace.data.browserSession.zoom[home][origin], undefined);

    // Context menu: real (human) right click only; a site-blocked link is not opened from the menu.
    await browser.execute('page.navigate', { url: `${origin}/` });
    await until(() => contents.getURL() === `${origin}/` && !contents.isLoading(), 'fixture again');
    const box = await contents.executeJavaScript('(() => { const r = document.getElementById("blocked").getBoundingClientRect(); return { x: Math.round(r.x + 5), y: Math.round(r.y + 5) }; })()');
    browser.sendSynthetic(tab, [{ type: 'mouseDown', x: box.x, y: box.y, button: 'right', clickCount: 1 }, { type: 'mouseUp', x: box.x, y: box.y, button: 'right', clickCount: 1 }]);
    await pause(400);
    assert.equal(menus.length, 0, 'agent input never opens the context menu');
    contents.sendInputEvent({ type: 'mouseDown', x: box.x, y: box.y, button: 'right', clickCount: 1 });
    contents.sendInputEvent({ type: 'mouseUp', x: box.x, y: box.y, button: 'right', clickCount: 1 });
    await until(() => menus.length === 1, 'context menu');
    const labels = menus[0].filter(item => item.label).map(item => item.label);
    assert.ok(labels.includes('Open link in new tab') && labels.includes('Copy link address') && labels.includes('Inspect'));
    const before = (await browser.execute('tabs.list')).length;
    menus[0].find(item => item.label === 'Open link in new tab').click();
    await until(() => notices.some(message => /Blocked by site rule/.test(message)), 'blocked notice');
    assert.equal((await browser.execute('tabs.list')).length, before);

    // DevTools: refused on a tab an agent drives and during protected operations; never reachable by agents.
    tab.controller = 'agent-fixture';
    await assert.rejects(browser.chromeAction('devtools'), /take control/);
    tab.controller = 'available';
    tab.protection = { active: true, reason: 'credential fill' };
    await assert.rejects(browser.chromeAction('devtools'), /protected/);
    tab.protection = null;
    browser.preview = { view: { webContents: contents } };
    await assert.rejects(browser.chromeAction('devtools'), /offline previews/);
    browser.preview = null;
    await browser.chromeAction('devtools');
    await until(() => contents.isDevToolsOpened(), 'DevTools open');
    assert.equal((await browser.execute('page.inspect', { tabId: tab.id })).devtools, true);
    contents.closeDevTools();
    await until(() => !contents.isDevToolsOpened(), 'DevTools closed');

    // Page source: read-only tab, never saved; view-source: stays refused for agents and typed navigation.
    const source = await browser.chromeAction('view-source');
    assert.equal(source.viewSource, true);
    await until(() => browser.tab(source.id).view.webContents.getURL().startsWith('view-source:'), 'source view');
    assert.ok(!workspace.data.browserSession.tabs.some(item => item.id === source.id));
    const { commands, validateCommand } = await import('../src/commands.js');
    assert.throws(() => validateCommand('page.navigate', { url: `view-source:${origin}/` }), 'the catalog refuses view-source: for every caller');
    assert.ok(!Object.keys(commands).some(name => /devtools|inspect\.open|viewSource|print/i.test(name)), 'DevTools, source view and print are not commands');
    await assert.rejects(browser.execute('tabs.new', { url: `view-source:${origin}/` }), /Only HTTP/);
    await browser.execute('tabs.close', { tabId: source.id });

    // Recently closed: close remembers scroll and zoom; reopen restores them with no agent control; history clearing forgets the list.
    await contents.executeJavaScript('scrollTo(0, 900)');
    await browser.execute('page.zoom', { tabId: tab.id, factor: 1.25 });
    tab.pinned = true;
    await browser.execute('tabs.close', { tabId: tab.id });
    const closed = await browser.execute('tabs.closed', {});
    assert.equal(closed[0].url, `${origin}/`);
    assert.equal(closed[0].scrollY, 900);
    assert.equal(workspace.data.browserSession.closed.at(-1).id, closed[0].id);
    const reopened = await browser.execute('tabs.reopen', {});
    assert.equal(reopened.pinned, true);
    assert.equal(reopened.controller, 'available');
    const view = browser.tab(reopened.id).view.webContents;
    await until(async () => !view.isLoading() && (await view.executeJavaScript('scrollY')) === 900, 'scroll restored');
    assert.equal(view.getZoomFactor().toFixed(2), '1.25');
    assert.equal((await browser.execute('tabs.closed', {})).length, 0);
    await browser.execute('tabs.close', { tabId: reopened.id });
    assert.equal((await browser.execute('tabs.closed', {})).length, 1);
    await workspace.execute('history.clear', { workspaceId: home });
    assert.equal((await browser.execute('tabs.closed', {})).length, 0);
    assert.equal(workspace.data.browserSession.closed.length, 0);

    // Tab order: reorder persists and is the order of tabs.list; agents cannot move a person's tab.
    const ids = [];
    for (const path of ['/second', '/', '/claims']) ids.push((await browser.execute('tabs.new', { url: `${origin}${path}` })).id);
    const order = async () => (await browser.execute('tabs.list')).map(item => item.id).filter(id => ids.includes(id));
    await browser.execute('tabs.reorder', { tabId: ids[2], index: 0 });
    assert.deepEqual((await order()).slice(0, 3), [ids[2], ids[0], ids[1]]);
    assert.deepEqual(workspace.data.browserSession.tabs.map(item => item.id).filter(id => ids.includes(id)), [ids[2], ids[0], ids[1]]);
    browser.tab(ids[0]).controller = 'human';
    await assert.rejects(browser.execute('tabs.reorder', { tabId: ids[0], index: 2 }, { actor: 'agent-fixture' }), /held/);
    console.log('WEFT_CHROME_BROWSER_OK');
  } finally {
    browser.close();
    workspace.close();
    server.close();
    app.exit(0);
  }
}

async function guiLevel() {
  const { app, BrowserWindow, webContents } = electron;
  app.setPath('userData', process.env.WEFT_TEST_PROFILE);
  const server = fixture();
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  await import('../src/main.js');
  await app.whenReady();
  let window;
  for (let i = 0; i < 400 && !(window = BrowserWindow.getAllWindows()[0]); i++) await pause(25);
  const run = expression => window.webContents.executeJavaScript(expression);
  const gui = (expression, label) => until(() => run(expression), label ?? expression);
  try {
    await gui('document.getElementById("status")?.textContent === "Ready"', 'GUI ready');
    const tab = await run(`window.weft.execute("tabs.new", { url: ${JSON.stringify(`${origin}/`)} })`);
    await run('document.querySelector(\'[data-action="activate-tab"]\').click()');
    const page = () => webContents.getAllWebContents().find(item => item.getURL() === `${origin}/`);
    await until(() => page() && !page().isLoading(), 'page loaded');
    await pause(500);
    const count = async () => (await run('window.weft.execute("tabs.list", {})')).length;
    const inPage = async (keyCode, modifiers = []) => {
      await run('window.weft.focusPage()');
      page().focus();
      page().sendInputEvent({ type: 'keyDown', keyCode, modifiers });
      page().sendInputEvent({ type: 'keyUp', keyCode, modifiers });
    };
    // Ctrl+T with focus inside the live page opens a tab; Ctrl+W closes it; Ctrl+Shift+T reopens it.
    const start = await count();
    await inPage('T', ['control']);
    await until(async () => (await count()) === start + 1, 'Ctrl+T in page');
    await run(`window.weft.execute("tabs.activate", { tabId: ${tab.id} })`);
    await run('document.querySelector(\'[data-action="activate-tab"][data-id="' + tab.id + '"]\').click()');
    await pause(300);
    await inPage('W', ['control']);
    await until(async () => !(await run('window.weft.execute("tabs.list", {})')).some(item => item.id === tab.id), 'Ctrl+W in page');
    // Ctrl+Shift+T from the chrome.
    window.webContents.focus();
    window.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'T', modifiers: ['control', 'shift'] });
    window.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'T', modifiers: ['control', 'shift'] });
    await until(async () => (await run('window.weft.execute("tabs.list", {})')).some(item => item.url === `${origin}/`), 'Ctrl+Shift+T');
    await until(() => page() && !page().isLoading(), 'reopened page');
    await gui('document.getElementById("breadcrumb-section").textContent === "Live page"', 'browse view');
    await pause(400);
    // Ctrl+F inside the page opens the find bar with a match count; Enter steps; Escape closes it.
    await inPage('F', ['control']);
    await gui('!document.getElementById("find-bar").hidden && document.activeElement?.id === "find-input"', 'find bar');
    await run('(() => { const i = document.getElementById("find-input"); i.value = "alpha"; i.dispatchEvent(new Event("input")); })()');
    await gui('document.getElementById("find-count").textContent === "1 of 3"', 'match count');
    await run('document.getElementById("find-input").dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }))');
    await gui('document.getElementById("find-count").textContent === "2 of 3"', 'next match');
    await run('document.getElementById("find-input").dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }))');
    await gui('document.getElementById("find-bar").hidden', 'find bar closed');
    // Zoom from the page shows the indicator; Ctrl+0 resets.
    await inPage('=', ['control']);
    await gui('!document.getElementById("zoom-indicator").hidden && document.getElementById("zoom-indicator").textContent === "110%"', 'zoom indicator');
    await inPage('0', ['control']);
    await gui('document.getElementById("zoom-indicator").hidden', 'zoom reset');
    // Address-bar suggestions: an accessible combobox over this workspace's tabs, bookmarks and history.
    await run('(() => { const a = document.getElementById("address"); a.focus(); a.value = "second"; a.dispatchEvent(new Event("input")); })()');
    await gui('!document.getElementById("omnibox-list").hidden && document.getElementById("address").getAttribute("aria-expanded") === "true"', 'suggestions');
    assert.match(await run('document.getElementById("omnibox-list").textContent'), /Search Google for “second”/);
    await run('document.getElementById("address").dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true }))');
    assert.equal(await run('document.getElementById("address").getAttribute("aria-activedescendant")'), 'omnibox-option-0');
    await run('document.getElementById("address").dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }))');
    await gui('document.getElementById("omnibox-list").hidden', 'suggestions closed');
    // Search engine setting through the shared catalog; invalid templates are refused.
    await run('window.weft.execute("settings.update", { searchEngine: { preset: "duckduckgo" } })');
    // The GUI picks up the setting on its next state refresh.
    await gui('(() => { const a = document.getElementById("address"); a.value = "weft browser"; a.dispatchEvent(new Event("input")); return document.getElementById("omnibox-list").textContent.includes("Search DuckDuckGo"); })()', 'engine applied');
    const refused = await run('window.weft.executeOutcome("settings.update", { searchEngine: { preset: "custom", template: "http://example.com/?q=%s" } })');
    assert.equal(refused.status, 'invalid');
    await run('document.getElementById("address").blur()');
    // Drag to reorder in the sidebar, and the keyboard alternative.
    const second = await run(`window.weft.execute("tabs.new", { url: ${JSON.stringify(`${origin}/second`)} })`);
    await gui(`document.querySelectorAll("#tabs .tab[data-tab-id]").length >= 3 && document.querySelector('#tabs .tab[data-tab-id="${second.id}"]') !== null`, 'sidebar tabs');
    const firstId = await run('Number(document.querySelector("#tabs .tab[data-tab-id]").dataset.tabId)');
    await run(`(() => {
      const source = document.querySelector('#tabs .tab[data-tab-id="${second.id}"]');
      const target = document.querySelector('#tabs .tab[data-tab-id="${firstId}"]');
      const box = target.getBoundingClientRect();
      const data = new DataTransfer();
      source.dispatchEvent(new DragEvent("dragstart", { bubbles: true, dataTransfer: data }));
      target.dispatchEvent(new DragEvent("dragover", { bubbles: true, cancelable: true, clientY: box.top + 2, dataTransfer: data }));
      target.dispatchEvent(new DragEvent("drop", { bubbles: true, cancelable: true, clientY: box.top + 2, dataTransfer: data }));
      source.dispatchEvent(new DragEvent("dragend", { bubbles: true, dataTransfer: data }));
    })()`);
    await until(async () => (await run('window.weft.execute("tabs.list", {})'))[0].id === second.id, 'drag reorder');
    await gui(`Number(document.querySelector("#tabs .tab[data-tab-id]").dataset.tabId) === ${second.id}`, 'sidebar order');
    await run(`document.querySelector('#tabs .tab[data-tab-id="${second.id}"] button[data-action="activate-tab"]').focus()`);
    window.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Down', modifiers: ['alt', 'shift'] });
    window.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Down', modifiers: ['alt', 'shift'] });
    await until(async () => (await run('window.weft.execute("tabs.list", {})'))[1].id === second.id, 'keyboard reorder');
    console.log('WEFT_CHROME_GUI_OK');
  } finally {
    server.close();
    app.exit(0);
  }
}

if (process.argv.includes('--chrome-browser')) browserLevel().catch(error => { console.error(error); electron.app.exit(1); });
else if (process.argv.includes('--chrome-gui')) guiLevel().catch(error => { console.error(error); electron.app.exit(1); });
else {
  test('shortcut table: platform modifiers, claimable keys, loading-only Esc and zoom steps', () => {
    assert.equal(matchShortcut({ type: 'keyDown', key: 't', control: true }, { platform: 'linux' }).id, 'tab-new');
    assert.equal(matchShortcut({ type: 'keyDown', key: 't', meta: true }, { platform: 'darwin' }).id, 'tab-new');
    assert.equal(matchShortcut({ type: 'keyDown', key: 't', meta: true }, { platform: 'linux' }), null);
    assert.equal(matchShortcut({ type: 'keyDown', key: 'T', control: true, shift: true }, { platform: 'linux' }).id, 'tab-reopen');
    assert.equal(matchShortcut({ type: 'keyDown', key: 'f', control: true }, { platform: 'linux' }).claimable, true);
    assert.equal(matchShortcut({ type: 'keyDown', key: 'w', control: true }, { platform: 'linux' }).claimable, undefined);
    assert.equal(matchShortcut({ type: 'keyDown', key: 'Escape' }, { platform: 'linux' }), null);
    assert.equal(matchShortcut({ type: 'keyDown', key: 'Escape' }, { platform: 'linux', loading: true }).id, 'stop');
    assert.equal(matchShortcut({ type: 'keyDown', key: 'ArrowLeft', alt: true }, { platform: 'linux' }).id, 'back');
    assert.equal(matchShortcut({ type: 'keyDown', key: '[', meta: true }, { platform: 'darwin' }).id, 'back');
    assert.equal(matchShortcut({ type: 'keyDown', key: 'u', meta: true, alt: true }, { platform: 'darwin' }).id, 'view-source');
    assert.equal(matchShortcut({ type: 'keyDown', key: 'F12', isAutoRepeat: true }, { platform: 'linux' }), null);
    assert.equal(matchShortcut({ type: 'keyUp', key: 'F12' }, { platform: 'linux' }), null);
    assert.equal(nextZoom(1, 1), 1.1);
    assert.equal(nextZoom(5, 1), 5);
    assert.equal(nextZoom(0.25, -1), 0.25);
    assert.equal(nextZoom(1.3, -1), 1.25);
  });
  test('context menu items by target, with protected operations restricting actions', () => {
    const labels = items => items.filter(item => item.label).map(item => item.label);
    assert.deepEqual(labels(contextMenuItems({ linkURL: 'https://example.com/' }, { sourceAvailable: true })).slice(0, 3), ['Open link in new tab', 'Copy link address', 'Download linked file']);
    assert.ok(labels(contextMenuItems({ mediaType: 'image', srcURL: 'https://example.com/a.png' })).includes('Copy image address'));
    assert.ok(labels(contextMenuItems({ selectionText: 'hello', editFlags: {} }, { searchName: 'Kagi' })).includes('Search Kagi for “hello”'));
    const editable = contextMenuItems({ isEditable: true, misspelledWord: 'teh', dictionarySuggestions: ['the'], editFlags: { canPaste: true } });
    assert.deepEqual(labels(editable).slice(0, 2), ['the', 'Add “teh” to dictionary']);
    assert.equal(editable.find(item => item.id === 'paste').enabled, true);
    const page = contextMenuItems({}, { canGoBack: true, sourceAvailable: true });
    assert.ok(['Back', 'Forward', 'Reload', 'Save page to workspace', 'Print…', 'View page source', 'Inspect'].every(label => labels(page).includes(label)));
    const restricted = contextMenuItems({}, { protectedOperation: 'credential fill', sourceAvailable: true });
    assert.equal(restricted.find(item => item.id === 'inspect').enabled, false);
    assert.equal(restricted.find(item => item.id === 'print').enabled, false);
    assert.equal(contextMenuItems({ linkURL: 'javascript:alert(1)' }).find(item => item.id === 'open-link').enabled, false);
  });
  test('search engine templates: https only, exactly one %s', () => {
    assert.equal(templateProblem('https://search.example/?q=%s'), null);
    assert.match(templateProblem('http://search.example/?q=%s'), /https/);
    assert.match(templateProblem('https://search.example/?q='), /exactly once/);
    assert.match(templateProblem('https://search.example/?q=%s&r=%s'), /exactly once/);
    assert.match(templateProblem('https://user:pw@search.example/?q=%s'), /credentials/);
    assert.equal(searchUrl({}, 'a b'), 'https://www.google.com/search?q=a%20b');
    assert.equal(searchUrl({ searchEngine: { preset: 'custom', template: 'https://s.example/?q=%s' } }, 'x&y'), 'https://s.example/?q=x%26y');
    assert.equal(searchUrl({ searchEngine: { preset: 'custom', template: 'http://bad/?q=%s' } }, 'x'), 'https://www.google.com/search?q=x');
  });
  for (const [name, flag, marker] of [['browser chrome in real Chromium: page shortcuts, context menu, find, zoom, closed tabs, order, DevTools and source', '--chrome-browser', 'WEFT_CHROME_BROWSER_OK'],
    ['browser chrome in the real GUI: shortcuts inside a page, find bar, zoom indicator, suggestions, search engine and tab reordering', '--chrome-gui', 'WEFT_CHROME_GUI_OK']]) {
    test(name, { skip: !process.env.DISPLAY && process.platform === 'linux' ? 'requires a display' : false, timeout: scaled(120000) }, async () => {
      const profile = mkdtempSync(join(tmpdir(), 'weft-chrome-'));
      const reservation = createServer();
      await new Promise(resolve => reservation.listen(0, '127.0.0.1', resolve));
      const port = reservation.address().port;
      await new Promise(resolve => reservation.close(resolve));
      const child = spawn(electron, ['--no-sandbox', '--disable-gpu', fileURLToPath(import.meta.url), flag],
        { env: electronEnv({ WEFT_TEST_PROFILE: profile, WEFT_PORT: String(port), WEFT_TOKEN: 'chrome-fixture-token-0123456789abcdef0123' }), stdio: ['ignore', 'pipe', 'pipe'] });
      let output = '';
      child.stdout.on('data', chunk => (output += chunk));
      child.stderr.on('data', chunk => (output += chunk));
      const timer = setTimeout(() => child.kill('SIGKILL'), scaled(110000));
      try {
        const code = await new Promise((resolve, reject) => { child.on('exit', resolve); child.on('error', reject); });
        assert.equal(code, 0, output);
        assert.match(output, new RegExp(marker));
      } finally { clearTimeout(timer); rmSync(profile, { recursive: true, force: true }); }
    });
  }
}
