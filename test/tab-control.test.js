import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EventEmitter } from 'node:events';
import { Browser } from '../src/browser.js';
import { WorkspaceService } from '../src/workspace.js';
import { DatabaseSync } from '../src/sqlite.js';
import { AutomationAdmission } from '../src/admission.js';
import { ClientGrants } from '../src/clients.js';
import { createDispatcher } from '../src/dispatch.js';
import { commands } from '../src/commands.js';
import { budget } from './time-budget.js';

const human = { actor: 'human', source: 'gui' };

/** Real dispatcher, grants, workspace store and lease logic over a scripted page. */
async function fixture(t) {
  const directory = mkdtempSync(join(tmpdir(), 'weft-tab-control-'));
  const workspace = new WorkspaceService({ directory });
  const workspaceId = workspace.activeWorkspaceId;
  const session = new EventEmitter();
  session.setPermissionRequestHandler = () => {};
  session.setPermissionCheckHandler = () => {};
  const admission = new AutomationAdmission();
  const browser = new Browser({ session, workspaceService: workspace, admission, electronApi: {} });
  workspace.attachBrowser(browser);
  const page = { snapshotRefs: ['f0e1', 'f0e2'], clicks: [] };
  const webContents = {
    getURL: () => 'https://example.test/form?session=secret-value', getTitle: () => 'Fixture ‮evil‬ title', stop: () => { page.stopped = true; },
    isDestroyed: () => false, close: () => {},
    async executeJavaScript(code) {
      if (code.includes('weftObservation')) {
        const op = code.match(/\)\("(\w+)", \{.*\}\)$/s)?.[1];
        if (op === 'snapshot') return { url: 'https://example.test/form', title: 'Fixture', viewport: { url: 'https://example.test/form', width: 800, height: 600, scrollX: 0, scrollY: 0, devicePixelRatio: 1 },
          nodes: page.snapshotRefs.map((ref, index) => ({ ref, role: 'button', name: `Button ${index}`, depth: 0, frame: 'f0' })), frames: [{ frameId: 'f0', accessible: true }],
          counts: { visited: 2, hidden: 0, omitted: 0, sensitiveInputs: 0, opaque: 0, lazyImages: 0, busy: 0, inaccessibleFrames: 0, openShadowRoots: 0 }, virtualized: [], truncated: null, refs: [...page.snapshotRefs] };
        if (op === 'click') {
          const { selector = null } = JSON.parse(code.match(/\)\("click", (\{.*\})\)$/s)[1]);
          page.clicks.push(selector);
          if (selector === '#slow') return new Promise(resolve => { page.finish = () => resolve({ ok: true }); });
          return { ok: true };
        }
      }
      return 7;
    },
  };
  browser.tabs.set(1, { id: 1, workspaceId, version: 1, controller: 'available', view: { webContents } });
  browser.activeId = 1;
  const clients = new ClientGrants({ directory, masterToken: 'tab-control-master', workspace });
  const providers = { close() {}, execute() { throw new Error('Unexpected provider call'); } };
  const dispatch = createDispatcher({ workspace, browser, clients, providers, admission });
  const agents = [];
  for (const name of ['First agent', 'Second agent']) {
    // Autonomous grants: these tests exercise leases, inspection and queues behind the authority gate.
    const grant = (await dispatch('clients.create', { name, scopes: ['read', 'records.write', 'tabs.control'], workspaceIds: [workspaceId], autonomy: 'autonomous' }, human)).result;
    agents.push(clients.authenticate(grant.token));
  }
  t.after(() => { browser.close(); workspace.close(); rmSync(directory, { recursive: true, force: true, maxRetries: 5 }); });
  const as = (agent, command, args = {}) => {
    const fields = commands[command].inputSchema.properties;
    return dispatch(command, { ...(fields.workspaceId && { workspaceId }), ...(fields.tabId && { tabId: 1 }), ...args }, agent);
  };
  return { workspace, workspaceId, browser, dispatch, agents, as, page, directory, clients };
}

test('two scoped clients compete for one tab: leases, inspection, FIFO queue and visible status', { timeout: budget(15000) }, async t => {
  const f = await fixture(t);
  const [first, second] = f.agents;
  const claim = await f.as(first, 'tabs.claim');
  assert.equal(claim.result.controlMode, 'agent-drives');
  assert.equal((await f.as(second, 'tabs.claim')).error.code, 'lease_conflict');
  assert.equal((await f.as(second, 'page.click', { expectedVersion: claim.result.version, selector: '#1' })).error.code, 'lease_conflict');
  // Busy tabs reject immediately by default.
  const slow = f.as(first, 'page.click', { expectedVersion: claim.result.version, selector: '#slow' });
  await new Promise(resolve => setImmediate(resolve));
  const busy = await f.as(first, 'page.click', { expectedVersion: f.browser.tab(1).version, selector: '#2' });
  assert.equal(busy.error.code, 'tab_busy');
  f.page.finish();
  assert.equal((await slow).result.submitted, true);

  // Configured queueing serializes input in arrival order and shows ownership and waiting work.
  assert.ok((await f.dispatch('settings.update', { automation: { queueLimit: 2, queueTimeoutMs: 2000 } }, human)).error === null);
  await f.as(first, 'tabs.release');
  await f.as(first, 'page.inspect');
  await f.as(second, 'page.inspect');
  const version = f.browser.tab(1).version;
  const running = f.as(first, 'page.click', { expectedVersion: version, selector: '#slow' });
  await new Promise(resolve => setImmediate(resolve));
  const queued = f.as(second, 'page.click', { expectedVersion: version + 1, selector: '#second' });
  await new Promise(resolve => setImmediate(resolve));
  const status = (await f.dispatch('tabs.list', { workspaceId: f.workspaceId }, human)).result[0];
  assert.equal(status.activity.actor, first.actor);
  assert.deepEqual(status.queued.map(item => item.actor), [second.actor]);
  f.page.finish();
  assert.equal((await running).result.submitted, true);
  // The second actor reaches the front only after the first finished, then must still prove fresh state.
  assert.equal((await queued).error.code, 'stale_state');
  assert.equal(f.page.clicks.includes('#second'), false, 'conflicting input never interleaves');

  // Exclusive mode requires a lease even on an available tab.
  await f.dispatch('settings.update', { automation: { inputConcurrency: 'exclusive' } }, human);
  const inspected = await f.as(second, 'page.inspect');
  assert.equal((await f.as(second, 'page.click', { expectedVersion: inspected.result.version, selector: '#3' })).error.code, 'lease_conflict');
  const lease = await f.as(second, 'tabs.claim');
  assert.equal((await f.as(second, 'page.click', { expectedVersion: lease.result.version, selector: '#3' })).result.submitted, true);
});

test('takeover during an in-flight action reports what could not be cancelled and persists a handoff record', { timeout: budget(15000) }, async t => {
  const f = await fixture(t);
  const [first, second] = f.agents;
  const audits = [];
  const events = [];
  f.browser.onAudit = entry => audits.push(entry);
  f.browser.onEvent = event => events.push(event);
  await f.dispatch('settings.update', { automation: { queueLimit: 1, queueTimeoutMs: 2000 } }, human);
  const claim = await f.as(first, 'tabs.claim');
  const pending = f.as(first, 'page.click', { expectedVersion: claim.result.version, selector: '#slow' });
  await new Promise(resolve => setImmediate(resolve));
  const waiting = f.as(first, 'page.click', { expectedVersion: claim.result.version + 1, selector: '#queued' });
  await new Promise(resolve => setImmediate(resolve));
  const takeover = await f.dispatch('tabs.takeover', { tabId: 1, workspaceId: f.workspaceId }, human);
  assert.equal(takeover.result.controlMode, 'you-drive');
  assert.deepEqual(takeover.result.lastBoundary.interrupted.map(item => [item.command, item.actor, item.cancellable]), [['page.click', first.actor, false]]);
  assert.equal(takeover.result.lastBoundary.cancelledQueue.length, 1);
  assert.equal(f.page.stopped, true);
  assert.equal((await waiting).error.code, 'cancelled', 'queued input that never started is cancelled, not run');
  f.page.finish();
  const interrupted = await pending;
  assert.equal(interrupted.error.code, 'action_interrupted');
  assert.deepEqual(interrupted.error.details.interrupted, { command: 'page.click', cancellable: false });
  await new Promise(resolve => setTimeout(resolve, 20));
  const records = (await f.dispatch('handoffs.list', { workspaceId: f.workspaceId }, human)).result;
  const record = records.find(item => item.kind === 'takeover');
  assert.equal(record.from, first.actor);
  // The control boundary is durable activity and a metadata-only live handoff event.
  const boundary = audits.find(entry => entry.reason === 'control_boundary');
  assert.deepEqual([boundary.type, boundary.outcome, boundary.summary.interrupted, boundary.summary.cancelledQueue], ['override', 'recorded', 1, 1]);
  assert.ok(events.some(event => event.type === 'handoff' && event.status === 'takeover' && event.handoffId === record.id && event.tabId === 1));
  assert.equal(record.interrupted[0].command, 'page.click');
  assert.equal(record.tabs[0].url, 'https://example.test/form', 'secret query parameters are not stored');
  assert.equal(record.tabs[0].title, 'Fixture evil title', 'page-sourced bidi controls are stripped');
  // Ownership and the takeover record persist with the workspace store.
  const db = new DatabaseSync(join(f.directory, 'workspace.sqlite'), { readOnly: true });
  const stored = { browserSession: JSON.parse(db.prepare("SELECT value FROM state_meta WHERE key = 'browserSession'").get().value),
    handoffs: db.prepare("SELECT doc FROM records WHERE collection = 'handoffs' ORDER BY seq").all().map(row => JSON.parse(row.doc)) };
  db.close();
  assert.equal(stored.browserSession.tabs[0].controller, 'human');
  assert.equal(stored.handoffs.find(item => item.kind === 'takeover').interrupted[0].cancellable, false);
  assert.equal((await f.as(second, 'tabs.claim')).error.code, 'lease_conflict');
});

test('structured handoff: exact evidence, no secrets, addressed acceptance and mandatory re-inspection', { timeout: budget(15000) }, async t => {
  const f = await fixture(t);
  const [first, second] = f.agents;
  const claim = await f.as(first, 'tabs.claim');
  const artifact = await f.as(first, 'artifacts.create', { title: 'Evidence', text: 'Observed price 10' });
  const versionId = f.workspace.data.artifacts[0].versions[0].id;
  const base = { to: second.actor, objective: 'Compare prices', completedActions: ['Opened the form'], findings: ['Price shown as 10 (page claim)'], nextStep: 'Submit the comparison form', tabIds: [1],
    evidence: [{ type: 'artifact', id: artifact.result.id }, { type: 'url', id: 'https://example.test/item?token=abc&id=4' }] };
  for (const leak of [{ findings: ['password: hunter2'] }, { completedActions: ['Typed card 4111 1111 1111 1111'] }, { nextStep: 'Use Bearer abcdefghijklmnopqrstuvwxyz' }, { password: 'x' }]) {
    const refused = await f.as(first, 'handoffs.create', { ...base, ...leak });
    assert.ok(refused.error, `secret must be refused: ${JSON.stringify(leak)}`);
  }
  assert.equal((await f.as(first, 'handoffs.create', { ...base, evidence: [{ type: 'artifact', id: 'artifact_missing' }] })).error.code, 'not_found');
  const created = await f.as(first, 'handoffs.create', base);
  assert.equal(created.error, null, JSON.stringify(created.error));
  const handoff = created.result;
  assert.equal(handoff.status, 'open');
  assert.equal(handoff.evidence[0].versionId, versionId, 'artifact evidence pins the exact version');
  assert.equal(handoff.evidence[1].id, 'https://example.test/item?id=4');
  assert.deepEqual(handoff.tabs.map(tab => [tab.tabId, tab.navigationVersion, tab.controller]), [[1, claim.result.version, first.actor]]);
  assert.doesNotMatch(JSON.stringify(handoff), /secret-value|abc&/);
  // Persisted with the workspace and visible in the scoped snapshot used by the GUI.
  const reopened = (await f.dispatch('workspace.snapshot', { workspaceId: f.workspaceId }, second)).result;
  assert.equal(reopened.handoffs[0].id, handoff.id);

  assert.equal((await f.dispatch('handoffs.accept', { id: handoff.id }, first)).error.code, 'permission_required', 'only the addressed recipient may accept');
  await f.as(first, 'tabs.release');
  const accepted = await f.as(second, 'handoffs.accept', { id: handoff.id });
  assert.equal(accepted.result.status, 'accepted');
  assert.equal(accepted.result.resume[0].changed, true, 'the tab changed after the handoff was written');
  // A guessed current version is not an inspection after accepting a handoff.
  const blocked = await f.as(second, 'page.click', { expectedVersion: f.browser.tab(1).version, selector: '#1' });
  assert.equal(blocked.error.code, 'stale_state');
  assert.equal(blocked.error.details.reason, 'inspection_required');
  const current = await f.as(second, 'page.inspect');
  assert.equal((await f.as(second, 'page.click', { expectedVersion: current.result.version, selector: '#1' })).result.submitted, true);
  const done = await f.as(second, 'handoffs.complete', { id: handoff.id, note: 'Submitted' });
  assert.equal(done.result.status, 'completed');
  assert.deepEqual(done.result.history.map(item => item.status), ['open', 'accepted', 'completed']);
  assert.ok((await f.as(first, 'handoffs.complete', { id: handoff.id })).error, 'closed handoffs cannot be reopened or closed twice');
});

test('element refs are grounded in the actor\'s latest snapshot and invalidated by every mutation', { timeout: budget(15000) }, async t => {
  const f = await fixture(t);
  const [first, second] = f.agents;
  const claim = await f.as(first, 'tabs.claim');
  assert.equal((await f.as(first, 'page.click', { expectedVersion: claim.result.version, ref: 'f0e1' })).error.details.reason, 'snapshot_required');
  const snapshot = (await f.as(first, 'page.snapshot')).result;
  assert.equal(snapshot.contentTrust, 'untrusted');
  assert.equal(snapshot.navigationVersion, claim.result.version);
  assert.equal((await f.as(first, 'page.click', { expectedVersion: claim.result.version, ref: 'f0e9' })).error.details.reason, 'ref_not_in_snapshot');
  assert.equal((await f.as(first, 'page.click', { expectedVersion: claim.result.version })).error.code, 'invalid_arguments');
  assert.equal((await f.as(first, 'page.click', { expectedVersion: claim.result.version, ref: 'f0e1', selector: '#x' })).error.code, 'invalid_arguments');
  // Another actor's snapshot does not ground this actor's refs.
  assert.equal((await f.as(second, 'page.snapshot')).error, null);
  const clicked = await f.as(first, 'page.click', { expectedVersion: claim.result.version, ref: 'f0e1', snapshotId: snapshot.snapshotId });
  assert.equal(clicked.error, null, JSON.stringify(clicked.error));
  assert.equal(clicked.result.outcome, 'unverified');
  const after = (await f.as(first, 'page.inspect')).result;
  assert.equal((await f.as(first, 'page.click', { expectedVersion: after.version, ref: 'f0e1' })).error.details.reason, 'snapshot_outdated', 'the click itself invalidated the refs');
  const newer = (await f.as(first, 'page.snapshot')).result;
  assert.equal((await f.as(first, 'page.click', { expectedVersion: after.version, ref: 'f0e1', snapshotId: snapshot.snapshotId })).error.details.reason, 'not_latest_snapshot');
  // Human interaction between observation and action invalidates refs and coordinates.
  f.browser.tab(1).inputSerial = 1;
  assert.equal((await f.as(first, 'page.click', { expectedVersion: after.version, ref: 'f0e1', snapshotId: newer.snapshotId })).error.details.reason, 'human_input');
});

test('coordinate and keyboard input require explicit human permission; control modes are explicit', { timeout: budget(15000) }, async t => {
  const f = await fixture(t);
  const [first] = f.agents;
  const claim = await f.as(first, 'tabs.claim');
  assert.equal((await f.as(first, 'page.clickAt', { expectedVersion: claim.result.version, x: 5, y: 5 })).error.code, 'permission_required');
  assert.equal((await f.as(first, 'page.press', { expectedVersion: claim.result.version, key: 'Enter' })).error.code, 'permission_required');
  assert.equal((await f.as(first, 'tabs.setControlMode', { mode: 'agent-drives', allowRawInput: true })).error.code, 'permission_required');
  const assist = await f.dispatch('tabs.setControlMode', { tabId: 1, mode: 'assist', agent: first.actor }, human);
  assert.equal(assist.result.controlMode, 'assist');
  assert.equal(assist.result.lastBoundary.previousController, first.actor);
  assert.equal((await f.as(first, 'tabs.claim')).error.code, 'lease_conflict', 'an assistant observes but cannot take input');
  assert.equal((await f.as(first, 'page.snapshot')).error, null, 'an assistant can still observe');
  assert.equal((await f.dispatch('tabs.setControlMode', { tabId: 1, mode: 'assist', allowRawInput: true }, human)).error.code, 'invalid_arguments');
  const drive = await f.dispatch('tabs.setControlMode', { tabId: 1, mode: 'agent-drives', agent: first.actor, allowRawInput: true }, human);
  assert.equal(drive.result.controlMode, 'agent-drives');
  assert.equal(drive.result.rawInput, true);
  const inspected = await f.as(first, 'page.inspect');
  assert.equal((await f.as(first, 'page.clickAt', { expectedVersion: inspected.result.version, x: 5, y: 5 })).error.code, 'invalid_arguments', 'agents must cite the observation their coordinates came from');
  assert.equal((await f.as(first, 'page.clickAt', { expectedVersion: inspected.result.version, x: 5, y: 5, observationId: 'snap_missing' })).error.details.reason, 'observation_required');
  const takeover = await f.dispatch('tabs.takeover', { tabId: 1, workspaceId: f.workspaceId }, human);
  assert.equal(takeover.result.rawInput, false, 'takeover revokes raw input permission');
});

test('protected operations deny every automation observation route but not the person', { timeout: budget(15000) }, async t => {
  const f = await fixture(t);
  const [first] = f.agents;
  f.browser.setProtectedOperation(1, 'credential entry');
  for (const command of ['page.readable', 'page.content', 'page.title', 'page.snapshot', 'page.pdf']) {
    assert.equal((await f.as(first, command)).error.code, 'permission_required', command);
  }
  assert.equal((await f.dispatch('artifacts.capture', { workspaceId: f.workspaceId, tabId: 1, kind: 'text' }, first)).error.code, 'permission_required');
  assert.equal((await f.dispatch('page.title', { tabId: 1, workspaceId: f.workspaceId }, human)).result, 'Fixture evil title');
  f.browser.setProtectedOperation(1, null);
  assert.equal((await f.as(first, 'page.title')).result, 'Fixture evil title');
});

test('the authority gate runs before version and inspection checks; approval then still requires fresh inspection', async t => {
  const f = await fixture(t);
  const scoped = (await f.dispatch('clients.create', { name: 'Scoped agent', scopes: ['read', 'tabs.control'], workspaceIds: [f.workspaceId] }, human)).result;
  const agent = f.clients.authenticate(scoped.token);
  const click = { expectedVersion: f.browser.tab(1).version, selector: '#go' };
  const pending = await f.as(agent, 'page.click', click);
  assert.equal(pending.error.code, 'approval_required', 'the gate decides before any page-state check');
  assert.equal(f.page.clicks.length, 0);
  await f.dispatch('approvals.approve', { id: pending.error.details.authority.approvalId, mode: 'once' }, human);
  const uninspected = await f.as(agent, 'page.click', click);
  assert.deepEqual([uninspected.error.code, uninspected.error.details.reason], ['stale_state', 'inspection_required'], 'approval does not replace inspection');
  assert.equal(f.page.clicks.length, 0);
  // The refused retry did not spend the one-time approval: after inspecting, the identical click runs without a new request.
  assert.equal(f.dispatch.authority.approvals.items.find(item => item.id === pending.error.details.authority.approvalId).status, 'approved');
  assert.equal((await f.as(agent, 'page.inspect', {})).execution, 'succeeded');
  const retried = await f.as(agent, 'page.click', click);
  assert.equal(retried.execution, 'succeeded', JSON.stringify(retried.error));
  assert.equal(f.page.clicks.length, 1);
  assert.equal(f.dispatch.authority.approvals.items.find(item => item.id === pending.error.details.authority.approvalId).status, 'consumed');
});
