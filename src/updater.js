import { createHash } from 'node:crypto';
import { chmodSync, closeSync, copyFileSync, createReadStream, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, statSync } from 'node:fs';
import { open } from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod';
import { fileStamp, writeVerifiedJson } from './storage-safety.js';

/**
 * Stable-only, integrity-verified updates from one fixed GitHub repository.
 * Policy (docs/decisions/004-distribution-and-updates.md): projects, pages and agents cannot
 * supply update URLs; nothing is contacted unless a human checks or opts in to background
 * checks; background checks only download and stage; a human installs; prereleases and
 * downgrades are refused; WEFT_DISABLE_UPDATES stops all update traffic.
 */
export const UPDATE_SOURCE = Object.freeze({ owner: 'jxburros', repo: 'Weft', channel: 'stable', releases: 'https://github.com/jxburros/Weft/releases' });
export const UPDATE_HOSTS = Object.freeze(['github.com', 'objects.githubusercontent.com', 'release-assets.githubusercontent.com']);
export const CHECK_INTERVAL_MS = 24 * 60 * 60 * 1000;
export const MAX_UNHEALTHY_LAUNCHES = 2;
const MANIFEST_LIMIT = 64 * 1024;
const ASSET_LIMIT = 1024 ** 3;
const MAX_REDIRECTS = 5;

export class UpdateError extends Error {
  constructor(code, message) { super(message); this.name = 'UpdateError'; this.updateCode = code; this.code = UpdateError.commandCode(code); }
  static commandCode(code) {
    return ({ disabled: 'unavailable', unsupported: 'unavailable', offline: 'unavailable', not_published: 'unavailable', http_error: 'unavailable', not_staged: 'not_found', human_required: 'human_required', stale_state: 'stale_state' })[code] || 'command_failed';
  }
}
const fail = (code, message) => { throw new UpdateError(code, message); };

/** Kill switch: any value other than empty/0/false/no/off disables updates (fails closed). */
export function updatesDisabled(env = process.env) {
  const value = env.WEFT_DISABLE_UPDATES;
  return value !== undefined && !['', '0', 'false', 'no', 'off'].includes(String(value).trim().toLowerCase());
}

const stable = /^(0|[1-9]\d{0,5})\.(0|[1-9]\d{0,5})\.(0|[1-9]\d{0,5})$/;
export function parseStableVersion(value) {
  const match = stable.exec(String(value));
  return match ? match.slice(1).map(Number) : null;
}
export function compareVersions(left, right) {
  const a = parseStableVersion(left), b = parseStableVersion(right);
  if (!a || !b) throw new UpdateError('invalid_version', 'Only stable x.y.z versions can be compared');
  for (let i = 0; i < 3; i++) if (a[i] !== b[i]) return a[i] < b[i] ? -1 : 1;
  return 0;
}

/** Install type of the running copy. Running from source is never updated in place. */
export function detectInstall({ isPackaged, platform, arch, env = {}, resourcesPath = '' }) {
  const base = { platform, arch, channelFile: null, supported: false, method: 'none' };
  if (!isPackaged) return { ...base, kind: 'source', reason: 'Running from source. Update with git and npm ci; packaged updates do not apply.' };
  if (platform === 'win32' && arch === 'x64') return { ...base, kind: 'nsis', channelFile: 'latest.yml', supported: true, method: 'installer', asset: /^Weft-Setup-(\d+\.\d+\.\d+)-x64\.exe$/ };
  if (platform === 'darwin' && ['arm64', 'x64'].includes(arch)) return { ...base, kind: 'dmg', channelFile: 'latest-mac.yml', supported: true, method: 'manual', asset: new RegExp(`^Weft-(\\d+\\.\\d+\\.\\d+)-${arch}\\.dmg$`) };
  if (platform === 'linux' && arch === 'x64') {
    if (env.APPIMAGE) return { ...base, kind: 'appimage', channelFile: 'latest-linux.yml', supported: true, method: 'replace', appImagePath: env.APPIMAGE, asset: /^Weft-(\d+\.\d+\.\d+)-x86_64\.AppImage$/ };
    let packageType = '';
    try { packageType = readFileSync(join(resourcesPath, 'package-type'), 'utf8').trim(); } catch { /* not a system package */ }
    if (packageType === 'deb') return { ...base, kind: 'deb', channelFile: 'latest-linux.yml', supported: true, method: 'manual', asset: /^Weft-(\d+\.\d+\.\d+)-amd64\.deb$/ };
    return { ...base, kind: 'unmanaged', reason: 'This Linux copy is not an AppImage or Debian package; update it the way it was installed.' };
  }
  return { ...base, kind: 'unsupported', reason: `No stable release is published for ${platform}/${arch}.` };
}

const fileName = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,199}$/).refine(value => !value.includes('..'), 'File names cannot contain ..');
const sha512 = z.string().regex(/^[A-Za-z0-9+/]{86}==$/, 'Expected a base64 SHA-512 digest');
const manifestSchema = z.strictObject({
  version: z.string().max(64),
  files: z.array(z.strictObject({
    url: fileName, sha512, size: z.number().int().positive().max(ASSET_LIMIT),
    blockMapSize: z.number().int().positive().optional(), isAdminRightsRequired: z.boolean().optional(),
  })).min(1).max(16),
  path: fileName, sha512,
  releaseDate: z.string().regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,3})?Z$/),
});

function scalar(raw) {
  if (raw === undefined || raw === '') fail('manifest_invalid', 'Update manifest has an empty value');
  if (/^'.*'$/.test(raw)) return raw.slice(1, -1).replaceAll("''", "'");
  if (/^".*"$/.test(raw)) { try { return JSON.parse(raw); } catch { fail('manifest_invalid', 'Update manifest has an invalid quoted value'); } }
  if (/^\d{1,15}$/.test(raw)) return Number(raw);
  if (raw === 'true' || raw === 'false') return raw === 'true';
  if (/^[-?:,[\]{}#&*!|>'"%@`]/.test(raw) || /\s#|:\s/.test(raw)) fail('manifest_invalid', 'Update manifest uses unsupported YAML syntax');
  return raw;
}
/** Parses exactly the electron-builder latest*.yml shape; anything else is rejected, never guessed. */
export function parseManifest(text) {
  if (typeof text !== 'string' || Buffer.byteLength(text) > MANIFEST_LIMIT) fail('manifest_invalid', 'Update manifest is missing or too large');
  const top = {};
  let files = null, current = null, inFiles = false;
  const set = (target, key, value) => {
    if (Object.hasOwn(target, key)) fail('manifest_invalid', `Update manifest repeats ${key}`);
    target[key] = value;
  };
  for (const line of text.replace(/\r\n/g, '\n').split('\n')) {
    if (!line.trim()) continue;
    let match;
    if ((match = /^([A-Za-z][A-Za-z0-9]{0,40}):(?: (.*))?$/.exec(line))) {
      inFiles = match[1] === 'files'; current = null;
      if (inFiles) {
        if (match[2] !== undefined || files) fail('manifest_invalid', 'Update manifest has an invalid files list');
        files = []; set(top, 'files', files);
      } else set(top, match[1], scalar(match[2]));
    } else if ((match = /^ {2}- ([A-Za-z][A-Za-z0-9]{0,40}): (.*)$/.exec(line)) && inFiles) {
      current = {}; files.push(current); set(current, match[1], scalar(match[2]));
    } else if ((match = /^ {4}([A-Za-z][A-Za-z0-9]{0,40}): (.*)$/.exec(line)) && current) {
      set(current, match[1], scalar(match[2]));
    } else fail('manifest_invalid', 'Update manifest uses unsupported YAML structure');
  }
  const parsed = manifestSchema.safeParse(top);
  if (!parsed.success) fail('manifest_invalid', `Update manifest failed validation: ${parsed.error.issues[0].path.join('.') || 'manifest'} ${parsed.error.issues[0].message}`);
  const manifest = parsed.data;
  if (new Set(manifest.files.map(file => file.url)).size !== manifest.files.length) fail('manifest_invalid', 'Update manifest lists a file twice');
  const primary = manifest.files.find(file => file.url === manifest.path);
  if (!primary || primary.sha512 !== manifest.sha512) fail('manifest_invalid', 'Update manifest path/sha512 do not match its file list');
  return manifest;
}

/** Pure release policy: stable only, newer only, the asset for this install and this exact release. */
export function evaluateRelease({ manifest, currentVersion, releaseTag, install, failedVersions = [], automatic = false }) {
  const { version } = manifest;
  if (/^\d+\.\d+\.\d+[-+]/.test(version)) fail('prerelease_refused', `Release ${version} is a prerelease or build variant; the stable channel refuses it`);
  if (!parseStableVersion(version)) fail('invalid_version', 'Update manifest version is not a stable x.y.z version');
  if (releaseTag !== `v${version}`) fail('release_mismatch', `Manifest version ${version} does not match release tag ${releaseTag || '(unknown)'}`);
  const order = compareVersions(version, currentVersion);
  if (order === 0) return { action: 'up_to_date', version };
  if (order < 0) return { action: 'downgrade_refused', version, reason: `Latest stable ${version} is older than installed ${currentVersion}; downgrades are refused.` };
  if (automatic && failedVersions.includes(version)) return { action: 'skipped_failed_version', version, reason: `${version} previously failed its health check; check manually to retry.` };
  const matches = manifest.files.filter(file => install.asset?.exec(file.url)?.[1] === version);
  if (matches.length !== 1) fail('no_matching_asset', `Release ${version} has no single verified asset for ${install.kind} ${install.platform}/${install.arch}`);
  return { action: 'stage', version, file: matches[0] };
}

/** Windows trust root: a signed install only accepts updates signed by the same publisher. */
export function signaturePolicy(current, candidate) {
  // Without the installed build's signature status there is no trust root to compare against.
  if (current?.status === 'unavailable') return { allowed: false, status: 'refused', reason: 'Could not read the installed build\'s signature, so the update publisher cannot be checked.' };
  if (current?.status === 'valid') {
    if (candidate?.status !== 'valid') return { allowed: false, status: 'refused', reason: 'The installed build is signed but the update is not validly signed.' };
    if (candidate.subject !== current.subject) return { allowed: false, status: 'refused', reason: 'The update is signed by a different publisher than the installed build.' };
    return { allowed: true, status: 'verified', subject: candidate.subject };
  }
  if (candidate?.status === 'invalid') return { allowed: false, status: 'refused', reason: 'The update carries an invalid or tampered signature.' };
  if (candidate?.status === 'valid') return { allowed: true, status: 'signed', subject: candidate.subject, reason: 'Installed build is unsigned; the update signature is valid but cannot be pinned to an installed publisher.' };
  return { allowed: true, status: 'not_verified', subject: null, reason: 'Unsigned build: only the release manifest size and SHA-512 were verified.' };
}

function assertAllowedUrl(value) {
  let url;
  try { url = new URL(value); } catch { fail('redirect_refused', 'Update server returned an invalid URL'); }
  if (url.protocol !== 'https:' || url.username || url.password || url.port || !UPDATE_HOSTS.includes(url.hostname)) fail('redirect_refused', `Update traffic is limited to HTTPS GitHub release hosts; refused ${url.protocol}//${url.hostname}`);
  if (url.hostname === 'github.com' && !url.pathname.toLowerCase().startsWith(`/${UPDATE_SOURCE.owner}/${UPDATE_SOURCE.repo}/releases/`.toLowerCase())) fail('redirect_refused', 'Update redirect left the fixed release repository');
  return url;
}
async function* limited(body, limit, onLength) {
  let total = 0;
  for await (const chunk of body || []) {
    const bytes = Buffer.from(chunk);
    total += bytes.length;
    if (total > limit) fail('integrity_mismatch', 'Download exceeded its declared size');
    onLength?.(total);
    yield bytes;
  }
}

/** UpdateService owns all update state and side effects. The transport is the only network path. */
export class UpdateService {
  constructor({ directory, currentVersion, install, env = process.env, transport = null, verifySignature = null, launcher = {}, now = () => Date.now(), timers = globalThis, userAgent = null }) {
    if (!parseStableVersion(currentVersion)) throw new Error('Weft version must be a stable x.y.z version');
    Object.assign(this, { directory, currentVersion, installation: install, env, transport, verifySignature, launcher, now, timers });
    this.userAgent = userAgent || `Weft/${currentVersion} (${install.platform}; ${install.arch}) update-check`;
    this.path = join(directory, 'state.json');
    this.inFlight = null;
    this.timer = null;
    this.load();
  }

  load() {
    mkdirSync(this.directory, { recursive: true, mode: 0o700 });
    this.stamp = fileStamp(this.path);
    this.stateWarning = null;
    this.state = defaultState();
    try {
      this.state = stateSchema.parse(JSON.parse(readFileSync(this.path, 'utf8')));
    } catch (error) {
      if (error.code !== 'ENOENT') {
        // Discard a corrupt or edited cache instead of trusting it; nothing staged is installed from it.
        this.stateWarning = 'Update state was unreadable and has been reset. Staged downloads must be checked again.';
        rmSync(join(this.directory, 'staged'), { recursive: true, force: true });
        this.save();
      }
    }
  }
  save() { this.stamp = writeVerifiedJson(this.path, JSON.stringify(this.state, null, 2), this.stamp); }
  get disabled() { return updatesDisabled(this.env); }
  stagedPath(file) { return join(this.directory, 'staged', file); }
  retainedPath(file) { return join(this.directory, 'retained', file); }

  status() {
    const staged = this.state.staged;
    let onDisk = null;
    if (staged) {
      try { onDisk = statSync(this.stagedPath(staged.file)).size === staged.size ? 'present' : 'changed'; } catch { onDisk = 'missing'; }
    }
    const rollback = this.rollbackCandidate();
    const nextCheckAt = this.state.automaticChecks && !this.disabled && this.installation.supported
      ? new Date(Math.max(this.now(), (this.state.lastCheck ? Date.parse(this.state.lastCheck.at) : 0) + CHECK_INTERVAL_MS)).toISOString() : null;
    return structuredClone({
      currentVersion: this.currentVersion, channel: UPDATE_SOURCE.channel,
      repository: `${UPDATE_SOURCE.owner}/${UPDATE_SOURCE.repo}`,
      install: { kind: this.installation.kind, platform: this.installation.platform, arch: this.installation.arch, supported: this.installation.supported, method: this.installation.method, reason: this.installation.reason ?? null },
      killSwitch: { active: this.disabled, variable: 'WEFT_DISABLE_UPDATES' },
      automaticChecks: { enabled: this.state.automaticChecks, intervalHours: 24, stagesOnly: true, nextCheckAt },
      egress: { hosts: [...UPDATE_HOSTS], sends: 'IP address, Weft version, platform and architecture (User-Agent). No workspace data, tokens or browsing data.', contactsNetwork: this.state.automaticChecks && !this.disabled && this.installation.supported ? 'when you check and once a day' : 'only when you choose Check now' },
      lastCheck: this.state.lastCheck,
      staged: staged ? { version: staged.version, file: staged.file, size: staged.size, sha512: staged.sha512, releaseTag: staged.releaseTag, verifiedAt: staged.verifiedAt, verification: { sizeAndSha512: 'verified_at_download', onDisk, recheckedBeforeInstall: true }, signature: staged.signature, releaseUrl: `${UPDATE_SOURCE.releases}/tag/${staged.releaseTag}` } : null,
      activation: {
        pending: this.state.pending ? { version: this.state.pending.version, fromVersion: this.state.pending.fromVersion, launches: this.state.pending.launches, method: this.state.pending.method } : null,
        health: this.state.health, history: this.state.history.slice(-10), failedVersions: [...this.state.failedVersions],
        rollback: rollback ? { available: true, version: rollback.version, kind: rollback.kind, automatic: rollback.kind === 'appimage' } : { available: false, guidance: `Download the previous release from ${UPDATE_SOURCE.releases} and verify it against SHA256SUMS.txt.` },
      },
      warning: this.stateWarning,
    });
  }

  assertNetworkAllowed() {
    if (this.disabled) fail('disabled', 'Updates are disabled by WEFT_DISABLE_UPDATES; no update traffic is sent.');
    if (!this.installation.supported) fail('unsupported', this.installation.reason || 'Updates are not supported for this installation.');
    if (!this.transport) fail('unsupported', 'No update transport is available in this process.');
  }

  async fetch(url, { limit, onLength } = {}) {
    let current = url;
    const chain = [current];
    for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
      assertAllowedUrl(current);
      let response;
      try { response = await this.transport({ url: current, headers: { 'user-agent': this.userAgent, accept: 'application/octet-stream, text/yaml, */*' } }); }
      catch (error) { if (error instanceof UpdateError) throw error; fail('offline', `Update server unreachable (${error.code || error.message}). Weft keeps working offline.`); }
      if ([301, 302, 303, 307, 308].includes(response.status)) {
        if (!response.location) fail('redirect_refused', 'Update redirect had no location');
        current = new URL(response.location, current).href;
        chain.push(current);
        continue;
      }
      if (response.status === 404) fail('not_published', 'No stable release with this file is published yet.');
      if (response.status !== 200) fail('http_error', `Update server returned HTTP ${response.status}; try again later.`);
      return { body: limited(response.body, limit, onLength), chain };
    }
    fail('redirect_refused', 'Too many update redirects');
  }

  releaseTagFrom(chain, file) {
    const prefix = `/${UPDATE_SOURCE.owner}/${UPDATE_SOURCE.repo}/releases/download/`.toLowerCase();
    for (const value of chain) {
      const url = new URL(value);
      if (url.hostname !== 'github.com' || !url.pathname.toLowerCase().startsWith(prefix)) continue;
      const [tag, name, ...rest] = url.pathname.slice(prefix.length).split('/');
      if (!rest.length && decodeURIComponent(name) === file && /^v\d+\.\d+\.\d+$/.test(decodeURIComponent(tag))) return decodeURIComponent(tag);
    }
    return null;
  }

  check({ automatic = false } = {}) {
    if (this.inFlight) return this.inFlight;
    this.inFlight = this.runCheck(automatic).finally(() => { this.inFlight = null; });
    return this.inFlight;
  }

  async runCheck(automatic) {
    this.assertNetworkAllowed();
    const at = new Date(this.now()).toISOString();
    const record = (status, message, latestVersion = null) => {
      this.state.lastCheck = { at, status, message, latestVersion, automatic };
      this.save();
    };
    try {
      const { body, chain } = await this.fetch(`${UPDATE_SOURCE.releases}/latest/download/${this.installation.channelFile}`, { limit: MANIFEST_LIMIT });
      const chunks = [];
      for await (const chunk of body) chunks.push(chunk);
      const manifest = parseManifest(Buffer.concat(chunks).toString('utf8'));
      const releaseTag = this.releaseTagFrom(chain, this.installation.channelFile);
      const decision = evaluateRelease({ manifest, currentVersion: this.currentVersion, releaseTag, install: this.installation, failedVersions: this.state.failedVersions, automatic });
      if (decision.action !== 'stage') {
        const messages = { up_to_date: `Weft ${this.currentVersion} is the latest stable release.` };
        record(decision.action, decision.reason || messages[decision.action], decision.version);
        return { status: decision.action, latestVersion: decision.version, message: this.state.lastCheck.message, staged: this.status().staged };
      }
      const existing = this.state.staged;
      if (existing?.version === decision.version && existing.sha512 === decision.file.sha512 && await this.verifyFile(this.stagedPath(existing.file), existing)) {
        record('staged', `Weft ${decision.version} is already downloaded and verified.`, decision.version);
        return { status: 'staged', latestVersion: decision.version, message: this.state.lastCheck.message, staged: this.status().staged };
      }
      // Replace any older staged build only once a newer one is chosen; a failed download leaves nothing staged.
      this.discardStaged();
      this.save();
      this.state.staged = await this.download(decision.file, releaseTag);
      record('staged', `Weft ${decision.version} was downloaded and verified. It installs only when you choose Install.`, decision.version);
      return { status: 'staged', latestVersion: decision.version, message: this.state.lastCheck.message, staged: this.status().staged };
    } catch (error) {
      const code = error instanceof UpdateError ? error.updateCode : 'failed';
      record(code, error.message);
      throw error instanceof UpdateError ? error : new UpdateError('failed', `Update check failed: ${error.message}`);
    }
  }

  async download(file, releaseTag) {
    const directory = join(this.directory, 'staged');
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    const partial = join(directory, `${file.url}.partial`);
    rmSync(partial, { force: true });
    const hash = createHash('sha512');
    let size = 0;
    const handle = await open(partial, 'wx', 0o600);
    try {
      const { body } = await this.fetch(`${UPDATE_SOURCE.releases}/download/${releaseTag}/${encodeURIComponent(file.url)}`, { limit: file.size });
      for await (const chunk of body) { hash.update(chunk); size += chunk.length; await handle.write(chunk); }
      await handle.sync();
    } catch (error) {
      await handle.close().catch(() => {});
      rmSync(partial, { force: true });
      throw error;
    }
    await handle.close();
    const digest = hash.digest('base64');
    if (size !== file.size || digest !== file.sha512) {
      rmSync(partial, { force: true });
      fail('integrity_mismatch', `UPDATE_INTEGRITY: downloaded ${file.url} does not match the release manifest size and SHA-512; it was deleted.`);
    }
    const signature = await this.checkSignature(partial);
    if (!signature.allowed) { rmSync(partial, { force: true }); fail('signature_refused', `UPDATE_SIGNATURE: ${signature.reason}`); }
    renameSync(partial, this.stagedPath(file.url));
    const { allowed, ...summary } = signature;
    return { version: this.versionOf(file.url), file: file.url, size: file.size, sha512: file.sha512, releaseTag, verifiedAt: new Date(this.now()).toISOString(), signature: { status: summary.status, subject: summary.subject ?? null, reason: summary.reason ?? null } };
  }
  versionOf(file) { return this.installation.asset.exec(file)[1]; }

  async checkSignature(path) {
    if (this.installation.kind !== 'nsis') return { allowed: true, status: 'platform_verified_on_open', subject: null, reason: this.installation.kind === 'dmg' ? 'macOS Gatekeeper verifies the signature and notarization when the app is opened.' : 'Linux packages are verified by release manifest size and SHA-512 only.' };
    if (!this.verifySignature) return { allowed: true, status: 'not_verified', subject: null, reason: 'No signature verifier is available; only the release manifest size and SHA-512 were verified.' };
    const verify = async target => { try { return await this.verifySignature(target); } catch { return { status: 'unavailable' }; } };
    return signaturePolicy(await verify(this.launcher.execPath || process.execPath), await verify(path));
  }

  async verifyFile(path, expected) {
    try {
      if (statSync(path).size !== expected.size) return false;
      const hash = createHash('sha512');
      for await (const chunk of createReadStream(path)) hash.update(chunk);
      return hash.digest('base64') === expected.sha512;
    } catch { return false; }
  }

  discardStaged() {
    rmSync(join(this.directory, 'staged'), { recursive: true, force: true });
    this.state.staged = null;
  }

  async install({ version }) {
    if (this.disabled) fail('disabled', 'Updates are disabled by WEFT_DISABLE_UPDATES.');
    if (!this.installation.supported) fail('unsupported', this.installation.reason || 'Updates are not supported for this installation.');
    const staged = this.state.staged;
    if (!staged) fail('not_staged', 'No verified update is staged. Check for updates first.');
    if (staged.version !== version) fail('stale_state', `The staged update is ${staged.version}, not ${version}. Review the Update Center again.`);
    if (compareVersions(version, this.currentVersion) <= 0) { this.discardStaged(); this.save(); fail('downgrade_refused', `Weft ${version} is not newer than ${this.currentVersion}; downgrades are refused.`); }
    const path = this.stagedPath(staged.file);
    if (!await this.verifyFile(path, staged)) {
      this.discardStaged(); this.save();
      fail('integrity_mismatch', 'UPDATE_INTEGRITY: the staged file changed on disk after verification and was deleted. Check again.');
    }
    if (this.installation.kind === 'nsis') {
      const signature = await this.checkSignature(path);
      if (!signature.allowed) { this.discardStaged(); this.save(); fail('signature_refused', `UPDATE_SIGNATURE: ${signature.reason}`); }
    }
    const pending = { version, fromVersion: this.currentVersion, method: this.installation.method, startedAt: new Date(this.now()).toISOString(), launches: 0, rolledBack: false, rollback: null };
    if (this.installation.kind === 'appimage') return this.replaceAppImage(path, staged, pending);
    if (this.installation.kind === 'nsis') {
      const previous = this.state.retained.find(item => item.version === this.currentVersion);
      pending.rollback = previous ? { kind: 'installer', version: previous.version, file: previous.file, size: previous.size, sha512: previous.sha512 } : null;
      this.state.pending = pending; this.save();
      // The branded installer runs visibly; --updated keeps workspace data and skips setup pages.
      try { await this.launcher.spawnDetached(path, ['--updated']); }
      catch (error) { this.state.pending = null; this.save(); fail('failed', `Could not start the verified installer (${error.code || error.message}); Weft was not changed.`); }
      this.launcher.quit?.();
      return { status: 'handed_off', version, restart: true, message: `The Weft ${version} installer is starting. Weft closes so it can finish; your workspaces are kept.` };
    }
    this.state.pending = pending; this.save();
    const error = await this.launcher.openPath(path);
    if (error) { this.state.pending = null; this.save(); fail('failed', `Could not open the verified installer: ${error}`); }
    return { status: 'handed_off_manual', version, restart: true, message: this.installation.kind === 'dmg'
      ? `The verified Weft ${version} disk image is open. Quit Weft, drag Weft to Applications to replace it, then reopen it.`
      : `The verified Weft ${version} package is open in your system installer. Finish there, then restart Weft.` };
  }

  async replaceAppImage(stagedFile, staged, pending) {
    const target = this.installation.appImagePath;
    const incoming = `${target}.weft-update`;
    const previous = `${target}.weft-previous`;
    try {
      copyFileSync(stagedFile, incoming);
      chmodSync(incoming, 0o755);
      flush(incoming);
      if (!await this.verifyFile(incoming, staged)) fail('integrity_mismatch', 'UPDATE_INTEGRITY: the copied AppImage failed verification.');
      const hash = createHash('sha512');
      for await (const chunk of createReadStream(target)) hash.update(chunk);
      const backup = { kind: 'appimage', version: this.currentVersion, file: previous, size: statSync(target).size, sha512: hash.digest('base64') };
      rmSync(previous, { force: true });
      renameSync(target, previous);
      try { renameSync(incoming, target); }
      catch (error) { renameSync(previous, target); throw error; }
      pending.rollback = backup;
    } catch (error) {
      rmSync(incoming, { force: true });
      if (error instanceof UpdateError) throw error;
      fail('failed', `Could not replace the AppImage (${error.code || error.message}). Check that its folder is writable; the current version is unchanged.`);
    }
    this.state.pending = pending;
    this.discardStaged();
    this.save();
    this.launcher.relaunch?.(target);
    return { status: 'restarting', version: pending.version, restart: true, message: `Weft ${pending.version} is installed and will restart now. The previous version is kept for rollback.` };
  }

  rollbackCandidate() { return this.state.pending?.rollback || this.state.previous || null; }

  /** Restores the retained previous version. Automatic only for AppImage after failed health checks. */
  async rollback({ automatic = false } = {}) {
    const candidate = this.rollbackCandidate();
    if (!candidate) fail('not_staged', `No previous version is retained on this platform. Download the previous release from ${UPDATE_SOURCE.releases} and verify it against SHA256SUMS.txt.`);
    if (automatic && candidate.kind !== 'appimage') fail('unsupported', 'Automatic rollback is only available for AppImage installs.');
    if (candidate.kind === 'appimage') {
      const target = this.installation.appImagePath;
      if (!target || !await this.verifyFile(candidate.file, candidate)) fail('integrity_mismatch', 'UPDATE_INTEGRITY: the retained previous AppImage is missing or changed; it was not restored.');
      const failed = `${target}.weft-failed`;
      rmSync(failed, { force: true });
      renameSync(target, failed);
      try { renameSync(candidate.file, target); } catch (error) { renameSync(failed, target); fail('failed', `Rollback failed (${error.code}); the current version is unchanged.`); }
      this.recordRollback(candidate, automatic);
      this.launcher.relaunch?.(target);
      return { status: 'restarting', version: candidate.version, automatic, message: `Restoring Weft ${candidate.version}. Weft will restart now.` };
    }
    const path = this.retainedPath(candidate.file);
    if (!await this.verifyFile(path, candidate)) fail('integrity_mismatch', 'UPDATE_INTEGRITY: the retained installer is missing or changed; it was not run.');
    const signature = await this.checkSignature(path);
    if (!signature.allowed) fail('signature_refused', `UPDATE_SIGNATURE: ${signature.reason}`);
    try { await this.launcher.spawnDetached(path, []); }
    catch (error) { fail('failed', `Could not start the retained installer (${error.code || error.message}); Weft was not changed.`); }
    this.recordRollback(candidate, automatic);
    this.launcher.quit?.();
    return { status: 'handed_off', version: candidate.version, automatic, message: `The verified Weft ${candidate.version} installer is starting. Your workspaces are kept.` };
  }

  recordRollback(candidate, automatic) {
    const at = new Date(this.now()).toISOString();
    if (this.state.pending && this.state.pending.version === this.currentVersion) this.state.pending.rolledBack = true;
    else this.state.pending = { version: candidate.version, fromVersion: this.currentVersion, method: 'rollback', startedAt: at, launches: 0, rolledBack: false, rollback: null };
    if (!this.state.failedVersions.includes(this.currentVersion) && this.state.health?.status === 'failed') this.state.failedVersions.push(this.currentVersion);
    this.state.history.push({ version: this.currentVersion, outcome: automatic ? 'rolled_back_automatically' : 'rolled_back', at, detail: `Restoring ${candidate.version}` });
    this.state.previous = null;
    this.trim();
    this.save();
  }

  /** Call once at startup, before services start. Counts launches of a new version until it proves healthy. */
  beginLaunch() {
    const pending = this.state.pending;
    const at = new Date(this.now()).toISOString();
    let phase = 'normal';
    if (this.state.staged && compareVersions(this.state.staged.version, this.currentVersion) <= 0) {
      if (this.installation.kind === 'nsis' && this.state.staged.version === this.currentVersion) this.retain(this.state.staged);
      this.discardStaged();
    }
    if (pending?.version === this.currentVersion && !pending.rolledBack) {
      pending.launches += 1;
      if (pending.launches > MAX_UNHEALTHY_LAUNCHES) {
        this.state.health = { version: this.currentVersion, status: 'failed', at, reason: `Did not pass its health check in ${MAX_UNHEALTHY_LAUNCHES} launches.` };
        if (!this.state.failedVersions.includes(this.currentVersion)) this.state.failedVersions.push(this.currentVersion);
        phase = 'failed';
      } else {
        this.state.health = { version: this.currentVersion, status: 'probation', at, reason: null };
        phase = 'probation';
      }
    } else if (pending && pending.fromVersion === this.currentVersion) {
      phase = pending.rolledBack ? 'rolled_back' : 'not_applied';
      this.state.history.push({ version: pending.version, outcome: phase, at, detail: pending.rolledBack ? `Running ${this.currentVersion} after rollback` : 'The update was not installed; the previous version is still running.' });
      this.state.pending = null;
    } else if (pending) {
      this.state.history.push({ version: pending.version, outcome: 'superseded', at, detail: `Running ${this.currentVersion}` });
      this.state.pending = null;
    }
    this.trim();
    this.save();
    const rollback = this.rollbackCandidate();
    if (phase === 'rolled_back' && this.installation.appImagePath) rmSync(`${this.installation.appImagePath}.weft-failed`, { force: true });
    return { phase, automaticRollback: phase === 'failed' && rollback?.kind === 'appimage', rollbackAvailable: Boolean(rollback) };
  }

  /** Health check: the GUI loaded, the API listens and the workspace store opened. */
  confirmHealthy(checks) {
    const pending = this.state.pending;
    if (!pending || pending.version !== this.currentVersion || pending.rolledBack) return { status: 'not_pending' };
    const failedChecks = Object.entries(checks).filter(([, ok]) => !ok).map(([name]) => name);
    const at = new Date(this.now()).toISOString();
    if (failedChecks.length) return this.reportUnhealthy(`Failed checks: ${failedChecks.join(', ')}`);
    this.state.health = { version: this.currentVersion, status: 'healthy', at, reason: null };
    this.state.history.push({ version: this.currentVersion, outcome: 'healthy', at, detail: `Updated from ${pending.fromVersion}` });
    this.state.previous = pending.rollback;
    this.state.pending = null;
    this.state.failedVersions = this.state.failedVersions.filter(version => version !== this.currentVersion);
    this.trim();
    this.save();
    return { status: 'healthy' };
  }
  reportUnhealthy(reason) {
    const pending = this.state.pending;
    if (!pending || pending.version !== this.currentVersion) return { status: 'not_pending' };
    const at = new Date(this.now()).toISOString();
    this.state.health = { version: this.currentVersion, status: 'failed', at, reason: String(reason).slice(0, 500) };
    if (!this.state.failedVersions.includes(this.currentVersion)) this.state.failedVersions.push(this.currentVersion);
    this.save();
    return { status: 'failed', rollbackAvailable: Boolean(this.rollbackCandidate()) };
  }

  retain(staged) {
    mkdirSync(join(this.directory, 'retained'), { recursive: true, mode: 0o700 });
    try { renameSync(this.stagedPath(staged.file), this.retainedPath(staged.file)); } catch { return; }
    this.state.retained = [...this.state.retained.filter(item => item.version !== staged.version), { version: staged.version, file: staged.file, size: staged.size, sha512: staged.sha512 }];
    while (this.state.retained.length > 2) rmSync(this.retainedPath(this.state.retained.shift().file), { force: true });
  }
  trim() {
    this.state.history = this.state.history.slice(-20);
    this.state.failedVersions = this.state.failedVersions.slice(-10);
  }

  configure({ automaticChecks }) {
    this.state.automaticChecks = automaticChecks;
    this.save();
    this.stopBackground();
    this.startBackground();
    return this.status();
  }

  /** Background checks only stage. They never run while disabled, unsupported or not opted in. */
  startBackground() {
    if (this.timer || !this.state.automaticChecks || this.disabled || !this.installation.supported || !this.transport) return false;
    const tick = () => {
      const last = this.state.lastCheck ? Date.parse(this.state.lastCheck.at) : 0;
      if (this.now() - last >= CHECK_INTERVAL_MS) this.check({ automatic: true }).catch(() => {});
    };
    this.timer = this.timers.setInterval(tick, 60 * 60 * 1000);
    this.timer.unref?.();
    this.startupTimer = this.timers.setTimeout(tick, 2 * 60 * 1000);
    this.startupTimer.unref?.();
    return true;
  }
  stopBackground() {
    if (this.timer) this.timers.clearInterval(this.timer);
    if (this.startupTimer) this.timers.clearTimeout(this.startupTimer);
    this.timer = this.startupTimer = null;
  }

  async execute(name, args, context = {}) {
    if (name === 'update.status') return this.status();
    if (context.actor !== 'human') fail('human_required', 'Checking, installing, configuring and rolling back updates require the trusted browser interface.');
    if (name === 'update.check') return this.check();
    if (name === 'update.install') return this.install(args);
    if (name === 'update.rollback') return this.rollback();
    if (name === 'update.configure') return this.configure(args);
    throw new Error(`Unknown update command: ${name}`);
  }
}

function flush(path) {
  const fd = openSync(path, 'r');
  try { fsyncSync(fd); } finally { closeSync(fd); }
}

const version = z.string().regex(stable);
const iso = z.string().max(40);
const rollbackSchema = z.strictObject({ kind: z.enum(['appimage', 'installer']), version, file: z.string().max(4096), size: z.number().int().nonnegative(), sha512 }).nullable();
const stateSchema = z.strictObject({
  version: z.literal(1),
  automaticChecks: z.boolean(),
  lastCheck: z.strictObject({ at: iso, status: z.string().max(40), message: z.string().max(1000), latestVersion: z.string().max(64).nullable(), automatic: z.boolean() }).nullable(),
  staged: z.strictObject({ version, file: fileName, size: z.number().int().positive(), sha512, releaseTag: z.string().regex(/^v\d+\.\d+\.\d+$/), verifiedAt: iso,
    signature: z.strictObject({ status: z.string().max(40), subject: z.string().max(1000).nullable(), reason: z.string().max(1000).nullable() }) }).nullable(),
  pending: z.strictObject({ version, fromVersion: version, method: z.string().max(40), startedAt: iso, launches: z.number().int().nonnegative(), rolledBack: z.boolean(), rollback: rollbackSchema }).nullable(),
  health: z.strictObject({ version, status: z.enum(['probation', 'healthy', 'failed']), at: iso, reason: z.string().max(1000).nullable() }).nullable(),
  previous: rollbackSchema,
  retained: z.array(z.strictObject({ version, file: fileName, size: z.number().int().positive(), sha512 })).max(2),
  failedVersions: z.array(version).max(10),
  history: z.array(z.strictObject({ version, outcome: z.string().max(40), at: iso, detail: z.string().max(500) })).max(20),
});
export function defaultState() {
  return { version: 1, automaticChecks: false, lastCheck: null, staged: null, pending: null, health: null, previous: null, retained: [], failedVersions: [], history: [] };
}

/** Electron net transport: one hop per call (redirects are validated by UpdateService), no cookies. */
export function createElectronTransport(net, { partition = 'weft-updater', headerTimeoutMs = 30000, idleTimeoutMs = 60000 } = {}) {
  return ({ url, headers }) => new Promise((resolve, reject) => {
    const request = net.request({ url, method: 'GET', redirect: 'manual', partition, useSessionCookies: false, credentials: 'omit', cache: 'no-store' });
    for (const [key, value] of Object.entries(headers)) request.setHeader(key, value);
    const timer = setTimeout(() => { request.abort(); reject(Object.assign(new Error('timed out'), { code: 'ETIMEDOUT' })); }, headerTimeoutMs);
    request.on('redirect', (status, _method, location) => { clearTimeout(timer); request.abort(); resolve({ status, location, body: null }); });
    request.on('response', response => {
      clearTimeout(timer);
      resolve({ status: response.statusCode, location: null, body: (async function* () {
        let idle;
        const reset = () => { clearTimeout(idle); idle = setTimeout(() => response.destroy(Object.assign(new Error('download stalled'), { code: 'ETIMEDOUT' })), idleTimeoutMs); };
        reset();
        try { for await (const chunk of response) { reset(); yield chunk; } } finally { clearTimeout(idle); }
      })() });
    });
    request.on('error', error => { clearTimeout(timer); reject(error); });
    request.end();
  });
}

/** Authenticode status via PowerShell; the path is passed in the environment, never interpolated. */
export function createWindowsSignatureVerifier(execFile) {
  const script = '$s = Get-AuthenticodeSignature -LiteralPath $env:WEFT_VERIFY_PATH; [pscustomobject]@{ status = [string]$s.Status; subject = $(if ($s.SignerCertificate) { $s.SignerCertificate.Subject } else { $null }) } | ConvertTo-Json -Compress';
  return path => new Promise(resolve => {
    execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { env: { ...process.env, WEFT_VERIFY_PATH: path }, timeout: 30000, windowsHide: true }, (error, stdout) => {
      if (error) return resolve({ status: 'unavailable', subject: null });
      try {
        const result = JSON.parse(stdout);
        resolve({ status: result.status === 'Valid' ? 'valid' : result.status === 'NotSigned' ? 'unsigned' : 'invalid', subject: typeof result.subject === 'string' ? result.subject : null });
      } catch { resolve({ status: 'unavailable', subject: null }); }
    });
  });
}

export const updateCommandDefinitions = {
  'update.status': ['Read installed version, stable channel, last check, staged update, verification, health and kill-switch state without network access', {}],
  'update.check': ['Human checks the fixed stable release channel now; a newer verified build is downloaded and staged but never installed', {}],
  'update.install': ['Human installs the verified staged update now; Weft hands off to the platform installer and restarts', { version: z.string().regex(stable).max(20).describe('Staged version shown to the human; must match exactly.') }],
  'update.rollback': ['Human restores the retained previous verified version where the platform allows', {}],
  'update.configure': ['Human turns disclosed background checks on or off (at most daily; they only download and stage)', { automaticChecks: z.boolean().describe('Whether Weft may check github.com once a day.') }],
};
