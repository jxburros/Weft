import { spawn } from 'node:child_process';
import { randomBytes, randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import { fileStamp, writeVerifiedJson } from './storage-safety.js';
import brokerModule from './credential-broker-child.cjs';

/**
 * Credential references and protected login operations (ADR-017).
 *
 * The main process never stores or lists secret values. A separate broker
 * process (src/credential-broker-child.cjs) owns the vault; this module starts
 * it with a minimal environment and Node's permission model, unwraps its data
 * key with OS-protected storage, maps commands to broker requests and, for
 * `credentials.fill`, hands the browser a `release` callback that asks the
 * broker for the secret only for browser-verified exact origins.
 */
const CHILD = fileURLToPath(new URL('./credential-broker-child.cjs', import.meta.url));
// The same origin rules as the broker (imported, not re-implemented); the broker re-checks everything it stores.
const { normalizeOrigin } = brokerModule;

/** Fixed vocabulary for refusals; the only credential detail that reaches agents. */
export const CREDENTIAL_REASONS = Object.freeze(['not_found', 'revoked', 'expired', 'integrity_failed', 'workspace_mismatch', 'origin_mismatch', 'frame_origin_mismatch',
  'provider_unavailable', 'provider_failed', 'provider_disabled', 'invalid_entry', 'locked', 'vault_full', 'unsupported', 'grant_exhausted', 'approval_required',
  'unprotected_storage', 'entry_cancelled', 'broker_unavailable', 'protected_operation', 'credential_residue', 'credential_revealed', 'tab_blocked',
  'navigation_in_progress', 'debugger_attached', 'frame_origin_not_authorized', 'no_login_form', 'ambiguous_login_form', 'not_login_field', 'navigated',
  'interrupted', 'fill_failed']);
const REASON_CODES = { not_found: 'not_found', revoked: 'permission_required', expired: 'permission_required', integrity_failed: 'unavailable', workspace_mismatch: 'target_mismatch',
  origin_mismatch: 'target_mismatch', frame_origin_mismatch: 'target_mismatch', provider_unavailable: 'unavailable', provider_failed: 'unavailable', provider_disabled: 'unavailable',
  invalid_entry: 'invalid_arguments', locked: 'unavailable', vault_full: 'command_failed', unsupported: 'command_failed', grant_exhausted: 'permission_required',
  approval_required: 'permission_required', unprotected_storage: 'unavailable', entry_cancelled: 'cancelled', broker_unavailable: 'unavailable' };
const REASON_MESSAGES = {
  not_found: 'Credential reference not found in this workspace', revoked: 'This credential reference was revoked', expired: 'This credential reference has expired',
  integrity_failed: 'The stored credential failed its integrity check (the vault file was changed outside Weft); it cannot be used',
  workspace_mismatch: 'The credential belongs to a different workspace', origin_mismatch: 'The page origin is not authorized for this credential',
  frame_origin_mismatch: 'The login frame origin is not authorized for this credential', provider_unavailable: 'The external vault CLI is not available',
  provider_failed: 'The external vault CLI did not return the secret', provider_disabled: 'The external vault provider is not enabled',
  invalid_entry: 'Invalid credential details', locked: 'The credential vault is locked or not created yet', vault_full: 'The credential vault is full',
  unsupported: 'Unsupported credential operation', grant_exhausted: 'The task credential grant is used up, expired or revoked',
  approval_required: 'Credential use needs an exact one-time human approval or a task grant',
  unprotected_storage: 'OS-protected storage is unavailable (or Linux is using the basic_text backend); Weft does not create or open a credential vault without it',
  entry_cancelled: 'The person cancelled credential entry; nothing was saved', broker_unavailable: 'The credential broker process is not available',
};
export function credentialError(reason, code = REASON_CODES[reason] ?? 'command_failed') {
  return Object.assign(new Error(REASON_MESSAGES[reason] ?? 'Credential operation failed'), { code, notStarted: true, details: { credential: CREDENTIAL_REASONS.includes(reason) ? reason : 'unsupported' } });
}

const id = z.string().regex(/^cred_[0-9a-f-]{36}$/).describe('Credential reference id from credentials.list.');
const origin = z.string().min(8).max(300).describe('Exact origin (scheme, host, optional port), for example https://accounts.example.com. HTTP only for loopback hosts.');
const isoDate = z.string().max(40).refine(value => Number.isFinite(Date.parse(value)), 'Expected an ISO date-time');
const workspaceId = z.string().min(1).max(200).optional();
export const credentialCommandDefinitions = {
  'credentials.status': ['Describe the credential vault: OS key protection, isolated broker process, external vault providers and limits (never secrets)', {}],
  'credentials.list': ['List credential references in a workspace: opaque ids, labels, purposes, exact authorized origins, masked account identifiers, expiry and status (never secret values)', {
    workspaceId, includeInactive: z.boolean().optional().describe('Include revoked, expired and integrity-failed references.') }],
  'credentials.get': ['Read one credential reference (metadata only, never the secret)', { id, workspaceId }],
  'credentials.fill': ['Fill the login form on an exactly authorized origin from a credential reference inside an exclusive protected operation (needs an exact one-time human approval or a task grant); returns sanitized status only', {
    id, tabId: z.number().int().positive(), workspaceId, expectedVersion: z.number().int().positive().optional(),
    ref: z.string().regex(/^f\d{1,6}e\d{1,9}$/).optional().describe('Password field (or its form) from your latest page.snapshot; omit to use the single login form on the page.'),
    snapshotId: z.string().max(64).optional().describe('Snapshot that supplied the ref; must be your latest.'),
    submit: z.boolean().optional().describe('Submit the login form after filling (default false).') }],
  'credentials.create': ['Human creates a credential reference; the secret is typed only into a browser-owned dialog, never passed as a command argument', {
    workspaceId, label: z.string().min(1).max(120), purpose: z.string().min(1).max(300), origins: z.array(origin).min(1).max(10),
    frameOrigins: z.array(origin).max(10).optional().describe('Extra origins of embedded login frames allowed to receive the credential; the top-level page must still match origins.'),
    expiresAt: isoDate.optional().describe('When the reference stops working (ISO date-time).'), provider: z.enum(['local', 'onepassword']).default('local'),
    reference: z.strictObject({ password: z.string().max(500).describe('1Password secret reference, op://vault/item/field.'), username: z.string().max(500).optional().describe('Optional op:// reference for the username.') }).optional(),
    accountLabel: z.string().min(1).max(120).optional().describe('Safe account identifier shown to agents instead of a masked username.') }],
  'credentials.update': ['Human changes a credential reference label, purpose, authorized origins, frames or expiry (the entry is re-sealed)', {
    id, label: z.string().min(1).max(120).optional(), purpose: z.string().min(1).max(300).optional(), origins: z.array(origin).min(1).max(10).optional(),
    frameOrigins: z.array(origin).max(10).optional(), expiresAt: isoDate.nullable().optional() }],
  'credentials.revoke': ['Human revokes a credential reference permanently; its stored secret is discarded and task grants end', { id }],
  'credentials.delete': ['Human deletes a credential reference and its encrypted record', { id }],
  'credentials.grantTask': ['Human lets one open task fill one credential a limited number of times without a per-use approval', {
    id, taskId: z.string().min(1).max(128), uses: z.number().int().min(1).max(20).default(1), minutes: z.number().int().min(5).max(1440).default(60) }],
  'credentials.revokeGrant': ['Human revokes a task credential grant', { grantId: z.string().regex(/^cgrant_[0-9a-f-]{36}$/) }],
  'credentials.configureProvider': ['Human enables or disables the external 1Password CLI (op) vault adapter (implemented against a test double; not validated with a real account)', {
    provider: z.enum(['onepassword']), enabled: z.boolean(), command: z.string().min(1).max(1024).optional().describe('Path to the op executable (default: op on PATH).') }],
};
export const CREDENTIAL_ADMIN_COMMANDS = Object.freeze(['credentials.create', 'credentials.update', 'credentials.revoke', 'credentials.delete', 'credentials.grantTask', 'credentials.revokeGrant', 'credentials.configureProvider']);

/** OS key protection through Electron safeStorage. Linux basic_text is a plaintext obfuscation and never counts as protected. */
export function safeStorageProtector(safeStorage) {
  return {
    status() {
      const available = Boolean(safeStorage?.isEncryptionAvailable?.());
      const backend = safeStorage?.getSelectedStorageBackend?.() ?? (process.platform === 'darwin' ? 'keychain' : process.platform === 'win32' ? 'dpapi' : 'unknown');
      return { available, backend, protected: available && backend !== 'basic_text' };
    },
    wrap: text => safeStorage.encryptString(text),
    unwrap: bytes => safeStorage.decryptString(bytes),
  };
}

const PASSTHROUGH_ENV = ['PATH', 'HOME', 'USERPROFILE', 'APPDATA', 'LOCALAPPDATA', 'XDG_CONFIG_HOME', 'XDG_RUNTIME_DIR', 'SystemRoot', 'TMPDIR', 'TEMP', 'TMP'];

/** One broker OS process; JSON lines over stdin/stdout; stderr is discarded. */
class BrokerProcess {
  constructor({ execPath, directory, allowChildProcess, env, timeoutMs }) {
    Object.assign(this, { execPath, directory, allowChildProcess, env, timeoutMs });
    this.pending = new Map();
    this.nextId = 1;
    this.child = null;
  }
  start() {
    const args = ['--permission', `--allow-fs-read=${this.directory}`, `--allow-fs-write=${this.directory}`, ...(this.allowChildProcess ? ['--allow-child-process'] : []),
      '--max-old-space-size=64', '--disallow-code-generation-from-strings', CHILD];
    const child = spawn(this.execPath, args, { cwd: tmpdir(), env: this.env, stdio: ['pipe', 'pipe', 'ignore'], windowsHide: true });
    this.child = child;
    let buffered = '';
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', chunk => {
      buffered += chunk;
      if (buffered.length > 1024 * 1024) { this.kill(); return; }
      let index;
      while ((index = buffered.indexOf('\n')) >= 0) {
        const line = buffered.slice(0, index);
        buffered = buffered.slice(index + 1);
        let message;
        try { message = JSON.parse(line); } catch { this.kill(); return; }
        const call = this.pending.get(message.seq);
        if (!call) continue;
        this.pending.delete(message.seq);
        clearTimeout(call.timer);
        if (message.ok) call.resolve(message.result);
        else call.reject(credentialError(CREDENTIAL_REASONS.includes(message.reason) ? message.reason : 'unsupported'));
      }
    });
    child.stdin.on('error', () => {});
    child.once('error', () => this.reset());
    child.once('exit', () => { if (this.child === child) this.reset(); });
  }
  get running() { return Boolean(this.child && this.child.exitCode === null); }
  send(type, payload = {}) {
    return new Promise((resolve, reject) => {
      if (!this.running) { reject(credentialError('broker_unavailable')); return; }
      const messageId = this.nextId++;
      const timer = setTimeout(() => { this.pending.delete(messageId); reject(credentialError('broker_unavailable')); this.kill(); }, this.timeoutMs);
      this.pending.set(messageId, { resolve, reject, timer });
      this.child.stdin.write(`${JSON.stringify({ ...payload, type, seq: messageId })}\n`);
    });
  }
  reset() {
    for (const call of this.pending.values()) { clearTimeout(call.timer); call.reject(credentialError('broker_unavailable')); }
    this.pending.clear();
    this.child = null;
  }
  kill() {
    const child = this.child;
    this.reset();
    if (child && child.exitCode === null) child.kill('SIGKILL');
  }
}

export class CredentialService {
  constructor({ directory, protector = null, browser = null, workspace = null, promptSecret = null, clock = Date.now, execPath = process.execPath, env = process.env, timeoutMs = 60000 } = {}) {
    if (!directory) throw new Error('CredentialService needs a profile directory');
    Object.assign(this, { directory, protector, browser, workspace, promptSecret, clock, execPath, env, timeoutMs });
    // Main-process files (wrapped key, provider settings, task grants) sit beside the broker's own directory, which is all the broker may touch.
    this.vaultDirectory = join(directory, 'vault');
    mkdirSync(this.vaultDirectory, { recursive: true, mode: 0o700 });
    this.keyFile = join(directory, 'key.wrapped');
    this.providersPath = join(directory, 'providers.json');
    this.grantsPath = join(directory, 'grants.json');
    this.providers = this.readJson(this.providersPath, { version: 1, onepassword: { enabled: false, command: 'op' } });
    const grants = this.readJson(this.grantsPath, { version: 1, grants: [] });
    this.grants = Array.isArray(grants.grants) ? grants.grants : [];
    this.grantsStamp = fileStamp(this.grantsPath);
    this.cache = [];
    this.process = null;
    this.starting = null;
  }
  readJson(path, fallback) {
    try { const value = JSON.parse(readFileSync(path, 'utf8')); return value && value.version === 1 ? value : fallback; }
    catch (error) { if (error.code === 'ENOENT') return fallback; throw error; }
  }
  saveGrants() { this.grantsStamp = writeVerifiedJson(this.grantsPath, JSON.stringify({ version: 1, grants: this.grants }), this.grantsStamp); }

  protection() {
    const status = this.protector?.status?.() ?? { available: false, backend: 'none' };
    return { available: Boolean(status.available), backend: String(status.backend ?? 'unknown'), protected: Boolean(status.available && status.protected !== false && status.backend !== 'basic_text') };
  }
  /** The data key, unwrapped with OS-protected storage; created only on first use and only when protection is real. */
  dataKey(create) {
    const exists = existsSync(this.keyFile);
    if (!exists && !create) return null;
    if (!this.protection().protected) throw credentialError('unprotected_storage');
    if (!exists) {
      const key = randomBytes(32);
      writeFileSync(this.keyFile, this.protector.wrap(key.toString('base64')), { flag: 'wx', mode: 0o600 });
      return key;
    }
    try { return Buffer.from(this.protector.unwrap(readFileSync(this.keyFile)), 'base64'); }
    catch { throw credentialError('locked'); }
  }
  brokerEnv() {
    const env = process.versions.electron ? { ELECTRON_RUN_AS_NODE: '1' } : {};
    if (!this.providers.onepassword?.enabled) return env;
    // The 1Password CLI needs its configuration directory, PATH and any OP_* session variables; nothing else is passed.
    for (const key of PASSTHROUGH_ENV) if (this.env[key]) env[key] = this.env[key];
    for (const [key, value] of Object.entries(this.env)) if (/^OP_[A-Z0-9_]{1,60}$/.test(key) && typeof value === 'string') env[key] = value;
    return env;
  }
  async broker(create = false) {
    if (this.process?.running) return this.process;
    if (this.starting) return this.starting;
    this.starting = (async () => {
      const key = this.dataKey(create);
      if (!key) return null;
      const onepassword = this.providers.onepassword?.enabled ? { command: this.providers.onepassword.command || 'op' } : null;
      const broker = new BrokerProcess({ execPath: this.execPath, directory: this.vaultDirectory, allowChildProcess: Boolean(onepassword), env: this.brokerEnv(), timeoutMs: this.timeoutMs });
      broker.start();
      try { await broker.send('init', { key: key.toString('base64'), directory: this.vaultDirectory, providers: onepassword ? { onepassword } : {} }); }
      catch (error) { broker.kill(); throw error; } finally { key.fill(0); }
      this.process = broker;
      return broker;
    })();
    try { return await this.starting; } finally { this.starting = null; }
  }
  async call(type, payload, { create = false } = {}) {
    const broker = await this.broker(create);
    if (!broker) throw credentialError('locked');
    return broker.send(type, payload);
  }
  async refresh() {
    const broker = await this.broker(false);
    this.cache = broker ? await broker.send('list') : [];
    return this.cache;
  }
  close() { this.process?.kill(); this.process = null; }

  expireGrants() {
    const now = this.clock();
    let changed = false;
    for (const grant of this.grants) if (grant.status === 'active' && (Date.parse(grant.expiresAt) <= now || grant.usesLeft <= 0 || !this.taskOpen(grant.taskId))) { grant.status = 'ended'; changed = true; }
    if (changed) this.saveGrants();
  }
  taskOpen(taskId) {
    const task = this.workspace?.snapshot?.().tasks?.find(item => item.id === taskId);
    return Boolean(task) && !['completed', 'failed', 'cancelled'].includes(task.status);
  }
  /** Authority hook: a human task grant is evidence for one credentials.fill by that task without a per-use approval. Never consumed here. */
  taskGrant(command, args, context, target) {
    if (command !== 'credentials.fill' || !context.taskId) return null;
    this.expireGrants();
    const grant = this.grants.find(item => item.status === 'active' && item.credentialId === args.id && item.taskId === context.taskId && item.workspaceId === target.workspaceId && item.usesLeft > 0);
    return grant ? { grantId: grant.id } : null;
  }
  /** Authority hook: what the person sees when approving a fill (label, masked account, exact origins). */
  approvalPreview(command, args) {
    if (command !== 'credentials.fill') return null;
    const entry = this.cache.find(item => item.id === args.id);
    return entry ? { 'Credential': `${entry.label} (${entry.account ?? 'no account identifier'})`, 'Authorized origins': entry.origins.join(', '), 'Purpose': entry.purpose, 'Submit after fill': args.submit === true }
      : { 'Credential': 'Unknown reference (the fill will be refused)' };
  }
  describe(entry, human = false) {
    const grants = this.grants.filter(grant => grant.credentialId === entry.id && grant.status === 'active');
    return { id: entry.id, workspaceId: entry.workspaceId, label: entry.label, purpose: entry.purpose, origins: [...entry.origins], frameOrigins: [...entry.frameOrigins],
      provider: entry.provider, account: entry.account, status: entry.state, integrity: entry.integrity, createdAt: entry.createdAt, updatedAt: entry.updatedAt,
      expiresAt: entry.expiresAt, revokedAt: entry.revokedAt, revision: entry.revision,
      taskGrants: human ? grants.map(grant => ({ id: grant.id, taskId: grant.taskId, usesLeft: grant.usesLeft, expiresAt: grant.expiresAt })) : grants.length };
  }
  async find(entryId, workspaceId) {
    await this.refresh();
    const entry = this.cache.find(item => item.id === entryId);
    if (!entry || (workspaceId && entry.workspaceId !== workspaceId)) throw credentialError('not_found');
    return entry;
  }
  status(human) {
    const protection = this.protection();
    const created = existsSync(this.keyFile);
    return { vault: !protection.protected ? 'unprotected' : created ? 'ready' : 'empty', entries: this.cache.length, keyProtection: protection,
      broker: { isolation: 'separate OS process', running: Boolean(this.process?.running), environment: 'minimal (no inherited variables unless an external vault CLI is enabled)',
        filesystem: 'Node permission model: read/write only its vault directory', childProcesses: Boolean(this.providers.onepassword?.enabled) },
      providers: { local: { available: protection.protected, cipher: 'AES-256-GCM, metadata authenticated, key wrapped by OS-protected storage' },
        onepassword: { enabled: Boolean(this.providers.onepassword?.enabled), ...(human && { command: this.providers.onepassword?.command ?? 'op' }),
          validation: 'Implemented and tested against a fake op CLI only; not validated against a real 1Password account.' } },
      independentReview: 'not performed',
      limits: ['Agents receive opaque references, labels, exact origins and masked account identifiers only; secret values are released to the browser process for one fill.',
        'After a fill the value is in the page DOM: scripts of the authorized origin can read it; automation observation keeps redacting it and page.evaluate is refused on that document.',
        'Not a defense against malware running as the same OS user, a compromised Weft main process, or operating-system memory dumps.'] };
  }

  async execute(name, args, context = {}) {
    const human = ['human', 'admin'].includes(context.actor);
    if (CREDENTIAL_ADMIN_COMMANDS.includes(name) && (!human || context.source !== 'gui')) {
      throw Object.assign(new Error('Credential administration requires the trusted browser interface'), { code: 'human_required', notStarted: true,
        details: { authority: { decision: 'deny', reason: 'human_only', actionClass: 'administration' } } });
    }
    switch (name) {
      case 'credentials.status': await this.refresh().catch(() => {}); return this.status(human);
      case 'credentials.list': {
        await this.refresh();
        return this.cache.filter(entry => (!args.workspaceId || entry.workspaceId === args.workspaceId) && (args.includeInactive || entry.state === 'active')).map(entry => this.describe(entry, human));
      }
      case 'credentials.get': return this.describe(await this.find(args.id, args.workspaceId), human);
      case 'credentials.fill': return this.fill(args, context);
      case 'credentials.create': return this.create(args);
      case 'credentials.update': {
        const changes = Object.fromEntries(['label', 'purpose', 'origins', 'frameOrigins', 'expiresAt'].filter(key => args[key] !== undefined).map(key => [key, args[key]]));
        this.validateOrigins(changes);
        await this.find(args.id);
        const entry = await this.call('update', { id: args.id, changes });
        await this.refresh();
        return this.describe(entry, true);
      }
      case 'credentials.revoke':
      case 'credentials.delete': {
        await this.find(args.id);
        const result = await this.call(name === 'credentials.revoke' ? 'revoke' : 'delete', { id: args.id });
        this.endGrants(grant => grant.credentialId === args.id);
        await this.refresh();
        return name === 'credentials.revoke' ? this.describe(result, true) : result;
      }
      case 'credentials.grantTask': {
        const entry = await this.find(args.id);
        if (entry.state !== 'active') throw credentialError(entry.state === 'integrity_failed' ? 'integrity_failed' : entry.state);
        const task = this.workspace?.snapshot?.().tasks?.find(item => item.id === args.taskId);
        if (!task || task.workspaceId !== entry.workspaceId) throw Object.assign(new Error('Task not found in the credential workspace'), { code: 'not_found' });
        if (!this.taskOpen(task.id)) throw Object.assign(new Error('Only an open task can receive a credential grant'), { code: 'stale_state' });
        const now = this.clock();
        const expiresAt = Math.min(now + args.minutes * 60000, entry.expiresAt ? Date.parse(entry.expiresAt) : Infinity);
        const grant = { id: `cgrant_${randomUUID()}`, credentialId: entry.id, taskId: task.id, workspaceId: entry.workspaceId, usesLeft: args.uses, uses: 0,
          status: 'active', createdAt: new Date(now).toISOString(), expiresAt: new Date(expiresAt).toISOString() };
        this.grants.push(grant);
        this.grants = this.grants.slice(-500);
        this.saveGrants();
        return { ...grant };
      }
      case 'credentials.revokeGrant': {
        const grant = this.grants.find(item => item.id === args.grantId);
        if (!grant) throw Object.assign(new Error('Grant not found'), { code: 'not_found' });
        this.endGrants(item => item.id === grant.id, 'revoked');
        return { ...grant };
      }
      case 'credentials.configureProvider': {
        if (args.command !== undefined && !/^[^\0\n\r]+$/.test(args.command)) throw Object.assign(new Error('Invalid executable path'), { code: 'invalid_arguments' });
        this.providers = { version: 1, onepassword: { enabled: args.enabled, command: args.command ?? this.providers.onepassword?.command ?? 'op' } };
        writeFileSync(this.providersPath, JSON.stringify(this.providers), { mode: 0o600 });
        // The broker restarts with (or without) child-process permission and the CLI's environment.
        this.close();
        return this.status(true).providers.onepassword;
      }
      default: throw Object.assign(new Error(`Unknown command: ${name}`), { code: 'unknown_command' });
    }
  }
  endGrants(match, status = 'ended') {
    let changed = false;
    for (const grant of this.grants) if (grant.status === 'active' && match(grant)) { grant.status = status; changed = true; }
    if (changed) this.saveGrants();
  }
  validateOrigins(input) {
    for (const key of ['origins', 'frameOrigins']) {
      if (!input[key]) continue;
      try { input[key] = [...new Set(input[key].map(normalizeOrigin))]; }
      catch { throw Object.assign(credentialError('invalid_entry'), { message: `${key} must be exact origins (https://host[:port]; http only for localhost), without paths, wildcards or credentials`, field: key }); }
    }
  }
  async create(args) {
    const input = { workspaceId: args.workspaceId, label: args.label, purpose: args.purpose, origins: args.origins, frameOrigins: args.frameOrigins ?? [],
      expiresAt: args.expiresAt ?? null, provider: args.provider, reference: args.reference ?? null, accountLabel: args.accountLabel ?? null };
    this.validateOrigins(input);
    if (input.expiresAt && !(Date.parse(input.expiresAt) > this.clock())) throw Object.assign(credentialError('invalid_entry'), { message: 'expiresAt must be in the future' });
    if (input.provider === 'onepassword' && !input.reference) throw Object.assign(credentialError('invalid_entry'), { message: 'A 1Password reference (op://vault/item/field) is required' });
    if (input.provider === 'onepassword' && !this.providers.onepassword?.enabled) throw credentialError('provider_disabled');
    if (!this.protection().protected) throw credentialError('unprotected_storage');
    let secret = null;
    if (input.provider === 'local') {
      if (typeof this.promptSecret !== 'function') throw credentialError('unsupported');
      // The value is typed into a browser-owned dialog and goes from there to the broker; it is never a command argument.
      secret = await this.promptSecret({ label: input.label, origins: input.origins, workspaceId: input.workspaceId });
      if (!secret || typeof secret.password !== 'string' || !secret.password) throw credentialError('entry_cancelled');
    }
    try {
      const entry = await this.call('create', { input, secret }, { create: true });
      await this.refresh();
      return this.describe(entry, true);
    } finally { if (secret) { secret.password = ''; secret.username = ''; } }
  }
  async fill(args, context) {
    const human = ['human', 'admin'].includes(context.actor);
    const entry = await this.find(args.id, args.workspaceId);
    if (entry.state !== 'active') throw credentialError(entry.state);
    let grant = null;
    if (!human) {
      const decision = context.authorityDecision;
      if (decision?.reason === 'task_credential_grant') {
        grant = this.grants.find(item => item.id === decision.grantId && item.status === 'active');
        if (!grant) throw credentialError('grant_exhausted');
      } else if (!decision?.approvedOnce) throw credentialError('approval_required');
    }
    if (!this.browser) throw credentialError('broker_unavailable');
    const result = await this.browser.credentialFill(args, context, {
      credential: { origins: entry.origins, frameOrigins: entry.frameOrigins },
      release: async (topOrigin, frameOrigin) => {
        if (grant) {
          // A task grant use is spent when the secret is released, not when the command is admitted.
          this.expireGrants();
          if (grant.status !== 'active' || grant.usesLeft <= 0) throw credentialError('grant_exhausted');
          grant.usesLeft--; grant.uses++;
          if (grant.usesLeft === 0) grant.status = 'used';
          this.saveGrants();
        }
        return this.call('release', { id: entry.id, request: { workspaceId: entry.workspaceId, topOrigin, frameOrigin } });
      },
    });
    return { ...result, id: entry.id, label: entry.label, account: entry.account, ...(grant && { taskGrant: { id: grant.id, usesLeft: grant.usesLeft } }) };
  }
}
