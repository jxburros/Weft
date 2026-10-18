import { EventEmitter } from 'node:events';
import { Browser } from '../../src/browser.js';
import { WorkspaceService } from '../../src/workspace.js';
import { AutomationAdmission } from '../../src/admission.js';
import { ClientGrants } from '../../src/clients.js';
import { createDispatcher } from '../../src/dispatch.js';
import { TaskRuntime } from '../../src/task-runtime.js';

export const human = { actor: 'human', source: 'gui' };

/**
 * A real workspace store, authority gate, client grants and task runtime over a
 * browser whose tabs are scripted fakes. `page.hold(tabId)` makes the next page
 * script on that tab hang until released, to simulate a step in flight.
 */
export function createRuntimeFixture({ directory, providers = null, credentials, credentialService = null, paymentService = null, pages = { 1: 'https://shop.example.com/cart' } } = {}) {
  const workspace = new WorkspaceService({ directory });
  const workspaceId = workspace.activeWorkspaceId;
  const session = new EventEmitter();
  session.setPermissionRequestHandler = () => {};
  session.setPermissionCheckHandler = () => {};
  const admission = new AutomationAdmission();
  const browser = new Browser({ session, workspaceService: workspace, admission, electronApi: {} });
  workspace.attachBrowser(browser);
  const scripts = [];
  const holds = new Map();
  const missing = new Set();
  const page = {
    urls: { ...pages },
    /** Hold the next page script on this tab; resolve or reject it later. */
    hold(tabId) {
      let control;
      const ready = new Promise(resolve => { control = { resolve: null, reject: null, started: resolve }; });
      holds.set(Number(tabId), control);
      return { started: ready, release: value => control.resolve(value), fail: error => control.reject(error) };
    },
    missing(selector) { missing.add(selector); },
  };
  const addTab = (id, url) => {
    page.urls[id] = url;
    browser.tabs.set(id, { id, workspaceId, version: 1, controller: 'available', view: { webContents: {
      getURL: () => page.urls[id], getTitle: () => 'Fixture', stop: () => {}, reload: () => {}, isDestroyed: () => false, close: () => {},
      loadURL: async url => { page.urls[id] = url; }, sendInputEvent: () => {}, focus: () => {}, navigationHistory: { canGoBack: () => false, canGoForward: () => false },
      executeJavaScript: async source => {
        scripts.push({ tabId: id, source });
        const held = holds.get(id);
        if (held) {
          holds.delete(id);
          return new Promise((resolve, reject) => { held.resolve = resolve; held.reject = reject; held.started(); });
        }
        const selector = /"selector":"((?:[^"\\]|\\.)*)"/.exec(source)?.[1];
        if (selector && missing.has(JSON.parse(`"${selector}"`))) return { ok: false, reason: 'not_found' };
        if (/\("(?:click|fill)", \{/.test(source)) return { ok: true };
        return { url: page.urls[id], title: 'Fixture', text: 'Fixture page text', links: [] };
      },
    } } });
  };
  for (const [id, url] of Object.entries(pages)) addTab(Number(id), url);
  browser.activeId = Number(Object.keys(pages)[0]);
  const clients = new ClientGrants({ directory, masterToken: 'runtime-master-token', workspace });
  // A factory receives the workspace and browser, so a real credential broker service can be wired in.
  const service = typeof credentialService === 'function' ? credentialService({ workspace, browser }) : credentialService;
  const tasks = new TaskRuntime({ workspace, browser, admission, clients, providers, ...(credentials || service ? { credentials: credentials ?? service } : {}) });
  // A factory receives the workspace, browser and credential service, so a real payment service can be wired in (ADR 019).
  const payments = typeof paymentService === 'function' ? paymentService({ workspace, browser, credentials: service }) : paymentService;
  const events = [];
  const dispatch = createDispatcher({ workspace, browser, clients, providers: providers ?? { close() {}, stopAll() {}, execute() { throw new Error('No model provider in this fixture'); } }, admission, tasks, credentials: service, payments, onEvent: event => events.push(event) });
  const run = async (command, args = {}, context = human) => {
    const outcome = await dispatch(command, args, context);
    if (outcome.error) throw Object.assign(new Error(`${command}: ${outcome.error.code}: ${outcome.error.message}`), { outcome });
    return outcome.result;
  };
  const attempt = (command, args = {}, context = human) => dispatch(command, args, context);
  const task = id => workspace.data.tasks.find(item => item.id === id);
  const settle = async id => { for (let i = 0; i < 50; i++) { await tasks.idle(id); await new Promise(resolve => setImmediate(resolve)); if (!tasks.active.has(id)) return task(id); } return task(id); };
  let closed = false;
  const close = () => { if (closed) return; closed = true; tasks.close(); service?.close?.(); browser.close(); workspace.close(); };
  return { credentialService: service, payments, workspace, workspaceId, browser, admission, clients, tasks, dispatch, run, attempt, task, settle, scripts, page, addTab, events, close, authority: dispatch.authority };
}
