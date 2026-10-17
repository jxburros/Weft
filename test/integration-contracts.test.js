import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { WorkspaceService } from '../src/workspace.js';
import { AutomationAdmission } from '../src/admission.js';
import { ClientGrants } from '../src/clients.js';
import { createDispatcher } from '../src/dispatch.js';
import { createApiServer, EventLog, sanitizeEvent, EVENT_TYPES } from '../src/server.js';
import { createClient } from '../src/client.js';
import { createMcpServer } from '../src/mcp.js';
import { commands, OUTCOME_STATUSES, ERROR_STATUS, ERROR_HTTP_STATUS, exitCodes, resultExitCode, resultHttpStatus } from '../src/commands.js';
import { PAGEABLE } from '../src/pagination.js';
import { Transfers, CHUNK_BYTES } from '../src/transfers.js';
import { png, fakeEndpoint, modelFixture, sse, openaiDelta } from './model-test-helpers.js';

const cli = fileURLToPath(new URL('../bin/weft.js', import.meta.url));
const human = { actor: 'human', source: 'gui' };
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

/** Real workspace service, dispatcher, event log, REST server, CLI and MCP bridge over a stub browser. */
async function stack(t) {
  const directory = mkdtempSync(join(tmpdir(), 'weft-contracts-'));
  const workspace = new WorkspaceService({ directory, onWarning() {} });
  const firstId = workspace.activeWorkspaceId;
  const other = await workspace.execute('workspaces.create', { name: 'Other project' }, human);
  await workspace.execute('workspaces.switch', { id: firstId }, human);
  const admission = new AutomationAdmission();
  const token = 'contracts-master-token';
  const clients = new ClientGrants({ directory, masterToken: token, workspace });
  const browser = { tabs: new Map(), downloads: new Map(), activeId: null, behavior: null, captureDelay: 0,
    tab(id) { const tab = this.tabs.get(id); if (!tab) throw Object.assign(new Error('Tab not found'), { code: 'not_found' }); return tab; },
    async execute(name, args, context) { return this.behavior ? this.behavior(name, args, context) : name === 'browser.info' ? { automation: admission.status } : { ok: true }; },
    async captureArtifact() { await sleep(this.captureDelay); return { text: 'captured text', title: 'Captured page', url: 'https://example.com/' }; } };
  workspace.attachBrowser(browser);
  const events = [];
  const eventLog = new EventLog();
  const transfers = new Transfers({ workspace });
  const dispatch = createDispatcher({ workspace, browser, clients, admission, transfers, eventLog, providers: { close() {} },
    onEvent: event => { events.push(event); eventLog.append(sanitizeEvent(event)); } });
  const server = createApiServer({ execute: dispatch, token, authenticate: value => clients.authenticate(value), executeReturnsOutcome: true, eventLog, subscribe: () => () => {} });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${server.address().port}`;
  const client = createClient({ url, token });
  const mcpServer = createMcpServer(client);
  const mcp = new Client({ name: 'contracts', version: '1' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await mcpServer.connect(serverTransport); await mcp.connect(clientTransport);
  t.after(async () => { await mcp.close(); await mcpServer.close(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); await sleep(20); workspace.close(); rmSync(directory, { recursive: true, force: true }); });
  const rest = async (command, args = {}, { bearer = token, headers = {}, body = {} } = {}) => {
    const response = await fetch(`${url}/v1/execute`, { method: 'POST', headers: { authorization: `Bearer ${bearer}`, 'content-type': 'application/json', ...headers }, body: JSON.stringify({ command, args, ...body }) });
    return { http: response.status, outcome: await response.json() };
  };
  const runCli = async (args, bearer = token) => {
    let result;
    try { result = await promisify(execFile)(process.execPath, [cli, ...args], { env: { ...process.env, WEFT_API_URL: url, WEFT_TOKEN: bearer } }); }
    catch (error) { result = error; }
    return { outcome: JSON.parse(result.stdout), exit: result.code ?? 0 };
  };
  const tool = async (command, args = {}, extra = {}) => {
    const name = (await mcp.listTools()).tools.find(item => item.inputSchema.properties.action?.enum.includes(command)).name;
    return (await mcp.callTool({ name, arguments: { action: command, args, ...extra } })).structuredContent;
  };
  const grant = async fields => (await dispatch('clients.create', { name: 'Agent', scopes: ['read'], workspaceIds: [firstId], ...fields }, human)).result;
  return { directory, workspace, firstId, other, browser, admission, clients, dispatch, events, eventLog, transfers, server, url, token, rest, runCli, tool, mcp, grant };
}

test('every error code maps to one stable outcome status, HTTP status and exit code', () => {
  assert.deepEqual(new Set(Object.values(ERROR_STATUS)), new Set(OUTCOME_STATUSES.filter(status => !['succeeded', 'partial'].includes(status))));
  assert.deepEqual(Object.keys(ERROR_STATUS).sort(), Object.keys(ERROR_HTTP_STATUS).sort(), 'every code has a status and an HTTP status');
  for (const required of ['succeeded', 'partial', 'blocked', 'approval_required', 'stale_state', 'unsupported', 'failed']) assert.ok(OUTCOME_STATUSES.includes(required), required);
  for (const code of Object.keys(exitCodes)) assert.ok(Object.hasOwn(ERROR_STATUS, code), `exit code for unknown error ${code}`);
});

test('outcome taxonomy is identical across GUI IPC, REST, CLI and MCP for every code', { timeout: 120000 }, async t => {
  const f = await stack(t);
  const cases = [...Object.keys(ERROR_STATUS).map(code => ({ code })), { result: { ok: true } }, { result: { status: 'partial', text: 'cut off' } }];
  for (const item of cases) {
    f.browser.behavior = () => { if (item.code) throw Object.assign(new Error(`Fixture failure ${item.code}`), { code: item.code }); return item.result; };
    const expected = item.code ? ERROR_STATUS[item.code] : item.result.status === 'partial' ? 'partial' : 'succeeded';
    const gui = await f.dispatch('browser.info', {}, human);
    const rest = await f.rest('browser.info');
    const cli = await f.runCli(['browser.info']);
    const mcp = await f.tool('browser.info');
    for (const [surface, outcome] of [['gui', gui], ['rest', rest.outcome], ['cli', cli.outcome], ['mcp', mcp]]) {
      assert.equal(outcome.status, expected, `${surface} ${item.code ?? expected}`);
      assert.equal(outcome.error?.code ?? null, item.code ?? null, surface);
    }
    for (const outcome of [rest.outcome, cli.outcome, mcp]) assert.equal(outcome.execution, gui.execution, `execution ${item.code}`);
    assert.equal(rest.http, resultHttpStatus(gui), `HTTP ${item.code}`);
    assert.equal(rest.http, item.code ? ERROR_HTTP_STATUS[item.code] : 200);
    assert.equal(cli.exit, resultExitCode(gui), `exit ${item.code}`);
    assert.equal(cli.exit, item.code ? exitCodes[item.code] ?? 1 : 0);
  }
  // Validation failures never reach the dispatcher and still carry the same status everywhere.
  f.browser.behavior = null;
  const invalid = [await f.dispatch('tabs.close', { tabId: 0 }, human), (await f.rest('tabs.close', { tabId: 0 })).outcome, (await f.runCli(['tabs.close', '{"tabId":0}'])).outcome, await f.tool('tabs.close', { tabId: 0 })];
  assert.deepEqual(invalid.map(outcome => [outcome.status, outcome.execution, outcome.error.code]), Array(4).fill(['invalid', 'not_started', 'invalid_arguments']));
});

test('outcomes echo the authenticated request linkage and expected-state checks are typed', async t => {
  const f = await stack(t);
  const task = await f.dispatch('tasks.create', { workspaceId: f.firstId, title: 'Linked', requestId: 'run-1:linked' });
  assert.deepEqual(task.request, { apiVersion: 1, requestId: 'run-1:linked', actor: 'automation', clientId: null, taskId: null, deadlineMs: null });
  const agent = await f.grant({ scopes: ['read', 'records.write'], taskId: task.result.id });
  const { outcome } = await f.rest('tasks.get', { id: task.result.id }, { bearer: agent.token });
  assert.equal(outcome.request.actor, `client:${agent.clientId}`);
  assert.equal(outcome.request.clientId, agent.clientId);
  assert.equal(outcome.request.taskId, task.result.id);
  // expectedRevision on transitions, deletions and annotations: stale callers change nothing.
  const stale = await f.dispatch('tasks.transition', { id: task.result.id, status: 'running', expectedRevision: 99 });
  assert.deepEqual([stale.status, stale.execution, stale.error.code, stale.error.details.reason], ['stale_state', 'not_started', 'stale_state', 'revision_changed']);
  assert.equal((await f.dispatch('tasks.delete', { id: task.result.id, expectedRevision: 2 })).status, 'stale_state');
  assert.equal((await f.dispatch('tasks.delete', { id: task.result.id, expectedRevision: 1 })).status, 'succeeded');
});

test('collections page with stable opaque cursors; unpaged results are unchanged', async t => {
  const f = await stack(t);
  const created = [];
  for (let i = 0; i < 7; i++) created.push((await f.dispatch('tasks.create', { workspaceId: f.firstId, title: `Task ${i}` })).result.id);
  await f.dispatch('tasks.create', { workspaceId: f.other.id, title: 'Elsewhere' });
  const legacy = await f.dispatch('tasks.list', { workspaceId: f.firstId });
  assert.ok(Array.isArray(legacy.result) && legacy.result.length === 7, 'without page the established array is returned');
  const first = (await f.rest('tasks.list', { workspaceId: f.firstId, page: { limit: 3 } })).outcome.result;
  assert.deepEqual(Object.keys(first).sort(), ['items', 'nextCursor', 'total']);
  assert.equal(first.total, 7);
  // A record created and one deleted between pages neither duplicates nor skips earlier items.
  await f.dispatch('tasks.delete', { id: created[1] });
  const late = (await f.dispatch('tasks.create', { workspaceId: f.firstId, title: 'Late' })).result.id;
  const second = (await f.runCli(['tasks.list', JSON.stringify({ workspaceId: f.firstId, page: { limit: 3, cursor: first.nextCursor } })])).outcome.result;
  const third = (await f.tool('tasks.list', { workspaceId: f.firstId, page: { limit: 3, cursor: second.nextCursor } })).result;
  assert.equal(third.nextCursor, null);
  assert.deepEqual([...first.items, ...second.items, ...third.items].map(item => item.id), [...created.slice(0, 2), ...created.slice(2), late]);
  // Cursors are bound to command, workspace and filters.
  const wrong = await f.dispatch('tasks.list', { workspaceId: f.other.id, page: { cursor: first.nextCursor } });
  assert.deepEqual([wrong.status, wrong.error.code, wrong.error.field], ['invalid', 'invalid_arguments', 'page.cursor']);
  assert.equal((await f.dispatch('materials.list', { workspaceId: f.firstId, page: { cursor: first.nextCursor } })).error.code, 'invalid_arguments');
  assert.equal((await f.dispatch('tasks.list', { workspaceId: f.firstId, page: { cursor: 'garbage' } })).error.code, 'invalid_arguments');
  // History is newest first; legacy limit and page are mutually exclusive.
  for (let i = 0; i < 5; i++) f.workspace.recordVisit({ workspaceId: f.firstId, url: `https://example.com/${i}`, title: `Visit ${i}`, tabId: i + 1 });
  const history = (await f.dispatch('history.list', { workspaceId: f.firstId, page: { limit: 2 } }, human)).result;
  const history2 = (await f.dispatch('history.list', { workspaceId: f.firstId, page: { limit: 10, cursor: history.nextCursor } }, human)).result;
  assert.deepEqual([...history.items, ...history2.items].map(item => item.title), ['Visit 4', 'Visit 3', 'Visit 2', 'Visit 1', 'Visit 0']);
  assert.equal((await f.dispatch('history.list', { workspaceId: f.firstId, limit: 2, page: {} }, human)).error.field, 'limit');
  // Messages and artifact versions page in append order.
  const conversation = (await f.dispatch('conversations.create', { workspaceId: f.firstId, title: 'Paged' })).result;
  for (let i = 0; i < 5; i++) await f.dispatch('conversations.message', { id: conversation.id, role: 'user', content: `message ${i}` });
  const messages = (await f.dispatch('conversations.messages', { id: conversation.id, page: { limit: 3 } })).result;
  const messages2 = (await f.dispatch('conversations.messages', { id: conversation.id, page: { cursor: messages.nextCursor } })).result;
  assert.deepEqual([...messages.items, ...messages2.items].map(item => item.content), ['message 0', 'message 1', 'message 2', 'message 3', 'message 4']);
  const artifact = (await f.dispatch('artifacts.create', { workspaceId: f.firstId, title: 'Doc', text: 'v1' })).result;
  await f.dispatch('artifacts.create', { workspaceId: f.firstId, artifactId: artifact.id, title: 'Doc', text: 'v2' });
  const versions = (await f.dispatch('artifacts.versions', { id: artifact.id, page: { limit: 1 } })).result;
  assert.equal(versions.items[0].number, 1);
  assert.equal(versions.items[0].text, undefined, 'version metadata only');
  assert.equal((await f.dispatch('artifacts.versions', { id: artifact.id, page: { cursor: versions.nextCursor } })).result.items[0].number, 2);
  // Every pageable command accepts page in its schema.
  for (const name of PAGEABLE) if (Object.hasOwn(commands, name)) assert.ok(commands[name].inputSchema.properties.page, name);
  // A scoped client pages only its own workspaces.
  const reader = await f.grant({ scopes: ['read'] });
  assert.deepEqual((await f.rest('workspaces.list', { page: { limit: 5 } }, { bearer: reader.token })).outcome.result.items.map(item => item.id), [f.firstId]);
});

test('deadlines propagate from REST, CLI and MCP and report whether execution started', { timeout: 30000 }, async t => {
  const f = await stack(t);
  // Started and still running after the grace period: effect uncertain.
  f.browser.behavior = async name => { if (name === 'page.stop') await sleep(2500); return { ok: true }; };
  f.browser.tabs.set(1, { id: 1, workspaceId: f.firstId, version: 1, controller: 'available' });
  const header = await f.rest('page.stop', { tabId: 1, workspaceId: f.firstId }, { headers: { 'weft-deadline-ms': '50' } });
  assert.equal(header.http, 504);
  assert.deepEqual([header.outcome.status, header.outcome.execution, header.outcome.error.code], ['timed_out', 'uncertain', 'deadline_exceeded']);
  assert.equal(header.outcome.error.details.started, true);
  assert.equal(header.outcome.error.details.effect, 'uncertain');
  assert.equal(header.outcome.request.deadlineMs, 50);
  const cli = await f.runCli(['page.stop', JSON.stringify({ tabId: 1, workspaceId: f.firstId }), '--deadline-ms', '50']);
  assert.equal(cli.exit, 7);
  assert.equal(cli.outcome.error.code, 'deadline_exceeded');
  const mcp = await f.tool('page.stop', { tabId: 1, workspaceId: f.firstId }, { deadlineMs: 50 });
  assert.equal(mcp.error.code, 'deadline_exceeded');
  assert.equal(mcp.request.deadlineMs, 50);
  // A fast command within its deadline is unaffected.
  f.browser.behavior = null;
  assert.equal((await f.rest('tasks.list', { workspaceId: f.firstId }, { body: { deadlineMs: 5000 } })).outcome.status, 'succeeded');
  // Invalid deadlines are rejected before anything runs.
  for (const bad of [{ headers: { 'weft-deadline-ms': 'soon' } }, { body: { deadlineMs: 0 } }, { headers: { 'weft-deadline-ms': '10' }, body: { deadlineMs: 10 } }]) {
    const response = await f.rest('tasks.list', {}, bad);
    assert.deepEqual([response.http, response.outcome.error.code], [400, 'invalid_arguments']);
  }
  assert.equal((await f.runCli(['tasks.list', '{}', '--deadline-ms=0'])).exit, 2);

  // Queued behind a slow capture: the deadline passes before the command starts, so it never runs.
  f.browser.captureDelay = 400;
  f.browser.tabs.get(1).workspaceId = f.firstId;
  const capture = f.dispatch('artifacts.capture', { workspaceId: f.firstId, tabId: 1, title: 'Slow' }, human);
  await sleep(20);
  const queued = await f.dispatch('tasks.create', { workspaceId: f.firstId, title: 'Never created' }, { deadlineMs: 60 });
  assert.deepEqual([queued.status, queued.execution, queued.error.details.started, queued.error.details.effect], ['timed_out', 'not_started', false, 'not_started']);
  assert.equal((await capture).status, 'succeeded');
  await sleep(50);
  assert.ok(!(await f.dispatch('tasks.list', { workspaceId: f.firstId })).result.some(task => task.title === 'Never created'));

  // Started, then rolled back before commit: nothing is saved.
  const rolled = await f.dispatch('artifacts.capture', { workspaceId: f.firstId, tabId: 1, title: 'Rolled back' }, { ...human, deadlineMs: 100 });
  assert.deepEqual([rolled.status, rolled.execution, rolled.error.details.started, rolled.error.details.effect], ['timed_out', 'cancelled', true, 'rolled_back']);
  assert.ok(!(await f.dispatch('artifacts.list', { workspaceId: f.firstId }, human)).result.some(item => item.title === 'Rolled back'));
});

test('task, navigation, handoff, policy, artifact, workspace and approval events replay by cursor without secrets', { timeout: 20000 }, async t => {
  const f = await stack(t);
  const start = (await f.dispatch('events.list', { limit: 1 })).result;
  assert.equal(start.gap, null);
  const task = (await f.dispatch('tasks.create', { workspaceId: f.firstId, title: 'secret-task-title' })).result;
  await f.dispatch('tasks.transition', { id: task.id, status: 'running' });
  const artifact = (await f.dispatch('artifacts.create', { workspaceId: f.firstId, title: 'Doc', text: 'secret-capture-text' })).result;
  await f.dispatch('siteRules.create', { workspaceId: f.firstId, hostname: 'blocked.example', reason: 'secret-rule-reason' }, human);
  const workspace = (await f.dispatch('workspaces.create', { name: 'secret-workspace-name' }, human)).result;
  await f.dispatch('workspaces.switch', { id: f.firstId }, human);
  const pending = await f.dispatch('materials.create', { workspaceId: f.firstId, title: 'secret-pending' }, { actor: 'automation', autonomy: 'assist' });
  assert.equal(pending.status, 'approval_required');
  // The browser publishes navigation metadata through the same channel.
  f.eventLog.append(sanitizeEvent({ type: 'navigation', status: 'committed', workspaceId: f.firstId, tabId: 1, version: 3, url: 'https://secret.example/?token=x' }));
  const all = (await f.rest('events.list', {})).outcome.result.items;
  const types = new Set(all.map(event => event.type));
  for (const type of ['command', 'task', 'artifact', 'policy', 'workspace', 'approval', 'navigation']) assert.ok(types.has(type), type);
  assert.ok(all.every(event => EVENT_TYPES.has(event.type)));
  assert.ok(all.some(event => event.type === 'task' && event.taskId === task.id && event.status === 'running'));
  assert.ok(all.some(event => event.type === 'artifact' && event.artifactId === artifact.id && event.versionId === artifact.versions[0].id));
  assert.ok(all.some(event => event.type === 'workspace' && event.workspaceId === workspace.id && event.status === 'create'));
  assert.ok(all.some(event => event.type === 'approval' && event.status === 'pending' && event.approvalId === pending.error.details.authority.approvalId));
  assert.ok(all.some(event => event.type === 'command' && event.outcome === 'approval_required'));
  assert.doesNotMatch(JSON.stringify(all), /secret|token=/);
  // Resume after a cursor through every surface; ids match the SSE Last-Event-ID format.
  const middle = all[3].id;
  const viaCli = (await f.runCli(['events.list', JSON.stringify({ after: middle, types: ['task', 'artifact'] })])).outcome.result;
  assert.ok(viaCli.items.every(event => ['task', 'artifact'].includes(event.type) && Number(event.id.split('-')[1]) > Number(middle.split('-')[1])));
  const viaMcp = (await f.tool('events.list', { after: all.at(-1).id })).result;
  assert.deepEqual(viaMcp.items, []);
  assert.equal(viaMcp.nextCursor, all.at(-1).id, 'an empty page keeps the cursor');
  const page = (await f.dispatch('events.list', { after: start.nextCursor, limit: 2 })).result;
  assert.equal(page.items.length, 2);
  assert.equal(page.more, true);
  assert.equal((await f.dispatch('events.list', { after: page.nextCursor, limit: 500 })).result.items[0].id, all.find(event => Number(event.id.split('-')[1]) > Number(page.nextCursor.split('-')[1])).id);
  const unknown = (await f.dispatch('events.list', { after: 'ffffffffffff-1' })).result;
  assert.equal(unknown.gap.reason, 'restarted');
  // SSE replay uses the same ids.
  const controller = new AbortController();
  const response = await fetch(`${f.url}/v1/events`, { headers: { authorization: `Bearer ${f.token}`, 'last-event-id': middle }, signal: controller.signal });
  const reader = response.body.getReader();
  let text = '';
  while (!text.includes(`id: ${all.at(-1).id}`)) text += new TextDecoder().decode((await reader.read()).value);
  controller.abort();
  assert.ok(!text.includes(`id: ${middle}\n`), 'replay starts after the cursor');
  // A scoped client replays only its own workspace's events.
  const reader2 = await f.grant({ scopes: ['read'] });
  const scoped = (await f.rest('events.list', {}, { bearer: reader2.token })).outcome.result.items;
  assert.ok(scoped.length > 0 && scoped.every(event => event.workspaceId === f.firstId));
});

test('capability discovery and scoped MCP resources', async t => {
  const f = await stack(t);
  const response = await fetch(`${f.url}/v1/capabilities`, { headers: { authorization: `Bearer ${f.token}` } });
  const capabilities = (await response.json()).result;
  assert.equal(capabilities.apiVersion, 1);
  assert.equal(capabilities.catalog.commands, Object.keys(commands).length);
  const canonical = value => JSON.stringify(value, (key, item) => item && typeof item === 'object' && !Array.isArray(item) ? Object.fromEntries(Object.keys(item).sort().map(name => [name, item[name]])) : item);
  assert.equal(capabilities.catalog.sha256, sha(canonical(commands)));
  assert.deepEqual(capabilities.outcomes.statuses, [...OUTCOME_STATUSES]);
  for (const [code, entry] of Object.entries(capabilities.outcomes.errors)) assert.deepEqual(entry, { status: ERROR_STATUS[code], httpStatus: ERROR_HTTP_STATUS[code], exitCode: exitCodes[code] ?? 1 });
  for (const feature of ['streaming', 'batch', 'idempotency', 'eventReplay', 'deadlines', 'pagination', 'transfers', 'search']) assert.ok(capabilities.features[feature], feature);
  assert.ok(capabilities.features.eventReplay.types.includes('navigation'));
  assert.deepEqual((await f.tool('weft.capabilities')).result.catalog, capabilities.catalog);
  const { resources } = await f.mcp.listResources();
  const uris = resources.map(resource => resource.uri);
  for (const uri of ['weft://capabilities', 'weft://reference/commands', 'weft://guide/start', `weft://workspaces/${f.firstId}/tasks`, `weft://workspaces/${f.other.id}/tasks`]) assert.ok(uris.includes(uri), uri);
  assert.ok((await f.mcp.listResourceTemplates()).resourceTemplates.some(template => template.uriTemplate === 'weft://workspaces/{workspaceId}/{collection}/{id}'));
  const guide = await f.mcp.readResource({ uri: 'weft://guide/record-writes' });
  assert.match(guide.contents[0].text, /requestId/);
  const task = (await f.dispatch('tasks.create', { workspaceId: f.other.id, title: 'Other task' })).result;
  const listed = JSON.parse((await f.mcp.readResource({ uri: `weft://workspaces/${f.other.id}/tasks` })).contents[0].text);
  assert.equal(listed.untrusted, true);
  assert.deepEqual(listed.items.map(item => item.id), [task.id]);
  await assert.rejects(f.mcp.readResource({ uri: `weft://workspaces/${f.firstId}/tasks/${task.id}` }), /not found in this workspace/);
  await assert.rejects(f.mcp.readResource({ uri: 'weft://workspaces/../etc' }), /Unknown Weft resource/);
  // A scoped token lists and reads only its own workspace through the same gate.
  const agent = await f.grant({ scopes: ['read'] });
  const scopedServer = createMcpServer(createClient({ url: f.url, token: agent.token }));
  const scoped = new Client({ name: 'scoped', version: '1' });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await scopedServer.connect(b); await scoped.connect(a);
  t.after(async () => { await scoped.close(); await scopedServer.close(); });
  const scopedUris = (await scoped.listResources()).resources.map(resource => resource.uri);
  assert.ok(scopedUris.includes(`weft://workspaces/${f.firstId}/tasks`));
  assert.ok(!scopedUris.some(uri => uri.includes(f.other.id)));
  await assert.rejects(scoped.readResource({ uri: `weft://workspaces/${f.other.id}/tasks/${task.id}` }), /permission_required|not found/);
});

test('chunked uploads and streamed downloads move content beyond the 1 MiB request cap', { timeout: 30000 }, async t => {
  const f = await stack(t);
  const image = Buffer.concat([png(64, 64), Buffer.alloc(CHUNK_BYTES * 2 + 1234, 7)]);
  const begin = (await f.rest('transfers.begin', { workspaceId: f.firstId, purpose: 'artifact', mimeType: 'image/png', size: image.length, sha256: sha(image), filename: 'large.png' })).outcome;
  assert.equal(begin.status, 'succeeded');
  const { transferId } = begin.result;
  for (let offset = 0; offset < image.length; offset += CHUNK_BYTES) {
    const body = JSON.stringify({ command: 'transfers.append', args: { transferId, offset, dataBase64: image.subarray(offset, offset + CHUNK_BYTES).toString('base64') } });
    assert.ok(Buffer.byteLength(body) < 1024 * 1024, 'each request stays under the REST cap');
    const appended = await f.rest('transfers.append', { transferId, offset, dataBase64: image.subarray(offset, offset + CHUNK_BYTES).toString('base64') });
    assert.equal(appended.outcome.status, 'succeeded', JSON.stringify(appended.outcome.error));
  }
  // A retried identical chunk is harmless; a conflicting one or a gap is stale state.
  assert.equal((await f.rest('transfers.append', { transferId, offset: 0, dataBase64: image.subarray(0, 10).toString('base64') })).outcome.result.duplicate, true);
  assert.equal((await f.rest('transfers.append', { transferId, offset: 0, dataBase64: Buffer.from('nope').toString('base64') })).outcome.status, 'stale_state');
  const committed = (await f.runCli(['transfers.commit', JSON.stringify({ transferId, title: 'Large capture', requestId: 'upload-1' })])).outcome;
  assert.equal(committed.status, 'succeeded', JSON.stringify(committed.error));
  const artifact = committed.result.result;
  assert.equal(artifact.versions[0].components[0].sha256, sha(image));
  // Stream it back through REST and in chunks through MCP; digests match.
  const download = await fetch(`${f.url}/v1/download?kind=artifact&id=${artifact.id}&versionId=${artifact.versions[0].id}&part=image`, { headers: { authorization: `Bearer ${f.token}` } });
  assert.equal(download.status, 200);
  assert.equal(download.headers.get('x-weft-sha256'), sha(image));
  assert.ok(Buffer.from(await download.arrayBuffer()).equals(image));
  const chunk = (await f.tool('transfers.read', { source: { kind: 'artifact', id: artifact.id, versionId: artifact.versions[0].id, part: 'image' }, offset: 100, length: 50 })).result;
  assert.deepEqual([chunk.totalBytes, chunk.length, chunk.done, chunk.sha256], [image.length, 50, false, sha(image)]);
  assert.equal(chunk.chunkSha256, sha(image.subarray(100, 150)));
  // A wrong digest creates nothing.
  const bad = (await f.dispatch('transfers.begin', { workspaceId: f.firstId, purpose: 'material', size: 3, sha256: '0'.repeat(64), filename: 'x.txt' })).result;
  await f.dispatch('transfers.append', { transferId: bad.transferId, offset: 0, dataBase64: Buffer.from('abc').toString('base64') });
  const rejected = await f.dispatch('transfers.commit', { transferId: bad.transferId });
  assert.deepEqual([rejected.status, rejected.execution, rejected.error.code], ['failed', 'not_started', 'component_integrity']);
  // Another caller never sees this caller's session; a scoped client cannot read another workspace's bytes.
  const agent = await f.grant({ scopes: ['read', 'records.write'], workspaceIds: [f.other.id] });
  assert.equal((await f.rest('transfers.commit', { transferId: bad.transferId }, { bearer: agent.token })).outcome.status !== 'succeeded', true);
  const denied = await fetch(`${f.url}/v1/download?kind=artifact&id=${artifact.id}&versionId=${artifact.versions[0].id}&part=image`, { headers: { authorization: `Bearer ${agent.token}` } });
  assert.notEqual(denied.status, 200);
  assert.equal((await f.rest('transfers.read', { source: { kind: 'artifact', id: artifact.id, versionId: artifact.versions[0].id, part: 'image' } }, { bearer: agent.token })).outcome.status, 'blocked');
});

test('package files stage through transfers and remain human-only to import or read', { timeout: 30000 }, async t => {
  const f = await stack(t);
  await f.dispatch('materials.create', { workspaceId: f.firstId, title: 'Packaged note', content: 'kept' });
  await f.dispatch('artifacts.create', { workspaceId: f.firstId, title: 'Packaged capture', text: 'capture body' });
  const exported = (await f.dispatch('workspaces.exportPackage', { id: f.firstId, name: 'source-pkg' }, human)).result;
  const manifest = JSON.parse((await f.dispatch('transfers.read', { source: { kind: 'package', name: 'source-pkg', path: 'manifest.json' } }, human)).result.dataBase64 && Buffer.from((await f.dispatch('transfers.read', { source: { kind: 'package', name: 'source-pkg', path: 'manifest.json' } }, human)).result.dataBase64, 'base64').toString('utf8'));
  assert.equal(manifest.files.length, exported.files);
  // Agents cannot read package folders (they can hold any workspace's records).
  assert.equal((await f.dispatch('transfers.read', { source: { kind: 'package', name: 'source-pkg', path: 'manifest.json' } })).status, 'blocked');
  // An agent stages each package file, manifest last; the folder is published only when every file verifies.
  const upload = async (path, bytes) => {
    const session = (await f.dispatch('transfers.begin', { workspaceId: f.firstId, purpose: 'package', packageName: 'staged-pkg', path, size: bytes.length, sha256: sha(bytes) })).result;
    for (let offset = 0; offset < bytes.length; offset += CHUNK_BYTES) await f.dispatch('transfers.append', { transferId: session.transferId, offset, dataBase64: bytes.subarray(offset, offset + CHUNK_BYTES).toString('base64') });
    return (await f.dispatch('transfers.commit', { transferId: session.transferId })).result.result;
  };
  const read = async path => {
    const result = (await f.dispatch('transfers.read', { source: { kind: 'package', name: 'source-pkg', path } }, human)).result;
    return Buffer.from(result.dataBase64, 'base64');
  };
  const manifestBytes = await read('manifest.json');
  const early = await upload('manifest.json', manifestBytes);
  assert.equal(early.ready, false);
  assert.ok(early.missing.includes('workspace.json'));
  for (const file of manifest.files) assert.equal((await upload(file.path, await read(file.path))).staged, true);
  const finished = await upload('manifest.json', manifestBytes);
  assert.equal(finished.ready, true);
  assert.ok(existsSync(join(f.directory, 'transfers', 'staged-pkg', 'workspace.json')));
  assert.equal((await f.dispatch('workspaces.importPackage', { name: 'staged-pkg' })).status, 'blocked', 'importing stays human-only');
  const imported = await f.dispatch('workspaces.importPackage', { name: 'staged-pkg' }, human);
  assert.equal(imported.status, 'succeeded', JSON.stringify(imported.error));
});

test('a deadline stops a running model turn and keeps its partial reply', { timeout: 20000 }, async t => {
  const endpoint = await fakeEndpoint(t, async (_req, res) => { sse(res, [openaiDelta('Partial answer')], { end: false }); await sleep(3000); res.end(); });
  const f = await modelFixture(t);
  const model = await f.save({ endpoint: `${endpoint.base}/v1` });
  const admission = new AutomationAdmission();
  const browser = { tabs: new Map(), downloads: new Map(), activeId: null, tab() { throw new Error('No tab'); }, execute: async () => ({}) };
  const dispatch = createDispatcher({ workspace: f.workspace, browser, providers: f.providers, admission });
  const outcome = await dispatch('chat.send', { conversationId: f.conversation.id, modelId: model.id, text: 'Hello' }, { ...human, deadlineMs: 1500 });
  assert.deepEqual([outcome.status, outcome.execution, outcome.error.code], ['timed_out', 'cancelled', 'deadline_exceeded']);
  assert.deepEqual([outcome.error.details.started, outcome.error.details.effect, outcome.error.details.partialSaved], [true, 'stopped', true]);
  assert.match(outcome.error.details.turnId, /^turn_/);
  const saved = f.messages().at(-1);
  assert.deepEqual([saved.role, saved.content, saved.status, saved.finishReason], ['assistant', 'Partial answer', 'interrupted', 'timeout']);
  assert.equal(f.manifests().at(-1).deadline, 'request');
});

test('restricted originals stay withheld through MCP resources, transfers.read, downloads and events', { timeout: 30000 }, async t => {
  const f = await stack(t);
  const SECRET = 'zebracodeword';
  const created = (await f.dispatch('artifacts.create', { workspaceId: f.firstId, title: 'Receipt', text: `Card note ${SECRET} kept.` }, human)).result;
  const original = created.versions[0].id;
  const redacted = await f.dispatch('artifacts.redact', { id: created.id, versionId: original, text: [{ literal: SECRET }] }, human);
  assert.equal(redacted.error, null, JSON.stringify(redacted.error));
  assert.equal((await f.dispatch('artifacts.setAccess', { id: created.id, versionId: original, access: 'restricted' }, human)).error, null);
  const agent = await f.grant({ scopes: ['read'] });
  const scopedServer = createMcpServer(createClient({ url: f.url, token: agent.token }));
  const scoped = new Client({ name: 'scoped-restricted', version: '1' });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await scopedServer.connect(b); await scoped.connect(a);
  t.after(async () => { await scoped.close(); await scopedServer.close(); });
  const record = (await scoped.readResource({ uri: `weft://workspaces/${f.firstId}/artifacts/${created.id}` })).contents[0].text;
  assert.equal(record.includes(SECRET), false, 'the MCP record resource withholds the restricted original');
  assert.match(record, /restricted_original/);
  const list = (await scoped.readResource({ uri: `weft://workspaces/${f.firstId}/artifacts` })).contents[0].text;
  assert.equal(list.includes(SECRET), false);
  const read = await f.rest('transfers.read', { source: { kind: 'artifact', id: created.id, versionId: original, part: 'text' }, offset: 0 }, { bearer: agent.token });
  assert.equal(read.outcome.error?.code, 'permission_required');
  assert.equal(JSON.stringify(read.outcome).includes(Buffer.from(SECRET).toString('base64').slice(0, 8)), false);
  const download = await fetch(`${f.url}/v1/download?kind=artifact&id=${created.id}&versionId=${original}&part=text`, { headers: { authorization: `Bearer ${agent.token}` } });
  assert.notEqual(download.status, 200);
  assert.equal((await download.text()).includes(SECRET), false);
  // The person still reads the original; derivative and access events carry identifiers only.
  const own = f.transfers.read({ source: { kind: 'artifact', id: created.id, versionId: original, part: 'text' }, offset: 0 }, human);
  assert.equal(Buffer.from(own.dataBase64, 'base64').toString().includes(SECRET), true);
  const statuses = f.events.filter(event => event.type === 'artifact' && event.artifactId === created.id).map(event => event.status);
  assert.ok(statuses.includes('derivative_saved') && statuses.includes('restricted'), JSON.stringify(statuses));
  assert.equal(JSON.stringify(f.events).includes(SECRET), false);
});
