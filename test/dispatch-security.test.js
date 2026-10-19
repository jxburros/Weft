import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { EventEmitter } from 'node:events';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { Browser } from '../src/browser.js';
import { WorkspaceService } from '../src/workspace.js';
import { AutomationAdmission } from '../src/admission.js';
import { ClientGrants } from '../src/clients.js';
import { createDispatcher } from '../src/dispatch.js';
import { createApiServer } from '../src/server.js';
import { budget } from './time-budget.js';
import { redactPaths } from '../src/activity-log.js';

const human = { actor: 'human', source: 'gui' };
const cliPath = fileURLToPath(new URL('../bin/weft.js', import.meta.url));
async function fixture(t) {
  const directory = mkdtempSync(join(tmpdir(), 'weft-dispatch-security-'));
  const workspace = new WorkspaceService({ directory });
  const firstId = workspace.activeWorkspaceId;
  const other = await workspace.execute('workspaces.create', { name: 'Other project' }, human);
  const privateNote = await workspace.execute('materials.create', { workspaceId: other.id, title: 'Private note', content: 'Do not cross workspace grants' }, human);
  const session = new EventEmitter();
  session.setPermissionRequestHandler = () => {};
  session.setPermissionCheckHandler = () => {};
  const admission = new AutomationAdmission();
  const browser = new Browser({ session, workspaceService: workspace, admission, electronApi: {} });
  for (const [id, workspaceId] of [[1, firstId], [2, other.id]]) browser.tabs.set(id, {
    id, workspaceId, version: 1, controller: 'available', view: { webContents: {
      getURL: () => 'about:blank', getTitle: () => 'Fixture', stop: () => {},
      isDestroyed: () => false, close: () => {},
    } },
  });
  browser.activeId = 1;
  browser.downloads.set(1, { item: null, record: { id: 1, workspaceId: other.id, state: 'completed' } });
  const token = 'dispatch-security-master';
  const clients = new ClientGrants({ directory, masterToken: token, workspace });
  let closed = 0;
  const providers = { close() { closed++; }, execute() { throw new Error('Unexpected provider call'); } };
  const dispatch = createDispatcher({ workspace, browser, clients, providers, admission });
  const server = createApiServer({ execute: dispatch, token, authenticate: value => clients.authenticate(value), executeReturnsOutcome: true });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${server.address().port}`;
  const request = async (command, args = {}, bearer = token) => {
    const response = await fetch(`${url}/v1/execute`, { method: 'POST', headers: { authorization: `Bearer ${bearer}`, 'content-type': 'application/json' }, body: JSON.stringify({ command, args }) });
    return { status: response.status, outcome: await response.json() };
  };
  const cli = async (command, args = {}, bearer = token) => {
    let result;
    try { result = await promisify(execFile)(process.execPath, [cliPath, command, JSON.stringify(args)], { env: { ...process.env, WEFT_API_URL: url, WEFT_TOKEN: bearer } }); }
    catch (error) { result = error; }
    return JSON.parse(result.stdout);
  };
  t.after(async () => { await new Promise(resolve => server.close(resolve)); browser.close(); workspace.close?.(); rmSync(directory, { recursive: true, force: true, maxRetries: 5 }); });
  return { workspace, firstId, other, privateNote, browser, admission, clients, dispatch, request, cli, url, token, closed: () => closed };
}

test('central emergency stop blocks REST, CLI, MCP and internal agent dispatch until human resume', { timeout: budget(15000) }, async t => {
  const f = await fixture(t);
  const mcp = new Client({ name: 'admission-test', version: '1' });
  await mcp.connect(new StdioClientTransport({ command: process.execPath, args: [cliPath, 'mcp'], env: { WEFT_API_URL: f.url, WEFT_TOKEN: f.token } }));
  t.after(() => mcp.close());
  const stopped = await f.dispatch('browser.emergencyStop', {}, human);
  assert.equal(stopped.result.stopped, true);
  assert.equal(f.closed(), 1);
  const args = { workspaceId: f.firstId, tabId: 1 };
  const rest = await f.request('page.inspect', args);
  assert.equal(rest.status, 409);
  assert.equal(rest.outcome.error.code, 'emergency_stop');
  assert.equal((await f.cli('page.inspect', args)).error.code, 'emergency_stop');
  const result = await mcp.callTool({ name: 'weft_page', arguments: { action: 'page.inspect', args } });
  assert.equal(result.isError, true);
  assert.equal(JSON.parse(result.content[0].text).error.code, 'emergency_stop');
  assert.equal((await f.dispatch('search.query', { workspaceId: f.firstId, query: 'note' }, { actor: 'model-reader' })).error.code, 'emergency_stop');
  assert.equal((await f.dispatch('browser.resumeAutomation', {}, { actor: 'automation' })).error.code, 'emergency_stop');
  assert.equal((await f.dispatch('page.inspect', args, human)).error, null);
  assert.equal((await f.dispatch('browser.resumeAutomation', {}, human)).error, null);
  assert.equal((await f.request('page.inspect', args)).outcome.error, null);
  assert.equal(f.browser.tab(1).controller, 'human', 'resume does not give away tab control');
});

test('resolved targets are explicit and echoed across REST, CLI and MCP', { timeout: budget(15000) }, async t => {
  const f = await fixture(t);
  assert.equal((await f.request('page.inspect')).outcome.error.code, 'ambiguous_target');
  assert.equal((await f.request('workspace.snapshot')).outcome.error.code, 'ambiguous_target');
  const humanSnapshot = await f.dispatch('workspace.snapshot', {}, human);
  assert.equal(humanSnapshot.result.workspaces.length, 2, 'GUI workspace rail retains all projects');
  const scopedSnapshot = await f.request('workspace.snapshot', { workspaceId: f.firstId });
  assert.equal(scopedSnapshot.outcome.result.workspaces.length, 1);
  assert.equal((await f.request('page.inspect', { workspaceId: f.firstId })).outcome.error.code, 'ambiguous_target');
  assert.equal((await f.request('page.inspect', { workspaceId: f.firstId, tabId: 2 })).outcome.error.code, 'target_mismatch');
  const args = { workspaceId: f.other.id, tabId: 2 };
  const outcomes = [(await f.request('page.inspect', args)).outcome, await f.cli('page.inspect', args)];
  const mcp = new Client({ name: 'target-test', version: '1' });
  await mcp.connect(new StdioClientTransport({ command: process.execPath, args: [cliPath, 'mcp'], env: { WEFT_API_URL: f.url, WEFT_TOKEN: f.token } }));
  try { outcomes.push(JSON.parse((await mcp.callTool({ name: 'weft_page', arguments: { action: 'page.inspect', args } })).content[0].text)); }
  finally { await mcp.close(); }
  for (const outcome of outcomes) {
    assert.equal(outcome.error, null);
    assert.equal(outcome.workspaceId, f.other.id);
    assert.equal(outcome.tabId, 2);
  }
  const humanDefault = await f.dispatch('page.inspect', {}, human);
  assert.equal(humanDefault.workspaceId, f.firstId);
  assert.equal(humanDefault.tabId, 1);
});

test('scoped clients cannot read, mutate or cancel another workspace and revocation applies immediately', { timeout: budget(15000) }, async t => {
  const f = await fixture(t);
  const created = await f.dispatch('clients.create', { name: 'Researcher', scopes: ['read', 'records.write', 'tabs.control'], workspaceIds: [f.firstId] }, human);
  assert.equal(created.error, null);
  const { token, clientId } = created.result;
  const deniedRecord = (await f.request('materials.get', { id: f.privateNote.id }, token)).outcome;
  assert.equal(deniedRecord.error.code, 'permission_required');
  assert.equal(deniedRecord.workspaceId, null, 'foreign record workspace is not disclosed');
  for (const [command, args] of [
    ['materials.get', { id: f.privateNote.id }],
    ['materials.update', { id: f.privateNote.id, changes: { title: 'Tampered' } }],
    ['materials.list', { workspaceId: f.other.id }],
    ['workspaces.get', { id: f.other.id }],
    ['page.inspect', { workspaceId: f.other.id, tabId: 2 }],
    ['downloads.cancel', { downloadId: 1 }],
    ['page.evaluate', { tabId: 1, expression: '42' }],
    ['cookies.list', { workspaceId: f.firstId }],
    ['browser.close', {}],
  ]) {
    const result = await f.request(command, args, token);
    assert.ok(result.outcome.error, `${command} must fail`);
  }
  assert.equal(f.browser.downloads.get(1).record.state, 'completed');
  assert.equal(f.workspace.record('materials', f.privateNote.id).title, 'Private note');
  const listed = (await f.request('workspaces.list', {}, token)).outcome.result;
  assert.deepEqual(listed.map(record => record.id), [f.firstId]);
  const snapshot = (await f.request('workspace.snapshot', {}, token)).outcome.result;
  assert.deepEqual(snapshot.workspaces.map(record => record.id), [f.firstId]);
  assert.equal(snapshot.materials.some(record => record.id === f.privateNote.id), false);
  assert.equal((await f.request('materials.list', {}, token)).outcome.workspaceId, f.firstId);
  assert.equal((await f.dispatch('clients.revoke', { clientId }, human)).error, null);
  assert.equal((await f.request('materials.list', {}, token)).status, 401);
  assert.equal((await f.request('materials.list', { workspaceId: f.firstId })).outcome.error, null);
});

test('emergency stop aborts providers even when pausing a task cannot persist', { timeout: budget(10000) }, async t => {
  const f = await fixture(t);
  await f.workspace.execute('tasks.create', { workspaceId: f.firstId, title: 'Running task', status: 'running' }, human);
  const original = f.workspace.execute.bind(f.workspace);
  f.workspace.execute = (name, ...args) => {
    if (name === 'tasks.transition') throw new Error('Simulated disk write failure');
    return original(name, ...args);
  };
  const result = await f.dispatch('browser.emergencyStop', {}, human);
  assert.ok(result.error);
  assert.equal(f.admission.status.stopped, true);
  assert.equal(f.closed(), 1, 'active providers must abort even if task metadata cannot be saved');
});

test('independent scoped clients contend for leases and expiry stops new admission', { timeout: budget(10000) }, async t => {
  const f = await fixture(t);
  const grants = [];
  for (const name of ['First agent', 'Second agent']) grants.push((await f.dispatch('clients.create', { name, scopes: ['read', 'tabs.control'], workspaceIds: [f.firstId], ttlSeconds: 60 }, human)).result);
  const first = await f.request('tabs.claim', { workspaceId: f.firstId, tabId: 1 }, grants[0].token);
  assert.equal(first.outcome.error, null);
  assert.equal(first.outcome.result.controller, `client:${grants[0].clientId}`);
  const second = await f.request('tabs.claim', { workspaceId: f.firstId, tabId: 1 }, grants[1].token);
  assert.equal(second.outcome.error.code, 'lease_conflict');
  assert.equal((await f.request('tabs.release', { workspaceId: f.firstId, tabId: 1 }, grants[1].token)).outcome.error.code, 'lease_conflict');
  f.clients.clock = () => grants[0].expiresAt + 1;
  assert.equal((await f.request('page.inspect', { workspaceId: f.firstId, tabId: 1 }, grants[0].token)).status, 401);
});

test('untyped errors never show agents local paths; activity details are path-free too (#126)', async t => {
  const directory = mkdtempSync(join(tmpdir(), 'weft-error-paths-'));
  const workspace = new WorkspaceService({ directory });
  t.after(() => { workspace.close(); rmSync(directory, { recursive: true, force: true }); });
  const leaked = '/home/someone/.config/weft/workspace-data/model-connections.json';
  const providers = { close() {}, execute() { throw Object.assign(new Error(`ENOENT: no such file or directory, open '${leaked}'`), { code: 'ENOENT' }); } };
  const dispatch = createDispatcher({ workspace, providers, admission: new AutomationAdmission() });
  const agent = await dispatch('models.list', {}, { actor: 'automation' });
  assert.equal(agent.error.code, 'command_failed');
  assert.equal(agent.error.message, "ENOENT: no such file or directory, open '<path>'");
  const person = await dispatch('models.list', {}, human);
  assert.match(person.error.message, /model-connections\.json/, 'the person still sees the path');
  assert.doesNotMatch(readFileSync(join(directory, 'activity-log.jsonl'), 'utf8'), /someone/, 'activity detail has no local path');
  assert.equal(redactPaths('C:\\Users\\me\\weft\\x.json failed; see https://example.com/a/b/c and GET /v1/commands'), '<path> failed; see https://example.com/a/b/c and GET /v1/commands');
});
