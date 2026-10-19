import { createHmac, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { chmodSync, readFileSync, mkdirSync, renameSync, writeFileSync } from 'node:fs';
import { readJson, writeJsonDurable } from './atomic-json.js';
import { fileStamp, writeVerifiedJson } from './storage-safety.js';
import { dirname, join } from 'node:path';
import { z } from 'zod';
import { AUTONOMY_LEVELS, DATA_CLASSES, DEFAULT_DATA_ACCESS, GRANTABLE_CLASSES, actionClassForCommand, dataClassesForCommand, matchDestination, resourceForCommand, validDestinationPattern } from './autonomy.js';

const scopes = ['read', 'records.write', 'tabs.control'];
const id = z.string().uuid();
const destination = z.string().trim().min(1).max(260).refine(validDestinationPattern, 'Use *, an origin such as https://example.com, or a wildcard host such as https://*.example.com');
/** Fields a human may set at creation and change later; the token itself (identity and expiry) never changes. */
const grantFields = {
  purpose: z.string().trim().max(500).default(''),
  scopes: z.array(z.enum(scopes)).min(1).max(3),
  workspaceIds: z.array(z.string().min(1).max(128)).min(1).max(100),
  crossWorkspace: z.boolean().default(false),
  actionClasses: z.array(z.enum(GRANTABLE_CLASSES)).max(GRANTABLE_CLASSES.length).default([]),
  dataAccess: z.array(z.enum(DATA_CLASSES)).max(DATA_CLASSES.length).default([...DEFAULT_DATA_ACCESS]),
  destinations: z.array(destination).min(1).max(100).default(['*']),
  autonomy: z.enum(AUTONOMY_LEVELS).default('scoped'),
  maxCommands: z.number().int().min(1).max(1000000).nullable().default(null),
  maxPerMinute: z.number().int().min(1).max(10000).nullable().default(null),
  // Resource budgets (#30): total model spend measured from provider-reported usage and configured prices, and total command run time.
  maxCost: z.strictObject({ amount: z.number().min(0).max(1000000).describe('Spend limit in the currency of the configured model prices.'), currency: z.string().regex(/^[A-Z]{3}$/).describe('ISO currency code.') }).nullable().default(null)
    .describe('Model spend budget; model connections without a configured price are refused while it is set.'),
  maxRuntimeSeconds: z.number().int().min(1).max(31536000).nullable().default(null).describe('Total command run time this grant may use.'),
  taskId: z.string().min(1).max(128).nullable().default(null),
};
const optionalFields = Object.fromEntries(Object.entries(grantFields).map(([key, field]) => [key, field.removeDefault ? field.removeDefault().optional() : field.optional()]));
export const clientCommandDefinitions = {
  'clients.create': ['Human creates a scoped, expiring automation credential with purpose, scopes, destinations, data classes and limits; token is shown once', {
    name: z.string().trim().min(1).max(100), ...grantFields, ttlSeconds: z.number().int().min(60).max(2592000).default(3600),
  }],
  'clients.list': ['Human lists automation grants and usage without tokens', {}],
  'clients.update': ['Human narrows or changes an automation grant; takes effect on the next command', { clientId: id, changes: z.strictObject(optionalFields) }],
  'clients.revoke': ['Human revokes an automation grant immediately', { clientId: id }],
};
const schemas = Object.fromEntries(Object.entries(clientCommandDefinitions).map(([name, [, shape]]) => [name, z.strictObject(shape)]));
const grantSchema = z.strictObject({ clientId: id, name: z.string().max(100), ...Object.fromEntries(Object.entries(grantFields).map(([key, field]) => [key, field.removeDefault ? field.removeDefault() : field])),
  expiresAt: z.number().int(), revoked: z.boolean(), createdAt: z.number().int(), updatedAt: z.number().int().optional(), usage: z.strictObject({ count: z.number().int().min(0), lastUsedAt: z.number().int().nullable(),
    runtimeMs: z.number().min(0).optional(), cost: z.strictObject({ amount: z.number().min(0), currency: z.string().regex(/^[A-Z]{3}$/) }).nullable().optional(), unpricedTurns: z.number().int().min(0).optional() }) });
const exhausted = (message, details) => Object.assign(new Error(message), { code: 'budget_exhausted', notStarted: true, details });
const denied = (message, reason = 'client_scope') => Object.assign(new Error(message), { code: 'permission_required', details: { authority: { decision: 'deny', reason } } });
const equal = (a, b) => {
  const left = Buffer.from(a || ''), right = Buffer.from(b || '');
  return left.length === right.length && timingSafeEqual(left, right);
};
/** Version 1 grants predate purpose/class/data/destination fields; migrate them without widening access. */
function migrateGrant(grant) {
  return { purpose: '', crossWorkspace: grant.workspaceIds?.length > 1, actionClasses: [], dataAccess: [...DEFAULT_DATA_ACCESS], destinations: ['*'], autonomy: 'scoped',
    maxCommands: null, maxPerMinute: null, taskId: null, usage: { count: 0, lastUsedAt: null }, ...grant };
}

/** Shortest accepted WEFT_TOKEN: it is the bootstrap bearer token for full automation. */
export const MIN_BOOTSTRAP_TOKEN_LENGTH = 32;
/**
 * The bootstrap API token: WEFT_TOKEN when set (refused if shorter than 32 characters), otherwise a random one.
 * With WEFT_TOKEN_FILE and no WEFT_TOKEN, a generated token is written there (owner-only) instead of being printed.
 */
export function bootstrapToken(env = process.env, { generate = () => randomBytes(32).toString('hex'), write = (path, value) => writeTokenFile(path, value) } = {}) {
  const supplied = env.WEFT_TOKEN;
  if (supplied) {
    if (supplied.trim() !== supplied || supplied.length < MIN_BOOTSTRAP_TOKEN_LENGTH) {
      throw new Error(`WEFT_TOKEN must be at least ${MIN_BOOTSTRAP_TOKEN_LENGTH} characters without surrounding spaces; generate one with: node -e "console.log(require('node:crypto').randomBytes(32).toString('hex'))"`);
    }
    return { token: supplied, generated: false, file: null };
  }
  const token = generate();
  if (env.WEFT_TOKEN_FILE) { write(env.WEFT_TOKEN_FILE, token); return { token, generated: true, file: env.WEFT_TOKEN_FILE }; }
  return { token, generated: true, file: null };
}
function writeTokenFile(path, value) {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.${randomUUID()}.tmp`;
  writeFileSync(temporary, `${value}\n`, { mode: 0o600, flag: 'wx' });
  renameSync(temporary, path);
  chmodSync(path, 0o600);
}

/** Per-profile key that signs client tokens, separate from the bootstrap bearer token so grants survive restarts. */
export const SIGNING_KEY_FILE = 'client-signing-key.json';

export class ClientGrants {
  constructor({ directory, masterToken, workspace, clock = Date.now }) {
    this.masterToken = masterToken;
    this.workspace = workspace;
    this.clock = clock;
    this.directory = directory;
    this.rate = new Map();
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    this.path = join(directory, 'client-grants.json');
    this.signingKeyPath = join(directory, SIGNING_KEY_FILE);
    this.signingKey = this.loadSigningKey();
    this.stamp = fileStamp(this.path);
    this.grants = [];
    try {
      const saved = JSON.parse(readFileSync(this.path, 'utf8'));
      if (![1, 2].includes(saved.version) || !Array.isArray(saved.grants)) throw new Error('Invalid client grant store');
      // Budget fields were added later; older grants have none.
      this.grants = saved.grants.map(value => grantSchema.parse({ maxCost: null, maxRuntimeSeconds: null, ...(saved.version === 1 ? migrateGrant(value) : value) }));
    } catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
  save() {
    this.stamp = writeVerifiedJson(this.path, JSON.stringify({ version: 2, grants: this.grants }), this.stamp);
  }
  loadSigningKey() {
    const saved = readJson(this.signingKeyPath, null);
    if (saved) {
      const key = Buffer.from(String(saved.key ?? ''), 'base64');
      if (saved.version !== 1 || key.length !== 32) throw new Error(`${this.signingKeyPath} is not a valid client signing key; preserve it and review before retrying`);
      return key;
    }
    const key = randomBytes(32);
    writeJsonDurable(this.signingKeyPath, { version: 1, key: key.toString('base64'), createdAt: new Date(this.clock()).toISOString() });
    return key;
  }
  /** Invalidate every issued client token at once (grants stay listed; their tokens stop authenticating). */
  rotateSigningKey() {
    const key = randomBytes(32);
    writeJsonDurable(this.signingKeyPath, { version: 1, key: key.toString('base64'), createdAt: new Date(this.clock()).toISOString() });
    this.signingKey = key;
  }
  sign(payload) { return createHmac('sha256', this.signingKey).update(payload).digest('base64url'); }
  /** Tokens issued before the per-profile signing key existed were signed with the bootstrap token; they keep working while it is unchanged. */
  legacySign(payload) { return typeof this.masterToken === 'string' && this.masterToken ? createHmac('sha256', this.masterToken).update(payload).digest('base64url') : null; }
  live(grant) { return grant && !grant.revoked && grant.expiresAt > this.clock(); }
  authenticate(token) {
    if (equal(token, this.masterToken)) return { actor: 'automation', source: 'api' };
    if (typeof token !== 'string' || token.length > 4096) return null;
    const parts = token.split('.');
    if (parts.length !== 3 || parts[0] !== 'weft1' || !(equal(parts[2], this.sign(parts[1])) || equal(parts[2], this.legacySign(parts[1])))) return null;
    let claims;
    try { claims = JSON.parse(Buffer.from(parts[1], 'base64url').toString()); } catch { return null; }
    const grant = this.grants.find(item => item.clientId === claims.clientId);
    if (!this.live(grant) || claims.expiresAt !== grant.expiresAt) return null;
    // Scope fields are re-read from the live grant on every check; this snapshot is only for routing and events.
    return { actor: `client:${grant.clientId}`, source: 'api', clientId: grant.clientId, scopes: [...grant.scopes], workspaceIds: [...grant.workspaceIds], expiresAt: grant.expiresAt,
      autonomy: grant.autonomy, taskId: grant.taskId ?? undefined, purpose: grant.purpose };
  }
  validateWorkspaces(fields) {
    for (const workspaceId of fields.workspaceIds) this.workspace.workspace(workspaceId);
    if (new Set(fields.workspaceIds).size > 1 && !fields.crossWorkspace) throw Object.assign(new Error('Granting more than one workspace requires an explicit cross-workspace grant (crossWorkspace: true)'), { code: 'invalid_arguments' });
    if (fields.taskId) {
      const task = this.workspace.snapshot?.().tasks?.find(item => item.id === fields.taskId);
      if (!task || !fields.workspaceIds.includes(task.workspaceId)) throw Object.assign(new Error('Task-bound grants require a task inside a granted workspace'), { code: 'invalid_arguments' });
    }
  }
  describe(grant) { return structuredClone(grant); }
  execute(name, input, context) {
    if (context.actor !== 'human' || context.source !== 'gui') throw Object.assign(denied('Client grants require the trusted browser interface', 'human_only'), { code: 'permission_required' });
    const args = schemas[name]?.parse(input);
    if (!args) throw new Error('Unknown client command');
    if (name === 'clients.list') return this.grants.map(grant => this.describe(grant));
    const before = structuredClone(this.grants);
    try {
      if (name === 'clients.revoke' || name === 'clients.update') {
        const grant = this.grants.find(item => item.clientId === args.clientId);
        if (!grant) throw Object.assign(new Error('Client not found'), { code: 'not_found' });
        if (name === 'clients.revoke') { grant.revoked = true; this.save(); return { clientId: grant.clientId, revoked: true }; }
        if (grant.revoked) throw Object.assign(new Error('Revoked grants cannot be changed; create a new connection'), { code: 'stale_state' });
        const next = { ...grant, ...structuredClone(args.changes), updatedAt: this.clock() };
        for (const key of ['scopes', 'workspaceIds', 'actionClasses', 'dataAccess', 'destinations']) next[key] = [...new Set(next[key])];
        this.validateWorkspaces(next);
        Object.assign(grant, grantSchema.parse(next));
        this.save();
        return this.describe(grant);
      }
      const fields = Object.fromEntries(Object.keys(grantFields).map(key => [key, Array.isArray(args[key]) ? [...new Set(args[key])] : args[key]]));
      this.validateWorkspaces(fields);
      const grant = grantSchema.parse({ clientId: randomUUID(), name: args.name, ...fields, expiresAt: this.clock() + args.ttlSeconds * 1000, revoked: false, createdAt: this.clock(), usage: { count: 0, lastUsedAt: null } });
      if (this.grants.length >= 1000) throw new Error('Client grant limit reached; use a fresh profile or archive expired grants');
      this.grants.push(grant); this.save();
      const payload = Buffer.from(JSON.stringify({ clientId: grant.clientId, expiresAt: grant.expiresAt })).toString('base64url');
      return { ...this.describe(grant), token: `weft1.${payload}.${this.sign(payload)}` };
    } catch (error) { this.grants = before; throw error; }
  }
  /**
   * Generic grant check driven by command metadata, so newly added commands are covered:
   * reads need `read` and their data classes; writes need the resource write scope; classes beyond
   * reads/local/external writes must be granted explicitly; destinations and workspaces must match.
   * Plugin reads (plugin.<name>.<op>, plugins.invoke, hook commands) are reads only when their manifest-derived class is a read.
   */
  assertAllowed(name, context, target = {}, actionClassOverride = null) {
    if (!context.clientId) return;
    const grant = this.grants.find(item => item.clientId === context.clientId);
    if (!this.live(grant)) throw denied('Client grant expired or revoked', 'grant_inactive');
    const touched = [...new Set([target.workspaceId, ...(target.workspaceIds || [])].filter(Boolean))];
    if (touched.some(workspaceId => !grant.workspaceIds.includes(workspaceId))) throw denied('Workspace is outside this client grant', 'outside_workspace_grant');
    if (touched.length > 1 && !grant.crossWorkspace) throw denied('Moving between workspaces requires an explicit cross-workspace grant', 'cross_workspace_not_granted');
    if (target.createsWorkspace) throw denied(`Client scope does not permit ${name}: it would create a workspace outside this grant`, 'outside_workspace_grant');
    // Plugin commands carry the class raised from their manifest permissions; never lower than the catalog class.
    const actionClass = target.actionClass ?? actionClassOverride ?? actionClassForCommand(name);
    const resource = target.resource ?? resourceForCommand(name);
    const dataClasses = target.dataClasses ?? dataClassesForCommand(name);
    const read = ['local_read', 'external_read'].includes(actionClass);
    if (read) {
      if (!grant.scopes.includes('read')) throw denied(`Client scope does not permit ${name} (read scope required)`);
    } else if (resource === 'browser' || actionClass === 'administration') {
      throw denied(`Client scope does not permit ${name} (browser administration is human only)`, 'human_only');
    } else {
      const required = resource === 'tabs' ? 'tabs.control' : 'records.write';
      if (!grant.scopes.includes(required)) throw denied(`Client scope does not permit ${name} (${required} scope required)`);
      if (!['local_write', 'external_write'].includes(actionClass) && !grant.actionClasses.includes(actionClass)) throw denied(`Client scope does not permit ${name} (action class ${actionClass} is not granted)`, 'action_class_not_granted');
      if (actionClass === 'external_write' && !grant.scopes.includes('tabs.control')) throw denied(`Client scope does not permit ${name} (tabs.control scope required)`);
    }
    const missing = dataClasses.filter(dataClass => !grant.dataAccess.includes(dataClass));
    if (missing.length) throw denied(`Client scope does not permit ${name} (data class ${missing.join(', ')} is not granted)`, 'data_class_not_granted');
    if (target.destination && !matchDestination(grant.destinations, target.destination)) throw denied(`Client scope does not permit ${name} for this destination`, 'destination_not_granted');
    if (target.recheck) return; // Mid-execution rechecks confirm liveness and scope; the admitted command was already counted.
    if (grant.maxCommands !== null && grant.usage.count >= grant.maxCommands) throw denied('Client usage limit reached; a human can raise it or create a new connection', 'usage_limit');
    if (grant.maxPerMinute !== null) {
      const window = (this.rate.get(grant.clientId) || []).filter(time => time > this.clock() - 60000);
      if (window.length >= grant.maxPerMinute) throw denied('Client rate limit reached; retry later', 'rate_limit');
    }
  }
  /**
   * Cost and time budgets, checked before a command starts. Spend is measured only from provider-reported
   * tokens and a configured price, so with a cost budget an unpriced model connection is refused, never guessed.
   */
  assertBudgets(clientId, command, { pricing } = {}) {
    const grant = this.current(clientId);
    if (!grant) return;
    const runtime = grant.usage.runtimeMs ?? 0;
    if (grant.maxRuntimeSeconds !== null && runtime >= grant.maxRuntimeSeconds * 1000) {
      throw exhausted(`This client used its ${grant.maxRuntimeSeconds} s run-time budget; a person can raise it`, { budget: 'runtime', limit: grant.maxRuntimeSeconds, used: Math.round(runtime / 1000), unit: 'seconds' });
    }
    if (grant.maxCost && command === 'chat.send') {
      const spent = grant.usage.cost?.amount ?? 0;
      if (spent >= grant.maxCost.amount) throw exhausted(`This client spent its ${grant.maxCost.amount} ${grant.maxCost.currency} model budget; a person can raise it`, { budget: 'cost', limit: grant.maxCost.amount, used: spent, unit: grant.maxCost.currency });
      if (!pricing) throw exhausted('This client has a model spend budget, but the selected model connection has no configured price, so spend cannot be measured', { budget: 'cost', limit: grant.maxCost.amount, used: spent, unit: grant.maxCost.currency, reason: 'unpriced_model' });
      if (pricing.currency !== grant.maxCost.currency) throw exhausted(`The model is priced in ${pricing.currency}, but this client's budget is in ${grant.maxCost.currency}`, { budget: 'cost', limit: grant.maxCost.amount, used: spent, unit: grant.maxCost.currency, reason: 'currency_mismatch' });
    }
  }
  /** Record time and provider-measured spend after a command. Persisted only for grants with budgets. */
  recordConsumption(clientId, { runtimeMs = 0, cost = null, unpriced = false } = {}) {
    const grant = this.grants.find(item => item.clientId === clientId);
    if (!grant) return;
    grant.usage.runtimeMs = (grant.usage.runtimeMs ?? 0) + Math.max(0, runtimeMs);
    if (cost && Number.isFinite(cost.amount)) {
      const previous = grant.usage.cost;
      grant.usage.cost = { amount: Math.round(((previous?.currency === cost.currency ? previous.amount : 0) + cost.amount) * 1e6) / 1e6, currency: cost.currency };
    }
    if (unpriced) grant.usage.unpricedTurns = (grant.usage.unpricedTurns ?? 0) + 1;
    if (grant.maxRuntimeSeconds !== null || grant.maxCost) this.save();
  }
  budgetStatus(clientId) {
    const grant = this.current(clientId);
    if (!grant) return null;
    return { actions: { used: grant.usage.count, limit: grant.maxCommands }, runtime: { usedSeconds: Math.round((grant.usage.runtimeMs ?? 0) / 1000), limitSeconds: grant.maxRuntimeSeconds },
      cost: { used: grant.usage.cost ?? null, limit: grant.maxCost, basis: 'Configured price × provider-reported tokens; not a bill.' }, perMinute: grant.maxPerMinute };
  }
  /** The live grant, so scope changes and revocation apply to the next command even for long-lived contexts. */
  current(clientId) { const grant = this.grants.find(item => item.clientId === clientId); return this.live(grant) ? grant : null; }
  /** An atomic batch counts every contained command: refuse it whole when it would exceed the usage or rate limit. */
  assertBudget(clientId, count) {
    const grant = this.current(clientId);
    if (!grant) throw denied('Client grant expired or revoked', 'grant_inactive');
    if (grant.maxCommands !== null && grant.usage.count + count > grant.maxCommands) throw denied(`Client usage limit would be exceeded by this ${count}-command batch; a human can raise it or create a new connection`, 'usage_limit');
    if (grant.maxPerMinute !== null) {
      const window = (this.rate.get(grant.clientId) || []).filter(time => time > this.clock() - 60000);
      if (window.length + count > grant.maxPerMinute) throw denied(`Client rate limit would be exceeded by this ${count}-command batch; retry later or split it`, 'rate_limit');
    }
  }
  /** Count an admitted command against usage limits. Persisted only for limited grants to avoid a write per call. */
  recordUse(clientId) {
    const grant = this.grants.find(item => item.clientId === clientId);
    if (!grant) return;
    grant.usage.count += 1;
    grant.usage.lastUsedAt = this.clock();
    if (grant.maxPerMinute !== null) this.rate.set(clientId, [...(this.rate.get(clientId) || []).filter(time => time > this.clock() - 60000), this.clock()]);
    if (grant.maxCommands !== null) this.save();
  }
}
