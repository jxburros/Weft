import { createHash, randomUUID } from 'node:crypto';
import { z } from 'zod';
import { rejectSecretKeys } from './export-safety.js';

const id = z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,99}$/);
const workspaceId = z.string().min(1).max(128).optional();
const sourcePath = z.string().min(1).max(1000).refine(value => !value.startsWith('/') && !/[\\?#\x00-\x1f]/.test(value) && !value.split('/').some(part => !part || part === '.' || part === '..'), 'Expected a repository-relative file path without traversal');
export const listCommandDefinitions = {
  'lists.install': ['Human installs or updates a disabled, commit/hash-pinned community site list from supplied offline JSON bytes', {
    id, workspaceId,
    sourceRepo: z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9_.-]*\/[a-zA-Z0-9][a-zA-Z0-9_.-]*$/).max(200),
    commit: z.string().regex(/^[a-fA-F0-9]{40}$/), path: sourcePath,
    sha256: z.string().regex(/^[a-fA-F0-9]{64}$/), bytes: z.number().int().min(1).max(500000),
    description: z.string().max(2000).default(''), data: z.string().min(1).max(500000),
  }],
  'lists.status': ['Human inspects installed list pins, rule status and rollback availability without downloading', { id: id.optional(), workspaceId }],
  'lists.rollback': ['Human restores the previous pinned list version with rules disabled for review', { id, workspaceId }],
};
const schemas = Object.fromEntries(Object.entries(listCommandDefinitions).map(([name, [, shape]]) => [name, z.strictObject(shape)]));
const sourceSchema = z.strictObject({
  format: z.literal('weft-site-list'), version: z.literal(1),
  rules: z.array(z.strictObject({
    hostname: z.string().min(1).max(253),
    includeSubdomains: z.boolean().default(true), path: z.string().max(2048).default('/'),
    behavior: z.enum(['block', 'warn']).default('block'),
    mode: z.enum(['navigation', 'connection']).default('navigation'),
    reason: z.string().max(240).default('Community site list'), note: z.string().max(2000).default(''),
  })).min(1).max(5000),
});
const hash = value => createHash('sha256').update(value).digest('hex');

/** Data-only subscriptions. All mutations share the workspace's single commit queue. */
export class CommunityLists {
  constructor({ workspace }) { this.workspace = workspace; }

  execute(name, input = {}, context = {}) {
    const run = this.workspace.queue.then(() => this.dispatch(name, input, context));
    this.workspace.queue = run.catch(() => {});
    return run;
  }

  dispatch(name, input, context) {
    if (context.actor !== 'human') throw new Error('PERMISSION_REQUIRED: community lists require the trusted human interface');
    const schema = schemas[name];
    if (!schema) throw new Error(`Unknown community list command: ${name}`);
    rejectSecretKeys(input);
    const args = schema.parse(input);
    const workspaceId = args.workspaceId || context.workspaceId || this.workspace.activeWorkspaceId;
    if (context.workspaceId && context.workspaceId !== workspaceId) throw new Error('PERMISSION_REQUIRED: list is outside the authorized workspace');
    this.workspace.workspace(workspaceId);
    const lists = this.workspace.data.siteLists || [];
    const current = lists.find(item => item.id === args.id && item.workspaceId === workspaceId);
    if (name === 'lists.status') {
      if (args.id && !current) throw new Error('Community list not found');
      return lists.filter(item => item.workspaceId === workspaceId && (!args.id || item.id === args.id)).map(item => this.summary(item));
    }
    let version;
    if (name === 'lists.install') {
      if (Buffer.byteLength(args.data, 'utf8') !== args.bytes || hash(args.data) !== args.sha256.toLowerCase()) throw new Error('LIST_INTEGRITY: supplied bytes do not match the pinned byte count and SHA-256');
      const parsed = JSON.parse(args.data);
      rejectSecretKeys(parsed);
      const source = sourceSchema.parse(parsed);
      const seen = new Set();
      for (const rule of source.rules) {
        this.workspace.validateRule(rule);
        const key = JSON.stringify([rule.hostname, rule.path, rule.mode, rule.behavior, rule.includeSubdomains]);
        if (seen.has(key)) throw new Error('Duplicate rule in community list');
        seen.add(key);
      }
      const { workspaceId: ignoredWorkspace, ...pin } = args;
      version = { ...pin, commit: pin.commit.toLowerCase(), sha256: pin.sha256.toLowerCase(), rules: source.rules, installedAt: new Date().toISOString() };
      if (current && current.sha256 === version.sha256 && current.commit === version.commit && current.sourceRepo === version.sourceRepo && current.path === version.path && this.summary(current).integrity === 'verified') return { ...this.summary(current), unchanged: true };
    } else {
      if (!current?.previous) throw new Error('No previous pinned list version is available for rollback');
      version = structuredClone(current.previous);
      // Revalidate preserved bytes instead of trusting a potentially edited cache.
      const { rules: cachedRules, installedAt, ...pinFields } = version;
      const pin = schemas['lists.install'].parse(pinFields);
      if (Buffer.byteLength(pin.data) !== pin.bytes || hash(pin.data) !== pin.sha256) throw new Error('LIST_INTEGRITY: preserved rollback bytes do not match their pin');
      const parsed = JSON.parse(pin.data);
      rejectSecretKeys(parsed);
      version.rules = sourceSchema.parse(parsed).rules;
      for (const rule of version.rules) this.workspace.validateRule(rule);
    }

    const before = structuredClone(this.workspace.data);
    try {
      const previous = current ? this.version(current) : null;
      const subscription = { ...version, id: args.id, workspaceId, enabled: false, previous };
      this.workspace.data.siteLists = lists.filter(item => item.id !== args.id || item.workspaceId !== workspaceId);
      this.workspace.data.siteLists.push(subscription);
      this.workspace.data.siteRules = this.workspace.data.siteRules.filter(rule => !this.ownsRule(rule, { id: args.id, workspaceId }));
      const timestamp = new Date().toISOString();
      for (const [index, sourceRule] of subscription.rules.entries()) {
        const { sourceRepo, commit, path, sha256, bytes } = subscription;
        this.workspace.data.siteRules.push({
          ...sourceRule, id: `list_rule_${randomUUID()}`, workspaceId, scope: 'workspace', enabled: false,
          createdAt: timestamp, updatedAt: timestamp, revision: 1,
          provenance: { kind: 'community-list', listId: args.id, subscriptionWorkspaceId: workspaceId, sourceRepo, commit, path, sha256, bytes, ruleIndex: index },
        });
      }
      this.workspace.log(name, workspaceId, args.id, 'human', `${subscription.sourceRepo}@${subscription.commit} ${subscription.sha256}; rules disabled for review`);
      this.workspace.save();
      return this.summary(subscription);
    } catch (error) { this.workspace.data = before; throw error; }
  }

  version(subscription) {
    const { previous, workspaceId, enabled, ...version } = subscription;
    return structuredClone(version);
  }

  ownsRule(rule, subscription) {
    return rule.provenance?.kind === 'community-list' && rule.provenance.listId === subscription.id && rule.provenance.subscriptionWorkspaceId === subscription.workspaceId;
  }

  summary(subscription) {
    const { rules, previous, data, ...metadata } = subscription;
    const installedRules = this.workspace.data.siteRules.filter(rule => this.ownsRule(rule, subscription));
    return structuredClone({ ...metadata, integrity: typeof data === 'string' && Buffer.byteLength(data) === subscription.bytes && hash(data) === subscription.sha256 ? 'verified' : 'mismatch', enabled: installedRules.some(rule => rule.enabled), ruleCount: installedRules.length, enabledRuleCount: installedRules.filter(rule => rule.enabled).length, rollbackAvailable: Boolean(previous), previous: previous ? { sourceRepo: previous.sourceRepo, commit: previous.commit, path: previous.path, sha256: previous.sha256, bytes: previous.bytes } : null, sourceUrl: `https://github.com/${subscription.sourceRepo}/blob/${subscription.commit}/${subscription.path.split('/').map(encodeURIComponent).join('/')}` });
  }
}
