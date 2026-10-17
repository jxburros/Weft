import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { EventEmitter } from 'node:events';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { Browser } from '../src/browser.js';
import { WorkspaceService } from '../src/workspace.js';
import { AutomationAdmission } from '../src/admission.js';
import { ClientGrants } from '../src/clients.js';
import { createDispatcher } from '../src/dispatch.js';
import { createApiServer } from '../src/server.js';
import { createClient } from '../src/client.js';
import { createMcpServer } from '../src/mcp.js';
import { createKeyProtector } from '../src/encryption.js';
import { fakeSafeStorage, kdfParams } from './encryption-helpers.js';

const human = { actor: 'human', source: 'gui' };
const PASSPHRASE = 'surface test passphrase';
const cliPath = fileURLToPath(new URL('../bin/weft.js', import.meta.url));
const options = { onWarning() {}, keyProtector: createKeyProtector({ safeStorage: fakeSafeStorage({ backend: 'basic_text' }), platform: 'linux' }), encryption: { kdf: kdfParams } };

async function lockedFixture(t) {
  const directory = mkdtempSync(join(tmpdir(), 'weft-encryption-surfaces-'));
  const setup = new WorkspaceService({ directory, ...options });
  const note = await setup.execute('materials.create', { title: 'Locked note', content: 'surface secret' });
  await setup.executeEncryption('encryption.enable', { acknowledgeKeyLoss: true, unlockMode: 'manual', passphrase: PASSPHRASE }, human);
  setup.close();
  // Restart: manual unlock mode starts locked.
  const workspace = new WorkspaceService({ directory, ...options });
  const session = new EventEmitter();
  session.setPermissionRequestHandler = () => {};
  session.setPermissionCheckHandler = () => {};
  const admission = new AutomationAdmission();
  const browser = new Browser({ session, workspaceService: workspace, admission, electronApi: {} });
  const token = 'encryption-surfaces-master';
  const clients = new ClientGrants({ directory, masterToken: token, workspace });
  const providers = { close() {}, stopAll() {}, execute() { throw new Error('Unexpected provider call'); } };
  const dispatch = createDispatcher({ workspace, browser, clients, providers, admission });
  const server = createApiServer({ execute: dispatch, token, authenticate: value => clients.authenticate(value), executeReturnsOutcome: true });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${server.address().port}`;
  const rest = async (command, args = {}) => {
    const response = await fetch(`${url}/v1/execute`, { method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: JSON.stringify({ command, args }) });
    return { status: response.status, outcome: await response.json() };
  };
  const cli = async (command, args = {}) => {
    let result;
    try { result = await promisify(execFile)(process.execPath, [cliPath, command, JSON.stringify(args)], { env: { ...process.env, WEFT_API_URL: url, WEFT_TOKEN: token } }); result.code = 0; }
    catch (error) { result = error; }
    return { code: result.code, outcome: JSON.parse(result.stdout) };
  };
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const mcpServer = createMcpServer(createClient({ url, token }));
  await mcpServer.connect(serverTransport);
  const mcp = new Client({ name: 'encryption-test', version: '1.0.0' });
  await mcp.connect(clientTransport);
  t.after(async () => { await mcp.close(); await new Promise(resolve => server.close(resolve)); browser.close(); workspace.close(); rmSync(directory, { recursive: true, force: true, maxRetries: 5 }); });
  return { directory, workspace, browser, dispatch, rest, cli, mcp, note };
}

test('a locked profile answers REST, CLI, MCP and in-process callers with a typed locked error', async t => {
  const { workspace, browser, dispatch, rest, cli, mcp, note } = await lockedFixture(t);
  assert.equal(workspace.locked, true);
  assert.equal(browser.suspended, true, 'no workspace session is created while locked');
  for (const [command, args] of [['materials.list', {}], ['materials.get', { id: note.id }], ['workspace.snapshot', {}], ['search.query', { query: 'secret' }], ['tabs.list', {}], ['browser.info', {}], ['tabs.new', { url: 'https://example.com/' }],
    ['batch.execute', { commands: [{ command: 'materials.create', args: { title: 'x' } }] }], ['workspaces.export', { id: 'ws_00000000-0000-0000-0000-000000000000' }]]) {
    const { status, outcome } = await rest(command, args);
    assert.equal(status, 423, command);
    assert.equal(outcome.error.code, 'locked', command);
    assert.equal(outcome.execution, 'not_started', command);
    assert.equal(outcome.error.details.reason, 'unlock_required');
    assert.doesNotMatch(JSON.stringify(outcome), /surface secret/);
  }
  const fromCli = await cli('materials.list');
  assert.equal(fromCli.code, 9);
  assert.equal(fromCli.outcome.error.code, 'locked');
  const fromMcp = await mcp.callTool({ name: 'weft_records', arguments: { action: 'materials.list' } });
  assert.equal(fromMcp.isError, true);
  assert.equal(fromMcp.structuredContent.error.code, 'locked');
  for (const caller of [human, { actor: 'model-reader', source: 'model', workspaceIds: [] }, { actor: 'automation' }]) {
    const outcome = await dispatch('materials.list', {}, caller);
    assert.equal(outcome.error.code, 'locked', caller.actor);
  }
  await assert.rejects(workspace.execute('materials.list', {}, human), error => error.code === 'locked');
  // Status and guidance still answer; status reveals no secret.
  const status = await rest('encryption.status');
  assert.equal(status.status, 200);
  assert.deepEqual({ enabled: status.outcome.result.enabled, locked: status.outcome.result.locked, protects: status.outcome.result.methods.os.protects }, { enabled: true, locked: true, protects: false });
  assert.equal((await mcp.callTool({ name: 'weft_workspace', arguments: { action: 'encryption.status' } })).structuredContent.result.locked, true);
  assert.equal((await rest('guide.get', { topic: 'approvals' })).status, 200);
});

test('agents cannot unlock or manage encryption; only the trusted human interface can, and secrets stay out of activity', async t => {
  const { directory, dispatch, rest, cli, mcp, note } = await lockedFixture(t);
  const denied = async (command, args) => {
    const { status, outcome } = await rest(command, args);
    assert.equal(status, 403, command);
    assert.equal(outcome.error.code, 'permission_required', command);
    assert.equal(outcome.error.details.authority.reason, 'human_only', command);
  };
  // While locked, the unlock path itself is human-only; other lifecycle commands are simply locked.
  await denied('encryption.unlock', { method: 'passphrase', secret: PASSPHRASE });
  await denied('encryption.checkRecoveryKey', { recoveryKey: 'AAAA' });
  assert.equal((await rest('encryption.disable', { acknowledgePlaintext: true })).outcome.error.code, 'locked');
  assert.equal((await cli('encryption.unlock', { method: 'passphrase', secret: PASSPHRASE })).code, 4);
  assert.equal((await mcp.callTool({ name: 'weft_workspace', arguments: { action: 'encryption.unlock', args: { method: 'passphrase', secret: PASSPHRASE } } })).structuredContent.error.code, 'permission_required');
  assert.equal((await rest('materials.get', { id: note.id })).status, 423, 'denied unlock attempts left it locked');
  const wrong = await dispatch('encryption.unlock', { method: 'passphrase', secret: 'not the passphrase' }, human);
  assert.equal(wrong.error.code, 'key_invalid');
  const unlocked = await dispatch('encryption.unlock', { method: 'passphrase', secret: PASSPHRASE }, human);
  assert.equal(unlocked.result.unlocked, true);
  const read = await rest('materials.get', { id: note.id });
  assert.equal(read.status, 200);
  assert.equal(read.outcome.result.content, 'surface secret');
  for (const [command, args] of [['encryption.enable', { acknowledgeKeyLoss: true }], ['encryption.disable', { acknowledgePlaintext: true }], ['encryption.rotate', { target: 'wrapping' }], ['encryption.configure', {}], ['encryption.lock', {}]]) await denied(command, args);
  assert.equal((await dispatch('encryption.lock', {}, human)).result.locked, true);
  assert.equal((await rest('materials.get', { id: note.id })).status, 423);
  const log = join(directory, 'activity-log.jsonl');
  assert.ok(existsSync(log));
  assert.doesNotMatch(readFileSync(log, 'utf8'), new RegExp(PASSPHRASE));
  assert.match(readFileSync(log, 'utf8'), /encryption\.unlock/);
});
