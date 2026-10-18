import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { createRuntimeFixture } from './fixtures/task-runtime-fixture.mjs';
import { CredentialService } from '../src/credentials.js';

const SECRET = 'task-runtime-secret-8817';
const ORIGIN = 'https://accounts.example.test';
/** Test-only stand-in for OS-protected storage (see test/credentials.test.js). */
function testProtector() {
  const key = randomBytes(32);
  return {
    status: () => ({ available: true, backend: 'test-keychain', protected: true }),
    wrap(text) { const iv = randomBytes(12); const cipher = createCipheriv('aes-256-gcm', key, iv); const data = Buffer.concat([cipher.update(text, 'utf8'), cipher.final()]); return Buffer.concat([iv, cipher.getAuthTag(), data]); },
    unwrap(bytes) { const decipher = createDecipheriv('aes-256-gcm', key, bytes.subarray(0, 12)); decipher.setAuthTag(bytes.subarray(12, 28)); return Buffer.concat([decipher.update(bytes.subarray(28)), decipher.final()]).toString('utf8'); },
  };
}

async function setup(t) {
  const directory = mkdtempSync(join(tmpdir(), 'weft-task-credentials-'));
  const f = createRuntimeFixture({ directory, pages: { 1: `${ORIGIN}/login` },
    credentialService: ({ workspace, browser }) => new CredentialService({ directory: join(directory, 'credentials'), protector: testProtector(), browser, workspace,
      promptSecret: async () => ({ username: 'person@example.test', password: SECRET }) }) });
  t.after(() => { f.close(); rmSync(directory, { recursive: true, force: true, maxRetries: 5 }); });
  // The browser half of a fill (origin checks, protected operation) is covered with real Chromium in credentials-browser.test.js.
  f.fills = [];
  f.fillBehavior = null;
  f.browser.credentialFill = async (args, context, { credential, release }) => {
    if (!credential.origins.includes(new URL(f.page.urls[args.tabId]).origin)) throw Object.assign(new Error('origin'), { code: 'target_mismatch', notStarted: true });
    const secret = await release(ORIGIN, ORIGIN);
    f.fills.push({ args, actor: context.actor, username: secret.username });
    if (f.fillBehavior) return f.fillBehavior();
    return { status: 'filled', fields: ['username', 'password'], submit: args.submit ? 'submitted' : 'not_requested', frame: 'top', origin: ORIGIN, navigation: 'none', outcome: 'unverified' };
  };
  const created = await f.run('credentials.create', { workspaceId: f.workspaceId, label: 'Supplier portal', purpose: 'Reorder supplies', origins: [ORIGIN] });
  const workflow = await f.run('workflows.create', { workspaceId: f.workspaceId, title: 'Sign in and reorder', allowedSites: ['accounts.example.test'],
    credentialRefs: [{ name: 'portal', ref: created.id, purpose: 'Supplier sign-in' }],
    steps: [{ title: 'Sign in', kind: 'command', command: 'credentials.fill', args: { id: '{{portal}}', submit: true }, reviewRequired: false },
      { title: 'Note it', kind: 'command', command: 'context.create', args: { title: 'Signed in', category: 'findings' }, reviewRequired: false }] });
  return Object.assign(f, { credential: created, workflow });
}
const everything = f => JSON.stringify([f.workspace.data.tasks, f.workspace.data.workflows, f.authority.activity.entries, f.authority.approvals.items]);

test('workflow credential references resolve through the broker; agents see only opaque ids', async t => {
  const f = await setup(t);
  const report = await f.run('workflows.validate', { id: f.workflow.id });
  assert.equal(report.ok, true, JSON.stringify(report.errors));
  const missing = await f.run('workflows.create', { workspaceId: f.workspaceId, title: 'Unknown sign-in', credentialRefs: [{ name: 'portal', ref: 'cred_00000000-0000-4000-8000-00000000abcd' }],
    steps: [{ title: 'Sign in', kind: 'command', command: 'credentials.fill', args: { id: '{{portal}}' }, reviewRequired: false }] });
  assert.ok((await f.run('workflows.validate', { id: missing.id })).errors.some(error => /No saved sign-in/.test(error)));
  await f.run('credentials.revoke', { id: f.credential.id });
  assert.ok((await f.run('workflows.validate', { id: f.workflow.id })).errors.some(error => /saved sign-in is revoked/.test(error)));
});

test('a credentials.fill step needs an exact approval or a human task grant, and its secret never reaches task records', async t => {
  const f = await setup(t);
  const run = await f.run('workflows.run', { id: f.workflow.id, tabId: 1, executor: { type: 'runner', autonomy: 'autonomous' } });
  let task = await f.settle(run.id);
  assert.equal(task.status, 'waiting_on_human', 'credential use is once-only: even an autonomous runner waits');
  assert.equal(task.run.blocker.kind, 'approval');
  assert.equal(f.fills.length, 0);
  // A person grants this task one use of this sign-in, then continues it.
  await f.run('credentials.grantTask', { id: f.credential.id, taskId: run.id, uses: 1 });
  await f.run('tasks.continue', { id: run.id });
  task = await f.settle(run.id);
  assert.equal(task.status, 'completed');
  assert.equal(f.fills.length, 1);
  assert.equal(f.fills[0].actor, `task:${run.id}`);
  assert.equal(f.fills[0].args.submit, true);
  const fill = task.operations.find(op => op.command === 'credentials.fill' && op.status === 'completed');
  assert.equal(fill.external, true, 'a fill (with submit) is recorded as attempted external work before it runs');
  assert.equal(fill.actionClass, 'credential_use');
  assert.equal(everything(f).includes(SECRET), false);
  // The single granted use is spent: a second run waits for a person again.
  const again = await f.run('workflows.run', { id: f.workflow.id, tabId: 1, executor: { type: 'runner', autonomy: 'autonomous' } });
  assert.equal((await f.settle(again.id)).run.blocker.kind, 'approval');
});

test('an interrupted credential fill with submit becomes uncertain and is never repeated blindly', async t => {
  const f = await setup(t);
  f.fillBehavior = () => { throw Object.assign(new Error('The page navigated while the login form was being submitted'), { code: 'action_interrupted' }); };
  const run = await f.run('workflows.run', { id: f.workflow.id, tabId: 1, start: false });
  await f.run('credentials.grantTask', { id: f.credential.id, taskId: run.id, uses: 2 });
  await f.run('tasks.start', { id: run.id, executor: { type: 'runner', autonomy: 'autonomous' } });
  const task = await f.settle(run.id);
  assert.equal(task.status, 'uncertain', JSON.stringify(task.operations.map(op => [op.command, op.status, op.error])) + JSON.stringify(f.fills.length));
  assert.equal(task.operations.at(-1).status, 'uncertain');
  assert.equal((await f.attempt('tasks.continue', { id: run.id })).error.code, 'duplicate_risk');
  assert.equal(f.fills.length, 1, 'the sign-in was not submitted twice');
  assert.equal(everything(f).includes(SECRET), false);
});
