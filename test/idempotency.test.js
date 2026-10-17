import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WorkspaceService } from '../src/workspace.js';
import { Browser } from '../src/browser.js';
import { AutomationAdmission } from '../src/admission.js';
import { ClientGrants } from '../src/clients.js';
import { createDispatcher } from '../src/dispatch.js';
import { createApiServer } from '../src/server.js';
import { commands } from '../src/commands.js';
import { REQUEST_RETENTION } from '../src/store.js';
import { beforeRemoval, closeAfter, removeAfter } from './temp-profile.js';

const human = { actor: 'human', source: 'gui' };
const cliPath = fileURLToPath(new URL('../bin/weft.js', import.meta.url));
function service(t, options = {}) {
  const directory = mkdtempSync(join(tmpdir(), 'weft-idempotency-'));
  const workspace = new WorkspaceService({ directory, onWarning() {}, ...options });
  removeAfter(t, directory); closeAfter(t, workspace);
  return { directory, workspace };
}
async function api(t) {
  const directory = mkdtempSync(join(tmpdir(), 'weft-idempotency-api-'));
  const workspace = new WorkspaceService({ directory, onWarning() {} });
  const firstId = workspace.activeWorkspaceId;
  const other = await workspace.execute('workspaces.create', { name: 'Other project' }, human);
  await workspace.execute('workspaces.switch', { id: firstId }, human);
  const session = new EventEmitter();
  session.setPermissionRequestHandler = () => {};
  session.setPermissionCheckHandler = () => {};
  const admission = new AutomationAdmission();
  const browser = new Browser({ session, workspaceService: workspace, admission, electronApi: {} });
  browser.tabs.set(1, { id: 1, workspaceId: firstId, version: 1, controller: 'available', view: { webContents: { getURL: () => 'about:blank', getTitle: () => 'Fixture', stop() {}, isDestroyed: () => false, close() {} } } });
  browser.activeId = 1;
  const token = 'idempotency-master';
  const clients = new ClientGrants({ directory, masterToken: token, workspace });
  const dispatch = createDispatcher({ workspace, browser, clients, providers: { close() {} }, admission });
  const server = createApiServer({ execute: dispatch, token, authenticate: value => clients.authenticate(value), executeReturnsOutcome: true });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${server.address().port}`;
  removeAfter(t, directory); beforeRemoval(t, async () => { await new Promise(resolve => server.close(resolve)); browser.close(); workspace.close(); });
  const request = async (command, args = {}, bearer = token) => {
    const response = await fetch(`${url}/v1/execute`, { method: 'POST', headers: { authorization: `Bearer ${bearer}`, 'content-type': 'application/json' }, body: JSON.stringify({ command, args }) });
    return { status: response.status, outcome: await response.json() };
  };
  const cli = async (command, args) => {
    let result;
    try { result = await promisify(execFile)(process.execPath, [cliPath, command, JSON.stringify(args)], { env: { ...process.env, WEFT_API_URL: url, WEFT_TOKEN: token } }); }
    catch (error) { result = error; }
    return { outcome: JSON.parse(result.stdout), code: result.code ?? 0 };
  };
  return { workspace, firstId, other, dispatch, request, cli, clients };
}

test('catalog exposes requestId on mutations and dryRun on destructive record commands', () => {
  for (const name of ['materials.create', 'tasks.update', 'tasks.transition', 'artifacts.create', 'artifacts.capture', 'conversations.message', 'workspaces.import', 'batch.execute']) assert.ok(commands[name].inputSchema.properties.requestId, name);
  for (const name of ['materials.delete', 'artifacts.delete', 'workspaces.delete', 'bookmarks.delete', 'workspaces.import', 'batch.execute']) assert.ok(commands[name].inputSchema.properties.dryRun, name);
  for (const name of ['materials.list', 'search.query', 'page.navigate', 'tabs.new']) assert.equal(commands[name].inputSchema.properties.requestId, undefined, name);
  assert.equal(commands['batch.execute'].actionClass, 'local_write');
});

test('identical retries replay the committed result over REST and CLI; changed payloads conflict', { timeout: 20000 }, async t => {
  const f = await api(t);
  const args = { workspaceId: f.firstId, title: 'Retry-safe task', requestId: 'agent-run-1:task-1' };
  const first = await f.request('tasks.create', args);
  assert.equal(first.status, 200);
  assert.deepEqual(first.outcome.idempotency, { requestId: args.requestId, replayed: false });
  const retry = await f.request('tasks.create', args);
  assert.deepEqual(retry.outcome.idempotency, { requestId: args.requestId, replayed: true });
  assert.deepEqual(retry.outcome.result, first.outcome.result);
  const cli = await f.cli('tasks.create', args);
  assert.equal(cli.outcome.idempotency.replayed, true);
  assert.equal(cli.outcome.result.id, first.outcome.result.id);
  assert.equal((await f.workspace.execute('tasks.list', { workspaceId: f.firstId })).length, 1);
  const conflict = await f.request('tasks.create', { ...args, title: 'Different task' });
  assert.equal(conflict.status, 409);
  assert.equal(conflict.outcome.error.code, 'idempotency_conflict');
  assert.equal((await f.cli('tasks.create', { ...args, title: 'Different task' })).code, 3);
  assert.equal((await f.workspace.execute('tasks.list', { workspaceId: f.firstId })).length, 1);
  // Identities are scoped to the caller; the human GUI is a different scope.
  const human = await f.dispatch('tasks.create', args, { actor: 'human', source: 'gui' });
  assert.equal(human.idempotency.replayed, false);
  assert.notEqual(human.result.id, first.outcome.result.id);
});

test('request identities are atomic with the mutation, survive restart and expire to bounded tombstones', async t => {
  let now = Date.parse('2026-10-01T00:00:00Z');
  const { workspace, directory } = service(t, { clock: () => now });
  workspace.storage.clock = () => now;
  // A failed command records nothing, so a corrected retry with the same id applies.
  await assert.rejects(workspace.execute('materials.update', { id: 'missing', changes: { title: 'x' }, requestId: 'r1' }), /not found/);
  const note = await workspace.execute('materials.create', { title: 'Note', requestId: 'r2' });
  workspace.close();
  const reopened = new WorkspaceService({ directory, onWarning() {}, clock: () => now });
  closeAfter(t, reopened);
  reopened.storage.clock = () => now;
  const replay = await reopened.execute('materials.create', { title: 'Note', requestId: 'r2' });
  assert.equal(replay.id, note.id);
  assert.equal(replay[Symbol.for('weft.replayed')], true);
  now += REQUEST_RETENTION.resultMs + 1;
  reopened.storage.pruneRequests(true);
  await assert.rejects(reopened.execute('materials.create', { title: 'Note', requestId: 'r2' }), error => error.code === 'already_committed');
  await assert.rejects(reopened.execute('materials.create', { title: 'Other', requestId: 'r2' }), error => error.code === 'idempotency_conflict');
  now += REQUEST_RETENTION.fingerprintMs;
  reopened.storage.pruneRequests(true);
  await reopened.execute('materials.create', { title: 'Note', requestId: 'r2' });
  assert.equal((await reopened.execute('materials.list')).length, 2);
});

test('oversized results are not retained but retries still never apply twice', async t => {
  const { workspace } = service(t);
  const args = { title: 'Large file', kind: 'file', filename: 'large.bin', fileBase64: Buffer.alloc(1536 * 1024, 7).toString('base64'), requestId: 'large-1' };
  await workspace.execute('materials.create', args);
  await assert.rejects(workspace.execute('materials.create', args), error => error.code === 'already_committed' && /1 MiB/.test(error.message));
  assert.equal((await workspace.execute('materials.list')).length, 1);
});

test('batches validate everything first and apply all-or-nothing in one transaction', async t => {
  const { workspace } = service(t);
  const before = workspace.storage.contentDigest();
  // Invalid argument in the third command: nothing applies, the error names the command.
  await assert.rejects(workspace.execute('batch.execute', { commands: [
    { command: 'materials.create', args: { title: 'One' } }, { command: 'tasks.create', args: { title: 'Two' } }, { command: 'context.create', args: { title: '', unknown: true } },
  ] }), error => error.issues?.[0]?.path?.slice(0, 3).join('.') === 'commands.2.args');
  // Runtime failure after earlier commands applied in memory: everything rolls back.
  await assert.rejects(workspace.execute('batch.execute', { commands: [
    { command: 'materials.create', args: { title: 'One' } }, { command: 'tasks.update', args: { id: 'missing', changes: { title: 'x' } } },
  ] }), /batch command 1 \(tasks\.update\).*not found/);
  assert.equal(workspace.storage.contentDigest(), before);
  assert.deepEqual(workspace.snapshot().materials, []);
  const result = await workspace.execute('batch.execute', { commands: [
    { command: 'materials.create', args: { title: 'Source' } },
    { command: 'tasks.create', args: { title: 'Use source', materialIds: ['$0.id'] } },
    { command: 'tasks.transition', args: { id: '$1.id', status: 'running', cause: 'batched' } },
  ] });
  assert.equal(result.atomic, true);
  assert.equal(result.count, 3);
  assert.deepEqual(result.results[1].materialIds, [result.results[0].id]);
  assert.equal(result.results[2].status, 'running');
  await assert.rejects(workspace.execute('batch.execute', { commands: [{ command: 'tasks.create', args: { title: 'Bad ref', materialIds: ['$5.id'] } }] }), /Placeholder/);
});

test('batches reject irreversible or nested commands and keep authority checks per command', async t => {
  const { workspace } = service(t);
  for (const command of ['artifacts.capture', 'page.navigate', 'workspaces.delete', 'workspaces.create', 'workspaces.import', 'backups.create', 'batch.execute']) {
    await assert.rejects(workspace.execute('batch.execute', { commands: [{ command, args: {} }] }), /cannot run in an atomic batch/, command);
  }
  await assert.rejects(workspace.execute('batch.execute', { commands: [{ command: 'tasks.create', args: { title: 'x', requestId: 'inner' } }] }), /whole batch/);
  const before = workspace.storage.contentDigest();
  await assert.rejects(workspace.execute('batch.execute', { commands: [{ command: 'tasks.create', args: { title: 'ok' } }, { command: 'siteRules.create', args: { hostname: 'example.com' } }] }, { actor: 'automation' }), /PERMISSION_REQUIRED/);
  await assert.rejects(workspace.execute('batch.execute', { commands: [{ command: 'context.create', args: { title: 'Injected', category: 'instructions' } }] }, { actor: 'agent' }), /PERMISSION_REQUIRED/);
  assert.equal(workspace.storage.contentDigest(), before);
});

test('dispatcher batches enforce client grants and catalog validation for every command', { timeout: 15000 }, async t => {
  const f = await api(t);
  const granted = await f.dispatch('clients.create', { name: 'Batch client', scopes: ['records.write', 'read'], workspaceIds: [f.firstId] }, human);
  const token = granted.result.token;
  const crossing = await f.request('batch.execute', { commands: [{ command: 'materials.create', args: { title: 'Mine' } }, { command: 'materials.create', args: { title: 'Theirs', workspaceId: f.other.id } }] }, token);
  assert.equal(crossing.outcome.error.code, 'permission_required');
  assert.match(crossing.outcome.error.message, /batch command 1/);
  const invalid = await f.request('batch.execute', { commands: [{ command: 'materials.create', args: { title: 'x', bogus: 1 } }] }, token);
  assert.equal(invalid.outcome.error.code, 'invalid_arguments');
  assert.equal(invalid.outcome.error.field, 'commands.0.args.bogus');
  const page = await f.request('batch.execute', { commands: [{ command: 'page.navigate', args: { url: 'https://example.com' } }] });
  assert.equal(page.outcome.error.code, 'invalid_arguments');
  assert.equal((await f.workspace.execute('materials.list', { workspaceId: f.other.id })).length, 0);
  const ok = await f.request('batch.execute', { commands: [{ command: 'materials.create', args: { title: 'Mine' } }, { command: 'tasks.create', args: { title: 'Mine too', materialIds: ['$0.id'] } }], requestId: 'batch-1' }, token);
  assert.equal(ok.outcome.execution, 'succeeded');
  assert.equal(ok.outcome.workspaceId, f.firstId);
  const replay = await f.request('batch.execute', { commands: [{ command: 'materials.create', args: { title: 'Mine' } }, { command: 'tasks.create', args: { title: 'Mine too', materialIds: ['$0.id'] } }], requestId: 'batch-1' }, token);
  assert.equal(replay.outcome.idempotency.replayed, true);
  assert.equal((await f.workspace.execute('materials.list', { workspaceId: f.firstId })).length, 1);
});

test('dry runs report exact changes without committing or touching the browser', async t => {
  const calls = [];
  const browser = { switchWorkspace: id => calls.push(['switch', id]), closeWorkspace: id => calls.push(['close', id]) };
  const { workspace } = service(t, { browser });
  const second = await workspace.execute('workspaces.create', { name: 'Doomed' });
  const note = await workspace.execute('materials.create', { title: 'Inside', workspaceId: second.id });
  await workspace.execute('artifacts.create', { title: 'Capture', text: 'kept', workspaceId: second.id });
  calls.length = 0;
  const before = workspace.storage.contentDigest();
  const preview = await workspace.execute('workspaces.delete', { id: second.id, dryRun: true });
  assert.equal(preview.dryRun, true);
  assert.equal(preview.applied, false);
  assert.deepEqual(preview.result, { deleted: true, id: second.id });
  assert.deepEqual(preview.changes.deleted.items.filter(item => item.collection !== 'activity').map(item => item.collection).sort(), ['artifacts', 'materials', 'workspaces']);
  assert.ok(preview.changes.state.includes('activeWorkspaceId'));
  assert.deepEqual(calls, []);
  assert.equal(workspace.storage.contentDigest(), before);
  const recordPreview = await workspace.execute('materials.delete', { id: note.id, dryRun: true });
  assert.deepEqual(recordPreview.changes.deleted.items, [{ collection: 'materials', id: note.id }]);
  const batchPreview = await workspace.execute('batch.execute', { dryRun: true, commands: [{ command: 'materials.delete', args: { id: note.id } }, { command: 'tasks.create', args: { title: 'Planned', workspaceId: second.id } }] });
  assert.equal(batchPreview.result.count, 2);
  assert.equal(batchPreview.changes.created.items.filter(item => item.collection === 'tasks').length, 1);
  assert.equal(workspace.storage.contentDigest(), before);
  assert.equal((await workspace.execute('artifacts.list', { workspaceId: second.id })).length, 1);
  await workspace.execute('workspaces.delete', { id: second.id });
  assert.deepEqual(calls.map(([kind]) => kind), ['close', 'switch']);
});
