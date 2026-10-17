import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, appendFileSync } from 'node:fs';
import { join } from 'node:path';
import { ActivityLog, summarizeArgs, minimizeUrl } from '../src/activity-log.js';
import { WorkspaceService } from '../src/workspace.js';
import { AutomationAdmission } from '../src/admission.js';
import { ClientGrants } from '../src/clients.js';
import { createDispatcher } from '../src/dispatch.js';
import { Providers } from '../src/providers.js';
import { closeAfter, tempDirectory } from './temp-profile.js';

const human = { actor: 'human', source: 'gui' };
const temp = t => tempDirectory(t, 'weft-activity-');
const lines = path => readFileSync(path, 'utf8').trim().split('\n');

test('hash chain detects edits, deletion and reordering, and survives reopening', t => {
  const directory = temp(t);
  const log = new ActivityLog({ directory });
  for (let i = 0; i < 5; i++) log.append({ type: 'command', command: 'materials.create', actor: 'automation', outcome: 'completed', targetId: `mate_${i}abcdef` });
  assert.equal(log.verify().status, 'intact');
  assert.equal(new ActivityLog({ directory }).verify().status, 'intact', 'reopened chain verifies');
  const original = readFileSync(log.path, 'utf8');
  const edited = lines(log.path);
  edited[2] = edited[2].replace('"completed"', '"failed"');
  writeFileSync(log.path, `${edited.join('\n')}\n`);
  assert.deepEqual([new ActivityLog({ directory }).verify().status, new ActivityLog({ directory }).verify().reason], ['broken', 'hash_mismatch']);
  const removed = original.trim().split('\n');
  removed.splice(1, 1);
  writeFileSync(log.path, `${removed.join('\n')}\n`);
  assert.equal(new ActivityLog({ directory }).verify().reason, 'sequence_gap');
  const truncated = original.trim().split('\n').slice(0, 3);
  writeFileSync(log.path, `${truncated.join('\n')}\n`);
  const tail = new ActivityLog({ directory }).verify();
  assert.equal(tail.status, 'broken', 'the separate head marker exposes tail truncation');
  assert.match(tail.issues.join(' '), /truncated/);
  const reopened = new ActivityLog({ directory });
  assert.ok(reopened.entries.some(entry => entry.reason === 'chain_broken_on_load'), 'a failed check is itself recorded in the chain');
});

test('a torn final write is discarded and recorded rather than silently accepted', t => {
  const directory = temp(t);
  const log = new ActivityLog({ directory });
  log.append({ type: 'command', command: 'tabs.pin', outcome: 'completed' });
  appendFileSync(log.path, '{"seq":2,"partial');
  const reopened = new ActivityLog({ directory });
  assert.equal(reopened.verify().status, 'intact');
  assert.equal(reopened.entries.at(-1).reason, 'torn_write_discarded');
});

test('retention by age and count keeps a verifiable anchor and never touches artifacts', async t => {
  const directory = temp(t);
  let now = Date.parse('2026-01-01T00:00:00Z');
  const log = new ActivityLog({ directory, clock: () => now });
  for (let i = 0; i < 30; i++) { log.append({ type: 'command', command: 'tasks.update', outcome: 'completed' }); now += 86400000; }
  const result = log.configure({ maxAgeDays: 10, maxEntries: null });
  assert.ok(result.removed >= 19);
  assert.ok(log.entries.every(entry => Date.parse(entry.at) >= now - 10 * 86400000 || entry.type !== 'command'));
  assert.equal(log.verify().status, 'intact');
  assert.equal(new ActivityLog({ directory, clock: () => now }).verify().status, 'intact', 'anchor persists');
  assert.ok(log.entries.some(entry => entry.type === 'retention'));
  for (let i = 0; i < 150; i++) log.append({ type: 'command', outcome: 'completed' });
  log.configure({ maxEntries: 100 });
  assert.ok(log.entries.length <= 103);
  assert.equal(log.verify().status, 'intact');
  // Workspace-level ordinary activity uses the same policy; records and artifacts remain.
  const workspace = new WorkspaceService({ directory: join(directory, 'ws') });
  closeAfter(t, workspace);
  await workspace.execute('artifacts.create', { title: 'Permanent evidence', text: 'kept' }, human);
  for (let i = 0; i < 5; i++) await workspace.execute('materials.create', { title: `Note ${i}` }, human);
  assert.equal(await workspace.pruneActivity({ maxEntries: 2 }), 4);
  const snapshot = workspace.snapshot();
  assert.equal(snapshot.activity.length, 2);
  assert.equal(snapshot.artifacts.length, 1);
  assert.equal(snapshot.materials.length, 5);
});

test('activity summaries exclude secrets and minimize personal data', () => {
  const summary = summarizeArgs({ url: 'https://user:pw@bank.example/account?session=abc&q=private#frag', password: 'hunter2', apiKey: 'sk-test', token: 'x',
    value: 'my home address', selector: '#name', tabId: 3, expectedVersion: 2, status: 'running', id: 'mate_0123456789', pngBase64: 'AAAA', changes: { title: 'x', secret: 'y' } });
  const text = JSON.stringify(summary);
  for (const leaked of ['hunter2', 'sk-test', 'session=abc', 'private', 'my home address', 'frag', 'pw@', 'AAAA', 'secret']) assert.doesNotMatch(text, new RegExp(leaked));
  assert.equal(summary.url, 'https://bank.example/account');
  assert.deepEqual(summary.value, { chars: 15 });
  assert.equal(summary.status, 'running');
  assert.equal(summary.id, 'mate_0123456789');
  assert.equal(minimizeUrl('not a url'), '[invalid url]');
});

test('activity summaries keep identifiers only in id fields and only the origin of service URLs', () => {
  // Identifier-shaped names (plugins, packages, formats, extractors, files) are reduced to a character count.
  const named = summarizeArgs({ name: 'acme_q3-acquisition-plan', format: 'acme-board-pack', extractor: 'patient_records-v2', filename: 'mate_0123456789.pdf',
    id: 'mate_0123456789', workspaceId: 'ws_0123456789', command: 'materials.create', note: 'task_0123456789' }, 'plugins.invoke');
  for (const key of ['name', 'format', 'extractor', 'filename', 'note']) assert.equal(typeof named[key], 'object', key);
  assert.deepEqual(named.name, { chars: 24 });
  assert.equal(named.id, 'mate_0123456789');
  assert.equal(named.workspaceId, 'ws_0123456789');
  assert.equal(named.command, 'materials.create');
  assert.deepEqual(summarizeArgs({ command: 'Delete the Q3 plan now' }).command, { chars: 22 }, 'a free-text command field is not kept');
  // Service references, model endpoints and other API URLs identify private resources by path: only the origin remains.
  const service = summarizeArgs({ url: 'https://git.example.com/acme/secret-merger/issues/42?token=abc' }, 'services.create');
  assert.equal(service.url, 'https://git.example.com/…');
  assert.equal(summarizeArgs({ endpoint: 'http://10.0.0.5:11434/v1/private-model' }, 'models.save').endpoint, 'http://10.0.0.5:11434/…');
  assert.equal(summarizeArgs({ baseUrl: 'https://issuer.example/accounts/acct_42' }, 'payments.configureProvider').baseUrl, 'https://issuer.example/…');
  assert.equal(summarizeArgs({ sourceUrl: 'https://lists.example/team/blocklist.json' }, 'lists.subscribe').sourceUrl, 'https://lists.example/…');
  assert.equal(summarizeArgs({ url: 'https://api.example.com/' }, 'services.update').url, 'https://api.example.com/');
  // Page navigation keeps its path (minimized, without query or fragment), as before.
  assert.equal(summarizeArgs({ url: 'https://news.example/story/1?ref=x' }, 'page.navigate').url, 'https://news.example/story/1');
  const text = JSON.stringify([named, service]);
  for (const leaked of ['acquisition', 'board-pack', 'patient', 'secret-merger', 'issues/42', 'token']) assert.doesNotMatch(text, new RegExp(leaked));
  assert.equal(minimizeUrl('https://a.example/x/y', { path: false }), 'https://a.example/…');
});

test('cursor pagination walks newest-first without duplicates and filters by type, outcome and workspace', t => {
  const log = new ActivityLog({ directory: temp(t) });
  for (let i = 0; i < 120; i++) log.append({ type: i % 3 ? 'command' : 'decision', outcome: i % 3 ? 'completed' : 'denied', workspaceId: i % 2 ? 'ws_a' : 'ws_b', command: 'materials.list' });
  const seen = [];
  let cursor;
  do {
    const page = log.list({ limit: 50, cursor });
    seen.push(...page.items.map(entry => entry.seq));
    cursor = page.nextCursor;
  } while (cursor);
  assert.equal(seen.length, 120);
  assert.equal(new Set(seen).size, 120);
  assert.deepEqual(seen, [...seen].sort((a, b) => b - a));
  const denied = log.list({ types: ['decision'], limit: 200 }).items;
  assert.ok(denied.length === 40 && denied.every(entry => entry.outcome === 'denied'));
  assert.ok(log.list({ workspaceId: 'ws_a', limit: 200 }).items.every(entry => entry.workspaceId === 'ws_a'));
  assert.ok(log.list({ limit: 200 }, entry => entry.workspaceId === 'ws_b').items.every(entry => entry.workspaceId === 'ws_b'));
  assert.throws(() => log.list({ cursor: 'not-a-cursor' }), { code: 'invalid_arguments' });
});

test('dispatcher records labelled outcomes, scopes activity reads and never stores command secrets', async t => {
  const directory = temp(t);
  const workspace = new WorkspaceService({ directory });
  const firstId = workspace.activeWorkspaceId;
  const other = await workspace.execute('workspaces.create', { name: 'Other' }, human);
  await workspace.execute('workspaces.switch', { id: firstId }, human);
  const admission = new AutomationAdmission();
  const clients = new ClientGrants({ directory, masterToken: 'activity-master', workspace });
  const browser = { tabs: new Map(), downloads: new Map(), activeId: null, tab: () => { throw new Error('No tab'); }, execute: async name => name === 'browser.info' ? { automation: admission.status } : [] };
  workspace.attachBrowser(browser);
  const dispatch = createDispatcher({ workspace, browser, clients, admission, providers: { close() {} } });
  closeAfter(t, workspace);
  await dispatch('workspace.snapshot', {}, human);
  await dispatch('materials.create', { workspaceId: firstId, title: 'Agent note', content: 'very private body text' });
  await dispatch('materials.delete', { id: 'mate_missing' }, human);
  await dispatch('materials.create', { workspaceId: other.id, title: 'Other note' });
  const grant = (await dispatch('clients.create', { name: 'Reader', scopes: ['read'], workspaceIds: [firstId] }, human)).result;
  const reader = clients.authenticate(grant.token);
  await dispatch('materials.create', { workspaceId: firstId, title: 'Denied' }, reader);
  const all = (await dispatch('activity.list', { scope: 'all', limit: 200 }, human)).result.items;
  assert.equal(all.some(entry => entry.command === 'workspace.snapshot'), false, 'human polling reads are not logged');
  const created = all.find(entry => entry.command === 'materials.create' && entry.workspaceId === firstId && entry.outcome === 'completed');
  assert.equal(created.actor, 'automation');
  assert.match(created.targetId, /^mate_/);
  assert.equal(created.irreversible, false);
  assert.ok(all.some(entry => entry.command === 'materials.delete' && entry.outcome === 'failed' && entry.actor === 'human'));
  assert.ok(all.some(entry => entry.type === 'grant' && entry.command === 'clients.create' && entry.outcome === 'completed'));
  assert.ok(all.some(entry => entry.type === 'decision' && entry.outcome === 'denied' && entry.clientId === grant.clientId));
  const visible = (await dispatch('activity.list', { limit: 200 }, reader)).result.items;
  assert.ok(visible.length > 0 && visible.every(entry => entry.workspaceId === firstId), 'clients only see their granted workspace');
  assert.equal((await dispatch('activity.list', { workspaceId: other.id }, reader)).error.code, 'permission_required');
  const scoped = (await dispatch('activity.list', { scope: 'all', limit: 200 }, reader)).result.items;
  assert.ok(scoped.every(entry => entry.workspaceId === firstId), 'scope all cannot widen a client view');
  assert.equal((await dispatch('activity.configure', { maxEntries: 100 }, reader)).error.code, 'permission_required');
  assert.equal((await dispatch('activity.configure', { maxEntries: 500 }, human)).result.retention.maxEntries, 500);
  const raw = readFileSync(join(directory, 'activity-log.jsonl'), 'utf8');
  assert.doesNotMatch(raw, /very private body text|weft1\./);
  assert.equal((await dispatch('activity.verify', {}, reader)).result.status, 'intact');
});

test('model destination decisions are durable without message content', async t => {
  const directory = temp(t);
  const workspace = new WorkspaceService({ directory });
  closeAfter(t, workspace);
  const log = new ActivityLog({ directory });
  const conversation = await workspace.execute('conversations.create', { title: 'Chat' }, human);
  const providers = new Providers({ directory, workspace, audit: entry => log.append(entry), env: { OPENAI_API_KEY: 'sk-test-secret' },
    fetchImpl: async () => new Response(JSON.stringify({ choices: [{ message: { content: 'Reply text' } }] }), { headers: { 'content-type': 'application/json' } }) });
  await providers.init();
  await assert.rejects(providers.execute('chat.send', { conversationId: conversation.id, modelId: 'openai', text: 'confidential plan' }, human), /CLOUD_DISCLOSURE_REQUIRED/);
  await providers.execute('chat.send', { conversationId: conversation.id, modelId: 'openai', text: 'confidential plan', disclosureAck: true }, human);
  await providers.execute('chat.send', { conversationId: conversation.id, modelId: 'local', text: 'local question' }, human);
  const summary = log.entries.map(entry => `${entry.type}:${entry.decision ?? ''}:${entry.reason}:${entry.outcome}`);
  assert.ok(summary.includes('model:deny:cloud_disclosure_required:denied'));
  assert.ok(summary.includes('override:approve:cloud_disclosure_acknowledged:recorded'));
  assert.ok(summary.includes('model:allow:acknowledged_destination:attempted'));
  assert.ok(summary.includes('model:allow:on_device_destination:attempted'));
  assert.ok(summary.includes('model::turn_complete:completed'));
  const cloud = log.entries.find(entry => entry.reason === 'acknowledged_destination');
  assert.equal(cloud.summary.destination, 'https://api.openai.com/');
  assert.equal(cloud.external, true);
  assert.doesNotMatch(readFileSync(log.path, 'utf8'), /confidential plan|Reply text|sk-test-secret|local question/);
});
