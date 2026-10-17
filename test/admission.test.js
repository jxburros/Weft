import test from 'node:test';
import assert from 'node:assert/strict';
import { AutomationAdmission, resolveCommandTargets } from '../src/admission.js';
import { actionClassForCommand, evaluateAutonomy } from '../src/autonomy.js';
import { commands } from '../src/commands.js';

test('emergency stop is a shared latch and only a trusted actor may resume', () => {
  const gate = new AutomationAdmission();
  gate.assertAutomationAdmitted('automation', 'page.readable');
  gate.stop();
  for (const actor of ['automation', 'model-reader', 'task-executor', undefined]) {
    for (const command of ['tabs.new', 'page.readable', 'search.query', 'chat.send', 'browser.resumeAutomation']) {
      assert.throws(() => gate.assertAutomationAdmitted(actor, command), { code: 'emergency_stop' });
    }
    assert.throws(() => gate.resume(actor), { code: 'human_required' });
  }
  gate.assertAutomationAdmitted('human', 'page.navigate');
  gate.resume('human');
  assert.equal(gate.status.stopped, false);
});

function targets() {
  const state = { workspaces: [{ id: 'a' }, { id: 'b' }], materials: [{ id: 'note', workspaceId: 'b' }] };
  const tabs = new Map([[1, { id: 1, workspaceId: 'a' }], [2, { id: 2, workspaceId: 'b' }]]);
  return { workspace: { activeWorkspaceId: 'a', snapshot: () => state }, browser: { tabs, activeId: 1, tab: id => tabs.get(id) }, commands };
}
test('automation cannot follow changing human focus across workspaces', () => {
  const fixture = targets();
  const actor = { actor: 'automation' };
  for (const [name, args] of [['page.readable', {}], ['page.readable', { workspaceId: 'a' }], ['materials.list', {}]]) {
    assert.throws(() => resolveCommandTargets(name, args, actor, fixture), { code: 'ambiguous_target' });
  }
  assert.throws(() => resolveCommandTargets('page.readable', { workspaceId: 'a', tabId: 2 }, actor, fixture), { code: 'target_mismatch' });
  const resolved = resolveCommandTargets('page.readable', { workspaceId: 'b', tabId: 2 }, actor, fixture);
  assert.deepEqual(resolved.target, { workspaceId: 'b', tabId: 2 });
  assert.equal(resolveCommandTargets('materials.get', { id: 'note' }, actor, fixture).target.workspaceId, 'b');
  const human = resolveCommandTargets('page.readable', {}, { actor: 'human' }, fixture);
  fixture.browser.activeId = 2;
  fixture.workspace.activeWorkspaceId = 'b';
  assert.deepEqual(human.args, { tabId: 1, workspaceId: 'a' });
});

test('catalog classifications are exhaustive; approval cannot override a hard floor', () => {
  for (const name of Object.keys(commands)) assert.notEqual(actionClassForCommand(name), 'restricted', name);
  assert.equal(actionClassForCommand('future.unknown'), 'restricted');
  for (const actionClass of ['administration', 'restricted', 'future-class']) {
    assert.equal(evaluateAutonomy({ actor: 'automation', actionClass, approved: true }).decision, 'deny');
  }
  assert.equal(evaluateAutonomy({ actor: 'automation', actionClass: 'external_write' }).decision, 'approval');
  assert.equal(evaluateAutonomy({ actor: 'automation', actionClass: 'local_write', level: 'observe', approved: true }).decision, 'deny');
});
