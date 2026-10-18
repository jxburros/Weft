import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { renderInstallerArt } from '../scripts/generate-installer-art.js';
import { changelogSection, releaseMetadata } from '../scripts/release/metadata.js';
import { verifyReleaseAssets } from '../scripts/release/verify-assets.js';
import { packagingEnvironment } from '../scripts/release/build-packages.js';
import { WEFT_VERSION } from '../src/version.js';
import { createOpenApiDocument } from '../src/openapi.js';
import { createMcpServer } from '../src/mcp.js';

const root = fileURLToPath(new URL('..', import.meta.url));
const require = createRequire(import.meta.url);

test('missing Actions signing secrets do not become certificate paths in electron-builder', () => {
  const { PlatformPackager } = require('app-builder-lib');
  const packager = { info: { config: {} }, platformSpecificBuildOptions: {} };
  const saved = process.env;
  try {
    const env = { CSC_LINK: '', WIN_CSC_LINK: '', CSC_KEY_PASSWORD: '', CSC_IDENTITY_AUTO_DISCOVERY: 'false', WEFT_DISABLE_UPDATES: '1' };
    process.env = env;
    // This is the upstream lookup that caused v1.1.1 to import the repository
    // directory as a certificate, even with identity auto-discovery disabled.
    assert.equal(PlatformPackager.prototype.getCscLink.call(packager), '');
    process.env = packagingEnvironment(env);
    assert.equal(PlatformPackager.prototype.getCscLink.call(packager), undefined);
    assert.equal(PlatformPackager.prototype.getCscLink.call(packager, 'WIN_CSC_LINK'), undefined);
    assert.equal(process.env.CSC_KEY_PASSWORD, '');
    assert.equal(process.env.CSC_IDENTITY_AUTO_DISCOVERY, 'false');
    assert.equal(process.env.WEFT_DISABLE_UPDATES, '1');
    assert.equal(env.CSC_LINK, '', 'the supplied environment is not mutated');

    process.env = packagingEnvironment({ CSC_LINK: '/certs/mac.p12', WIN_CSC_LINK: '/certs/windows.pfx' });
    assert.equal(PlatformPackager.prototype.getCscLink.call(packager), '/certs/mac.p12');
    assert.equal(PlatformPackager.prototype.getCscLink.call(packager, 'WIN_CSC_LINK'), '/certs/windows.pfx');
    process.env = packagingEnvironment({ CSC_LINK: '/certs/fallback.p12', WIN_CSC_LINK: '' });
    assert.equal(PlatformPackager.prototype.getCscLink.call(packager, 'WIN_CSC_LINK'), '/certs/fallback.p12');
  } finally { process.env = saved; }
});

test('product version is consistent across package, lockfile, plugin and served API metadata', () => {
  const { version, problems } = releaseMetadata(root);
  assert.deepEqual(problems, []);
  assert.equal(WEFT_VERSION, version);
  assert.equal(createOpenApiDocument().info.version, version);
  assert.equal(createMcpServer({})._serverInfo.version, version);
});

test('release gate rejects mismatched tags, manifests and missing changelog notes', t => {
  const fixture = mkdtempSync(join(tmpdir(), 'weft-release-meta-'));
  t.after(() => rmSync(fixture, { recursive: true, force: true }));
  const write = (path, value) => writeFileSync(join(fixture, path), typeof value === 'string' ? value : JSON.stringify(value));
  cpSync(join(root, '.claude-plugin'), join(fixture, '.claude-plugin'), { recursive: true });
  write('package.json', { version: '1.2.0' });
  write('package-lock.json', { version: '1.2.0', packages: { '': { version: '1.2.0' } } });
  write('.claude-plugin/plugin.json', { version: '1.2.0' });
  write('CHANGELOG.md', '# Changelog\n\n## v1.2.0 — 2026-11-01\n\n### Changed\n\n- Shipped installers.\n\n## 2026-10-17 — Agent\n\n- Older.\n');
  assert.deepEqual(releaseMetadata(fixture, 'v1.2.0').problems, []);
  assert.equal(releaseMetadata(fixture, 'v1.2.0').notes, '### Changed\n\n- Shipped installers.');
  assert.match(releaseMetadata(fixture, 'v1.2.1').problems.join('\n'), /Tag v1\.2\.1 does not match/);
  assert.match(releaseMetadata(fixture, 'v1.2.0-beta.1').problems.join('\n'), /does not match/);
  write('CHANGELOG.md', '# Changelog\n\n## v1.1.0 — 2026-10-01\n\n- Old.\n');
  assert.match(releaseMetadata(fixture, 'v1.2.0').problems.join('\n'), /CHANGELOG\.md has no/);
  write('package-lock.json', { version: '1.2.0', packages: { '': { version: '1.1.0' } } });
  write('.claude-plugin/plugin.json', { version: '1.1.0' });
  const problems = releaseMetadata(fixture).problems.join('\n');
  assert.match(problems, /package-lock\.json/);
  assert.match(problems, /plugin\.json/);
  write('package.json', { version: '1.2.0-rc.1' });
  assert.match(releaseMetadata(fixture).problems.join('\n'), /not a stable/);
  assert.equal(changelogSection('## [2.0.0]\nNotes\n', '2.0.0'), 'Notes');
  assert.equal(changelogSection('## v2.0.10 — x\nNotes\n', '2.0.1'), null, 'versions match exactly');
});

test('release assets must match their manifests before SHA256SUMS.txt is produced', async t => {
  const fixture = mkdtempSync(join(tmpdir(), 'weft-release-assets-'));
  t.after(() => rmSync(fixture, { recursive: true, force: true }));
  const bytes = Buffer.from('installer bytes');
  const file = 'Weft-Setup-1.2.0-x64.exe';
  writeFileSync(join(fixture, file), bytes);
  const sha512 = createHash('sha512').update(bytes).digest('base64');
  // Shape copied from a local electron-builder 26.15.3 NSIS build (latest.yml).
  writeFileSync(join(fixture, 'latest.yml'), `version: 1.2.0\nfiles:\n  - url: ${file}\n    sha512: ${sha512}\n    size: ${bytes.length}\npath: ${file}\nsha512: ${sha512}\nreleaseDate: '2026-10-17T16:27:34.696Z'\n`);
  writeFileSync(join(fixture, 'unrelated.txt'), 'not an asset');
  const verified = await verifyReleaseAssets(fixture, '1.2.0');
  assert.deepEqual(verified.problems, []);
  assert.deepEqual(verified.sums.trim().split('\n').map(line => line.split('  ')[1]), [file, 'latest.yml']);
  assert.equal(verified.sums.split('  ')[0], createHash('sha256').update(bytes).digest('hex'));
  assert.match((await verifyReleaseAssets(fixture, '1.3.0')).problems.join('\n'), /does not match 1\.3\.0/);
  writeFileSync(join(fixture, file), 'installer bytez!');
  assert.match((await verifyReleaseAssets(fixture, '1.2.0')).problems.join('\n'), /size differs|SHA-512 differs/);
  rmSync(join(fixture, file));
  assert.match((await verifyReleaseAssets(fixture, '1.2.0')).problems.join('\n'), /missing/);
});

test('installer bitmaps are the Vixl exports in packaging/source, at NSIS dimensions', () => {
  for (const [path, bytes] of Object.entries(renderInstallerArt())) {
    assert.ok(readFileSync(join(root, path)).equals(bytes), `${path} drifted; run node scripts/generate-installer-art.js`);
    assert.equal(bytes.toString('latin1', 0, 2), 'BM');
    assert.equal(bytes.readUInt16LE(28), 24, `${path} must be 24-bit`);
    const size = [bytes.readInt32LE(18), bytes.readInt32LE(22)];
    assert.deepEqual(size, path.endsWith('header.bmp') ? [150, 57] : [164, 314], path);
  }
});

test('packaging policy: per-user assisted installer, data kept, stable GitHub channel, signing only with secrets', () => {
  const load = env => {
    const saved = { ...process.env };
    for (const key of ['AZURE_SIGNING_ENDPOINT', 'AZURE_SIGNING_ACCOUNT', 'AZURE_SIGNING_PROFILE', 'WEFT_WINDOWS_PUBLISHER', 'APPLE_API_KEY', 'APPLE_API_KEY_ID', 'APPLE_API_ISSUER']) delete process.env[key];
    Object.assign(process.env, env);
    const path = require.resolve('../electron-builder.config.cjs');
    delete require.cache[path];
    try { return require(path); } finally { process.env = saved; delete require.cache[path]; }
  };
  const config = load({});
  assert.deepEqual([config.nsis.oneClick, config.nsis.perMachine, config.nsis.selectPerMachineByDefault, config.nsis.deleteAppDataOnUninstall], [false, false, false, false]);
  for (const resource of [config.nsis.installerSidebar, config.nsis.uninstallerSidebar, config.nsis.installerHeader]) assert.ok(existsSync(join(root, config.directories.buildResources, resource)), resource);
  assert.ok(existsSync(join(root, config.nsis.include)));
  assert.deepEqual(config.publish.map(({ provider, owner, repo }) => [provider, owner, repo]), [['github', 'jxburros', 'Weft']]);
  assert.equal(config.win.azureSignOptions, undefined);
  assert.equal(config.win.signtoolOptions, undefined);
  assert.equal(config.mac.notarize, false);
  assert.ok(!config.files.some(pattern => /^(test|docs|evals|perf|scripts)\b/.test(pattern)), 'tests and docs are not shipped');
  const signed = load({ AZURE_SIGNING_ENDPOINT: 'https://eus.codesigning.azure.net', AZURE_SIGNING_ACCOUNT: 'weft', AZURE_SIGNING_PROFILE: 'release', WEFT_WINDOWS_PUBLISHER: 'Weft Contributors', APPLE_API_KEY: '/k.p8', APPLE_API_KEY_ID: 'id', APPLE_API_ISSUER: 'issuer' });
  assert.equal(signed.win.azureSignOptions.publisherName, 'Weft Contributors');
  assert.equal(signed.mac.notarize, true);
});

test('the profile folder the uninstaller may remove is the one packaged Weft uses', () => {
  const name = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).name;
  const main = readFileSync(join(root, 'src/main.js'), 'utf8');
  const nsis = readFileSync(join(root, 'packaging/installer.nsh'), 'utf8');
  assert.match(main, new RegExp(`app\\.setPath\\('userData', join\\(app\\.getPath\\('appData'\\), '${name}'\\)\\)`));
  const removed = [...nsis.matchAll(/RMDir \/r "\$APPDATA\\([^"]+)"/g)].map(match => match[1]);
  assert.deepEqual(removed, [`${name}\\updates`, name]);
  // The Windows install check plants its keep-me file in that same folder.
  const check = readFileSync(join(root, 'scripts/release/windows-install-check.ps1'), 'utf8');
  assert.match(check, new RegExp(`\\$profileDir = Join-Path \\$env:APPDATA '${name}'`));
});
