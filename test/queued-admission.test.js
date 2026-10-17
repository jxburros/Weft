import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WorkspaceService } from '../src/workspace.js';
import { ClientGrants } from '../src/clients.js';
import { AutomationAdmission } from '../src/admission.js';
import { createDispatcher } from '../src/dispatch.js';
import { budget } from './time-budget.js';

const human = { actor: 'human', source: 'gui' };
function fixture(t) {
  const directory = mkdtempSync(join(tmpdir(), 'weft-queued-admission-'));
  const workspace = new WorkspaceService({ directory });
  const admission = new AutomationAdmission();
  const clients = new ClientGrants({ directory, masterToken: 'queue-test', workspace });
  const grant = clients.execute('clients.create', {
    name: 'Queued writer', scopes: ['read', 'records.write'], workspaceIds: [workspace.activeWorkspaceId], ttlSeconds: 60,
  }, human);
  const context = clients.authenticate(grant.token);
  const tab = { id: 1, workspaceId: workspace.activeWorkspaceId };
  const browser = { tabs: new Map([[1, tab]]), downloads: new Map(), activeId: 1, tab: () => tab };
  workspace.attachBrowser(browser);
  const dispatch = createDispatcher({ workspace, clients, browser, admission, providers: {} });
  t.after(() => { workspace.close(); rmSync(directory, { recursive: true, force: true }); });
  return { workspace, admission, clients, grant, context, dispatch, browser };
}
const invalidate = {
  revoke: f => f.clients.execute('clients.revoke', { clientId: f.grant.clientId }, human),
  expire: f => { f.clients.clock = () => f.grant.expiresAt + 1; },
  stop: f => f.admission.stop(),
};
for (const [reason, block] of Object.entries(invalidate)) {
  test(`${reason} prevents an admitted workspace write from executing after its queue wait`, { timeout: budget(5000) }, async t => {
    const f = fixture(t);
    let release;
    f.workspace.queue = new Promise(resolve => { release = resolve; });
    const pending = f.dispatch('materials.create', { title: 'Must not persist' }, f.context);
    block(f);
    release();
    const outcome = await pending;
    assert.equal(outcome.error?.code, reason === 'stop' ? 'emergency_stop' : 'permission_required');
    assert.equal(f.workspace.snapshot().materials.length, 0);
  });
  test(`${reason} rolls back a capture when authority changes while awaiting browser evidence`, { timeout: budget(5000) }, async t => {
    const f = fixture(t);
    let started; let release;
    const capturing = new Promise(resolve => { started = resolve; });
    f.browser.captureArtifact = async () => {
      started();
      await new Promise(resolve => { release = resolve; });
      return { title: 'Late evidence', text: 'Must not persist' };
    };
    const pending = f.dispatch('artifacts.capture', { tabId: 1, kind: 'text' }, f.context);
    await capturing;
    block(f); release();
    const outcome = await pending;
    assert.equal(outcome.error?.code, reason === 'stop' ? 'emergency_stop' : 'permission_required');
    assert.equal(f.workspace.snapshot().artifacts.length, 0);
  });
}

test('revocation also prevents an admitted queued read from returning private records', { timeout: budget(5000) }, async t => {
  const f = fixture(t);
  await f.workspace.execute('materials.create', { title: 'Private title' }, human);
  let release;
  f.workspace.queue = new Promise(resolve => { release = resolve; });
  const pending = f.dispatch('materials.list', {}, f.context);
  invalidate.revoke(f); release();
  const outcome = await pending;
  assert.equal(outcome.error?.code, 'permission_required');
  assert.equal(outcome.result, null);
  assert.doesNotMatch(JSON.stringify(outcome), /Private title/);
});
