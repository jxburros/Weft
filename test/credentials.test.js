import test from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { WorkspaceService } from '../src/workspace.js';
import { AutomationAdmission } from '../src/admission.js';
import { ClientGrants } from '../src/clients.js';
import { createDispatcher } from '../src/dispatch.js';
import { commands } from '../src/commands.js';
import { CredentialService, safeStorageProtector } from '../src/credentials.js';

const require = createRequire(import.meta.url);
const broker = require('../src/credential-broker-child.cjs');
const human = { actor: 'human', source: 'gui' };
const agent = { actor: 'agent-one' };
const SECRET = 'correct-horse-battery-staple-9431';
const USERNAME = 'jeffrey.example@example.com';
const ORIGIN = 'https://accounts.example.test';

/**
 * Test-only key protector standing in for Electron safeStorage. It is an AES wrapper with a
 * process-local key: it exercises the wrap/unwrap contract, not OS keychain protection.
 */
function testProtector({ backend = 'test-keychain', available = true } = {}) {
  const wrapKey = randomBytes(32);
  return {
    status: () => ({ available, backend, protected: available && backend !== 'basic_text' }),
    wrap(text) { const iv = randomBytes(12); const cipher = createCipheriv('aes-256-gcm', wrapKey, iv); const data = Buffer.concat([cipher.update(text, 'utf8'), cipher.final()]); return Buffer.concat([iv, cipher.getAuthTag(), data]); },
    unwrap(bytes) { const decipher = createDecipheriv('aes-256-gcm', wrapKey, bytes.subarray(0, 12)); decipher.setAuthTag(bytes.subarray(12, 28)); return Buffer.concat([decipher.update(bytes.subarray(28)), decipher.final()]).toString('utf8'); },
  };
}

/** Scripted tab: the browser half of credentials.fill is exercised against real Chromium in credentials-browser.test.js. */
function fakeBrowser(workspaceId) {
  const page = { url: `${ORIGIN}/login`, frameOrigin: null, fills: [] };
  const tab = { id: 1, workspaceId, version: 3, view: { webContents: { getURL: () => page.url } } };
  return { page, tabs: new Map([[1, tab]]), activeId: 1, downloads: new Map(),
    tab(id = 1) { if (id !== 1) throw new Error('Tab not found'); return tab; },
    async credentialFill(args, context, { credential, release }) {
      const top = new URL(page.url).origin;
      if (!credential.origins.includes(top)) throw Object.assign(new Error('origin'), { code: 'target_mismatch', notStarted: true, details: { credential: 'origin_mismatch' } });
      const secret = await release(top, page.frameOrigin ?? top);
      page.fills.push({ username: secret.username, password: secret.password, args, actor: context.actor });
      return { status: 'filled', fields: ['username', 'password'], submit: 'not_requested', frame: 'top', origin: top, navigation: 'none', outcome: 'unverified' };
    },
    async execute() { throw new Error('not used'); } };
}

async function fixture(t, { protector = testProtector(), env = {}, promptValue = { username: USERNAME, password: SECRET } } = {}) {
  const directory = mkdtempSync(join(tmpdir(), 'weft-credentials-'));
  const workspace = new WorkspaceService({ directory: join(directory, 'workspace-data') });
  const workspaceId = workspace.activeWorkspaceId;
  const browser = fakeBrowser(workspaceId);
  const prompts = [];
  const credentials = new CredentialService({ directory: join(directory, 'credentials'), protector, browser, workspace, env,
    promptSecret: async request => { prompts.push(request); return promptValue && { ...promptValue }; } });
  const clients = new ClientGrants({ directory: join(directory, 'workspace-data'), masterToken: 'master-token-for-tests', workspace });
  const events = [];
  const dispatch = createDispatcher({ workspace, browser, providers: { execute() {}, close() {} }, clients, credentials, admission: new AutomationAdmission(), onEvent: event => events.push(event) });
  t.after(() => { credentials.close(); workspace.close(); rmSync(directory, { recursive: true, force: true }); });
  const create = (args = {}) => dispatch('credentials.create', { workspaceId, label: 'Example account', purpose: 'Sign in to the example dashboard', origins: [ORIGIN], ...args }, human);
  return { directory, workspace, workspaceId, browser, credentials, clients, dispatch, events, prompts, create };
}
const everything = f => [JSON.stringify(f.events), ...[join(f.directory, 'workspace-data'), join(f.directory, 'credentials'), join(f.directory, 'credentials', 'vault')]
  .flatMap(dir => readdirSync(dir).map(name => join(dir, name)))
  .filter(path => { try { return readFileSync(path) && true; } catch { return false; } }).map(path => readFileSync(path, 'latin1'))].join('\n');

test('vault seals entries with AES-256-GCM, authenticates metadata and accepts only exact origins', () => {
  const key = randomBytes(32);
  const entry = { id: 'cred_00000000-0000-4000-8000-000000000000', workspaceId: 'ws', label: 'x', purpose: 'y', origins: [ORIGIN], frameOrigins: [], provider: 'local',
    account: 'j***@example.com', createdAt: 'now', expiresAt: null, revokedAt: null, revision: 1 };
  entry.seal = broker.seal(key, entry, { kind: 'local', username: USERNAME, password: SECRET });
  assert.equal(broker.open(key, entry).password, SECRET);
  assert.ok(!JSON.stringify(entry).includes(SECRET), 'ciphertext only');
  for (const tamper of [{ origins: ['https://evil.example'] }, { frameOrigins: ['https://evil.example'] }, { workspaceId: 'other' }, { revokedAt: null, revision: 2 }, { expiresAt: '2999-01-01T00:00:00.000Z' }]) {
    assert.throws(() => broker.open(key, { ...entry, ...tamper }), error => error.reason === 'integrity_failed', JSON.stringify(tamper));
  }
  assert.throws(() => broker.open(randomBytes(32), entry), error => error.reason === 'integrity_failed');
  assert.equal(broker.normalizeOrigin('https://Accounts.Example.test:443/'), ORIGIN);
  assert.equal(broker.normalizeOrigin('http://127.0.0.1:8080'), 'http://127.0.0.1:8080');
  for (const bad of ['http://example.test', 'https://*.example.test', 'https://example.test/login', 'https://user:pw@example.test', 'https://example.test/?a=1', 'javascript:alert(1)', 'null']) {
    assert.throws(() => broker.normalizeOrigin(bad), error => error.reason === 'invalid_entry', bad);
  }
  assert.equal(broker.maskAccount(USERNAME), 'j***e@example.com');
  assert.equal(broker.maskAccount('ab'), '***');
  assert.equal(broker.maskAccount(''), null);
});

test('no vault is created or opened without OS-protected storage (Linux basic_text refused)', async t => {
  for (const protector of [testProtector({ backend: 'basic_text' }), testProtector({ available: false }), null]) {
    const f = await fixture(t, { protector });
    const outcome = await f.create();
    assert.equal(outcome.error.code, 'unavailable');
    assert.equal(outcome.error.details.credential, 'unprotected_storage');
    assert.equal(f.prompts.length, 0, 'the person is not asked for a secret that could not be protected');
    assert.equal(existsSync(join(f.directory, 'credentials', 'key.wrapped')), false);
    assert.equal((await f.dispatch('credentials.status', {}, agent)).result.vault, 'unprotected');
  }
  const status = safeStorageProtector({ isEncryptionAvailable: () => true, getSelectedStorageBackend: () => 'basic_text' }).status();
  assert.equal(status.protected, false);
  assert.equal(safeStorageProtector({ isEncryptionAvailable: () => true, getSelectedStorageBackend: () => 'gnome_libsecret' }).status().protected, true);
});

test('only a person in the trusted GUI creates credentials; secrets are never command arguments', async t => {
  const f = await fixture(t);
  const denied = await f.dispatch('credentials.create', { workspaceId: f.workspaceId, label: 'x', purpose: 'y', origins: [ORIGIN] }, agent);
  assert.equal(denied.error.code, 'permission_required');
  assert.equal(denied.error.details.authority.reason, 'human_only');
  const viaApi = await f.dispatch('credentials.create', { workspaceId: f.workspaceId, label: 'x', purpose: 'y', origins: [ORIGIN] }, { actor: 'human', source: 'cli' });
  assert.equal(viaApi.error.code, 'human_required');
  for (const field of ['password', 'secret', 'value', 'username']) {
    const smuggled = await f.dispatch('credentials.create', { workspaceId: f.workspaceId, label: 'x', purpose: 'y', origins: [ORIGIN], [field]: SECRET }, human);
    assert.equal(smuggled.error.code, 'invalid_arguments', `${field} is not an accepted argument`);
    assert.ok(!JSON.stringify(smuggled).includes(SECRET), 'invalid values are not echoed');
  }
  const wildcard = await f.create({ origins: ['https://*.example.test'] });
  assert.equal(wildcard.error.code, 'invalid_arguments');
  assert.equal(f.prompts.length, 0);
  const cancelled = await fixture(t, { promptValue: null });
  assert.equal((await cancelled.create()).error.details.credential, 'entry_cancelled');
  for (const name of ['credentials.update', 'credentials.revoke', 'credentials.delete', 'credentials.grantTask', 'credentials.revokeGrant', 'credentials.configureProvider']) {
    assert.equal(commands[name].humanOnly, true, name);
    assert.equal(commands[name].actionClass, 'administration', name);
  }
  assert.equal(commands['credentials.fill'].actionClass, 'credential_use');
});

test('agents see opaque references and masked identifiers; the vault file holds ciphertext only', async t => {
  const f = await fixture(t);
  const created = await f.create({ frameOrigins: ['https://login.example.test'] });
  assert.equal(created.error, null);
  assert.deepEqual(f.prompts, [{ label: 'Example account', origins: [ORIGIN], workspaceId: f.workspaceId }], 'the dialog is told what the secret is for, nothing else');
  assert.match(created.result.id, /^cred_/);
  assert.equal(created.result.account, 'j***e@example.com');
  const listed = await f.dispatch('credentials.list', { workspaceId: f.workspaceId }, agent);
  assert.equal(listed.error, null);
  assert.deepEqual(Object.keys(listed.result[0]).sort(), ['account', 'createdAt', 'expiresAt', 'frameOrigins', 'id', 'integrity', 'label', 'origins', 'provider', 'purpose', 'revision', 'revokedAt', 'status', 'taskGrants', 'updatedAt', 'workspaceId'].sort());
  assert.equal(listed.result[0].status, 'active');
  const raw = readFileSync(join(f.directory, 'credentials', 'vault', 'vault.json'), 'utf8');
  for (const value of [SECRET, USERNAME]) {
    assert.ok(!raw.includes(value), 'vault file has no plaintext secret or username');
    assert.ok(!everything(f).includes(value), 'no secret or full username in events, activity, approvals, grants or the workspace store');
    assert.ok(!JSON.stringify(listed).includes(value));
  }
  // Credentials live outside workspace data: exports and backups of workspace-data cannot include them.
  assert.equal(existsSync(join(f.directory, 'workspace-data', 'vault.json')), false);
  const status = (await f.dispatch('credentials.status', {}, agent)).result;
  assert.equal(status.vault, 'ready');
  assert.equal(status.independentReview, 'not performed');
  assert.equal(status.providers.onepassword.command, undefined, 'agents do not see local executable paths');
});

test('the broker is a separate process with a minimal environment and filesystem permission limited to its vault', async t => {
  const f = await fixture(t, { env: { SECRET_TOKEN_IN_PARENT: 'parent-only', PATH: process.env.PATH } });
  await f.create();
  const child = f.credentials.process.child;
  assert.notEqual(child.pid, process.pid);
  const vault = join(f.directory, 'credentials', 'vault');
  assert.ok(child.spawnargs.includes('--permission'));
  assert.ok(child.spawnargs.includes(`--allow-fs-read=${vault}`) && child.spawnargs.includes(`--allow-fs-write=${vault}`));
  assert.ok(!child.spawnargs.some(arg => arg.includes('allow-child-process')), 'no child processes without an external vault CLI');
  assert.ok(!child.spawnargs.some(arg => arg.includes(SECRET)) && !child.spawnargs.some(arg => /key/i.test(arg)), 'the data key is sent over stdin, not argv');
  if (process.platform === 'linux') {
    const environ = readFileSync(`/proc/${child.pid}/environ`, 'utf8').split('\0').filter(Boolean);
    assert.deepEqual(environ.filter(entry => !entry.startsWith('ELECTRON_RUN_AS_NODE=')), [], 'nothing inherited from the parent environment');
  }
  // A crashed broker is restarted on the next request; nothing is lost.
  child.kill('SIGKILL');
  await new Promise(resolve => child.once('exit', resolve));
  assert.equal((await f.dispatch('credentials.list', { workspaceId: f.workspaceId }, agent)).result.length, 1);
});

test('credentials.fill needs an exact one-time approval showing the credential and origins, then releases only for the authorized origin', async t => {
  const f = await fixture(t);
  const { id } = (await f.create()).result;
  const args = { id, tabId: 1, workspaceId: f.workspaceId, expectedVersion: 3 };
  const first = await f.dispatch('credentials.fill', args, agent);
  assert.equal(first.error.code, 'approval_required');
  const pending = (await f.dispatch('approvals.list', {}, human)).result[0];
  assert.equal(pending.actionClass, 'credential_use');
  assert.match(pending.preview.Credential, /Example account \(j\*\*\*e@example\.com\)/);
  assert.equal(pending.preview['Authorized origins'], ORIGIN);
  assert.equal(f.browser.page.fills.length, 0);
  const standing = await f.dispatch('approvals.approve', { id: pending.id, mode: 'standing' }, human);
  assert.equal(standing.error.code, 'permission_required', 'credential use never gets a standing approval');
  await f.dispatch('approvals.approve', { id: pending.id, mode: 'once' }, human);
  const filled = await f.dispatch('credentials.fill', args, agent);
  assert.equal(filled.error, null);
  assert.equal(filled.result.status, 'filled');
  assert.equal(filled.result.account, 'j***e@example.com');
  assert.deepEqual(f.browser.page.fills.map(fill => fill.password), [SECRET], 'the browser received the secret exactly once');
  assert.ok(!JSON.stringify(filled).includes(SECRET) && !JSON.stringify(filled).includes(USERNAME), 'sanitized status only');
  assert.equal((await f.dispatch('credentials.fill', args, agent)).error.code, 'approval_required', 'the approval is consumed by one use');
  // Redirect between approval and fill: the approval was bound to the approved destination; a changed page needs a new approval.
  const again = (await f.dispatch('approvals.list', {}, human)).result.find(item => item.status === 'pending');
  await f.dispatch('approvals.approve', { id: again.id, mode: 'once' }, human);
  f.browser.page.url = 'https://evil.example.test/login';
  const redirected = await f.dispatch('credentials.fill', args, agent);
  assert.equal(redirected.error.code, 'approval_required', 'the approval does not follow a redirect to another destination');
  // Even a human-approved request for the wrong page is refused by the broker's own origin check.
  const wrong = (await f.dispatch('approvals.list', {}, human)).result.find(item => item.status === 'pending');
  await f.dispatch('approvals.approve', { id: wrong.id, mode: 'once' }, human);
  const original = f.browser.credentialFill;
  f.browser.credentialFill = async (fillArgs, context, { release }) => release('https://evil.example.test', 'https://evil.example.test');
  const refused = await f.dispatch('credentials.fill', args, agent);
  assert.equal(refused.error.code, 'target_mismatch');
  assert.equal(refused.error.details.credential, 'origin_mismatch');
  assert.equal((await f.dispatch('approvals.list', {}, human)).result.find(item => item.status === 'pending'), undefined,
    'the refused attempt gave its one-time approval back instead of spending it');
  // A cross-origin frame on the right page is refused unless the credential lists it in frameOrigins.
  f.browser.page.url = `${ORIGIN}/login`;
  f.browser.credentialFill = async (fillArgs, context, { release }) => release(ORIGIN, 'https://phish.example.test');
  const phish = await f.dispatch('credentials.fill', args, agent);
  assert.equal(phish.error.code, 'target_mismatch');
  assert.equal(phish.error.details.credential, 'frame_origin_mismatch');
  f.browser.credentialFill = original;
  assert.equal((await f.dispatch('credentials.fill', args, agent)).error, null, 'the approval given back after a refusal still covers the identical command');
  assert.equal(f.browser.page.fills.length, 2);
  const text = everything(f);
  assert.ok(!text.includes(SECRET) && !text.includes(USERNAME), 'activity, approvals and events never contain the secret');
});

test('expired, revoked, tampered and other-workspace references are refused before any release', async t => {
  const f = await fixture(t);
  const soon = (await f.create({ expiresAt: new Date(Date.now() + 1200).toISOString() })).result;
  const revoked = (await f.create({ label: 'To revoke' })).result;
  const tampered = (await f.create({ label: 'To tamper' })).result;
  const other = await f.dispatch('workspaces.create', { name: 'Other' }, human);
  const elsewhere = (await f.create({ workspaceId: other.result.id, label: 'Elsewhere' })).result;
  await new Promise(resolve => setTimeout(resolve, 1300));
  assert.equal((await f.dispatch('credentials.revoke', { id: revoked.id }, human)).result.status, 'revoked');
  const file = join(f.directory, 'credentials', 'vault', 'vault.json');
  const vault = JSON.parse(readFileSync(file, 'utf8'));
  vault.entries.find(entry => entry.id === tampered.id).origins.push('https://evil.example.test');
  writeFileSync(file, JSON.stringify(vault));
  // A running broker keeps its verified copy; the edited file is what the next broker start reads.
  f.credentials.close();
  const listed = (await f.dispatch('credentials.list', { workspaceId: f.workspaceId, includeInactive: true }, agent)).result;
  assert.deepEqual(Object.fromEntries(listed.map(entry => [entry.label, entry.status])), { 'Example account': 'expired', 'To revoke': 'revoked', 'To tamper': 'integrity_failed' });
  assert.equal((await f.dispatch('credentials.list', { workspaceId: f.workspaceId }, agent)).result.length, 0, 'inactive references are hidden by default');
  for (const [entry, reason] of [[soon, 'expired'], [revoked, 'revoked'], [tampered, 'integrity_failed']]) {
    const outcome = await f.dispatch('credentials.fill', { id: entry.id, tabId: 1, workspaceId: f.workspaceId, expectedVersion: 3 }, human);
    assert.equal(outcome.error.details.credential, reason, reason);
  }
  const cross = await f.dispatch('credentials.fill', { id: elsewhere.id, tabId: 1, workspaceId: f.workspaceId, expectedVersion: 3 }, human);
  assert.equal(cross.error.details.credential, 'not_found');
  assert.equal(f.browser.page.fills.length, 0);
  // The revoked secret itself was discarded.
  const sealed = JSON.parse(readFileSync(file, 'utf8')).entries.find(entry => entry.id === revoked.id);
  assert.equal(sealed.revokedAt !== null, true);
  assert.equal((await f.dispatch('credentials.update', { id: revoked.id, origins: [ORIGIN] }, human)).error.details.credential, 'revoked', 'revocation is permanent');
  assert.equal((await f.dispatch('credentials.delete', { id: tampered.id }, human)).result.deleted, true);
});

test('a human task grant lets one open task fill a limited number of times without per-use approval', async t => {
  const f = await fixture(t);
  const { id } = (await f.create()).result;
  const task = (await f.dispatch('tasks.create', { workspaceId: f.workspaceId, title: 'Download the monthly invoice', status: 'running' }, human)).result;
  const other = (await f.dispatch('tasks.create', { workspaceId: f.workspaceId, title: 'Something else', status: 'running' }, human)).result;
  const grant = (await f.dispatch('credentials.grantTask', { id, taskId: task.id, uses: 1, minutes: 30 }, human)).result;
  assert.equal(grant.usesLeft, 1);
  assert.equal((await f.dispatch('credentials.grantTask', { id, taskId: task.id }, agent)).error.details.authority.reason, 'human_only');
  const args = { id, tabId: 1, workspaceId: f.workspaceId, expectedVersion: 3 };
  assert.equal((await f.dispatch('credentials.fill', args, { actor: 'agent-one', taskId: other.id })).error.code, 'approval_required', 'another task gets nothing');
  const used = await f.dispatch('credentials.fill', args, { actor: 'agent-one', taskId: task.id });
  assert.equal(used.error, null);
  assert.deepEqual(used.result.taskGrant, { id: grant.id, usesLeft: 0 });
  assert.equal((await f.dispatch('credentials.fill', args, { actor: 'agent-one', taskId: task.id })).error.code, 'approval_required', 'uses are bounded');
  const second = (await f.dispatch('credentials.grantTask', { id, taskId: task.id, uses: 5 }, human)).result;
  await f.dispatch('tasks.transition', { id: task.id, status: 'completed' }, human);
  assert.equal((await f.dispatch('credentials.fill', args, { actor: 'agent-one', taskId: task.id })).error.code, 'approval_required', 'a closed task loses its grant');
  assert.equal(f.credentials.grants.find(item => item.id === second.id).status, 'ended');
  assert.equal(f.browser.page.fills.length, 1);
});

test('1Password CLI adapter resolves op:// references at fill time through the broker (fake CLI; unvalidated against a real account)', { skip: process.platform === 'win32' ? 'The fake op CLI is a POSIX script' : false }, async t => {
  const bin = mkdtempSync(join(tmpdir(), 'weft-fake-op-'));
  t.after(() => rmSync(bin, { recursive: true, force: true }));
  const op = join(bin, 'op');
  writeFileSync(op, `#!${process.execPath}
const [command, flag, reference] = process.argv.slice(2);
if (process.env.OP_SERVICE_ACCOUNT_TOKEN !== 'ops_test_token') { process.stderr.write('not signed in: ${SECRET}'); process.exit(1); }
if (command !== 'read' || flag !== '--no-newline') process.exit(2);
const values = { 'op://Private/Example/password': ${JSON.stringify(SECRET)}, 'op://Private/Example/username': ${JSON.stringify(USERNAME)} };
if (!(reference in values)) { process.stderr.write('[ERROR] item not found'); process.exit(1); }
process.stdout.write(values[reference]);
`);
  chmodSync(op, 0o755);
  const f = await fixture(t, { env: { PATH: process.env.PATH, HOME: bin, OP_SERVICE_ACCOUNT_TOKEN: 'ops_test_token', UNRELATED_SECRET: 'keep-out' } });
  assert.equal((await f.create({ provider: 'onepassword', reference: { password: 'op://Private/Example/password' } })).error.details.credential, 'provider_disabled');
  await f.dispatch('credentials.configureProvider', { provider: 'onepassword', enabled: true, command: op }, human);
  const created = await f.create({ provider: 'onepassword', reference: { password: 'op://Private/Example/password', username: 'op://Private/Example/username' }, accountLabel: 'Personal 1Password item' });
  assert.equal(created.error, null);
  assert.equal(f.prompts.length, 0, 'external references need no typed secret');
  assert.equal(created.result.account, 'Personal 1Password item');
  const missing = (await f.create({ provider: 'onepassword', reference: { password: 'op://Private/Missing/password' }, label: 'Missing item' })).result;
  const child = f.credentials.process.child;
  assert.ok(child.spawnargs.includes('--allow-child-process'));
  if (process.platform === 'linux') {
    const environ = readFileSync(`/proc/${child.pid}/environ`, 'utf8');
    assert.match(environ, /OP_SERVICE_ACCOUNT_TOKEN=ops_test_token/);
    assert.ok(!environ.includes('keep-out'), 'only the CLI’s variables are passed');
  }
  const filled = await f.dispatch('credentials.fill', { id: created.result.id, tabId: 1, workspaceId: f.workspaceId, expectedVersion: 3 }, human);
  assert.equal(filled.error, null);
  assert.deepEqual(f.browser.page.fills.map(({ username, password }) => ({ username, password })), [{ username: USERNAME, password: SECRET }]);
  const failed = await f.dispatch('credentials.fill', { id: missing.id, tabId: 1, workspaceId: f.workspaceId, expectedVersion: 3 }, human);
  assert.equal(failed.error.details.credential, 'provider_failed');
  assert.ok(!JSON.stringify(failed).includes('item not found'), 'CLI output never reaches callers');
  assert.equal((await f.create({ provider: 'onepassword', reference: { password: 'https://not-a-reference' } })).error.code, 'invalid_arguments');
  assert.ok(!everything(f).includes(SECRET));
});
