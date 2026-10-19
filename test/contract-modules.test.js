// Direct tests for modules that were covered only indirectly (#125): the durable JSON writer,
// provider presets, capability discovery, the encryption-coverage statement and the store CLI.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { readJson, writeJsonDurable } from '../src/atomic-json.js';
import { PROVIDER_PRESETS, reportedCapabilities } from '../src/provider-presets.js';
import { describeCapabilities, MCP_RESOURCES, MAX_DEADLINE_MS } from '../src/capabilities.js';
import { ENCRYPTION_COVERAGE } from '../src/profile-encryption.js';
import { runStoreCommand } from '../src/store-cli.js';
import { createClient } from '../src/client.js';
import { WorkspaceService } from '../src/workspace.js';
import { commands } from '../src/commands.js';
import { budget } from './time-budget.js';

const temporary = t => { const directory = mkdtempSync(join(tmpdir(), 'weft-contract-')); t.after(() => rmSync(directory, { recursive: true, force: true })); return directory; };

test('writeJsonDurable replaces a file whole, privately, and leaves no temporary file behind', t => {
  const directory = temporary(t);
  const file = join(directory, 'nested', 'state.json');
  assert.deepEqual(readJson(file, { empty: true }), { empty: true }, 'a missing file reads as a copy of the fallback');
  writeJsonDurable(file, { version: 1 });
  writeJsonDurable(file, { version: 2, items: [1, 2, 3] });
  assert.deepEqual(readJson(file, null), { version: 2, items: [1, 2, 3] });
  assert.deepEqual(readdirSync(join(directory, 'nested')), ['state.json']);
  if (process.platform !== 'win32') assert.equal(statSync(file).mode & 0o777, 0o600);
  // A value that cannot be serialized fails before the rename: the previous file is intact and no temporary file remains.
  assert.throws(() => writeJsonDurable(file, { big: 1n }), /BigInt/);
  assert.deepEqual(readJson(file, null), { version: 2, items: [1, 2, 3] });
  assert.deepEqual(readdirSync(join(directory, 'nested')), ['state.json']);
});

test('readJson refuses a truncated file instead of treating it as empty, and ignores leftover temporary files', t => {
  const directory = temporary(t);
  const file = join(directory, 'state.json');
  writeFileSync(file, '{"version": 2, "items": [1, 2');
  assert.throws(() => readJson(file, {}), /unreadable; preserve it/);
  writeJsonDurable(file, { version: 3 });
  writeFileSync(`${file}.0000-crash.tmp`, '{"version": 4, "items": [');
  assert.deepEqual(readJson(file, {}), { version: 3 });
});

test('a writer killed mid-write leaves either the old or the new complete file', { timeout: budget(30000) }, async t => {
  const directory = temporary(t);
  const file = join(directory, 'state.json');
  writeJsonDurable(file, { generation: 0, payload: '' });
  const script = `import { writeJsonDurable } from ${JSON.stringify(new URL('../src/atomic-json.js', import.meta.url).href)};
    const payload = 'x'.repeat(256 * 1024);
    for (let generation = 1; ; generation++) { writeJsonDurable(${JSON.stringify(file)}, { generation, payload }); if (generation === 3) process.stdout.write('ready\\n'); }`;
  for (let round = 0; round < 3; round++) {
    const child = spawn(process.execPath, ['--input-type=module', '-e', script], { stdio: ['ignore', 'pipe', 'inherit'] });
    await new Promise((resolve, reject) => { child.stdout.once('data', resolve); child.once('exit', code => reject(new Error(`writer exited early with ${code}`))); });
    await new Promise(resolve => setTimeout(resolve, 20 + round * 15));
    child.kill('SIGKILL');
    await new Promise(resolve => child.once('exit', resolve));
    const value = readJson(file, null);
    assert.ok(Number.isInteger(value.generation) && value.generation >= 1, 'the file is a complete earlier or later write');
    assert.ok(value.payload === '' || value.payload.length === 256 * 1024);
  }
});

test('provider presets: explicit endpoints, HTTPS for hosted providers, loopback for local servers, no model IDs', () => {
  assert.deepEqual(PROVIDER_PRESETS.map(preset => preset.id), ['openai', 'compatible', 'anthropic', 'gemini', 'deepseek', 'moonshot', 'meta', 'ollama', 'jx']);
  assert.equal(new Set(PROVIDER_PRESETS.map(preset => preset.id)).size, PROVIDER_PRESETS.length);
  for (const preset of PROVIDER_PRESETS) {
    assert.deepEqual(Object.keys(preset).sort(), ['endpoint', 'id', 'name', 'provider'], `${preset.id} carries no model ID or key`);
    assert.ok(['openai', 'anthropic', 'ollama'].includes(preset.provider), preset.id);
    if (preset.id === 'compatible') { assert.equal(preset.endpoint, ''); continue; }
    const url = new URL(preset.endpoint);
    if (['ollama', 'jx'].includes(preset.id)) assert.equal(url.hostname, '127.0.0.1', `${preset.id} is a local server`);
    else assert.equal(url.protocol, 'https:', `${preset.id} is reached over HTTPS`);
  }
  assert.equal(PROVIDER_PRESETS.find(preset => preset.id === 'anthropic').endpoint, 'https://api.anthropic.com/v1');
  assert.equal(PROVIDER_PRESETS.find(preset => preset.id === 'ollama').endpoint, 'http://127.0.0.1:11434');
});

test('reportedCapabilities reads each provider listing shape and ignores implausible context windows', () => {
  assert.deepEqual(reportedCapabilities({ architecture: { input_modalities: ['text', 'image'] }, context_length: 128000 }), { images: true, contextWindow: 128000 });
  assert.deepEqual(reportedCapabilities({ capabilities: ['completion', 'tools'] }), { images: false, tools: true });
  assert.deepEqual(reportedCapabilities({ capabilities: { vision: true, tools: false } }), { images: true, tools: false });
  assert.deepEqual(reportedCapabilities({ capabilities: { image_input: { supported: false } } }), { images: false });
  assert.deepEqual(reportedCapabilities({ supports_tool_calls: true, max_input_tokens: 200000 }), { tools: true, contextWindow: 200000 });
  assert.deepEqual(reportedCapabilities({ context_window: 12 }), {}, 'a window below 256 tokens is not believed');
  assert.deepEqual(reportedCapabilities({ inputTokenLimit: 1e12 }), {});
  assert.deepEqual(reportedCapabilities({}), {});
});

test('capability discovery reports the real catalog, limits and features to agents', () => {
  const describe = context => describeCapabilities({ commands, outcomeStatuses: ['ok', 'error'], errorHttpStatus: { not_found: 404, invalid_arguments: 400 },
    errorStatus: { not_found: 'failed', invalid_arguments: 'failed' }, exitCodes: { not_found: 3 }, apiVersion: 'v1', eventTypes: ['tab', 'command'], context });
  const scoped = describe({ actor: 'client', clientId: 'c1', workspaceIds: ['w1'], scopes: ['read'] });
  assert.equal(scoped.catalog.commands, Object.keys(commands).length);
  assert.match(scoped.catalog.sha256, /^[0-9a-f]{64}$/);
  assert.equal(describe({}).catalog.sha256, scoped.catalog.sha256, 'the catalog hash is stable');
  assert.deepEqual(scoped.caller, { actor: 'client', clientId: 'c1', workspaceIds: ['w1'], taskId: null, scopes: ['read'] });
  assert.deepEqual(describe({}).caller, { actor: null, clientId: null, workspaceIds: null, taskId: null, scopes: null });
  assert.deepEqual(scoped.outcomes.errors, { invalid_arguments: { status: 'failed', httpStatus: 400, exitCode: 1 }, not_found: { status: 'failed', httpStatus: 404, exitCode: 3 } });
  assert.deepEqual(scoped.limits, { restRequestBytes: 1024 * 1024, batchCommands: 100, batchCommandsNeedingApproval: 20, pageLimit: scoped.features.pagination.maxLimit, deadlineMs: MAX_DEADLINE_MS });
  assert.equal(MAX_DEADLINE_MS, 600000);
  assert.deepEqual(scoped.features.mcp.resources, [...MCP_RESOURCES]);
  assert.ok(scoped.features.pagination.commands.every(name => Object.hasOwn(commands, name)), 'only real commands are listed as pageable');
  assert.deepEqual(scoped.features.eventReplay.types, ['command', 'tab']);
  assert.equal(scoped.features.eventReplay.persisted, false);
  assert.equal(scoped.features.batch.atomic, true);
  assert.equal(scoped.features.search.lexical, 'fts5-bm25');
  assert.equal(describeCapabilities({ commands, outcomeStatuses: [], errorHttpStatus: {}, errorStatus: {}, exitCodes: {}, apiVersion: 'v1', embeddings: false }).features.search.hybrid, false);
});

test('the encryption coverage statement is frozen and names what stays unencrypted', async t => {
  assert.ok(Object.isFrozen(ENCRYPTION_COVERAGE) && Object.isFrozen(ENCRYPTION_COVERAGE.encrypted) && Object.isFrozen(ENCRYPTION_COVERAGE.notEncrypted));
  const encrypted = ENCRYPTION_COVERAGE.encrypted.join('\n');
  const plain = ENCRYPTION_COVERAGE.notEncrypted.join('\n');
  for (const item of ['Project records', 'Captured page text, screenshots and stored files', 'visit history', 'Payment records', 'Embedding vectors', 'Backups made while encryption is on']) assert.ok(encrypted.includes(item), item);
  for (const item of ['Record identifiers', 'never written to disk', 'Chromium sessions, cookies', 'Durable activity log', 'Plaintext copies made before encryption', 'OS swap']) assert.ok(plain.includes(item), item);
  assert.match(ENCRYPTION_COVERAGE.threatModel, /does not protect against malware/);
  // The statement Weft gives callers is exactly this table.
  const directory = temporary(t);
  const service = new WorkspaceService({ directory });
  t.after(() => service.close());
  assert.deepEqual((await service.executeEncryption('encryption.status', {}, { actor: 'human', source: 'gui' })).coverage, structuredClone(ENCRYPTION_COVERAGE));
});

test('the offline store CLI validates its arguments, lists, verifies and restores a closed profile', async t => {
  const directory = temporary(t);
  assert.throws(() => runStoreCommand([]), error => error.code === 'invalid_arguments' && /Usage: weft store/.test(error.message));
  assert.throws(() => runStoreCommand(['verify', directory]), error => error.code === 'invalid_arguments');
  assert.throws(() => runStoreCommand(['delete', directory, 'x']), error => error.code === 'invalid_arguments');
  assert.throws(() => runStoreCommand(['backups', join(directory, 'missing')]), error => error.code === 'not_found');
  const service = new WorkspaceService({ directory });
  const note = await service.execute('materials.create', { title: 'Note', content: 'v1' });
  const backup = await service.execute('backups.create', {});
  await service.execute('materials.update', { id: note.id, changes: { content: 'v2' } });
  service.close();
  assert.deepEqual(runStoreCommand(['backups', directory]).backups.map(item => item.id), [backup.id]);
  assert.equal(runStoreCommand(['verify', directory, backup.id]).status, 'verified');
  const restored = runStoreCommand(['restore', directory, backup.id]);
  assert.equal(restored.verification.status, 'verified');
  const reopened = new WorkspaceService({ directory });
  t.after(() => reopened.close());
  assert.equal((await reopened.execute('materials.get', { id: note.id })).content, 'v1');
  assert.ok(readFileSync(join(directory, '.workspace.lock'), 'utf8').includes(String(process.pid)), 'the reopened service holds the lock again');
});

test('the CLI client reaches the IPv4-only API through localhost and refuses [::1] with the reason (#126)', async t => {
  const server = createServer((request, response) => { response.setHeader('content-type', 'application/json'); response.end(JSON.stringify({ commands: [request.headers.host] })); });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => server.close());
  const { port } = server.address();
  assert.deepEqual(await createClient({ url: `http://localhost:${port}`, token: 'x' }).listCommands(), [`127.0.0.1:${port}`]);
  assert.throws(() => createClient({ url: `http://[::1]:${port}`, token: 'x' }), /listens only on 127\.0\.0\.1/);
  assert.throws(() => createClient({ url: 'http://example.com:9222', token: 'x' }), /loopback HTTP origin/);
});
