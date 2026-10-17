import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EventEmitter } from 'node:events';
import { Browser } from '../src/browser.js';
import { WorkspaceService } from '../src/workspace.js';
import { AutomationAdmission } from '../src/admission.js';
import { ClientGrants } from '../src/clients.js';
import { createDispatcher } from '../src/dispatch.js';
import { ResourceScheduler, resourceSettings, CAPTURE_LIMITS, MODEL_IMAGE_LIMITS } from '../src/resources.js';
import { IMAGE_LIMITS } from '../src/model-media.js';
import { exitCodes, resultHttpStatus } from '../src/commands.js';

const human = { actor: 'human', source: 'gui' };
const tick = () => new Promise(resolve => setImmediate(resolve));

test('agent concurrency is bounded globally, per client and per task with typed backpressure', () => {
  const scheduler = new ResourceScheduler({ settings: () => ({ resources: { maxAgentCommands: 3, maxPerClient: 2, maxPerTask: 1 } }) });
  const a1 = scheduler.admit('page.readable', { actor: 'client:a', clientId: 'a' });
  const a2 = scheduler.admit('page.readable', { actor: 'client:a', clientId: 'a' });
  assert.throws(() => scheduler.admit('page.readable', { actor: 'client:a', clientId: 'a' }), error => error.code === 'resource_busy' && error.details.resource === 'client' && error.details.limit === 2);
  const b1 = scheduler.admit('chat.send', { actor: 'client:b', clientId: 'b', taskId: 'task_1' });
  assert.throws(() => scheduler.admit('page.readable', { actor: 'client:c', clientId: 'c' }), error => error.details.resource === 'agent_commands' && error.details.active === 3);
  a1();
  a1(); // releasing twice frees one slot only
  assert.throws(() => scheduler.admit('page.readable', { actor: 'client:d', clientId: 'd', taskId: 'task_1' }), error => error.details.resource === 'task', 'the task already runs a command');
  b1();
  const c1 = scheduler.admit('page.readable', { actor: 'client:c', clientId: 'c', taskId: 'task_1' });
  // People and the internal model reader are never throttled by agent limits.
  for (let i = 0; i < 10; i++) { scheduler.admit('tabs.list', { actor: 'human' }); scheduler.admit('page.readable', { actor: 'model-reader' }); }
  assert.equal(scheduler.status().agentCommands.running, 2);
  a2(); c1();
  assert.equal(scheduler.status().agentCommands.running, 0);
});

test('capture queue: bounded waiting, human priority, progress, cancellation of queued and running jobs', async () => {
  const events = [];
  const scheduler = new ResourceScheduler({ settings: () => ({ resources: { captureConcurrency: 1, captureQueueLimit: 1 } }), onEvent: event => events.push(event) });
  const gates = [];
  const work = value => () => new Promise(resolve => gates.push(() => resolve(value)));
  const agent = { actor: 'client:a', clientId: 'a' };
  const first = scheduler.capture({ command: 'page.screenshot', context: { ...agent }, workspaceId: 'ws', tabId: 1 }, work('first'));
  await tick();
  const secondContext = { ...agent };
  const second = scheduler.capture({ command: 'page.pdf', context: secondContext, workspaceId: 'ws', tabId: 1 }, work('second'));
  await tick();
  await assert.rejects(scheduler.capture({ command: 'page.screenshot', context: { ...agent }, workspaceId: 'ws' }, work('third')),
    error => error.code === 'resource_busy' && error.details.resource === 'capture_queue' && error.details.queued === 1 && error.notStarted);
  // A person is never refused and goes ahead of queued agent work.
  const personal = scheduler.capture({ command: 'page.screenshot', context: { ...human }, workspaceId: 'ws' }, work('human'));
  await tick();
  const listed = scheduler.list();
  assert.deepEqual(listed.filter(job => job.state === 'queued').map(job => [job.actor, job.position]), [['human', 1], ['client:a', 2]]);
  assert.match(listed.find(job => job.actor === 'human').progress, /waiting \(1 in queue\)/);
  // Cancel the queued agent job: it never starts.
  const cancelled = scheduler.cancel(secondContext.captureJobId, agent);
  assert.equal(cancelled.cancelled, true);
  await assert.rejects(second, error => error.code === 'cancelled' && error.notStarted);
  assert.throws(() => scheduler.cancel(secondContext.captureJobId, { actor: 'client:other', clientId: 'other' }), /not found/, 'other agents cannot see or cancel the job');
  gates.shift()();
  assert.equal(await first, 'first');
  await tick();
  // The human job runs next; cancelling a running screenshot discards its result.
  const running = scheduler.list().find(job => job.state === 'running');
  assert.equal(running.actor, 'human');
  assert.equal(scheduler.cancel(running.id, human).cancelled, true);
  gates.shift()();
  await assert.rejects(personal, error => error.code === 'cancelled');
  const states = events.filter(event => event.type === 'capture').map(event => event.status);
  assert.ok(['queued', 'running', 'succeeded', 'cancelled'].every(state => states.includes(state)));
  // A running artifact capture is reported as not cancellable.
  const artifactContext = { ...agent };
  const artifact = scheduler.capture({ command: 'artifacts.capture', context: artifactContext, workspaceId: 'ws' }, work('saved'));
  await tick();
  const refused = scheduler.cancel(artifactContext.captureJobId, agent);
  assert.equal(refused.cancelled, false);
  assert.equal(refused.cancellable, false);
  gates.shift()();
  assert.equal(await artifact, 'saved');
  assert.equal(scheduler.running, 0);
});

test('image and capture resolution limits live in one place', () => {
  assert.equal(IMAGE_LIMITS, MODEL_IMAGE_LIMITS);
  assert.equal(resourceSettings({}).maxCaptureEdge, CAPTURE_LIMITS.defaultMaxEdge);
  assert.equal(resourceSettings({ resources: { maxCaptureEdge: 1024 } }).maxCaptureEdge, 1024);
  assert.equal(exitCodes.resource_busy, 3);
  assert.equal(exitCodes.budget_exhausted, 4);
});

/** Real dispatcher, grants and workspace store with a scripted page that can print slowly. */
async function fixture(t, { providers } = {}) {
  const directory = mkdtempSync(join(tmpdir(), 'weft-resources-'));
  const workspace = new WorkspaceService({ directory });
  const workspaceId = workspace.activeWorkspaceId;
  const session = new EventEmitter();
  session.setPermissionRequestHandler = () => {};
  session.setPermissionCheckHandler = () => {};
  const admission = new AutomationAdmission();
  const browser = new Browser({ session, workspaceService: workspace, admission, electronApi: {} });
  workspace.attachBrowser(browser);
  const prints = [];
  const webContents = { id: 41, getURL: () => 'https://example.test/', getTitle: () => 'Fixture', isDestroyed: () => false, close() {}, stop() {},
    executeJavaScript: async () => false,
    printToPDF: () => new Promise(resolve => prints.push(() => resolve(Buffer.from('%PDF-fixture')))) };
  browser.tabs.set(1, { id: 1, workspaceId, version: 1, controller: 'available', view: { webContents } });
  browser.activeId = 1;
  const clients = new ClientGrants({ directory, masterToken: 'resources-master', workspace });
  const events = [];
  const dispatch = createDispatcher({ workspace, browser, clients, admission, onEvent: event => events.push(event),
    providers: providers ?? { profiles: [], close() {}, execute() { throw new Error('Unexpected provider call'); } } });
  t.after(() => { browser.close(); workspace.close(); rmSync(directory, { recursive: true, force: true, maxRetries: 5 }); });
  const grant = async fields => clients.authenticate((await dispatch('clients.create', { name: 'Agent', scopes: ['read', 'records.write', 'tabs.control'], workspaceIds: [workspaceId], autonomy: 'autonomous', ...fields }, human)).result.token);
  return { workspace, workspaceId, browser, dispatch, clients, prints, events, grant, directory };
}

test('dispatcher queues captures, reports backpressure as resource_busy (HTTP 429, exit 3) and cancels queued jobs', async t => {
  const f = await fixture(t);
  await f.dispatch('settings.update', { resources: { captureConcurrency: 1, captureQueueLimit: 1 } }, human);
  assert.equal((await f.dispatch('settings.update', { resources: { captureQueueLimit: 50 } })).error.code, 'permission_required', 'limits are human settings');
  const agent = await f.grant({});
  const pdf = () => f.dispatch('page.pdf', { workspaceId: f.workspaceId, tabId: 1 }, agent);
  const first = pdf();
  for (let i = 0; i < 20 && !f.prints.length; i++) await tick();
  const second = pdf();
  await tick();
  const refused = await pdf();
  assert.equal(refused.error.code, 'resource_busy');
  assert.equal(refused.execution, 'not_started');
  assert.equal(resultHttpStatus(refused), 429);
  assert.deepEqual(refused.error.details.busy, { resource: 'capture_queue', limit: 1, active: 1, queued: 1, retryAfterMs: 1000 });
  const jobs = (await f.dispatch('captures.list', { workspaceId: f.workspaceId }, agent)).result;
  const queued = jobs.find(job => job.state === 'queued');
  assert.equal(jobs.find(job => job.state === 'running').command, 'page.pdf');
  assert.equal((await f.dispatch('captures.cancel', { jobId: queued.id }, agent)).result.cancelled, true);
  const cancelled = await second;
  assert.equal(cancelled.error.code, 'cancelled');
  assert.equal(cancelled.error.details.jobId, queued.id);
  f.prints.shift()();
  assert.equal((await first).result.mimeType, 'application/pdf');
  assert.ok(f.events.some(event => event.type === 'capture' && event.status === 'succeeded' && event.jobId));
  const status = (await f.dispatch('resources.status', {}, agent)).result;
  assert.equal(status.captures.running, 0);
  assert.equal(status.agentCommands.running, 1, 'only the status request itself holds a slot: every earlier command, including failures, released its own');
});

test('client run-time and model-spend budgets are measured, enforced before execution and never guessed', async t => {
  let pricing = { currency: 'USD', inputPerMillion: 1000000, outputPerMillion: 0 };
  const providers = { get profiles() { return [{ id: 'priced', pricing }, { id: 'unpriced' }]; }, close() {},
    async execute(name) { if (name === 'chat.send') return { message: { content: 'ok' }, cost: { estimate: true, amount: 0.6, currency: 'USD' }, usage: { inputTokens: 1, outputTokens: 0 } }; throw new Error('unexpected'); } };
  const f = await fixture(t, { providers });
  const conversation = (await f.dispatch('conversations.create', { title: 'Budget' }, human)).result;
  const spender = await f.grant({ actionClasses: ['cloud_spend'], maxCost: { amount: 1, currency: 'USD' } });
  const send = (modelId = 'priced', agent = spender) => f.dispatch('chat.send', { conversationId: conversation.id, modelId, text: 'hi', disclosureAck: true }, agent);
  const unpriced = await send('unpriced');
  assert.equal(unpriced.error.code, 'budget_exhausted');
  assert.equal(unpriced.error.details.budget.reason, 'unpriced_model', 'spend that cannot be measured is refused, not estimated');
  assert.equal(unpriced.execution, 'not_started');
  assert.equal((await send()).execution, 'succeeded');
  assert.equal((await send()).execution, 'succeeded');
  const spent = await send();
  assert.equal(spent.error.code, 'budget_exhausted');
  assert.deepEqual([spent.error.details.budget.budget, spent.error.details.budget.limit, spent.error.details.budget.used, spent.error.details.budget.unit], ['cost', 1, 1.2, 'USD']);
  assert.equal(resultHttpStatus(spent), 429);
  pricing = { currency: 'EUR', inputPerMillion: 1, outputPerMillion: 1 };
  const status = (await f.dispatch('resources.status', {}, spender)).result;
  assert.deepEqual(status.budgets.cost.used, { amount: 1.2, currency: 'USD' });
  // Time budget: every admitted command adds its run time.
  const timed = await f.grant({ maxRuntimeSeconds: 1 });
  f.clients.recordConsumption(timed.clientId, { runtimeMs: 999 });
  assert.equal((await f.dispatch('tabs.list', { workspaceId: f.workspaceId }, timed)).execution, 'succeeded');
  f.clients.recordConsumption(timed.clientId, { runtimeMs: 5 });
  const late = await f.dispatch('tabs.list', { workspaceId: f.workspaceId }, timed);
  assert.equal(late.error.code, 'budget_exhausted');
  assert.equal(late.error.details.budget.budget, 'runtime');
  // A person raises the budget and the client continues; grants survive a restart with their usage.
  await f.dispatch('clients.update', { clientId: timed.clientId, changes: { maxRuntimeSeconds: 600 } }, human);
  assert.equal((await f.dispatch('tabs.list', { workspaceId: f.workspaceId }, timed)).execution, 'succeeded');
  const reopened = new ClientGrants({ directory: f.directory, masterToken: 'resources-master', workspace: f.workspace });
  assert.ok(reopened.current(timed.clientId).usage.runtimeMs >= 1004);
});

test('a long-running agent workload leaves no leaked slots or unbounded job history', async t => {
  const f = await fixture(t);
  const agent = await f.grant({});
  const pending = [];
  for (let i = 0; i < 150; i++) {
    pending.push(f.dispatch('tabs.list', { workspaceId: f.workspaceId }, agent));
    if (pending.length === 4) { for (const outcome of await Promise.all(pending.splice(0))) assert.equal(outcome.execution, 'succeeded'); }
  }
  await Promise.all(pending);
  const jobs = [];
  for (let i = 0; i < 120; i++) {
    const outcome = f.dispatch('page.pdf', { workspaceId: f.workspaceId, tabId: 1 }, agent);
    for (let j = 0; j < 20 && !f.prints.length; j++) await tick();
    f.prints.shift()();
    jobs.push(await outcome);
  }
  assert.ok(jobs.every(outcome => outcome.execution === 'succeeded'));
  const status = (await f.dispatch('resources.status', {}, agent)).result;
  assert.equal(status.agentCommands.running, 1, 'only the status request is running');
  assert.ok(f.browser && (await f.dispatch('captures.list', {}, human)).result.length <= 101, 'finished jobs are pruned');
});

test('agents cannot suspend a tab a person or another actor holds', async t => {
  const f = await fixture(t);
  const agent = await f.grant({});
  f.browser.tab(1).controller = 'human';
  const refused = await f.dispatch('tabs.suspend', { workspaceId: f.workspaceId, tabId: 1 }, agent);
  assert.equal(refused.error.code, 'lease_conflict');
  assert.equal(f.browser.tab(1).suspended, undefined);
});
