import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { UpdateService, UpdateError, compareVersions, detectInstall, evaluateRelease, parseManifest, signaturePolicy, updatesDisabled, MAX_UNHEALTHY_LAUNCHES, CHECK_INTERVAL_MS } from '../src/updater.js';
import { WorkspaceService } from '../src/workspace.js';
import { ClientGrants } from '../src/clients.js';
import { AutomationAdmission } from '../src/admission.js';
import { createDispatcher } from '../src/dispatch.js';

const sha = bytes => createHash('sha512').update(bytes).digest('base64');
const RELEASES = 'https://github.com/jxburros/Weft/releases';
const appImage = version => `Weft-${version}-x86_64.AppImage`;

/** Same shape electron-builder writes (see dist/latest-linux.yml from a local build). */
function manifestText({ version, files, path = files[0].url, primarySha = files[0].sha512, extra = '' }) {
  return `version: ${version}\nfiles:\n${files.map(file => `  - url: ${file.url}\n    sha512: ${file.sha512}\n    size: ${file.size}\n`).join('')}path: ${path}\nsha512: ${primarySha}\nreleaseDate: '2026-10-01T12:00:00.000Z'\n${extra}`;
}

/** Simulates GitHub: /latest/download redirects to the tagged release, then to the asset host. */
function github({ version = '1.1.0', bytes = Buffer.from('new weft build'), manifest, assetBytes = bytes, overrides = {} } = {}) {
  const file = { url: appImage(version), sha512: sha(bytes), size: bytes.length };
  const yml = manifest ?? manifestText({ version, files: [file, { url: `Weft-${version}-amd64.deb`, sha512: sha(Buffer.from('deb')), size: 3 }] });
  const routes = {
    [`${RELEASES}/latest/download/latest-linux.yml`]: { status: 302, location: `${RELEASES}/download/v${version}/latest-linux.yml` },
    [`${RELEASES}/download/v${version}/latest-linux.yml`]: { status: 302, location: 'https://release-assets.githubusercontent.com/github-production-release-asset/1/manifest?sig=x' },
    'https://release-assets.githubusercontent.com/github-production-release-asset/1/manifest?sig=x': { status: 200, body: [Buffer.from(yml)] },
    [`${RELEASES}/download/v${version}/${appImage(version)}`]: { status: 302, location: 'https://objects.githubusercontent.com/asset/2' },
    'https://objects.githubusercontent.com/asset/2': { status: 200, body: [assetBytes.subarray(0, 4), assetBytes.subarray(4)] },
    ...overrides,
  };
  const requests = [];
  const transport = async ({ url, headers }) => {
    requests.push({ url, headers });
    const route = routes[url];
    if (!route) return { status: 404, body: [] };
    if (route.throws) throw route.throws;
    return { status: route.status, location: route.location ?? null, body: route.body ?? null };
  };
  return { transport, requests, bytes, file };
}

function fixture(t, { version = '1.0.0', env = {}, net = github(), install, launcher = {}, now } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'weft-updater-'));
  const appPath = join(root, 'Weft.AppImage');
  writeFileSync(appPath, `installed ${version}`);
  const calls = { relaunch: [], spawn: [], open: [], quit: 0 };
  const options = {
    directory: join(root, 'updates'), currentVersion: version, env, transport: net.transport, now,
    install: install ?? detectInstall({ isPackaged: true, platform: 'linux', arch: 'x64', env: { APPIMAGE: appPath } }),
    launcher: { relaunch: path => calls.relaunch.push(path), spawnDetached: async (path, args) => calls.spawn.push({ path, args }), openPath: async path => { calls.open.push(path); return ''; }, quit: () => calls.quit++, ...launcher },
  };
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return { root, appPath, calls, net, options, service: new UpdateService(options), restart: next => new UpdateService({ ...options, currentVersion: next }) };
}

test('versions are stable x.y.z only and compare numerically', () => {
  assert.equal(compareVersions('1.10.0', '1.9.9'), 1);
  assert.equal(compareVersions('2.0.0', '2.0.0'), 0);
  assert.equal(compareVersions('0.9.0', '1.0.0'), -1);
  for (const bad of ['1.0', '1.0.0-beta.1', 'v1.0.0', '01.0.0', '1.0.0+build']) assert.throws(() => compareVersions(bad, '1.0.0'), UpdateError);
});

test('kill switch fails closed for any value except empty/0/false/no/off', () => {
  for (const value of ['1', 'true', 'yes', 'TRUE', 'anything']) assert.equal(updatesDisabled({ WEFT_DISABLE_UPDATES: value }), true, value);
  for (const value of [undefined, '', '0', 'false', 'off', ' no ']) assert.equal(updatesDisabled({ WEFT_DISABLE_UPDATES: value }), false, String(value));
});

test('install detection never offers in-place updates for source runs or unpublished platforms', t => {
  assert.equal(detectInstall({ isPackaged: false, platform: 'linux', arch: 'x64' }).supported, false);
  assert.equal(detectInstall({ isPackaged: true, platform: 'win32', arch: 'x64' }).kind, 'nsis');
  assert.equal(detectInstall({ isPackaged: true, platform: 'win32', arch: 'arm64' }).supported, false);
  const mac = detectInstall({ isPackaged: true, platform: 'darwin', arch: 'arm64' });
  assert.equal(mac.asset.exec('Weft-1.2.3-arm64.dmg')[1], '1.2.3');
  assert.equal(mac.asset.exec('Weft-1.2.3-x64.dmg'), null);
  const resources = mkdtempSync(join(tmpdir(), 'weft-resources-'));
  t.after(() => rmSync(resources, { recursive: true, force: true }));
  assert.equal(detectInstall({ isPackaged: true, platform: 'linux', arch: 'x64', env: {}, resourcesPath: resources }).kind, 'unmanaged');
  writeFileSync(join(resources, 'package-type'), 'deb\n');
  assert.equal(detectInstall({ isPackaged: true, platform: 'linux', arch: 'x64', env: {}, resourcesPath: resources }).kind, 'deb');
  assert.equal(detectInstall({ isPackaged: true, platform: 'linux', arch: 'x64', env: { APPIMAGE: '/opt/Weft.AppImage' }, resourcesPath: resources }).kind, 'appimage');
});

test('manifest parser accepts electron-builder output and rejects tampered or unexpected shapes', () => {
  const file = { url: appImage('1.1.0'), sha512: sha(Buffer.from('a')), size: 1 };
  const valid = manifestText({ version: '1.1.0', files: [file] });
  assert.equal(parseManifest(valid).files[0].url, file.url);
  assert.equal(parseManifest(valid.replace(`size: 1\n`, `size: 1\n    blockMapSize: 9\n`)).files[0].blockMapSize, 9);
  const rejects = {
    unknownKey: valid + 'updateUrl: https://evil.example/\n',
    duplicate: valid + 'version: 9.9.9\n',
    blockScalar: valid + 'releaseNotes: |\n  hello\n',
    traversal: manifestText({ version: '1.1.0', files: [{ ...file, url: '../Weft-1.1.0-x86_64.AppImage' }] }),
    absoluteUrl: manifestText({ version: '1.1.0', files: [{ ...file, url: 'https://evil.example/Weft-1.1.0-x86_64.AppImage' }] }),
    badDigest: manifestText({ version: '1.1.0', files: [{ ...file, sha512: 'abc' }] }),
    primaryMismatch: manifestText({ version: '1.1.0', files: [file], primarySha: sha(Buffer.from('other')) }),
    pathNotListed: manifestText({ version: '1.1.0', files: [file], path: 'Weft-1.1.0-other.AppImage' }),
    flowSyntax: valid.replace('size: 1', 'size: {a: 1}'),
    oversized: valid + `releaseName: ${'x'.repeat(70000)}\n`,
    negativeSize: valid.replace('size: 1', 'size: -1'),
  };
  for (const [name, text] of Object.entries(rejects)) assert.throws(() => parseManifest(text), error => error.updateCode === 'manifest_invalid', name);
});

test('release policy refuses prereleases, downgrades, mismatched tags and foreign assets', () => {
  const install = detectInstall({ isPackaged: true, platform: 'linux', arch: 'x64', env: { APPIMAGE: '/a' } });
  const file = { url: appImage('1.1.0'), sha512: sha(Buffer.from('a')), size: 1 };
  const manifest = { version: '1.1.0', files: [file], path: file.url, sha512: file.sha512, releaseDate: '2026-10-01T00:00:00Z' };
  assert.equal(evaluateRelease({ manifest, currentVersion: '1.0.0', releaseTag: 'v1.1.0', install }).action, 'stage');
  assert.equal(evaluateRelease({ manifest, currentVersion: '1.1.0', releaseTag: 'v1.1.0', install }).action, 'up_to_date');
  assert.equal(evaluateRelease({ manifest, currentVersion: '1.2.0', releaseTag: 'v1.1.0', install }).action, 'downgrade_refused');
  assert.equal(evaluateRelease({ manifest, currentVersion: '1.0.0', releaseTag: 'v1.1.0', install, failedVersions: ['1.1.0'], automatic: true }).action, 'skipped_failed_version');
  assert.equal(evaluateRelease({ manifest, currentVersion: '1.0.0', releaseTag: 'v1.1.0', install, failedVersions: ['1.1.0'] }).action, 'stage');
  const refuse = (input, code) => assert.throws(() => evaluateRelease({ manifest, currentVersion: '1.0.0', releaseTag: 'v1.1.0', install, ...input }), error => error.updateCode === code, code);
  refuse({ manifest: { ...manifest, version: '1.1.0-beta.1' }, releaseTag: 'v1.1.0-beta.1' }, 'prerelease_refused');
  refuse({ releaseTag: 'v1.0.9' }, 'release_mismatch');
  refuse({ releaseTag: null }, 'release_mismatch');
  refuse({ manifest: { ...manifest, files: [{ ...file, url: 'Weft-1.0.5-x86_64.AppImage' }] } }, 'no_matching_asset');
  refuse({ install: detectInstall({ isPackaged: true, platform: 'darwin', arch: 'arm64' }) }, 'no_matching_asset');
});

test('Windows signature policy pins a signed install to the same publisher', () => {
  const signed = { status: 'valid', subject: 'CN=Weft Contributors' };
  assert.equal(signaturePolicy(signed, signed).status, 'verified');
  assert.equal(signaturePolicy(signed, { status: 'valid', subject: 'CN=Someone Else' }).allowed, false);
  assert.equal(signaturePolicy(signed, { status: 'unsigned' }).allowed, false);
  assert.equal(signaturePolicy(signed, { status: 'unavailable' }).allowed, false);
  assert.equal(signaturePolicy({ status: 'unavailable' }, signed).allowed, false, 'an unreadable installed signature is not a trust root');
  assert.equal(signaturePolicy({ status: 'unsigned' }, { status: 'invalid' }).allowed, false);
  assert.equal(signaturePolicy({ status: 'unsigned' }, { status: 'unsigned' }).status, 'not_verified');
  assert.equal(signaturePolicy({ status: 'unsigned' }, signed).status, 'signed');
});

test('a human check follows only the fixed GitHub release chain and stages a verified build', async t => {
  const f = fixture(t);
  const result = await f.service.check();
  assert.equal(result.status, 'staged');
  assert.equal(result.staged.version, '1.1.0');
  assert.equal(result.staged.verification.onDisk, 'present');
  assert.deepEqual(f.net.requests.map(request => new URL(request.url).hostname), ['github.com', 'github.com', 'release-assets.githubusercontent.com', 'github.com', 'objects.githubusercontent.com']);
  assert.match(f.net.requests[0].headers['user-agent'], /^Weft\/1\.0\.0 \(linux; x64\) update-check$/);
  assert.equal(readFileSync(join(f.options.directory, 'staged', appImage('1.1.0')), 'utf8'), 'new weft build');
  assert.equal(readFileSync(f.appPath, 'utf8'), 'installed 1.0.0', 'checking never installs');
  assert.equal(f.calls.relaunch.length + f.calls.spawn.length + f.calls.open.length, 0);
  // A second check reuses the verified download instead of fetching the asset again.
  const before = f.net.requests.length;
  assert.equal((await f.service.check()).status, 'staged');
  assert.equal(f.net.requests.length - before, 3);
});

test('hash, size and manifest tampering never leave a staged file', async t => {
  const cases = {
    hash: github({ assetBytes: Buffer.from('evil weft build') }),
    longer: github({ assetBytes: Buffer.from('new weft build plus extra') }),
    shorter: github({ assetBytes: Buffer.from('new weft') }),
    manifest: github({ manifest: manifestText({ version: '1.1.0', files: [{ url: appImage('1.1.0'), sha512: sha(Buffer.from('x')), size: 1 }], primarySha: sha(Buffer.from('y')) }) }),
  };
  for (const [name, net] of Object.entries(cases)) {
    const f = fixture(t, { net });
    await assert.rejects(f.service.check(), error => ['integrity_mismatch', 'manifest_invalid'].includes(error.updateCode), name);
    assert.equal(f.service.status().staged, null, name);
    const staged = join(f.options.directory, 'staged');
    assert.deepEqual(existsSync(staged) ? readdirSync(staged) : [], [], `${name}: no partial or unverified file remains`);
    assert.notEqual(f.service.status().lastCheck.status, 'staged', name);
  }
});

test('redirects outside HTTPS GitHub release hosts or the fixed repository are refused', async t => {
  const latest = `${RELEASES}/latest/download/latest-linux.yml`;
  for (const location of ['https://evil.example/latest-linux.yml', 'http://github.com/jxburros/Weft/releases/download/v1.1.0/latest-linux.yml', 'https://github.com/attacker/Weft/releases/download/v1.1.0/latest-linux.yml', 'https://user:pass@objects.githubusercontent.com/x']) {
    const f = fixture(t, { net: github({ overrides: { [latest]: { status: 302, location } } }) });
    await assert.rejects(f.service.check(), error => error.updateCode === 'redirect_refused', location);
    assert.equal(f.net.requests.length, 1, 'the refused destination is never requested');
  }
});

test('stable channel refusals: prerelease manifest and downgrade are not staged', async t => {
  const pre = fixture(t, { net: github({ version: '1.1.0-rc.1' }) });
  await assert.rejects(pre.service.check(), error => error.updateCode === 'prerelease_refused');
  const down = fixture(t, { version: '2.0.0' });
  const result = await down.service.check();
  assert.equal(result.status, 'downgrade_refused');
  assert.equal(down.service.status().staged, null);
  assert.equal(down.net.requests.some(request => request.url.endsWith('.AppImage')), false, 'downgrade assets are never downloaded');
});

test('kill switch, source runs and offline failures produce no success and no hidden traffic', async t => {
  const killed = fixture(t, { env: { WEFT_DISABLE_UPDATES: '1' } });
  await assert.rejects(killed.service.check(), error => error.code === 'unavailable' && /WEFT_DISABLE_UPDATES/.test(error.message));
  await assert.rejects(killed.service.install({ version: '1.1.0' }), error => error.code === 'unavailable');
  assert.equal(killed.service.configure({ automaticChecks: true }).killSwitch.active, true);
  assert.equal(killed.service.startBackground(), false);
  assert.equal(killed.net.requests.length, 0);

  const source = fixture(t, { install: detectInstall({ isPackaged: false, platform: 'linux', arch: 'x64' }) });
  await assert.rejects(source.service.check(), error => error.updateCode === 'unsupported');
  assert.equal(source.net.requests.length, 0);

  const offline = fixture(t, { net: github({ overrides: { [`${RELEASES}/latest/download/latest-linux.yml`]: { throws: Object.assign(new Error('getaddrinfo ENOTFOUND github.com'), { code: 'ENOTFOUND' }) } } }) });
  await assert.rejects(offline.service.check(), error => error.code === 'unavailable' && error.updateCode === 'offline');
  const status = offline.service.status();
  assert.equal(status.lastCheck.status, 'offline');
  assert.equal(status.staged, null);

  const unpublished = fixture(t, { net: github({ overrides: { [`${RELEASES}/latest/download/latest-linux.yml`]: { status: 404 } } }) });
  await assert.rejects(unpublished.service.check(), error => error.code === 'unavailable' && /No stable release/.test(error.message));
});

test('only the trusted human interface can check, install, configure or roll back', async t => {
  const f = fixture(t);
  for (const name of ['update.check', 'update.install', 'update.rollback', 'update.configure']) {
    await assert.rejects(f.service.execute(name, { version: '1.1.0', automaticChecks: true }, { actor: 'automation' }), error => error.code === 'human_required', name);
  }
  assert.equal((await f.service.execute('update.status', {}, { actor: 'automation' })).channel, 'stable');
  assert.equal(f.net.requests.length, 0);

  const directory = mkdtempSync(join(tmpdir(), 'weft-update-dispatch-'));
  const workspace = new WorkspaceService({ directory: join(directory, 'ws') });
  t.after(() => { workspace.close(); rmSync(directory, { recursive: true, force: true }); });
  const clients = new ClientGrants({ directory, masterToken: 'update-test', workspace });
  const grant = clients.execute('clients.create', { name: 'Reader', scopes: ['read'], workspaceIds: [workspace.activeWorkspaceId] }, { actor: 'human', source: 'gui' });
  const dispatch = createDispatcher({ workspace, clients, updates: f.service, admission: new AutomationAdmission(), browser: { tabs: new Map(), downloads: new Map() }, providers: {} });
  const reader = clients.authenticate(grant.token);
  assert.equal((await dispatch('update.status', {}, reader)).result.currentVersion, '1.0.0');
  assert.equal((await dispatch('update.check', {}, reader)).error.code, 'permission_required');
  assert.equal((await dispatch('update.check', {}, { actor: 'automation' })).error.code, 'human_required');
  assert.equal((await dispatch('update.install', { version: '1.1.0', url: 'https://evil.example/' }, { actor: 'human', source: 'gui' })).error.code, 'invalid_arguments', 'callers cannot supply update URLs');
  assert.equal(f.net.requests.length, 0);
  const checked = await dispatch('update.check', {}, { actor: 'human', source: 'gui' });
  assert.equal(checked.execution, 'succeeded');
  assert.equal(checked.result.status, 'staged');
  const offline = createDispatcher({ workspace, clients, admission: new AutomationAdmission(), browser: { tabs: new Map(), downloads: new Map() }, providers: {} });
  assert.equal((await offline('update.status', {}, { actor: 'human', source: 'gui' })).error.code, 'unavailable');
});

test('AppImage install replaces atomically, then health check promotes or rollback restores', async t => {
  const f = fixture(t);
  await f.service.check();
  await assert.rejects(f.service.install({ version: '1.2.0' }), error => error.code === 'stale_state');
  const installed = await f.service.install({ version: '1.1.0' });
  assert.equal(installed.status, 'restarting');
  assert.deepEqual(f.calls.relaunch, [f.appPath]);
  assert.equal(readFileSync(f.appPath, 'utf8'), 'new weft build');
  assert.equal(readFileSync(`${f.appPath}.weft-previous`, 'utf8'), 'installed 1.0.0');

  const next = f.restart('1.1.0');
  assert.equal(next.beginLaunch().phase, 'probation');
  assert.equal(next.status().activation.health.status, 'probation');
  assert.equal(next.confirmHealthy({ gui: true, api: true, workspace: true }).status, 'healthy');
  const status = next.status();
  assert.equal(status.activation.health.status, 'healthy');
  assert.equal(status.activation.rollback.version, '1.0.0');
  assert.equal(status.activation.history.at(-1).outcome, 'healthy');

  // A human can still restore the retained, re-verified previous version later.
  assert.equal((await next.rollback()).status, 'restarting');
  assert.equal(readFileSync(f.appPath, 'utf8'), 'installed 1.0.0');
  const back = f.restart('1.0.0');
  assert.equal(back.beginLaunch().phase, 'probation');
  back.confirmHealthy({ gui: true, api: true, workspace: true });
  assert.equal(back.status().activation.health.status, 'healthy');
});

test('a version that never proves healthy is rolled back automatically on AppImage', async t => {
  const f = fixture(t);
  await f.service.check();
  await f.service.install({ version: '1.1.0' });
  let launch;
  for (let i = 1; i <= MAX_UNHEALTHY_LAUNCHES; i++) {
    launch = f.restart('1.1.0').beginLaunch();
    assert.equal(launch.phase, 'probation', `launch ${i}`);
  }
  const failing = f.restart('1.1.0');
  launch = failing.beginLaunch();
  assert.deepEqual([launch.phase, launch.automaticRollback], ['failed', true]);
  const restored = await failing.rollback({ automatic: true });
  assert.equal(restored.automatic, true);
  assert.equal(readFileSync(f.appPath, 'utf8'), 'installed 1.0.0');
  const old = f.restart('1.0.0');
  assert.equal(old.beginLaunch().phase, 'rolled_back');
  assert.equal(existsSync(`${f.appPath}.weft-failed`), false);
  const status = old.status();
  assert.deepEqual(status.activation.failedVersions, ['1.1.0']);
  assert.equal(status.activation.pending, null);
  // Background checks will not re-stage a version that failed; a human check may retry it.
  assert.equal((await old.check({ automatic: true })).status, 'skipped_failed_version');
  assert.equal((await old.check()).status, 'staged');
});

test('explicit health failure, unapplied updates and corrupt state are reported honestly', async t => {
  const f = fixture(t);
  await f.service.check();
  await f.service.install({ version: '1.1.0' });
  const next = f.restart('1.1.0');
  next.beginLaunch();
  assert.equal(next.confirmHealthy({ gui: true, api: false, workspace: true }).status, 'failed');
  assert.match(next.status().activation.health.reason, /api/);

  const g = fixture(t);
  await g.service.check();
  await g.service.install({ version: '1.1.0' });
  assert.equal(g.restart('1.0.0').beginLaunch().phase, 'not_applied');

  writeFileSync(join(g.options.directory, 'state.json'), JSON.stringify({ version: 1, automaticChecks: true, staged: { file: '../../evil' } }));
  mkdirSync(join(g.options.directory, 'staged'), { recursive: true });
  writeFileSync(join(g.options.directory, 'staged', 'Weft-9.9.9-x86_64.AppImage'), 'planted');
  const reset = g.restart('1.0.0');
  const status = reset.status();
  assert.match(status.warning, /reset/);
  assert.equal(status.staged, null);
  assert.equal(status.automaticChecks.enabled, false);
  assert.equal(existsSync(join(g.options.directory, 'staged')), false);
});

test('a staged file changed on disk after verification is refused at install time', async t => {
  const f = fixture(t);
  await f.service.check();
  writeFileSync(join(f.options.directory, 'staged', appImage('1.1.0')), 'new weft bxild');
  await assert.rejects(f.service.install({ version: '1.1.0' }), error => error.updateCode === 'integrity_mismatch');
  assert.equal(f.service.status().staged, null);
  assert.equal(readFileSync(f.appPath, 'utf8'), 'installed 1.0.0');
  assert.deepEqual(f.calls.relaunch, []);
});

test('Windows hands the verified installer to NSIS with --updated and refuses a different publisher', async t => {
  const version = '1.1.0';
  const bytes = Buffer.from('signed setup');
  const file = { url: `Weft-Setup-${version}-x64.exe`, sha512: sha(bytes), size: bytes.length };
  const routes = {
    [`${RELEASES}/latest/download/latest.yml`]: { status: 302, location: `${RELEASES}/download/v${version}/latest.yml` },
    [`${RELEASES}/download/v${version}/latest.yml`]: { status: 200, body: [Buffer.from(manifestText({ version, files: [file] }))] },
    [`${RELEASES}/download/v${version}/${file.url}`]: { status: 200, body: [bytes] },
  };
  const net = { requests: [], transport: async ({ url }) => { net.requests.push({ url }); return routes[url] || { status: 404 }; } };
  const install = detectInstall({ isPackaged: true, platform: 'win32', arch: 'x64' });
  const signer = subjects => async path => ({ status: 'valid', subject: path === 'C:\\Weft\\Weft.exe' ? subjects.current : subjects.update });

  const other = fixture(t, { net, install, launcher: { execPath: 'C:\\Weft\\Weft.exe' } });
  other.service.verifySignature = signer({ current: 'CN=Weft', update: 'CN=Mallory' });
  await assert.rejects(other.service.check(), error => error.updateCode === 'signature_refused');
  assert.equal(other.service.status().staged, null);

  const f = fixture(t, { net, install, launcher: { execPath: 'C:\\Weft\\Weft.exe' } });
  f.service.verifySignature = signer({ current: 'CN=Weft', update: 'CN=Weft' });
  const checked = await f.service.check();
  assert.equal(checked.staged.signature.status, 'verified');
  const result = await f.service.install({ version });
  assert.equal(result.status, 'handed_off');
  assert.deepEqual(f.calls.spawn.map(call => call.args), [['--updated']]);
  assert.equal(f.calls.quit, 1);
  // After the installer runs, the new version retains its own verified installer for a later rollback.
  const next = f.restart(version);
  assert.equal(next.beginLaunch().phase, 'probation');
  next.confirmHealthy({ gui: true, api: true, workspace: true });
  assert.equal(next.status().activation.rollback.available, false, 'the first installed version has no retained installer');
  assert.ok(existsSync(join(f.options.directory, 'retained', file.url)));

  // The next update can roll back to the retained, re-verified 1.1.0 installer.
  const newer = Buffer.from('signed setup 1.2.0');
  const newerFile = { url: 'Weft-Setup-1.2.0-x64.exe', sha512: sha(newer), size: newer.length };
  Object.assign(routes, {
    [`${RELEASES}/latest/download/latest.yml`]: { status: 302, location: `${RELEASES}/download/v1.2.0/latest.yml` },
    [`${RELEASES}/download/v1.2.0/latest.yml`]: { status: 200, body: [Buffer.from(manifestText({ version: '1.2.0', files: [newerFile] }))] },
    [`${RELEASES}/download/v1.2.0/${newerFile.url}`]: { status: 200, body: [newer] },
  });
  next.verifySignature = f.service.verifySignature;
  await next.check();
  await next.install({ version: '1.2.0' });
  const latest = f.restart('1.2.0');
  latest.verifySignature = f.service.verifySignature;
  latest.beginLaunch();
  latest.confirmHealthy({ gui: true, api: true, workspace: true });
  assert.deepEqual(latest.status().activation.rollback, { available: true, version: '1.1.0', kind: 'installer', automatic: false });
  await assert.rejects(latest.rollback({ automatic: true }), error => error.code === 'unavailable', 'Windows rollback is never automatic');
  writeFileSync(join(f.options.directory, 'retained', file.url), 'tampered');
  await assert.rejects(latest.rollback(), error => error.updateCode === 'integrity_mismatch');
  writeFileSync(join(f.options.directory, 'retained', file.url), bytes);
  const spawned = f.calls.spawn.length;
  assert.equal((await latest.rollback()).status, 'handed_off');
  assert.deepEqual(f.calls.spawn.slice(spawned), [{ path: join(f.options.directory, 'retained', file.url), args: [] }]);
});

test('macOS and Debian hand off the verified file for a visible manual install', async t => {
  const version = '1.1.0';
  const bytes = Buffer.from('dmg bytes');
  const file = { url: `Weft-${version}-arm64.dmg`, sha512: sha(bytes), size: bytes.length };
  const routes = {
    [`${RELEASES}/latest/download/latest-mac.yml`]: { status: 302, location: `${RELEASES}/download/v${version}/latest-mac.yml` },
    [`${RELEASES}/download/v${version}/latest-mac.yml`]: { status: 200, body: [Buffer.from(manifestText({ version, files: [{ url: `Weft-${version}-arm64-mac.zip`, sha512: sha(Buffer.from('zip')), size: 3 }, file], path: `Weft-${version}-arm64-mac.zip`, primarySha: sha(Buffer.from('zip')) }))] },
    [`${RELEASES}/download/v${version}/${file.url}`]: { status: 200, body: [bytes] },
  };
  const net = { transport: async ({ url }) => routes[url] || { status: 404 } };
  const f = fixture(t, { net, install: detectInstall({ isPackaged: true, platform: 'darwin', arch: 'arm64' }) });
  const checked = await f.service.check();
  assert.equal(checked.staged.file, file.url);
  const result = await f.service.install({ version });
  assert.equal(result.status, 'handed_off_manual');
  assert.equal(f.calls.open.length, 1);
  assert.equal(f.service.status().activation.rollback.available, false);
  await assert.rejects(f.service.rollback(), error => error.code === 'not_found' && /SHA256SUMS/.test(error.message));
});

test('background checks are opt-in, at most daily and only stage', async t => {
  let clock = Date.parse('2026-10-17T00:00:00Z');
  const timers = { intervals: [], timeouts: [], setInterval(fn) { this.intervals.push(fn); return { unref() {} }; }, setTimeout(fn) { this.timeouts.push(fn); return { unref() {} }; }, clearInterval() { this.intervals = []; }, clearTimeout() { this.timeouts = []; } };
  const f = fixture(t, { now: () => clock });
  f.service.timers = timers;
  assert.equal(f.service.startBackground(), false, 'off by default');
  assert.equal(f.service.status().automaticChecks.nextCheckAt, null);
  f.service.configure({ automaticChecks: true });
  assert.equal(timers.intervals.length, 1);
  timers.timeouts[0]();
  await f.service.inFlight;
  assert.equal(f.service.status().lastCheck.automatic, true);
  assert.equal(f.service.status().staged.version, '1.1.0');
  assert.equal(readFileSync(f.appPath, 'utf8'), 'installed 1.0.0', 'background checks never install');
  const requests = f.net.requests.length;
  clock += CHECK_INTERVAL_MS - 1;
  timers.intervals[0]();
  assert.equal(f.service.inFlight, null);
  assert.equal(f.net.requests.length, requests, 'no second check within 24 hours');
  clock += 1;
  timers.intervals[0]();
  await f.service.inFlight;
  assert.ok(f.net.requests.length > requests);
  f.service.configure({ automaticChecks: false });
  assert.equal(timers.intervals.length, 0);
});
