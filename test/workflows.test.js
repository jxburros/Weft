import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRuntimeFixture, human } from './fixtures/task-runtime-fixture.mjs';
import { matchUrlPattern, normalizeParameters, substitute } from '../src/task-runtime.js';

function setup(t, options = {}) {
  const directory = mkdtempSync(join(tmpdir(), 'weft-workflows-'));
  const f = createRuntimeFixture({ directory, ...options });
  t.after(() => { f.close(); rmSync(directory, { recursive: true, force: true, maxRetries: 5 }); });
  return f;
}
const agentGrant = async (f, scopes = ['read', 'records.write']) => {
  const grant = await f.run('clients.create', { name: 'Workflow agent', scopes, workspaceIds: [f.workspaceId] });
  return { actor: `client:${grant.clientId}`, source: 'api', clientId: grant.clientId, workspaceIds: [f.workspaceId] };
};
const orderWorkflow = extra => ({
  title: 'Reorder supplies', enabled: true, description: 'Search the supplier and record the result',
  parameters: [{ name: 'item', type: 'string' }, { name: 'quantity', type: 'number', required: false, default: 1 }, { name: 'size', type: 'enum', options: ['small', 'large'] },
    { name: 'portal', type: 'url', required: false }],
  allowedSites: ['shop.example.com'],
  steps: [
    { title: 'Search {{item}}', kind: 'command', command: 'page.fill', args: { selector: '#q', value: '{{item}} ({{size}})' }, reviewRequired: false, expect: { urlPattern: 'https://shop.example.com/*' } },
    { title: 'Record order', kind: 'command', command: 'context.create', args: { title: 'Ordered {{item}}', content: 'Quantity {{quantity}}', category: 'findings' }, reviewRequired: false },
  ],
  expectedOutputs: 'A findings record naming the item', ...extra,
});

test('parameter substitution keeps whole-value types and placeholders must be declared', () => {
  assert.deepEqual(substitute({ count: '{{n}}', label: 'x{{n}}y', nested: ['{{flag}}'] }, { n: 3, flag: true }), { count: 3, label: 'x3y', nested: [true] });
  assert.throws(() => substitute('{{missing}}', {}), /Missing parameter missing/);
  assert.deepEqual(normalizeParameters(['Search terms']).map(item => [item.name, item.label, item.type]), [['Search_terms', 'Search terms', 'string']], 'legacy free-text parameters become typed required strings');
  assert.throws(() => normalizeParameters([{ name: 'a' }, { name: 'a' }]), /Duplicate/);
  assert.equal(matchUrlPattern('https://shop.example.com/orders/*', 'https://shop.example.com/orders/17?x=1'), true);
  assert.equal(matchUrlPattern('https://shop.example.com/orders/*', 'https://shop.example.com/account'), false);
  assert.equal(matchUrlPattern('https://shop.example.com/*', 'https://evil.example.net/shop.example.com/'), false);
});

test('workflow parameters are validated by type before a run; credentials resolve only through the broker interface', async t => {
  const f = setup(t);
  const workflow = await f.run('workflows.create', { workspaceId: f.workspaceId, ...orderWorkflow() });
  const check = parameters => f.run('workflows.validate', { id: workflow.id, parameters });
  const good = await check({ item: 'paper', size: 'large', quantity: 5 });
  assert.equal(good.ok, true, JSON.stringify(good.errors));
  const bad = await check({ item: 'paper', size: 'medium', quantity: 'many', portal: 'ftp://x', extra: 1 });
  assert.equal(bad.ok, false);
  for (const pattern of [/size: expected one of small, large/, /quantity: expected a number/, /portal: expected an http/, /Unknown parameter extra/]) assert.ok(bad.errors.some(error => pattern.test(error)), String(pattern));
  assert.ok((await check({ size: 'small' })).errors.some(error => /item is required/.test(error)));
  assert.ok((await check({ item: 'x', size: 'small', password: 'hunter2' })).errors.some(error => /secret field names/.test(error)), 'secret-named parameters are refused');
  const refused = await f.attempt('workflows.run', { id: workflow.id, parameters: { item: 'paper', size: 'medium' } });
  assert.equal(refused.error.code, 'invalid_arguments');
  assert.equal(f.workspace.data.tasks.length, 0, 'an invalid run creates nothing');
  // Undeclared placeholders and credential placeholders in arguments are workflow errors.
  const sloppy = await f.run('workflows.create', { workspaceId: f.workspaceId, title: 'Sloppy', parameters: [{ name: 'login', type: 'credential' }],
    steps: [{ title: 'Type', kind: 'command', command: 'page.fill', args: { selector: '#user', value: '{{login}} {{who}}' }, reviewRequired: false }] });
  const sloppyReport = await f.run('workflows.validate', { id: sloppy.id });
  assert.ok(sloppyReport.errors.some(error => /undeclared parameter \{\{who\}\}/.test(error)));
  assert.ok(sloppyReport.errors.some(error => /credentials are never typed by automation/.test(error)));
  // Credential references are opaque and checked through the broker interface; without a broker they never resolve.
  const withCredential = await f.run('workflows.create', { workspaceId: f.workspaceId, ...orderWorkflow({ title: 'Signed-in reorder', credentialRefs: [{ name: 'supplier', ref: 'cred.supplier-login' }] }) });
  assert.ok((await f.run('workflows.validate', { id: withCredential.id })).errors.some(error => /credential broker is not available/.test(error)));
});

test('a credential reference that the broker confirms lets the run proceed without any secret in the record', async t => {
  const seen = [];
  const f = setup(t, { credentials: { status: (ref, scope) => { seen.push([ref, scope.workspaceId]); return { available: ref === 'cred.supplier-login', reason: 'unknown reference' }; } } });
  const workflow = await f.run('workflows.create', { workspaceId: f.workspaceId, ...orderWorkflow({ credentialRefs: [{ name: 'supplier', ref: 'cred.supplier-login' }], expectedOutputs: '' }) });
  const report = await f.run('workflows.validate', { id: workflow.id, parameters: { item: 'ink', size: 'small' } });
  assert.equal(report.ok, true, JSON.stringify(report.errors));
  assert.deepEqual(seen[0], ['cred.supplier-login', f.workspaceId]);
});

test('runs substitute parameters, enforce allowed sites, ask for expected-output review and keep sensitive values out of records', async t => {
  const f = setup(t);
  const workflow = await f.run('workflows.create', { workspaceId: f.workspaceId, ...orderWorkflow({ parameters: [...orderWorkflow().parameters, { name: 'note', type: 'string', sensitive: true, required: false, default: '' }],
    steps: [...orderWorkflow().steps, { title: 'Private note', kind: 'command', command: 'context.create', args: { title: 'Note', content: '{{note}}', category: 'findings' }, reviewRequired: false }] }) });
  const task = await f.run('workflows.run', { id: workflow.id, parameters: { item: 'paper', size: 'large', quantity: 2, note: 'door code 4471' }, tabId: 1, executor: { type: 'runner', autonomy: 'autonomous' } });
  let record = await f.settle(task.id);
  assert.equal(record.status, 'waiting_on_human');
  assert.equal(record.run.blocker.kind, 'expected_outputs');
  const fill = f.scripts.find(item => /"selector":"#q"/.test(item.source));
  assert.match(fill.source, /paper \(large\)/, 'parameters are substituted at execution time');
  assert.equal(f.workspace.data.context.find(item => item.title === 'Ordered paper').content, 'Quantity 2');
  assert.deepEqual(record.workflowRun.sensitive, ['note']);
  assert.equal(JSON.stringify(record).includes('4471'), false, 'sensitive parameter values are never stored on the task');
  assert.equal(JSON.stringify(f.authority.activity.entries).includes('4471'), false, 'or in activity');
  await f.run('tasks.review', { id: task.id, stepId: '_outputs', decision: 'approve', note: 'Finding recorded' });
  record = await f.settle(task.id);
  assert.equal(record.status, 'completed');
  // A step that would leave the allowed sites pauses before running.
  f.page.urls[1] = 'https://elsewhere.example.org/';
  const offsite = await f.run('workflows.run', { id: workflow.id, parameters: { item: 'ink', size: 'small' }, tabId: 1, executor: { type: 'runner', autonomy: 'autonomous' } });
  record = await f.settle(offsite.id);
  assert.equal(record.status, 'paused');
  assert.equal(record.run.blocker.kind, 'invalidated', 'the expected URL no longer matches');
});

test('invalidated steps pause with a blocker: missing selectors and changed URLs never execute blindly', async t => {
  const f = setup(t);
  const workflow = await f.run('workflows.create', { workspaceId: f.workspaceId, ...orderWorkflow({ expectedOutputs: '' }) });
  f.page.missing('#q');
  const run = await f.run('workflows.run', { id: workflow.id, parameters: { item: 'paper', size: 'small' }, tabId: 1, executor: { type: 'runner', autonomy: 'autonomous' } });
  let record = await f.settle(run.id);
  assert.equal(record.status, 'paused');
  assert.equal(record.run.blocker.kind, 'invalidated');
  assert.equal(record.run.blocker.reason, 'selector_not_found');
  assert.equal(record.operations.at(-1).status, 'not_started', 'a missing element means nothing was typed');
  assert.equal(f.workspace.data.context.length, 0, 'later steps did not run');
  // The person fixes the step (the site changed its search box) and continues.
  await f.run('tasks.redirect', { id: run.id, steps: [{ kind: 'command', title: 'Search', command: 'page.fill', args: { selector: '#search', value: '{{item}}' } }, orderWorkflow().steps[1]] });
  await f.run('tasks.continue', { id: run.id });
  record = await f.settle(run.id);
  assert.equal(record.status, 'completed');
  // A URL assumption that no longer holds is detected before input.
  f.page.urls[1] = 'https://shop.example.com/maintenance';
  const moved = await f.run('workflows.create', { workspaceId: f.workspaceId, ...orderWorkflow({ expectedOutputs: '', steps: [{ ...orderWorkflow().steps[0], expect: { urlPattern: 'https://shop.example.com/search*' } }] }) });
  const second = await f.run('workflows.run', { id: moved.id, parameters: { item: 'ink', size: 'small' }, tabId: 1, executor: { type: 'runner', autonomy: 'autonomous' } });
  record = await f.settle(second.id);
  assert.equal(record.run.blocker.reason, 'url_mismatch');
  assert.equal(record.operations.length, 0, 'no operation was attempted');
});

test('saving or importing a workflow never authorizes it; agent edits require human review again', async t => {
  const f = setup(t);
  const agent = await agentGrant(f);
  const drafted = await f.run('workflows.create', { workspaceId: f.workspaceId, ...orderWorkflow() }, agent);
  assert.equal(drafted.enabled, false, 'a workflow written by automation waits for review');
  const refused = await f.attempt('workflows.run', { id: drafted.id, parameters: { item: 'x', size: 'small' } }, agent);
  assert.equal(refused.error.details.authority.reason, 'workflow_inactive');
  assert.equal((await f.attempt('workflows.update', { id: drafted.id, changes: { enabled: true } }, agent)).error.code, 'permission_required');
  await f.run('workflows.update', { id: drafted.id, changes: { enabled: true } });
  await f.run('workflows.update', { id: drafted.id, changes: { steps: [{ title: 'Buy everything', kind: 'command', command: 'page.click', args: { selector: '#buy-all' }, reviewRequired: false }] } }, agent);
  assert.equal(f.workspace.data.workflows.find(item => item.id === drafted.id).enabled, false, 'changing what a workflow does disables it until reviewed');
  // Import: format 2 keeps the inactive flag; even a person must review before running.
  const reviewed = await f.run('workflows.create', { workspaceId: f.workspaceId, ...orderWorkflow({ title: 'Reviewed', expectedOutputs: '' }) });
  assert.equal(reviewed.enabled, true);
  const exported = await f.run('workspaces.export', { id: f.workspaceId });
  f.workspace.browser = null; // The fake browser has no Electron sessions to switch to after import.
  const imported = await f.run('workspaces.import', { data: exported });
  assert.ok(imported.importReport.policies.workflows.every(item => item.enabled === false));
  const copy = f.workspace.data.workflows.find(item => item.workspaceId === imported.id && item.title === 'Reviewed');
  assert.equal(copy.enabled, false);
  assert.equal((await f.attempt('workflows.run', { id: copy.id, parameters: { item: 'x', size: 'small' } })).error.details.authority.reason, 'workflow_inactive');
  assert.equal((await f.run('workflows.validate', { id: copy.id })).enabled, false);
  // An agent may run an enabled workflow only as itself, under its own current grants.
  const enabled = await f.run('workflows.create', { workspaceId: f.workspaceId, ...orderWorkflow({ title: 'Agent run', expectedOutputs: '' }) });
  assert.equal((await f.attempt('workflows.run', { id: enabled.id, parameters: { item: 'x', size: 'small' }, executor: { type: 'runner', autonomy: 'autonomous' } }, agent)).error.details.authority.reason, 'executor_not_self');
  const own = await f.run('workflows.run', { id: enabled.id, parameters: { item: 'x', size: 'small' }, tabId: 1 }, agent);
  const record = await f.settle(own.id);
  assert.equal(record.status, 'paused', 'the agent grant has no tabs.control scope');
  assert.equal(record.run.blocker.kind, 'permission');
});

test('recording turns a person’s actions into secret-free steps and parameters', async t => {
  const f = setup(t);
  assert.equal((await f.attempt('workflows.recordStart', { tabId: 1 }, { actor: 'automation' })).error.code, 'permission_required', 'recording is human-only');
  const started = await f.run('workflows.recordStart', { tabId: 1, title: 'Supplier login and search' });
  assert.equal(started.recording, true);
  await f.run('page.navigate', { tabId: 1, url: 'https://shop.example.com/login?session=abc123' });
  await f.run('page.fill', { tabId: 1, selector: '#password', value: 'hunter2-secret' });
  await f.run('page.fill', { tabId: 1, selector: '#q', value: 'my private query' });
  await f.run('page.press', { tabId: 1, key: 'x' });
  await f.run('page.press', { tabId: 1, key: 'Enter' });
  // In-page events come from the isolated-world recorder with selectors and labels only.
  f.tasks.recordPageEvent(1, { type: 'click', selector: 'button.search', label: 'Search' });
  f.tasks.recordPageEvent(1, { type: 'fill', selector: 'input[name="cvc"]', label: 'Security code', sensitive: true });
  f.browser.onNavigate({ tabId: 1, url: 'https://shop.example.com/results?q=private&token=t0k' });
  const stopped = await f.run('workflows.recordStop', { tabId: 1 });
  assert.equal(stopped.saved, true);
  assert.equal(stopped.omitted, 1, 'typed characters are omitted, not recorded');
  const workflow = f.workspace.data.workflows.find(item => item.id === stopped.workflow.id);
  const json = JSON.stringify(workflow);
  for (const secret of ['hunter2-secret', 'my private query', 'abc123', 't0k', '"x"']) assert.equal(json.includes(secret), false, secret);
  assert.equal(workflow.enabled, false, 'recorded workflows wait for review');
  const steps = workflow.steps.map(step => [step.kind, step.command ?? null, step.args?.value ?? null]);
  assert.deepEqual(steps, [
    ['command', 'page.navigate', null],
    ['command', 'page.navigate', null],
    ['command', 'credentials.fill', null],
    ['command', 'page.fill', '{{field_2}}'],
    ['command', 'page.press', null],
    ['command', 'page.click', null],
    ['instruction', null, null],
  ]);
  assert.equal(workflow.steps[0].args.url, 'https://shop.example.com/cart', 'recording starts from the tab’s current page');
  assert.equal(workflow.steps[1].args.url, 'https://shop.example.com/login', 'secret-named query parameters are stripped');
  assert.deepEqual(workflow.steps.at(-1).expect, undefined);
  assert.deepEqual(workflow.parameters.map(item => [item.name, item.type]), [['field_1', 'credential'], ['field_2', 'string'], ['field_3', 'credential']]);
  assert.deepEqual(workflow.allowedSites, ['shop.example.com']);
  const report = await f.run('workflows.validate', { id: workflow.id });
  assert.ok(report.warnings.some(warning => /Sensitive field/.test(warning)));
});
