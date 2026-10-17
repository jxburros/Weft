import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WorkspaceService } from '../src/workspace.js';
import { ClientGrants } from '../src/clients.js';
import { AutomationAdmission } from '../src/admission.js';
import { createDispatcher } from '../src/dispatch.js';

const human = { actor: 'human', source: 'gui' };
function fixture(t) {
  const directory = mkdtempSync(join(tmpdir(), 'weft-trusted-context-'));
  const workspace = new WorkspaceService({ directory });
  const clients = new ClientGrants({ directory, masterToken: 'trust-test', workspace });
  const grant = clients.execute('clients.create', {
    name: 'Context writer', scopes: ['records.write'], workspaceIds: [workspace.activeWorkspaceId],
  }, human);
  const caller = clients.authenticate(grant.token);
  const dispatch = createDispatcher({ workspace, clients, admission: new AutomationAdmission(),
    browser: { tabs: new Map(), downloads: new Map() }, providers: {} });
  t.after(() => { workspace.close(); rmSync(directory, { recursive: true, force: true }); });
  return { workspace, caller, dispatch };
}
for (const category of ['confirmed', 'instructions', 'decisions']) {
  test(`automation cannot delete or demote human ${category} context`, { timeout: 5000 }, async t => {
    const f = fixture(t);
    const record = await f.workspace.execute('context.create', { title: 'Trusted', content: 'Human established', category }, human);
    await assert.rejects(f.workspace.execute('context.delete', { id: record.id }, { actor: 'automation' }), /human approval/);
    for (const [command, args] of [
      ['context.delete', { id: record.id }],
      ['context.update', { id: record.id, changes: { category: 'findings' } }],
      ['context.update', { id: record.id, changes: { content: 'Replaced' } }],
    ]) {
      const outcome = await f.dispatch(command, args, f.caller);
      assert.equal(outcome.error?.code, 'permission_required');
      assert.deepEqual(f.workspace.record('context', record.id), record);
    }
    assert.equal((await f.dispatch('context.delete', { id: record.id }, human)).error, null);
    assert.equal(f.workspace.snapshot().context.length, 0);
  });
}
test('scoped writers can delete findings and questions without gaining promotion rights', { timeout: 5000 }, async t => {
  const f = fixture(t);
  for (const category of ['findings', 'questions']) {
    const record = await f.workspace.execute('context.create', { title: 'Unreviewed', category }, human);
    assert.equal((await f.dispatch('context.update', { id: record.id, changes: { category: 'confirmed' } }, f.caller)).error?.code, 'permission_required');
    assert.equal((await f.dispatch('context.delete', { id: record.id }, f.caller)).error, null);
  }
  assert.equal(f.workspace.snapshot().context.length, 0);
});
