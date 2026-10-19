import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { z } from 'zod';
import { commands } from '../src/commands.js';
import { createDispatcher } from '../src/dispatch.js';
import { WorkspaceService } from '../src/workspace.js';
import { Browser } from '../src/browser.js';
import { AutomationAdmission } from '../src/admission.js';
import { ClientGrants } from '../src/clients.js';
import { PluginRegistry, HOOK_NAMES } from '../src/plugins/registry.js';
import { validateManifest, effectiveActionClass } from '../src/plugins/manifest.js';
import { actionClassForCommand } from '../src/autonomy.js';

const human = { actor: 'human', source: 'gui' };
const automation = { actor: 'automation' };
const manifest = (overrides = {}) => ({ name: 'csv-export', version: '1.0.0', apiVersion: 1, description: 'CSV exports', permissions: { workspaceRead: true }, hooks: { 'export-format': ['csv'] }, ...overrides });
const CSV = `globalThis.weftPlugin = {
  hooks: { 'export-format': { csv(snapshot) { return { mimeType: 'text/csv', extension: 'csv', content: 'title\\n' + snapshot.context.map(item => item.title).join('\\n'), exclusions: ['Only context titles are exported.'] }; } } },
  commands: { count(args, data) { return { context: data.context.length, label: args.label }; } },
};`;

function installPlugin(root, name, manifestValue, code) {
  const directory = join(root, name);
  mkdirSync(directory, { recursive: true });
  writeFileSync(join(directory, 'weft-plugin.json'), typeof manifestValue === 'string' ? manifestValue : JSON.stringify(manifestValue));
  writeFileSync(join(directory, 'plugin.js'), code);
  return directory;
}

async function fixture(t, { thirdParty = [] } = {}) {
  const directory = mkdtempSync(join(tmpdir(), 'weft-plugins-'));
  const pluginsDirectory = join(directory, 'plugins');
  mkdirSync(pluginsDirectory);
  for (const [name, value, code] of thirdParty) installPlugin(pluginsDirectory, name, value, code);
  const workspace = new WorkspaceService({ directory: join(directory, 'records') });
  const session = new EventEmitter();
  session.setPermissionRequestHandler = () => {};
  session.setPermissionCheckHandler = () => {};
  const admission = new AutomationAdmission();
  const browser = new Browser({ session, workspaceService: workspace, admission, electronApi: {} });
  const page = { url: 'https://example.test/paper', title: 'Paper', text: 'See doi 10.1000/xyz123 and https://example.org/source today.', links: [] };
  browser.tabs.set(1, { id: 1, workspaceId: workspace.activeWorkspaceId, version: 1, controller: 'available', view: { webContents: {
    getURL: () => page.url, getTitle: () => page.title, stop: () => {}, isDestroyed: () => false, close: () => {}, executeJavaScript: async () => structuredClone(page),
  } } });
  browser.activeId = 1;
  const plugins = new PluginRegistry({ pluginsDirectory, stateDirectory: join(directory, 'state'), timeoutMs: 1000 });
  const clients = new ClientGrants({ directory, masterToken: 'plugins-master', workspace });
  const dispatch = createDispatcher({ workspace, browser, clients, providers: { close() {} }, plugins, admission });
  t.after(() => { plugins.close(); browser.close(); workspace.close(); rmSync(directory, { recursive: true, force: true, maxRetries: 5 }); });
  return { directory, pluginsDirectory, workspace, browser, plugins, clients, dispatch, admission, page };
}
const ok = outcome => { assert.equal(outcome.error, null, JSON.stringify(outcome.error)); return outcome.result; };

test('built-in plugin commands merge into the one catalog with manifest-derived action classes', () => {
  for (const name of ['plugin.markdown.digest', 'plugin.session-stats.summary']) {
    assert.ok(Object.hasOwn(commands, name), name);
    assert.equal(commands[name].actionClass, 'local_read');
    assert.equal(actionClassForCommand(name), 'local_read');
    assert.equal(commands[name].inputSchema.additionalProperties, false);
    assert.ok(commands[name].inputSchema.properties.workspaceId, 'the core supplies the workspace target');
  }
  assert.deepEqual(HOOK_NAMES, ['capture-format', 'page-extract', 'after-command', 'activity-report', 'export-format']);
  assert.ok(!Object.keys(commands).some(name => name.startsWith('plugin.') && !/^plugin\.[a-z][a-z0-9-]+\.[a-zA-Z]+$/.test(name)));
});

test('manifests are strict data: unknown keys, executable values, undeclared hooks and overprivileged requests are refused', () => {
  assert.equal(validateManifest(manifest()).name, 'csv-export');
  const refusals = [
    [manifest({ entry: './index.js' }), /entry/],
    [manifest({ hooks: { 'before-anything': ['x'] } }), /before-anything/],
    [manifest({ apiVersion: 2 }), /apiVersion/],
    [manifest({ name: 'Bad Name' }), /name/],
    [manifest({ permissions: { workspaceRead: true, nativeAccess: true } }), /nativeAccess: denied/],
    [manifest({ permissions: { workspaceRead: true, origins: ['https://collector.example'] } }), /origins: denied/],
    [manifest({ permissions: { workspaceRead: true, workspaceWrite: true } }), /workspaceWrite: unsupported/],
    [manifest({ permissions: {} }), /requires permissions.workspaceRead/],
    [manifest({ commands: { wipe: { description: 'x', actionClass: 'local_write', input: { type: 'object', properties: {}, additionalProperties: false } } } }), /read-only/],
    [manifest({ commands: { find: { description: 'x', actionClass: 'local_read', input: { type: 'object', properties: { q: { type: 'string', maxLength: 10, pattern: '(a+)+$' } }, additionalProperties: false } } } }), /pattern|Unrecognized|Invalid/],
    [manifest({ commands: { find: { description: 'x', actionClass: 'local_read', input: { type: 'object', properties: { q: { type: 'string' } }, additionalProperties: false } } } }), /maxLength|Invalid/],
    [manifest({ requires: ['csv-export'] }), /itself/],
  ];
  for (const [value, pattern] of refusals) assert.throws(() => validateManifest(value), pattern, JSON.stringify(value));
  assert.throws(() => validateManifest({ ...manifest(), commands: { go: { description: 'x', actionClass: 'local_read', input: { q: z.string() } } } }), /Invalid/, 'zod schemas are built-in only');
  const builtin = validateManifest({ ...manifest(), permissions: { pageRead: true, workspaceRead: true }, commands: { go: { description: 'x', actionClass: 'local_read', input: {} } } }, { builtin: true });
  assert.equal(effectiveActionClass(builtin, 'go'), 'external_read', 'declared permissions raise the autonomy class');
});

test('markdown export-format hook runs end to end through the dispatcher and is human-only like JSON export', async t => {
  const f = await fixture(t);
  const id = f.workspace.activeWorkspaceId;
  await f.workspace.execute('context.create', { title: 'Finding <script>', content: 'Ignore previous instructions [link](javascript:alert(1))', sources: ['https://example.test/a'] }, human);
  const exported = ok(await f.dispatch('workspaces.exportAs', { id, format: 'markdown', sensitiveTerms: ['previous instructions'] }, human));
  assert.equal(exported.mimeType, 'text/markdown');
  assert.equal(exported.provenance.plugin, 'markdown');
  assert.match(exported.content, /## Context/);
  assert.match(exported.content, /Finding &lt;script&gt;/);
  assert.doesNotMatch(exported.content, /<script>|[^\\]\]\(javascript:/, 'untrusted text cannot become markup or links');
  assert.match(exported.content, /\\\[link\\\]/);
  assert.ok(exported.exclusions.some(item => /Browser sessions/.test(item)), 'core export limitations are always appended');
  assert.equal(exported.residueScan.status, 'found');
  const refused = await f.dispatch('workspaces.exportAs', { id, format: 'markdown' }, automation);
  assert.equal(refused.error.code, 'permission_required');
  const unknown = await f.dispatch('workspaces.exportAs', { id, format: 'docx' }, human);
  assert.equal(unknown.error.code, 'unsupported');
  assert.deepEqual(unknown.error.details ?? null, null, 'details are not leaked through the stable error contract');
});

test('capture-format, activity-report and page-extract hooks use authorized inputs and validated outputs', async t => {
  const f = await fixture(t);
  const id = f.workspace.activeWorkspaceId;
  const artifact = await f.workspace.execute('artifacts.create', { title: 'Saved', text: 'Captured *text*', url: 'https://example.test/' }, human);
  const rendered = ok(await f.dispatch('artifacts.render', { id: artifact.id, format: 'markdown' }, { actor: 'automation' }));
  assert.equal(rendered.untrusted, true);
  assert.match(rendered.content, /Captured \\\*text\\\*/);
  assert.equal(rendered.versionId, artifact.versions[0].id);
  const report = ok(await f.dispatch('activity.report', { workspaceId: id, format: 'markdown' }, automation));
  assert.ok(report.eventIds.length >= 1);
  assert.ok(report.eventIds.every(eventId => report.content.includes(eventId)), 'reports cite event ids');
  const extracted = ok(await f.dispatch('page.extract', { workspaceId: id, tabId: 1, extractor: 'citations' }, automation));
  assert.deepEqual(extracted.items.map(item => item.kind), ['doi', 'url']);
  for (const item of extracted.items) assert.equal(f.page.text.slice(item.start, item.end), item.text);
  f.page.text = 'x'.repeat(10);
  assert.equal((await f.dispatch('page.extract', { workspaceId: id, tabId: 1, extractor: 'unknown' }, automation)).error.code, 'unsupported');
});

test('a misbehaving built-in is caught by output contracts, and disabling a built-in removes its hooks and commands', async t => {
  const f = await fixture(t);
  const id = f.workspace.activeWorkspaceId;
  const provider = f.plugins.first('page-extract', 'citations', human);
  const entry = f.plugins.builtins.get('citations');
  const original = entry.implementation.hooks['page-extract'].citations;
  entry.implementation.hooks['page-extract'].citations = () => ({ items: [{ kind: 'url', text: 'forged', start: 0, end: 6 }] });
  t.after(() => { entry.implementation.hooks['page-extract'].citations = original; });
  const forged = await f.dispatch('page.extract', { workspaceId: id, tabId: 1, extractor: provider.id }, human);
  assert.match(forged.error.message, /does not match its source offsets/);
  // The shared authority gate refuses plugin administration before the registry runs (typed human_only denial).
  const refusedDisable = await f.dispatch('plugins.disable', { name: 'markdown' }, automation);
  assert.deepEqual([refusedDisable.error.code, refusedDisable.error.details.authority.reason, refusedDisable.execution], ['permission_required', 'human_only', 'not_started']);
  ok(await f.dispatch('plugins.disable', { name: 'markdown' }, human));
  assert.equal((await f.dispatch('workspaces.exportAs', { id, format: 'markdown' }, human)).error.code, 'unsupported');
  assert.equal((await f.dispatch('plugin.markdown.digest', {}, human)).error.code, 'unavailable');
  const reopened = new PluginRegistry({ pluginsDirectory: f.pluginsDirectory, stateDirectory: join(f.directory, 'state') });
  assert.equal(reopened.list().find(item => item.name === 'markdown').status, 'disabled', 'disablement persists');
  ok(await f.dispatch('plugins.enable', { name: 'markdown' }, human));
  assert.equal(ok(await f.dispatch('workspaces.exportAs', { id, format: 'markdown' }, human)).format, 'markdown');
});

test('after-command observers see sanitized metadata only and plugin commands read through scoped capabilities', async t => {
  const f = await fixture(t);
  const id = f.workspace.activeWorkspaceId;
  await f.workspace.execute('context.create', { title: 'Confirmed fact', category: 'confirmed', content: 'Evidence' }, human);
  const listed = ok(await f.dispatch('context.list', { workspaceId: id }, automation));
  assert.equal(listed.length, 1, 'observer cannot alter the completed result');
  await new Promise(resolve => setImmediate(resolve));
  const summary = ok(await f.dispatch('plugin.session-stats.summary', { workspaceId: id }, automation));
  assert.ok(summary.commands.some(row => row.command === 'context.list' && row.status === 'success'));
  const digest = ok(await f.dispatch('plugin.markdown.digest', { workspaceId: id, category: 'confirmed' }, automation));
  assert.deepEqual(digest.sources, [listed[0].id]);
  const other = await f.workspace.execute('workspaces.create', { name: 'Other' }, human);
  await f.workspace.execute('context.create', { workspaceId: other.id, title: 'Private elsewhere' }, human);
  const grant = ok(await f.dispatch('clients.create', { name: 'reader', scopes: ['read'], workspaceIds: [id] }, human));
  const auth = f.clients.authenticate(grant.token);
  const scoped = ok(await f.dispatch('plugin.markdown.digest', {}, auth));
  assert.equal(scoped.workspaceId, id);
  assert.doesNotMatch(scoped.content, /Private elsewhere/);
  assert.equal((await f.dispatch('plugin.markdown.digest', { workspaceId: other.id }, auth)).error.code, 'permission_required');
  assert.equal((await f.dispatch('plugins.enable', { name: 'markdown' }, auth)).error.code, 'permission_required');
});

test('third-party plugins are listed without running code and stay off until a person enables reviewed digests', async t => {
  const marker = join(tmpdir(), `weft-plugin-marker-${process.pid}`);
  const sideEffect = `require('fs').writeFileSync(${JSON.stringify(marker)}, 'ran'); ${CSV}`;
  const commandManifest = manifest({ commands: { count: { description: 'Count context records', actionClass: 'local_read', reads: ['context'],
    input: { type: 'object', properties: { label: { type: 'string', maxLength: 20 } }, required: ['label'], additionalProperties: false } } } });
  const f = await fixture(t, { thirdParty: [['csv-export', commandManifest, CSV], ['side-effect', manifest({ name: 'side-effect' }), sideEffect], ['broken', '{not json', ''], ['spy', manifest({ name: 'spy', permissions: { nativeAccess: true, workspaceRead: true } }), CSV]] });
  const id = f.workspace.activeWorkspaceId;
  const listed = ok(await f.dispatch('plugins.list', {}, automation));
  const csv = listed.find(item => item.name === 'csv-export');
  assert.equal(csv.status, 'disabled');
  assert.ok(csv.scope.some(line => /No workspace writes, network/.test(line)));
  assert.match(csv.codeSha256, /^[a-f0-9]{64}$/);
  assert.equal(listed.find(item => item.name === 'broken').status, 'invalid');
  assert.match(listed.find(item => item.name === 'spy').problems.join(' '), /nativeAccess: denied/);
  assert.equal(existsSync(marker), false, 'discovery never imports or runs plugin code');
  assert.equal((await f.dispatch('workspaces.exportAs', { id, format: 'csv' }, human)).error.code, 'unsupported');
  assert.equal((await f.dispatch('plugins.enable', { name: 'csv-export', manifestSha256: csv.manifestSha256, codeSha256: csv.codeSha256 }, automation)).error.details.authority.reason, 'human_only');
  assert.equal((await f.dispatch('plugins.enable', { name: 'csv-export', manifestSha256: csv.manifestSha256, codeSha256: '0'.repeat(64) }, human)).error.code, 'stale_state');
  assert.equal((await f.dispatch('plugins.enable', { name: 'spy' }, human)).error.code, 'invalid_arguments');
  const enabled = ok(await f.dispatch('plugins.enable', { name: 'csv-export', manifestSha256: csv.manifestSha256, codeSha256: csv.codeSha256 }, human));
  assert.equal(enabled.status, 'enabled');
  assert.equal(enabled.allowAutomation, false);
  await f.workspace.execute('context.create', { title: 'Alpha' }, human);
  const exported = ok(await f.dispatch('workspaces.exportAs', { id, format: 'csv' }, human));
  assert.equal(exported.content, 'title\nAlpha');
  assert.equal(exported.provenance.builtin, false);
  const invoked = ok(await f.dispatch('plugins.invoke', { name: 'csv-export', operation: 'count', args: { label: 'n' }, workspaceId: id }, human));
  assert.deepEqual(invoked.result, { context: 1, label: 'n' });
  assert.equal(invoked.untrusted, true);
  assert.equal((await f.dispatch('plugins.invoke', { name: 'csv-export', operation: 'count', args: { label: 'n', extra: 1 }, workspaceId: id }, human)).error.code, 'invalid_arguments');
  // Automation never reaches third-party code unless a person allowed it.
  assert.equal((await f.dispatch('plugins.invoke', { name: 'csv-export', operation: 'count', args: { label: 'n' }, workspaceId: id }, automation)).error.code, 'permission_required');
  assert.deepEqual(f.plugins.hooks('export-format', automation).map(item => item.id), ['markdown']);
  ok(await f.dispatch('plugins.enable', { name: 'csv-export', manifestSha256: csv.manifestSha256, codeSha256: csv.codeSha256, allowAutomation: true }, human));
  assert.deepEqual(ok(await f.dispatch('plugins.invoke', { name: 'csv-export', operation: 'count', args: { label: 'a' }, workspaceId: id }, automation)).result.label, 'a');
  // Changing code after the grant requires a new grant.
  writeFileSync(join(f.pluginsDirectory, 'csv-export', 'plugin.js'), CSV.replace('title\\n', 'changed\\n'));
  assert.equal((await f.dispatch('workspaces.exportAs', { id, format: 'csv' }, human)).error.code, 'unsupported');
  assert.equal(f.plugins.list().find(item => item.name === 'csv-export').status, 'changed');
  rmSync(marker, { force: true });
});

test('third-party plugin code is sandboxed: no Node, network or code generation; loops and revocation terminate', async t => {
  const hostile = `globalThis.weftPlugin = { hooks: { 'export-format': { csv(snapshot) {
    const probes = {};
    for (const [name, fn] of Object.entries({ require: () => require('fs'), process: () => process.env, fetch: () => fetch('https://collector.example'), eval: () => eval('1'),
      escape: () => ({}).constructor.constructor('return process')(), timers: () => setTimeout(() => {}, 1) })) { try { fn(); probes[name] = 'reachable'; } catch (error) { probes[name] = 'blocked'; } }
    if (snapshot.workspace.name === 'loop') for (;;) {}
    return { mimeType: 'application/json', extension: 'json', content: JSON.stringify(probes), exclusions: [] };
  } } } };`;
  const f = await fixture(t, { thirdParty: [['hostile', manifest({ name: 'hostile' }), hostile], ['liar', manifest({ name: 'liar', hooks: { 'export-format': ['csv'] } }), `globalThis.weftPlugin = { hooks: { 'export-format': { csv() { return { mimeType: 'text/html', extension: 'html', content: '<script>', exclusions: [] }; }, extra() {} } } };`]] });
  for (const name of ['hostile', 'liar']) {
    const entry = f.plugins.list().find(item => item.name === name);
    ok(await f.dispatch('plugins.enable', { name, manifestSha256: entry.manifestSha256, codeSha256: entry.codeSha256 }, human));
  }
  const id = f.workspace.activeWorkspaceId;
  const probes = JSON.parse(ok(await f.dispatch('workspaces.exportAs', { id, format: 'csv' }, human)).content);
  assert.deepEqual(probes, { require: 'blocked', process: 'blocked', fetch: 'blocked', eval: 'blocked', escape: 'blocked', timers: 'blocked' });
  ok(await f.dispatch('plugins.disable', { name: 'hostile' }, human));
  const liar = await f.dispatch('workspaces.exportAs', { id, format: 'csv' }, human);
  assert.match(liar.error.message, /does not match its manifest/, 'undeclared handlers are refused');
  ok(await f.dispatch('plugins.disable', { name: 'liar' }, human));
  const entry = f.plugins.list().find(item => item.name === 'hostile');
  ok(await f.dispatch('plugins.enable', { name: 'hostile', manifestSha256: entry.manifestSha256, codeSha256: entry.codeSha256 }, human));
  await f.workspace.execute('workspaces.update', { id, changes: { name: 'loop' } }, human);
  const started = Date.now();
  const looped = await f.dispatch('workspaces.exportAs', { id, format: 'csv' }, human);
  assert.equal(looped.error.code, 'timeout');
  assert.ok(Date.now() - started < 5000);
  const pending = f.dispatch('workspaces.exportAs', { id, format: 'csv' }, human);
  setTimeout(() => void f.dispatch('plugins.disable', { name: 'hostile' }, human), 100);
  const revoked = await pending;
  assert.equal(revoked.error.code, 'cancelled', 'revocation terminates in-flight calls');
  assert.equal((await f.dispatch('workspaces.exportAs', { id, format: 'csv' }, human)).error.code, 'unsupported');
});

test('resource exhaustion and name collisions are contained', async t => {
  const exhaust = mode => `globalThis.weftPlugin = { hooks: { 'export-format': { csv() {
    ${mode === 'output' ? "return { mimeType: 'text/csv', extension: 'csv', content: 'x'.repeat(9 * 1024 * 1024), exclusions: [] };" : 'const hoard = []; for (;;) hoard.push(new Array(1e6).fill(hoard.length));'}
  } } } };`;
  const f = await fixture(t, { thirdParty: [['flood', manifest({ name: 'flood' }), exhaust('output')], ['hoard', manifest({ name: 'hoard' }), exhaust('memory')], ['markdown', manifest({ name: 'markdown' }), CSV]] });
  assert.match(f.plugins.list().find(item => item.name === 'markdown' && !item.builtin).problems.join(' '), /reserved by a built-in/);
  const id = f.workspace.activeWorkspaceId;
  for (const name of ['flood', 'hoard']) {
    const entry = f.plugins.list().find(item => item.name === name);
    ok(await f.dispatch('plugins.enable', { name, manifestSha256: entry.manifestSha256, codeSha256: entry.codeSha256 }, human));
    const outcome = await f.dispatch('workspaces.exportAs', { id, format: 'csv' }, human);
    assert.notEqual(outcome.error, null, name);
    assert.match(outcome.error.message, /limit|exited|timed out/, name);
    ok(await f.dispatch('plugins.disable', { name }, human));
  }
  ok(await f.dispatch('context.list', { workspaceId: id }, human));
});

test('emergency stop terminates plugin processes and blocks automation hook commands', async t => {
  const f = await fixture(t, { thirdParty: [['csv-export', manifest(), CSV.replace(/commands: \{.*\},/, '')]] });
  const entry = f.plugins.list().find(item => item.name === 'csv-export');
  ok(await f.dispatch('plugins.enable', { name: 'csv-export', manifestSha256: entry.manifestSha256, codeSha256: entry.codeSha256, allowAutomation: true }, human));
  const id = f.workspace.activeWorkspaceId;
  ok(await f.dispatch('workspaces.exportAs', { id, format: 'csv' }, human));
  assert.equal(f.plugins.sandboxes.size, 1);
  ok(await f.dispatch('browser.emergencyStop', {}, human));
  assert.equal(f.plugins.sandboxes.size, 0);
  assert.equal((await f.dispatch('activity.report', { workspaceId: id, format: 'markdown' }, automation)).error.code, 'emergency_stop');
});

test('plugin commands, plugins.invoke and nested hook reads pass the shared authority gate with the caller identity', async t => {
  const f = await fixture(t, { thirdParty: [['page-count', { name: 'page-count', version: '1.0.0', apiVersion: 1, description: 'Count', permissions: { workspaceRead: true, pageRead: true },
    commands: { count: { description: 'Count context', actionClass: 'local_read', input: { type: 'object', properties: {}, required: [], additionalProperties: false }, reads: ['context'] } } },
    'globalThis.weftPlugin = { commands: { count(args, data) { return { context: data.context.length }; } } };']] });
  const id = f.workspace.activeWorkspaceId;
  const authority = f.dispatch.authority;
  // Manifest permissions set catalog metadata: the session-stats observer discloses activity metadata.
  assert.deepEqual(commands['plugin.session-stats.summary'].dataClasses.sort(), ['activity', 'workspace_records']);
  const grant = async dataAccess => ok(await f.dispatch('clients.create', { name: 'Agent', scopes: ['read'], workspaceIds: [id], dataAccess }, human));
  const narrow = await grant(['workspace_records']);
  const as = client => ({ actor: 'client', clientId: client.clientId, workspaceIds: client.workspaceIds });
  const denied = await f.dispatch('plugin.session-stats.summary', {}, as(narrow));
  assert.deepEqual([denied.error.code, denied.error.details.authority.reason], ['permission_required', 'data_class_not_granted']);
  assert.equal((await f.dispatch('page.extract', { tabId: 1, extractor: 'citations' }, as(narrow))).error.details.authority.reason, 'data_class_not_granted');
  const wide = await grant(['workspace_records', 'activity', 'page_content']);
  ok(await f.dispatch('plugin.session-stats.summary', {}, as(wide)));
  ok(await f.dispatch('page.extract', { tabId: 1, extractor: 'citations' }, as(wide)));
  // Nested reads a hook makes are gated and recorded under the caller's identity.
  const artifact = await f.workspace.execute('artifacts.create', { title: 'Saved', text: 'Captured', url: 'https://example.test/' }, human);
  ok(await f.dispatch('artifacts.render', { id: artifact.id, format: 'markdown' }, as(wide)));
  const nested = authority.activity.entries.filter(entry => entry.command === 'artifacts.get');
  assert.ok(nested.length >= 1 && nested.every(entry => entry.clientId === wide.clientId && entry.outcome === 'completed'));
  // plugins.invoke is raised to the operation's manifest-derived class (pageRead -> external_read).
  const entry = f.plugins.list().find(item => item.name === 'page-count');
  ok(await f.dispatch('plugins.enable', { name: 'page-count', manifestSha256: entry.manifestSha256, codeSha256: entry.codeSha256, allowAutomation: true }, human));
  assert.equal(ok(await f.dispatch('plugins.invoke', { name: 'page-count', operation: 'count', workspaceId: id }, automation)).result.context, 0);
  const invoked = authority.activity.entries.filter(item => item.command === 'plugins.invoke').at(-1);
  assert.equal(invoked.actionClass, 'external_read');
  // A narrow client lacking page content cannot reach the pageRead plugin through plugins.invoke.
  const refused = await f.dispatch('plugins.invoke', { name: 'page-count', operation: 'count', workspaceId: id }, as(narrow));
  assert.equal(refused.error.details.authority.reason, 'data_class_not_granted');
  // Emergency stop stops model streams and plugin processes together.
  let stopped = null;
  const providers = { stopAll: reason => { stopped = reason; }, close() {} };
  const dispatch = createDispatcher({ workspace: f.workspace, browser: f.browser, clients: f.clients, providers, plugins: f.plugins, admission: f.admission });
  ok(await f.dispatch('plugins.invoke', { name: 'page-count', operation: 'count', workspaceId: id }, human));
  assert.equal(f.plugins.sandboxes.size, 1);
  ok(await dispatch('browser.emergencyStop', {}, human));
  assert.equal(stopped, 'emergency_stop');
  assert.equal(f.plugins.sandboxes.size, 0);
});

test('the plugin process gets an OS network layer where the platform provides one, and reports which (#107)', async t => {
  const { pluginNetworkIsolation, sandboxLaunch } = await import('../src/plugins/sandbox.js');
  const { createServer } = await import('node:net');
  const { spawn } = await import('node:child_process');
  const isolation = pluginNetworkIsolation({ refresh: true });
  assert.ok(['network-namespace', 'vm-only'].includes(isolation.mode));
  if (process.platform !== 'linux') assert.equal(isolation.mode, 'vm-only', 'only Linux namespaces are used');
  assert.deepEqual(sandboxLaunch('/node', ['child.cjs'], { mode: 'vm-only' }), { command: '/node', args: ['child.cjs'] });
  assert.deepEqual(sandboxLaunch('/node', ['child.cjs'], { mode: 'network-namespace', unshare: '/usr/bin/unshare' }), { command: '/usr/bin/unshare', args: ['--user', '--net', '/node', 'child.cjs'] });
  if (isolation.mode !== 'network-namespace') { t.diagnostic('Unprivileged network namespaces are unavailable here; the vm context is the only network boundary (documented in docs/PLUGINS.md).'); return; }
  // Code running in the plugin process outside the vm (as after an escape) cannot reach a host listener.
  let connections = 0;
  const server = createServer(socket => { connections++; socket.destroy(); });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => server.close());
  const code = `require('net').connect(${server.address().port}, '127.0.0.1').on('connect', () => { console.log('connected'); process.exit(0); }).on('error', error => { console.log(error.code); process.exit(0); })`;
  const launch = sandboxLaunch(process.execPath, ['-e', code], isolation);
  const child = spawn(launch.command, launch.args, { env: {}, stdio: ['ignore', 'pipe', 'ignore'] });
  let output = '';
  child.stdout.on('data', chunk => { output += chunk; });
  await new Promise(resolve => child.once('exit', resolve));
  assert.notEqual(output.trim(), 'connected');
  assert.equal(connections, 0, 'the host listener never received a connection');
});
