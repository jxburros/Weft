import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync, appendFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { auditExtensionManifest, matchesPattern, isBroadPattern } from '../src/extension-policy.js';
import { WorkspaceExtensions, readPackage } from '../src/extensions.js';
import { WorkspaceService } from '../src/workspace.js';
import { Browser } from '../src/browser.js';
import { AutomationAdmission } from '../src/admission.js';
import { createDispatcher } from '../src/dispatch.js';

const fixtures = JSON.parse(readFileSync(new URL('./fixtures/extensions.json', import.meta.url), 'utf8')).extensions;
const human = { actor: 'human', source: 'gui' };
export function materialize(directory, name) {
  const target = join(directory, name);
  mkdirSync(target, { recursive: true });
  for (const [file, contents] of Object.entries(fixtures[name])) writeFileSync(join(target, file), contents);
  return target;
}
const audit = (name, hostGrants) => auditExtensionManifest(JSON.parse(fixtures[name]['manifest.json']), { hostGrants, files: new Set(Object.keys(fixtures[name])), chromiumVersion: '152.0.0.0' });
const kinds = report => Object.fromEntries(report.refusals.map(item => [item.key, item.kind]));

test('the verified probe passes only with its exact host grant; UI-only keys are reported as ignored', () => {
  const ungranted = audit('probe', []);
  assert.equal(ungranted.ok, false);
  assert.deepEqual(kinds(ungranted), { 'hosts.http://127.0.0.1/*': 'ungranted' });
  const granted = audit('probe', ['http://127.0.0.1/*']);
  assert.equal(granted.ok, true, JSON.stringify(granted.refusals));
  assert.deepEqual(granted.scope.permissions.map(item => item.name), ['storage', 'scripting', 'tabs']);
  assert.deepEqual(granted.ignored.map(item => item.key), ['action']);
  assert.ok(granted.scope.residualRisks.some(item => /runs its code inside matching pages/.test(item)), 'residual risk is part of the scope display');
  assert.equal(audit('probe', ['http://127.0.0.1/*', 'https://extra.example/*']).ok, false, 'grants beyond the request are refused');
});

test('overprivileged, native-messaging, broad-host and legacy fixtures are refused with specific reasons', () => {
  assert.equal(kinds(audit('native-messaging'))['permissions.nativeMessaging'], 'denied');
  const broad = audit('all-urls');
  assert.equal(kinds(broad)['hosts.<all_urls>'], 'ungranted');
  assert.match(broad.refusals[0].reason, /broad host access/);
  assert.equal(audit('all-urls', ['<all_urls>']).ok, true, 'a person may grant every site explicitly');
  assert.equal(audit('all-urls', ['<all_urls>']).scope.hosts[0].broad, true);
  const hostile = kinds(audit('overprivileged', ['*://*/*']));
  for (const permission of ['debugger', 'proxy', 'webRequest', 'webRequestBlocking', 'cookies', 'declarativeNetRequest', 'management']) assert.equal(hostile[`permissions.${permission}`], 'denied', permission);
  assert.equal(hostile['permissions.alarms'], 'unsupported');
  assert.equal(hostile['permissions.madeUpPermission'], 'unknown');
  assert.equal(hostile['hosts.file:///*'], 'denied');
  assert.equal(hostile.externally_connectable, 'denied');
  assert.equal(hostile.optional_host_permissions, 'unsupported');
  const legacy = kinds(audit('mv2'));
  assert.equal(legacy.manifest_version, 'unsupported');
  assert.equal(legacy.background, 'unsupported');
  assert.equal(legacy['permissions.http://127.0.0.1/*'], 'invalid');
  const odd = auditExtensionManifest({ manifest_version: 3, name: 'x', version: '1', content_scripts: [{ matches: ['https://a.example/*'], js: ['../outside.js'] }], content_security_policy: { extension_pages: "script-src 'self' 'unsafe-eval'" }, minimum_chrome_version: '999', surprise: true }, { hostGrants: ['https://a.example/*'], chromiumVersion: '152' });
  assert.deepEqual(Object.keys(kinds(odd)).sort(), ['content_scripts.0', 'content_security_policy', 'minimum_chrome_version', 'surprise']);
});

test('match patterns follow Chrome semantics for egress checks', () => {
  assert.ok(matchesPattern('http://127.0.0.1/*', 'http://127.0.0.1:4100/a?b'));
  assert.ok(!matchesPattern('http://127.0.0.1/*', 'http://localhost:4100/a'));
  assert.ok(matchesPattern('*://*.example.com/api/*', 'https://deep.example.com/api/x'));
  assert.ok(!matchesPattern('*://*.example.com/api/*', 'https://example.com.evil.test/api/x'));
  assert.ok(!matchesPattern('https://a.example/*', 'http://a.example/'));
  assert.ok(matchesPattern('<all_urls>', 'https://any.example/'));
  assert.ok(!matchesPattern('<all_urls>', 'file:///etc/passwd'));
  assert.ok(isBroadPattern('*://*/*') && isBroadPattern('https://*.com/*') && !isBroadPattern('https://*.example.com/*'));
});

function fakeSession() {
  const session = new EventEmitter();
  session.setPermissionRequestHandler = () => {};
  session.setPermissionCheckHandler = () => {};
  session.loaded = new Map();
  session.extensions = {
    loadExtension: async (path, options) => { const id = `chrome${session.loaded.size}`.padEnd(32, 'a'); session.loaded.set(id, { path, options }); return { id, name: 'probe', path }; },
    removeExtension: id => { session.loaded.delete(id); },
  };
  session.webRequest = { onBeforeRequest: handler => { session.requestHandler = handler; } };
  return session;
}
function fixture(t) {
  const directory = mkdtempSync(join(tmpdir(), 'weft-extensions-'));
  const workspace = new WorkspaceService({ directory: join(directory, 'records') });
  const sessions = new Map();
  const electronApi = { session: { fromPartition: name => { if (!sessions.has(name)) sessions.set(name, fakeSession()); return sessions.get(name); } } };
  const browser = new Browser({ workspaceService: workspace, electronApi });
  const extensions = new WorkspaceExtensions({ directory: join(directory, 'profile'), workspace, browser, chromiumVersion: '152.0.0.0' });
  const dispatch = createDispatcher({ workspace, browser, extensions, providers: { close() {} }, clients: null, admission: new AutomationAdmission() });
  t.after(() => { browser.close(); workspace.close(); rmSync(directory, { recursive: true, force: true }); });
  const sessionOf = workspaceId => sessions.get(`persist:weft-${workspaceId}`);
  return { directory, workspace, browser, extensions, dispatch, sessionOf, source: name => materialize(join(directory, 'sources'), name) };
}
const ok = outcome => { assert.equal(outcome.error, null, JSON.stringify(outcome.error)); return outcome.result; };

test('extension installation is human-only, hash-pinned, disabled by default and scoped to one workspace session', async t => {
  const f = fixture(t);
  const path = f.source('probe');
  const workspaceId = f.workspace.activeWorkspaceId;
  for (const [name, args] of [['extensions.list', {}], ['extensions.audit', { path }], ['extensions.install', { path, hostGrants: [], sha256: '0'.repeat(64) }]]) {
    const refused = await f.dispatch(name, args, { actor: 'automation' });
    assert.deepEqual([refused.error.code, refused.error.details.authority.reason], ['permission_required', 'human_only'], name);
  }
  const report = ok(await f.dispatch('extensions.audit', { path, hostGrants: ['http://127.0.0.1/*'] }, human));
  assert.equal(report.ok, true);
  const refused = await f.dispatch('extensions.install', { path, hostGrants: [], sha256: report.sha256 }, human);
  assert.equal(refused.error.code, 'permission_required');
  assert.match(refused.error.message, /ungranted/);
  appendFileSync(join(path, 'content.js'), '\n// changed after review');
  assert.equal((await f.dispatch('extensions.install', { path, hostGrants: ['http://127.0.0.1/*'], sha256: report.sha256 }, human)).error.code, 'stale_state');
  const reviewed = ok(await f.dispatch('extensions.audit', { path, hostGrants: ['http://127.0.0.1/*'] }, human));
  const installed = ok(await f.dispatch('extensions.install', { path, hostGrants: ['http://127.0.0.1/*'], sha256: reviewed.sha256 }, human));
  assert.equal(installed.enabled, false);
  assert.equal(installed.workspaceId, workspaceId);
  assert.ok(existsSync(join(f.directory, 'profile', 'extensions', installed.id, 'manifest.json')), 'a pinned copy is installed');
  assert.ok(f.workspace.snapshot().activity.some(event => event.action === 'extensions.install' && event.targetId === installed.id), 'installation is attributable');
  const enabled = ok(await f.dispatch('extensions.enable', { id: installed.id }, human));
  assert.equal(enabled.loaded, true);
  const session = f.sessionOf(workspaceId);
  assert.equal([...session.loaded.values()][0].options.allowFileAccess, false);
  const other = await f.workspace.execute('workspaces.create', { name: 'Other' }, human);
  f.browser.sessionFor(other.id);
  assert.equal(f.sessionOf(other.id).loaded.size, 0, 'other workspaces never receive the extension');
  const origin = `chrome-extension://${enabled.chromeId}`;
  const decide = (target, details) => new Promise(resolve => f.sessionOf(target).requestHandler({ resourceType: 'xhr', initiatorOrigin: origin, ...details }, resolve));
  assert.deepEqual(await decide(workspaceId, { url: 'http://127.0.0.1:8080/allowed' }), { cancel: false });
  assert.deepEqual(await decide(workspaceId, { url: 'https://collector.example/upload' }), { cancel: true }, 'ungranted egress is cancelled');
  assert.deepEqual(await decide(other.id, { url: 'http://127.0.0.1:8080/allowed' }), { cancel: true }, 'the extension origin is unknown in other workspaces');
  await f.workspace.execute('siteRules.create', { workspaceId, hostname: '127.0.0.1', path: '/blocked', mode: 'navigation' }, human);
  assert.deepEqual(await decide(workspaceId, { url: 'http://127.0.0.1:8080/blocked/x' }), { cancel: true }, 'navigation rules also stop extension requests');
  const disabled = ok(await f.dispatch('extensions.disable', { id: installed.id }, human));
  assert.equal(disabled.loaded, false);
  assert.equal(session.loaded.size, 0, 'revocation unloads immediately');
  assert.deepEqual(await decide(workspaceId, { url: 'http://127.0.0.1:8080/allowed' }), { cancel: true }, 'revoked extensions lose network access');
  appendFileSync(join(f.directory, 'profile', 'extensions', installed.id, 'content.js'), '\n// tampered');
  const tampered = await f.dispatch('extensions.enable', { id: installed.id }, human);
  assert.equal(tampered.error.code, 'permission_required');
  assert.match(tampered.error.message, /changed since installation/);
  ok(await f.dispatch('extensions.remove', { id: installed.id }, human));
  assert.equal(existsSync(join(f.directory, 'profile', 'extensions', installed.id)), false);
  assert.deepEqual(ok(await f.dispatch('extensions.list', {}, human)), []);
});

test('hostile packages and engines without extension support fail clearly before anything loads', async t => {
  const f = fixture(t);
  for (const name of ['native-messaging', 'overprivileged', 'all-urls', 'mv2']) {
    const path = f.source(name);
    const report = ok(await f.dispatch('extensions.audit', { path }, human));
    assert.equal(report.ok, false, name);
    assert.equal((await f.dispatch('extensions.install', { path, sha256: report.sha256 }, human)).error.code, 'permission_required', name);
  }
  const linked = f.source('probe');
  symlinkSync('/etc/hostname', join(linked, 'linked.txt'));
  assert.match((await f.dispatch('extensions.audit', { path: linked, hostGrants: ['http://127.0.0.1/*'] }, human)).error.message, /link/);
  assert.equal((await f.dispatch('extensions.audit', { path: 'relative/path' }, human)).error.code, 'invalid_arguments');
  // Restart: enabled extensions reload after verification; a tampered one is disabled with a reason.
  const path = f.source('probe');
  rmSync(join(path, 'linked.txt'), { force: true });
  const { sha256 } = readPackage(path);
  const installed = ok(await f.dispatch('extensions.install', { path, hostGrants: ['http://127.0.0.1/*'], sha256 }, human));
  ok(await f.dispatch('extensions.enable', { id: installed.id }, human));
  const restarted = new WorkspaceExtensions({ directory: join(f.directory, 'profile'), workspace: f.workspace, browser: f.browser, chromiumVersion: '152.0.0.0' });
  await restarted.restore();
  assert.equal(restarted.summary(restarted.records[0]).loaded, true);
  writeFileSync(join(f.directory, 'profile', 'extensions', installed.id, 'service-worker.js'), 'fetch("https://collector.example")');
  const tampered = new WorkspaceExtensions({ directory: join(f.directory, 'profile'), workspace: f.workspace, browser: f.browser, chromiumVersion: '152.0.0.0' });
  await tampered.restore();
  assert.equal(tampered.records[0].enabled, false);
  assert.match(tampered.records[0].lastError, /changed since installation/);
  const plain = new WorkspaceExtensions({ directory: join(f.directory, 'plain'), workspace: f.workspace, browser: new Browser({ workspaceService: f.workspace, electronApi: { session: { fromPartition: () => { const s = fakeSession(); delete s.extensions; return s; } } } }) });
  const copy = f.source('all-urls');
  const report = await plain.execute('extensions.audit', { path: copy, hostGrants: ['<all_urls>'] }, human);
  const record = await plain.execute('extensions.install', { path: copy, hostGrants: ['<all_urls>'], sha256: report.sha256 }, human);
  await assert.rejects(plain.execute('extensions.enable', { id: record.id }, human), { code: 'unsupported' });
});
