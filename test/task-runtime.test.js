import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync, existsSync, unlinkSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRuntimeFixture, human } from './fixtures/task-runtime-fixture.mjs';
import { PHASES, TRANSITIONS, TERMINAL_PHASES, canTransition, turnPhase } from '../src/task-phases.js';
import { WorkspaceService } from '../src/workspace.js';
import { commands } from '../src/commands.js';
import { fakeEndpoint, sse, openaiDelta, openaiFinish } from './model-test-helpers.js';
import { Providers } from '../src/providers.js';
import { TurnRelay } from '../src/turn-relay.js';

function setup(t, options = {}) {
  const directory = mkdtempSync(join(tmpdir(), 'weft-tasks-'));
  const f = createRuntimeFixture({ directory, ...options });
  t.after(() => { f.close(); rmSync(directory, { recursive: true, force: true, maxRetries: 5 }); });
  return { ...f, directory };
}
const step = (title, command, args = {}, extra = {}) => ({ kind: 'command', title, command, args, ...extra });
const finding = title => step(`Record ${title}`, 'context.create', { title, category: 'findings', content: title });
async function startTask(f, plan, { executor = { type: 'runner', autonomy: 'scoped' }, context = human, fields = {} } = {}) {
  const task = await f.run('tasks.create', { workspaceId: f.workspaceId, title: 'Runtime task', plan, ...fields }, context);
  await f.run('tasks.start', { id: task.id, ...(executor ? { executor } : {}) }, context);
  return task.id;
}
const transitions = record => record.timeline.filter(entry => entry.type === 'transition').map(entry => `${entry.from}>${entry.to}:${entry.reason}`);

test('one phase vocabulary: uncertain leaves only through a determination, retry or stop; terminal phases only reopen', () => {
  assert.deepEqual(PHASES, ['queued', 'running', 'waiting_on_human', 'paused', 'completed', 'failed', 'cancelled', 'uncertain']);
  for (const from of PHASES) for (const to of TRANSITIONS[from]) assert.ok(PHASES.includes(to), `${from} -> ${to}`);
  assert.equal(canTransition('uncertain', 'completed'), false, 'uncertain work is never silently marked complete');
  assert.equal(canTransition('queued', 'uncertain'), false);
  for (const phase of TERMINAL_PHASES) assert.ok(TRANSITIONS[phase].every(to => ['queued', 'running', 'paused'].includes(to)), phase);
  assert.deepEqual(['running', 'complete', 'partial', 'stopped', 'timed-out', 'mystery'].map(turnPhase), ['running', 'completed', 'completed', 'cancelled', 'failed', 'uncertain']);
  assert.deepEqual(commands['tasks.create'].inputSchema.properties.status.enum, PHASES, 'task records, workflow runs and model turns share one vocabulary');
});

test('a runner executes local steps with request IDs, stops at a review point and records attributed transitions', async t => {
  const f = setup(t);
  const id = await startTask(f, [finding('first'), { kind: 'review', title: 'Check the finding', instruction: 'Confirm it is sourced' }, finding('second')]);
  let task = await f.settle(id);
  assert.equal(task.status, 'waiting_on_human');
  assert.equal(task.run.blocker.kind, 'review');
  const [first] = task.operations;
  assert.equal(first.status, 'completed');
  assert.match(first.requestId, new RegExp(`^task\\.${id}\\.s1\\.`), 'record writes use the store request identity');
  assert.ok(task.outputs.includes(first.result.id), 'outputs link to the created record');
  // A non-human cannot decide a review checkpoint.
  assert.equal((await f.attempt('tasks.review', { id, stepId: 's2', decision: 'approve' }, { actor: 'automation' })).error.code, 'permission_required');
  await f.run('tasks.review', { id, stepId: 's2', decision: 'approve', note: 'Looks sourced' });
  task = await f.settle(id);
  assert.equal(task.status, 'completed');
  assert.equal(task.progress, 100);
  assert.deepEqual(transitions(task), ['queued>running:started', 'running>waiting_on_human:review_required', 'waiting_on_human>running:review_approved', 'running>completed:plan_completed']);
  const actors = task.timeline.filter(entry => entry.type === 'transition').map(entry => entry.actor);
  assert.deepEqual(actors, ['human', `task:${id}`, 'human', `task:${id}`]);
  const logged = f.authority.activity.entries.filter(entry => entry.type === 'task' && entry.taskId === id).map(entry => `${entry.summary.from}>${entry.summary.to}:${entry.reason}`);
  assert.deepEqual(logged, transitions(task), 'every transition is mirrored in the hash-chained activity log');
  const steps = f.authority.activity.entries.filter(entry => entry.command === 'context.create' && entry.taskId === id);
  assert.ok(steps.length >= 2 && steps.every(entry => entry.actor === `task:${id}`), 'steps run through the shared gate as the task identity');
  assert.equal(f.authority.activity.verify().status, 'intact');
  // The store survives reopening with the same phase history.
  f.close();
  const reopened = new WorkspaceService({ directory: f.directory });
  t.after(() => reopened.close());
  assert.deepEqual(transitions(reopened.data.tasks.find(item => item.id === id)), transitions(task));
});

test('approval-required steps wait for a person and resume with the identical approved command', async t => {
  const f = setup(t);
  const id = await startTask(f, [step('Place order', 'page.click', { tabId: 1, selector: '#place-order' }), finding('ordered')]);
  let task = await f.settle(id);
  assert.equal(task.status, 'waiting_on_human');
  assert.equal(task.run.blocker.kind, 'approval');
  assert.equal(f.scripts.filter(item => /place-order/.test(item.source)).length, 0, 'nothing ran before approval');
  const [request] = (await f.run('approvals.list', {})).filter(item => item.id === task.run.blocker.approvalId);
  assert.equal(request.actor, `task:${id}`);
  assert.equal(request.taskId, id);
  await f.run('approvals.approve', { id: request.id });
  task = await f.settle(id);
  assert.equal(task.status, 'completed');
  const click = task.operations.find(op => op.command === 'page.click' && op.status === 'completed');
  assert.equal(click.external, true);
  assert.match(click.note, /not verified/, 'accepted external input is not reported as a verified external result');
  // A rejected approval pauses the task rather than retrying.
  const second = await startTask(f, [step('Delete account', 'page.click', { tabId: 1, selector: '#delete' })]);
  task = await f.settle(second);
  await f.run('approvals.reject', { id: task.run.blocker.approvalId, reason: 'Not this one' });
  task = await f.settle(second);
  assert.equal(task.status, 'paused');
  assert.equal(task.run.blocker.kind, 'approval_rejected');
  assert.equal((await f.attempt('tasks.continue', { id: second }, { actor: 'automation' })).error.code, 'permission_required', 'agents cannot continue a task a person stopped');
});

test('expired grants pause the task with a blocker; a person reassigns and continues it', async t => {
  const f = setup(t);
  const grant = await f.run('clients.create', { name: 'Researcher', scopes: ['read', 'records.write'], workspaceIds: [f.workspaceId], ttlSeconds: 60 });
  const agent = { actor: `client:${grant.clientId}`, source: 'api', clientId: grant.clientId, workspaceIds: [f.workspaceId] };
  // The agent delegates a task to itself (an existing grant); it cannot bind another identity.
  const task = await f.run('tasks.create', { workspaceId: f.workspaceId, title: 'Agent task', plan: [finding('one'), { kind: 'review', title: 'Pause point' }, finding('two')] }, agent);
  const refused = await f.attempt('tasks.start', { id: task.id, executor: { type: 'runner', autonomy: 'autonomous' } }, agent);
  assert.equal(refused.error.details.authority.reason, 'executor_not_self');
  await f.run('tasks.start', { id: task.id }, agent);
  let record = await f.settle(task.id);
  assert.equal(record.status, 'waiting_on_human');
  assert.deepEqual(record.executor, { type: 'client', clientId: grant.clientId });
  f.clients.clock = () => Date.now() + 120000;
  await f.run('tasks.review', { id: task.id, stepId: 's2', decision: 'approve' });
  record = await f.settle(task.id);
  assert.equal(record.status, 'paused');
  assert.equal(record.run.blocker.kind, 'grant');
  assert.equal(record.run.blocker.reason, 'grant_inactive');
  assert.equal(record.operations.at(-1).status, 'not_started');
  assert.equal(f.workspace.data.context.filter(item => item.title === 'two').length, 0);
  await f.run('tasks.reassign', { id: task.id, executor: { type: 'runner', autonomy: 'scoped' }, note: 'Agent token expired' });
  assert.equal((await f.attempt('tasks.reassign', { id: task.id, executor: { type: 'runner', autonomy: 'autonomous' } }, { actor: 'automation' })).error.code, 'permission_required', 'rebinding identity is human-only');
  await f.run('tasks.continue', { id: task.id });
  record = await f.settle(task.id);
  assert.equal(record.status, 'completed');
  assert.equal(f.workspace.data.context.filter(item => item.title === 'two').length, 1);
});

test('agents steer only their own tasks; plans of runner tasks cannot be changed behind a person', async t => {
  const f = setup(t);
  const grant = await f.run('clients.create', { name: 'Other agent', scopes: ['read', 'records.write'], workspaceIds: [f.workspaceId] });
  const agent = { actor: `client:${grant.clientId}`, source: 'api', clientId: grant.clientId, workspaceIds: [f.workspaceId] };
  const id = await startTask(f, [{ kind: 'review', title: 'Hold' }, finding('x')]);
  await f.settle(id);
  for (const [command, args] of [['tasks.pause', { id }], ['tasks.cancel', { id }], ['tasks.redirect', { id, objective: 'Something else' }]]) {
    assert.equal((await f.attempt(command, args, agent)).error.details.authority.reason, 'not_task_executor', command);
  }
  const update = await f.attempt('tasks.update', { id, changes: { plan: [step('Evil', 'page.click', { tabId: 1, selector: '#buy' })] } }, agent);
  assert.equal(update.error.code, 'permission_required');
  const transition = await f.attempt('tasks.transition', { id, status: 'completed' }, human);
  assert.equal(transition.error.code, 'invalid_arguments', 'runtime tasks change phase only through the runtime commands');
  assert.equal((await f.attempt('tasks.create', { workspaceId: f.workspaceId, title: 'x', status: 'uncertain' })).error.code, 'invalid_arguments');
  // Human-only steps are refused when the plan is validated.
  const bad = await f.run('tasks.create', { workspaceId: f.workspaceId, title: 'Bad', plan: [step('Clear cookies', 'cookies.clear', {})] });
  assert.match((await f.attempt('tasks.start', { id: bad.id })).error.message, /human-only/);
});

test('emergency stop: no new steps are scheduled and already-submitted work is distinguished, then recorded as uncertain', async t => {
  const f = setup(t);
  const id = await startTask(f, [step('Send message', 'page.click', { tabId: 1, selector: '#send' }), finding('after send')], { executor: { type: 'runner', autonomy: 'autonomous' } });
  const hold = f.page.hold(1);
  await hold.started;
  const stop = await f.run('browser.emergencyStop', {});
  assert.deepEqual(stop.tasks.paused, [id]);
  assert.equal(stop.tasks.submitted.length, 1);
  assert.equal(stop.tasks.submitted[0].command, 'page.click');
  assert.equal(stop.tasks.submitted[0].external, true);
  let task = f.task(id);
  assert.equal(task.status, 'paused');
  assert.equal(task.run.pausedBy, 'human');
  assert.equal((await f.attempt('tasks.continue', { id })).error.code, 'stale_state', 'cannot continue while submitted work is still in flight');
  hold.fail(Object.assign(new Error('The page action was interrupted by an emergency stop'), { code: 'action_interrupted' }));
  task = await f.settle(id);
  assert.equal(task.status, 'uncertain');
  const op = task.operations.find(item => item.command === 'page.click');
  assert.equal(op.status, 'uncertain');
  assert.equal(f.workspace.data.context.some(item => item.title === 'after send'), false, 'the next step was never scheduled');
  assert.equal((await f.attempt('tasks.continue', { id })).error.code, 'duplicate_risk');
});

test('no blind retries: uncertain external work needs a determination or an explicit duplicate-risk confirmation', async t => {
  const f = setup(t);
  const id = await startTask(f, [step('Pay invoice', 'page.click', { tabId: 1, selector: '#pay' }), finding('paid')], { executor: { type: 'runner', autonomy: 'autonomous' } });
  const hold = f.page.hold(1);
  await hold.started;
  hold.fail(new Error('Renderer connection lost'));
  let task = await f.settle(id);
  assert.equal(task.status, 'uncertain');
  const clicks = () => f.scripts.filter(item => /#pay/.test(item.source)).length;
  assert.equal(clicks(), 1);
  assert.equal((await f.attempt('tasks.continue', { id })).error.code, 'duplicate_risk');
  const unconfirmed = await f.attempt('tasks.retryStep', { id });
  assert.equal(unconfirmed.error.code, 'duplicate_risk');
  assert.equal(unconfirmed.execution, 'not_started');
  assert.equal((await f.attempt('tasks.retryStep', { id, confirmDuplicateRisk: true }, { actor: 'automation' })).error.code, 'permission_required', 'agents never accept duplicate risk');
  assert.equal((await f.attempt('tasks.reconcile', { id, operationId: task.operations[0].id, determination: 'lookup' })).error.code, 'unsupported', 'no invented remote lookup for a page click');
  assert.equal(clicks(), 1, 'nothing was repeated');
  // A person checked the destination: the payment went through. The step is not repeated.
  const reconciled = await f.run('tasks.reconcile', { id, operationId: task.operations[0].id, determination: 'completed', note: 'Invoice shows paid', continue: true });
  assert.equal(reconciled.determination.source, 'human');
  task = await f.settle(id);
  assert.equal(task.status, 'completed');
  assert.equal(clicks(), 1);
  // A second uncertain run: the person explicitly accepts the duplicate risk.
  const again = await startTask(f, [step('Pay again', 'page.click', { tabId: 1, selector: '#pay' })], { executor: { type: 'runner', autonomy: 'autonomous' } });
  const second = f.page.hold(1);
  await second.started;
  second.fail(new Error('timed out waiting for the page'));
  await f.settle(again);
  await f.run('tasks.retryStep', { id: again, confirmDuplicateRisk: true, note: 'Checked: nothing charged' });
  task = await f.settle(again);
  assert.equal(task.status, 'completed');
  assert.equal(task.operations[0].determination.duplicateRiskAccepted, true);
  assert.equal(clicks(), 3);
  const audit = f.authority.activity.entries.filter(entry => entry.reason === 'duplicate_risk_accepted');
  assert.equal(audit.length, 1);
});

test('process interruption: killed mid-step, restart pauses local work and marks external work uncertain', { timeout: 30000 }, async t => {
  const directory = mkdtempSync(join(tmpdir(), 'weft-crash-'));
  let f;
  t.after(() => { f?.close(); rmSync(directory, { recursive: true, force: true, maxRetries: 5 }); });
  const child = spawn(process.execPath, [fileURLToPath(new URL('./fixtures/task-crash-child.mjs', import.meta.url)), directory], { stdio: ['ignore', 'pipe', 'inherit'] });
  const ready = await new Promise((resolve, reject) => {
    let buffer = '';
    child.stdout.on('data', chunk => { buffer += chunk; const line = buffer.split('\n').find(item => item.startsWith('{')); if (line) resolve(JSON.parse(line)); });
    child.once('exit', code => reject(new Error(`child exited early (${code})`)));
  });
  child.kill('SIGKILL');
  await new Promise(resolve => child.once('exit', resolve));
  // After a crash the profile lock remains; the dead owner is verified before removing it.
  const lock = join(realpathSync(directory), '.workspace.lock');
  assert.ok(existsSync(lock));
  unlinkSync(lock);
  f = createRuntimeFixture({ directory, pages: { 1: 'https://shop.example.com/cart', 2: 'https://docs.example.com/guide' } });
  assert.equal(f.task(ready.external).status, 'running', 'the store shows the state at the moment of the kill');
  assert.equal(f.task(ready.external).operations.at(-1).status, 'attempted', 'the attempt was committed before the click was dispatched');
  await f.tasks.init();
  const external = f.task(ready.external);
  const local = f.task(ready.local);
  assert.equal(external.status, 'uncertain');
  assert.equal(external.operations.at(-1).status, 'uncertain');
  assert.equal(external.run.blocker.kind, 'uncertain');
  assert.equal(local.status, 'paused');
  assert.equal(local.run.blocker.kind, 'server_restart');
  assert.equal(local.operations.at(-1).status, 'interrupted');
  assert.ok(transitions(external).includes('running>uncertain:server_restart_uncertain'));
  assert.ok(transitions(local).includes('running>paused:server_restart'));
  // The local capture is safe to run again on continue; the click is not.
  await f.run('tasks.continue', { id: ready.local });
  assert.equal((await f.settle(ready.local)).status, 'completed');
  assert.equal((await f.attempt('tasks.continue', { id: ready.external })).error.code, 'duplicate_risk');
  assert.equal(f.scripts.filter(item => /place-order/.test(item.source)).length, 0, 'restart never repeats the click');
});

test('handoff steps wait until the recipient completes the handoff', async t => {
  const f = setup(t);
  const id = await startTask(f, [{ kind: 'handoff', title: 'Ask a person to sign in', instruction: 'Sign in to the supplier portal', to: 'human' }, finding('after handoff')], { executor: { type: 'runner', autonomy: 'scoped' } });
  let task = await f.settle(id);
  assert.equal(task.status, 'waiting_on_human');
  assert.equal(task.run.blocker.kind, 'handoff');
  const handoff = await f.run('handoffs.get', { id: task.run.blocker.handoffId });
  assert.equal(handoff.taskId, id);
  assert.equal(handoff.from, `task:${id}`);
  await f.run('handoffs.complete', { id: handoff.id, status: 'completed', note: 'Signed in' });
  task = await f.settle(id);
  assert.equal(task.status, 'completed');
});

test('redirect replaces only steps that have not started; staleness marks results when inputs change', async t => {
  const f = setup(t);
  const material = await f.run('materials.create', { workspaceId: f.workspaceId, title: 'Brief', content: 'v1' });
  const id = await startTask(f, [finding('a'), { kind: 'review', title: 'Hold' }, finding('b')], { fields: { materialIds: [material.id] } });
  let task = await f.settle(id);
  assert.equal((await f.run('tasks.get', { id })).staleness.stale, false);
  await f.run('materials.update', { id: material.id, changes: { content: 'v2' } });
  const stale = await f.run('tasks.get', { id });
  assert.equal(stale.staleness.stale, true);
  assert.match(stale.staleness.reasons[0], /material .* changed/);
  await f.run('tasks.redirect', { id, objective: 'Use the new brief', steps: [{ kind: 'review', title: 'Hold again' }, finding('c')] });
  task = f.task(id);
  assert.deepEqual(task.plan.map(item => item.title), ['Record a', 'Hold again', 'Record c'], 'the completed step stays; the waiting review was not started and is replaced');
  assert.equal(task.timeline.at(-1).type, 'redirect');
});

test('provider switch mid-task: later model steps use the newly selected connection in the same conversation', { timeout: 20000 }, async t => {
  const reply = text => (req, res) => sse(res, [openaiDelta(text), openaiFinish('stop'), '[DONE]']);
  const first = await fakeEndpoint(t, reply('Answer from A'));
  const second = await fakeEndpoint(t, reply('Answer from B'));
  const directory = mkdtempSync(join(tmpdir(), 'weft-switch-'));
  const relay = new TurnRelay();
  const f = createRuntimeFixture({ directory });
  const providers = await new Providers({ directory, workspace: f.workspace, env: {}, relay }).init();
  f.tasks.providers = providers;
  t.after(() => { providers.close(); relay.close(); f.close(); rmSync(directory, { recursive: true, force: true, maxRetries: 5 }); });
  // The dispatcher in the fixture routes chat.send to providers via the runtime's dispatch; rebuild with real providers.
  const { createDispatcher } = await import('../src/dispatch.js');
  const dispatch = createDispatcher({ workspace: f.workspace, browser: f.browser, clients: f.clients, providers, admission: f.admission, tasks: f.tasks });
  const run = async (command, args) => { const outcome = await dispatch(command, args, human); if (outcome.error) throw new Error(`${command}: ${outcome.error.message}`); return outcome.result; };
  const a = await providers.execute('models.save', { name: 'A', provider: 'openai', model: 'model-a', endpoint: `${first.base}/v1` });
  const b = await providers.execute('models.save', { name: 'B', provider: 'openai', model: 'model-b', endpoint: `${second.base}/v1` });
  const task = await run('tasks.create', { workspaceId: f.workspaceId, title: 'Summarize', modelId: a.id, plan: [
    { kind: 'model', title: 'Draft', prompt: 'Draft a summary' }, { kind: 'review', title: 'Choose model' }, { kind: 'model', title: 'Refine', prompt: 'Refine the summary' }] });
  await run('tasks.start', { id: task.id, executor: { type: 'runner', autonomy: 'autonomous' } });
  let record = await f.settle(task.id);
  assert.equal(record.status, 'waiting_on_human');
  assert.equal(first.requests.length, 1);
  await run('tasks.redirect', { id: task.id, modelId: b.id, note: 'Switch to B' });
  assert.ok((await run('tasks.get', { id: task.id })).staleness.reasons.some(reason => /model changed/.test(reason)));
  await run('tasks.review', { id: task.id, stepId: 's2', decision: 'approve' });
  record = await f.settle(task.id);
  assert.equal(record.status, 'completed');
  assert.equal(second.requests.length, 1);
  const sent = second.requests[0].body.messages.map(message => message.content).join('\n');
  assert.match(sent, /Answer from A/, 'the conversation history carries over to the new provider');
  const conversation = f.workspace.getConversation(record.run.conversationId);
  assert.deepEqual(conversation.messages.filter(message => message.role === 'assistant').map(message => message.model), ['model-a', 'model-b']);
  assert.deepEqual(record.operations.filter(op => op.kind === 'model').map(op => op.modelId), [a.id, b.id]);
  assert.equal((await run('tasks.get', { id: task.id })).staleness.stale, false);
});

test('imported tasks never resume and legacy waiting records use the shared vocabulary', async t => {
  const f = setup(t);
  const id = await startTask(f, [{ kind: 'review', title: 'Hold' }]);
  await f.settle(id);
  const legacy = await f.run('tasks.create', { workspaceId: f.workspaceId, title: 'Legacy' });
  const exported = await f.run('workspaces.export', { id: f.workspaceId });
  f.workspace.browser = null; // The fake browser has no Electron sessions to switch to after import.
  exported.tasks.find(item => item.id === legacy.id).status = 'waiting';
  const imported = await f.run('workspaces.import', { data: exported });
  const tasks = f.workspace.data.tasks.filter(item => item.workspaceId === imported.id);
  const runtime = tasks.find(item => item.title === 'Runtime task');
  assert.equal(runtime.status, 'paused');
  assert.equal(runtime.executor, undefined, 'authority is never imported');
  assert.equal(tasks.find(item => item.title === 'Legacy').status, 'waiting_on_human');
  assert.ok(imported.importReport.lossy.some(item => item.collection === 'tasks' && /runtime/.test(item.reason)));
});
