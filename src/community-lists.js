import { createHash, randomUUID } from 'node:crypto';
import { z } from 'zod';
import { rejectSecretKeys } from './export-safety.js';
import { ListError, keyIdOf, sha256 } from './list-signing.js';
import { diffReleases, evaluateRelease, matchRelease, normalizeHostname, verifyRelease } from './list-format.js';

const id = z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,99}$/);
const workspaceId = z.string().min(1).max(128).optional();
const base64Key = z.string().min(40).max(200).regex(/^[A-Za-z0-9+/]+={0,2}$/);
const sha256Hex = z.string().regex(/^[a-fA-F0-9]{64}$/);
const httpsUrl = z.string().max(2000).refine(value => { try { const url = new URL(value); return url.protocol === 'https:' && !url.username && !url.password && !url.hash; } catch { return false; } }, 'Expected an https URL without credentials');
const scheduledCheck = z.strictObject({ enabled: z.boolean(), intervalHours: z.number().int().min(1).max(720).default(24) });
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
  'lists.rollback': ['Human restores the previous pinned list version (signed lists: the previous verified release; legacy pins: with rules disabled for review)', { id, workspaceId }],
  'lists.subscribe': ['Human subscribes to a signed community list: pins the publisher key, chooses private-group or public, label/warn/block mode and confirms the previewed release digest', {
    id, workspaceId, groupType: z.enum(['private-group', 'public']), publicKey: base64Key, mode: z.enum(['label', 'warn', 'block']).default('label'),
    minReviewers: z.number().int().min(1).max(10).optional(), sourceUrl: httpsUrl.optional(), scheduledCheck: scheduledCheck.optional(),
    data: z.string().min(2).max(1000000), payloadSha256: sha256Hex,
  }],
  'lists.preview': ['Human previews a signed list release without applying it: added/removed/changed entries, newly blocked domains, governance and key changes', {
    id, workspaceId, publicKey: base64Key.optional(), data: z.string().min(2).max(1000000).optional(),
    mode: z.enum(['label', 'warn', 'block']).optional(), minReviewers: z.number().int().min(1).max(10).optional(), allowOlder: z.boolean().default(false),
  }],
  'lists.update': ['Human applies a previewed signed release (supplied or fetched by an explicit check); the previewed payload digest must be confirmed', {
    id, workspaceId, data: z.string().min(2).max(1000000).optional(), payloadSha256: sha256Hex, allowOlder: z.boolean().default(false),
  }],
  'lists.configure': ['Human changes a subscription mode, reviewer floor, source URL or opt-in scheduled check', {
    id, workspaceId, mode: z.enum(['label', 'warn', 'block']).optional(), minReviewers: z.number().int().min(1).max(10).optional(),
    sourceUrl: httpsUrl.nullable().optional(), scheduledCheck: scheduledCheck.optional(),
  }],
  'lists.exception': ['Human adds or removes a visible per-site exception for one subscription', {
    id, workspaceId, action: z.enum(['add', 'remove']), hostname: z.string().trim().min(1).max(253), reason: z.string().max(240).default(''),
  }],
  'lists.unsubscribe': ['Human removes a signed subscription and every rule it owns', { id, workspaceId }],
  'lists.check': ['Human fetches the subscription source URL once and stores a verified update for preview; nothing is applied', { id, workspaceId }],
  'lists.matches': ['Human lists every community-list entry and site rule matching a URL, with provenance and precedence', { url: z.string().min(1).max(4096), workspaceId }],
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
const SIGNED_COMMANDS = new Set(['lists.subscribe', 'lists.preview', 'lists.update', 'lists.configure', 'lists.exception', 'lists.unsubscribe', 'lists.matches']);
const MAX_SOURCE_BYTES = 1_000_000;

async function defaultFetcher(url, { maxBytes }) {
  // Plain GET: no cookies, no body, no headers beyond Accept; redirects are refused so credentials or hosts can never change silently.
  const response = await fetch(url, { redirect: 'error', credentials: 'omit', headers: { accept: 'application/json' }, signal: AbortSignal.timeout(15_000) });
  if (!response.ok) throw new Error(`Source returned HTTP ${response.status}`);
  const chunks = [];
  let total = 0;
  for await (const chunk of response.body) {
    total += chunk.length;
    if (total > maxBytes) throw new Error('Source exceeds the 1,000,000 byte limit');
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString('utf8');
}

/** Data-only subscriptions. All mutations share the workspace's single commit queue. */
export class CommunityLists {
  /** `fetcher(url, {maxBytes})` is the only network seam; it is used solely by explicit or opt-in scheduled source checks. */
  constructor({ workspace, fetcher = defaultFetcher, clock = () => Date.now() }) {
    this.workspace = workspace; this.fetcher = fetcher; this.clock = clock; this.cache = new Map();
    // Integration point for browser labels and for the site-rule explain command: workspace.communityLists.matchesForUrl(url, workspaceId).
    workspace.communityLists = this;
  }

  execute(name, input = {}, context = {}) {
    if (name === 'lists.check') return this.check(input, context);
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
    if (SIGNED_COMMANDS.has(name) || (name === 'lists.rollback' && current?.kind === 'signed')) return this.signedCommand(name, args, workspaceId, current);
    if (name === 'lists.install' && current?.kind === 'signed') throw new Error('LIST_KIND: this id is a signed subscription; use lists.update');
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
    if (subscription.kind === 'signed') return this.signedSummary(subscription);
    const { rules, previous, data, ...metadata } = subscription;
    const installedRules = this.workspace.data.siteRules.filter(rule => this.ownsRule(rule, subscription));
    return structuredClone({ ...metadata, integrity: typeof data === 'string' && Buffer.byteLength(data) === subscription.bytes && hash(data) === subscription.sha256 ? 'verified' : 'mismatch', enabled: installedRules.some(rule => rule.enabled), ruleCount: installedRules.length, enabledRuleCount: installedRules.filter(rule => rule.enabled).length, rollbackAvailable: Boolean(previous), previous: previous ? { sourceRepo: previous.sourceRepo, commit: previous.commit, path: previous.path, sha256: previous.sha256, bytes: previous.bytes } : null, sourceUrl: `https://github.com/${subscription.sourceRepo}/blob/${subscription.commit}/${subscription.path.split('/').map(encodeURIComponent).join('/')}` });
  }

  // ---- Signed, governed subscriptions -------------------------------------------------------------

  signedSubs(workspaceId) { return (this.workspace.data.siteLists || []).filter(item => item.kind === 'signed' && (!workspaceId || item.workspaceId === workspaceId)); }
  pinOf(sub) { return { keyId: sub.publisher.keyId, publicKey: sub.publisher.publicKey }; }
  options(sub, now = new Date(this.clock())) { return { mode: sub.mode, exceptions: sub.exceptions, minReviewers: sub.minReviewers, now }; }

  /** Re-verify the stored bytes (signature, schema) before every use; results are memoised per exact bytes. */
  release(version, listId) {
    const key = `${sha256(version.envelope)}:${version.keyId}`;
    if (!this.cache.has(key)) {
      if (this.cache.size > 64) this.cache.clear();
      this.cache.set(key, verifyRelease(version.envelope, { pinned: { keyId: version.keyId, publicKey: version.publicKey }, listId }));
    }
    return this.cache.get(key);
  }
  evaluation(sub) {
    const now = new Date(this.clock());
    const key = `eval:${sha256(sub.current.envelope)}:${sub.mode}:${sub.minReviewers}:${JSON.stringify(sub.exceptions)}:${Math.floor(now.getTime() / 3_600_000)}`;
    if (!this.cache.has(key)) this.cache.set(key, evaluateRelease(this.release(sub.current, sub.listId).payload, this.options(sub, now)));
    return this.cache.get(key);
  }

  /** Verify a candidate release against the pinned key and anti-rollback rules; never mutates state. */
  prepare({ sub, data, publicKey, allowOlder = false, mode, minReviewers }) {
    const now = new Date(this.clock());
    const pinned = sub ? this.pinOf(sub) : { keyId: keyIdOf(publicKey), publicKey };
    const release = verifyRelease(data, { pinned, listId: sub?.listId });
    const { payload } = release;
    if (payload.expiresAt && Date.parse(payload.expiresAt) < now.getTime()) throw new ListError('LIST_EXPIRED', `Release expired at ${payload.expiresAt}`);
    let rollback = false;
    if (sub) {
      if (release.payloadSha256 === sub.current.payloadSha256) return { unchanged: true, release };
      if (payload.sequence === sub.current.sequence || (payload.sequence === sub.highWater && release.payloadSha256 !== sub.highWaterSha256)) throw new ListError('LIST_EQUIVOCATION', `Two different releases claim sequence ${payload.sequence}; refusing the new one`);
      // Rolling forward again to the highest release ever accepted (after a human rollback) is not an older release.
      if (payload.sequence < sub.highWater) {
        if (!allowOlder) throw new ListError('LIST_ROLLBACK', `Release sequence ${payload.sequence} is not newer than the highest accepted sequence ${sub.highWater}; a human must pass allowOlder to accept an older release`);
        rollback = true;
      }
    }
    const before = sub ? this.release(sub.current, sub.listId).payload : null;
    const options = sub ? this.options(sub, now) : { mode: mode || 'label', exceptions: [], minReviewers: minReviewers ?? 1, now };
    const diff = diffReleases(before, payload, options);
    const warnings = [...diff.warnings];
    if (rollback) warnings.unshift(`ROLLBACK: sequence ${payload.sequence} is older than the highest accepted sequence ${sub.highWater}.`);
    if (release.rotation) warnings.unshift(`KEY ROTATION: the publisher asks to replace pinned key ${release.rotation.fromKeyId.slice(0, 16)}... with ${release.rotation.toKeyId.slice(0, 16)}... (${release.rotation.statement}). Applying pins the new key.`);
    return { unchanged: false, release, rollback, diff: { ...diff, warnings }, options };
  }

  describePrepared(id, sub, prepared) {
    const { release } = prepared;
    const { payload } = release;
    return { id, isNew: !sub, unchanged: Boolean(prepared.unchanged), valid: true, listId: payload.listId, name: payload.name,
      publisher: { keyId: payload.publisher.keyId, fingerprint: payload.publisher.keyId.match(/.{4}/g).slice(0, 8).join(' '), pinned: Boolean(sub), rotation: release.rotation },
      from: sub ? { sequence: sub.current.sequence, payloadSha256: sub.current.payloadSha256 } : null,
      to: { sequence: payload.sequence, issuedAt: payload.issuedAt, expiresAt: payload.expiresAt ?? null, payloadSha256: release.payloadSha256, bytes: release.bytes },
      rollback: Boolean(prepared.rollback), ...(prepared.diff ?? { added: [], removed: [], changed: [], newlyBlocked: [], noLongerBlocked: [], newlyWarned: [], governanceChanges: [], warnings: [], counts: {} }),
      confirm: 'Pass to.payloadSha256 as payloadSha256 to lists.subscribe/lists.update to apply exactly this release.' };
  }

  releaseRecord(prepared, now) {
    const { release } = prepared;
    return { envelope: release.envelopeText, sequence: release.payload.sequence, payloadSha256: release.payloadSha256, issuedAt: release.payload.issuedAt, appliedAt: now, keyId: release.payload.publisher.keyId, publicKey: release.pinnedPublicKey, bytes: release.bytes };
  }

  signedCommand(name, args, workspaceId, current) {
    const need = () => { if (current?.kind !== 'signed') throw new Error('Signed community subscription not found'); return current; };
    if (name === 'lists.matches') return this.explainUrl(args.url, workspaceId);
    if (name === 'lists.preview') {
      const sub = current ? need() : null;
      const data = args.data ?? sub?.pending?.envelope;
      if (!data) throw new Error('Supply the signed list in data (or run lists.check to fetch a pending update)');
      if (!sub && !args.publicKey) throw new Error('A first preview needs the publisher public key you intend to pin');
      return this.describePrepared(args.id, sub, this.prepare({ sub, data, publicKey: args.publicKey, allowOlder: args.allowOlder, mode: args.mode, minReviewers: args.minReviewers }));
    }
    const lists = this.workspace.data.siteLists || [];
    const before = structuredClone(this.workspace.data);
    const now = new Date(this.clock()).toISOString();
    try {
      let sub;
      let detail;
      if (name === 'lists.subscribe') {
        if (current) throw new Error('Already subscribed under this id; use lists.update, or unsubscribe first');
        const prepared = this.prepare({ sub: null, data: args.data, publicKey: args.publicKey, mode: args.mode, minReviewers: args.minReviewers });
        if (prepared.release.payloadSha256 !== args.payloadSha256.toLowerCase()) throw new ListError('LIST_UNCONFIRMED', 'payloadSha256 does not match the release; run lists.preview and confirm that digest');
        rejectSecretKeys(prepared.release.payload);
        const { payload } = prepared.release;
        if (args.scheduledCheck?.enabled && !args.sourceUrl) throw new Error('A scheduled check needs a sourceUrl');
        sub = { kind: 'signed', id: args.id, workspaceId, listId: payload.listId, name: payload.name, description: payload.description, groupType: args.groupType,
          publisher: { keyId: payload.publisher.keyId, publicKey: args.publicKey, pinnedAt: now, history: [] },
          sourceUrl: args.sourceUrl ?? null, scheduledCheck: args.scheduledCheck ?? { enabled: false, intervalHours: 24 }, lastCheck: null,
          mode: args.mode, minReviewers: args.minReviewers ?? (args.groupType === 'public' ? 2 : 1), exceptions: [],
          current: this.releaseRecord(prepared, now), previous: null, highWater: payload.sequence, highWaterSha256: prepared.release.payloadSha256, pending: null, subscribedAt: now };
        lists.push(sub); this.workspace.data.siteLists = lists;
        detail = `subscribed ${payload.listId} seq ${payload.sequence} key ${sub.publisher.keyId.slice(0, 16)} mode ${sub.mode}; ${prepared.diff.newlyBlocked.length} blocked domains`;
      } else {
        sub = need();
        if (name === 'lists.update') {
          const data = args.data ?? sub.pending?.envelope;
          if (!data) throw new Error('Supply the signed list in data, or run lists.check first');
          const prepared = this.prepare({ sub, data, allowOlder: args.allowOlder });
          if (prepared.unchanged) return { ...this.signedSummary(sub), unchanged: true };
          if (prepared.release.payloadSha256 !== args.payloadSha256.toLowerCase()) throw new ListError('LIST_UNCONFIRMED', 'payloadSha256 does not match the release; run lists.preview and confirm that digest');
          rejectSecretKeys(prepared.release.payload);
          const { payload, rotation } = prepared.release;
          sub.previous = sub.current;
          sub.current = this.releaseRecord(prepared, now);
          if (rotation) {
            sub.publisher.history.push({ keyId: sub.publisher.keyId, publicKey: sub.publisher.publicKey, retiredAt: now, atSequence: payload.sequence, statement: rotation.statement });
            sub.publisher = { ...sub.publisher, keyId: rotation.toKeyId, publicKey: rotation.toPublicKey, pinnedAt: now };
          }
          sub.name = payload.name; sub.description = payload.description;
          if (payload.sequence > sub.highWater) { sub.highWater = payload.sequence; sub.highWaterSha256 = prepared.release.payloadSha256; }
          if (sub.pending && sub.pending.payloadSha256 === prepared.release.payloadSha256) sub.pending = null;
          detail = `updated ${sub.listId} to seq ${payload.sequence}${prepared.rollback ? ' (explicit older release)' : ''}${rotation ? ' with key rotation' : ''}: +${prepared.diff.added.length} -${prepared.diff.removed.length} ~${prepared.diff.changed.length}; ${prepared.diff.newlyBlocked.length} newly blocked domains`;
        } else if (name === 'lists.rollback') {
          if (!sub.previous) throw new Error('No previous verified release is available for rollback');
          const known = sub.previous.keyId === sub.publisher.keyId || sub.publisher.history.some(item => item.keyId === sub.previous.keyId);
          if (!known) throw new ListError('LIST_KEY_UNPINNED', 'Previous release was signed by a key that is no longer in this subscription\'s key history');
          const restored = verifyRelease(sub.previous.envelope, { pinned: { keyId: sub.previous.keyId, publicKey: sub.previous.publicKey }, listId: sub.listId });
          if (restored.payloadSha256 !== sub.previous.payloadSha256) throw new ListError('LIST_INTEGRITY', 'Preserved rollback bytes do not match their recorded digest');
          const left = sub.current;
          sub.current = { ...sub.previous, appliedAt: now, rolledBack: true };
          sub.previous = left;
          detail = `rolled back ${sub.listId} to seq ${sub.current.sequence} (highest accepted stays ${sub.highWater})`;
        } else if (name === 'lists.configure') {
          if (args.mode) sub.mode = args.mode;
          if (args.minReviewers) sub.minReviewers = args.minReviewers;
          if (args.sourceUrl !== undefined) sub.sourceUrl = args.sourceUrl;
          if (args.scheduledCheck) sub.scheduledCheck = args.scheduledCheck;
          if (sub.scheduledCheck.enabled && !sub.sourceUrl) throw new Error('A scheduled check needs a sourceUrl');
          detail = `configured ${sub.listId}: mode ${sub.mode}, reviewers ${sub.minReviewers}, scheduled ${sub.scheduledCheck.enabled ? `every ${sub.scheduledCheck.intervalHours}h` : 'off'}`;
        } else if (name === 'lists.exception') {
          const host = normalizeHostname(args.hostname);
          if (args.action === 'add') {
            if (!sub.exceptions.some(item => item.hostname === host)) sub.exceptions.push({ hostname: host, reason: args.reason, createdAt: now });
          } else {
            if (!sub.exceptions.some(item => item.hostname === host)) throw new Error('No such exception');
            sub.exceptions = sub.exceptions.filter(item => item.hostname !== host);
          }
          detail = `exception ${args.action} ${host}`;
        } else if (name === 'lists.unsubscribe') {
          const removed = this.workspace.data.siteRules.filter(rule => this.ownsRule(rule, sub)).length;
          this.workspace.data.siteLists = lists.filter(item => item !== sub);
          this.workspace.data.siteRules = this.workspace.data.siteRules.filter(rule => !this.ownsRule(rule, sub));
          this.workspace.log(name, workspaceId, args.id, 'human', `unsubscribed ${sub.listId}; removed ${removed} rules; nothing was uploaded`);
          this.workspace.save();
          return { id: args.id, unsubscribed: true, removedRules: removed };
        }
      }
      this.materialize(sub);
      this.workspace.log(name, workspaceId, args.id, 'human', detail);
      this.workspace.save();
      return this.signedSummary(sub);
    } catch (error) { this.workspace.data = before; throw error; }
  }

  /** Replace this subscription's rules with those its current release enforces under the chosen mode and exceptions. */
  materialize(sub) {
    const evaluation = this.evaluation(sub);
    const { payload, payloadSha256 } = this.release(sub.current, sub.listId);
    this.workspace.data.siteRules = this.workspace.data.siteRules.filter(rule => !this.ownsRule(rule, sub));
    const timestamp = new Date(this.clock()).toISOString();
    for (const item of evaluation.rules) {
      const rule = { ...item.rule };
      this.workspace.validateRule(rule);
      this.workspace.data.siteRules.push({ ...rule, id: `list_rule_${randomUUID()}`, workspaceId: sub.workspaceId, scope: 'workspace', enabled: true, createdAt: timestamp, updatedAt: timestamp, revision: 1,
        provenance: { kind: 'community-list', signed: true, listId: sub.id, subscriptionWorkspaceId: sub.workspaceId, listName: payload.name, publisherListId: payload.listId, publisherKeyId: payload.publisher.keyId,
          sequence: payload.sequence, payloadSha256, entryId: item.entry.id, entryRevision: item.entry.revision, entryStatus: item.entry.status, claim: item.entry.claim.slice(0, 300), claimKind: item.entry.claimType === 'opinion' ? 'Opinion' : 'Factual claim',
          category: item.entry.category, subjectType: item.entry.subject.type, subscriptionMode: sub.mode, groupType: sub.groupType, approvals: item.effect.approvals } });
    }
  }

  signedSummary(sub) {
    let integrity = 'verified';
    let evaluation = null;
    try { this.release(sub.current, sub.listId); evaluation = this.evaluation(sub); } catch { integrity = 'mismatch'; }
    const owned = this.workspace.data.siteRules.filter(rule => this.ownsRule(rule, sub));
    const count = status => evaluation ? evaluation.entries.filter(item => item.entry.status === status).length : null;
    const { envelope, ...current } = sub.current;
    return structuredClone({ kind: 'signed', id: sub.id, workspaceId: sub.workspaceId, listId: sub.listId, name: sub.name, description: sub.description, groupType: sub.groupType, mode: sub.mode, minReviewers: sub.minReviewers,
      publisher: { keyId: sub.publisher.keyId, fingerprint: sub.publisher.keyId.match(/.{4}/g).slice(0, 8).join(' '), pinnedAt: sub.publisher.pinnedAt, rotations: sub.publisher.history.map(({ keyId, retiredAt, atSequence, statement }) => ({ keyId, retiredAt, atSequence, statement })) },
      sourceUrl: sub.sourceUrl, scheduledCheck: sub.scheduledCheck, lastCheck: sub.lastCheck, exceptions: sub.exceptions, integrity,
      current: { sequence: current.sequence, payloadSha256: current.payloadSha256, issuedAt: current.issuedAt, appliedAt: current.appliedAt, bytes: current.bytes, rolledBack: Boolean(current.rolledBack) }, highWater: sub.highWater,
      rollbackAvailable: Boolean(sub.previous), previous: sub.previous ? { sequence: sub.previous.sequence, payloadSha256: sub.previous.payloadSha256 } : null,
      pendingUpdate: sub.pending ? { sequence: sub.pending.sequence, payloadSha256: sub.pending.payloadSha256, fetchedAt: sub.pending.fetchedAt } : null,
      enabled: owned.some(rule => rule.enabled), ruleCount: owned.length, enabledRuleCount: owned.filter(rule => rule.enabled).length,
      counts: evaluation ? { entries: evaluation.entries.length, proposed: count('proposed'), accepted: count('accepted'), disputed: count('disputed'), corrected: count('corrected'), retired: count('retired'), stale: count('stale'),
        active: evaluation.entries.filter(item => item.effect.active).length, labelOnly: evaluation.entries.filter(item => item.behavior === 'label').length, excepted: evaluation.entries.filter(item => item.excepted).length,
        governanceViolations: [...evaluation.violations.values()].filter(items => items.some(item => item.blocking)).length } : null,
      reviewerThreshold: evaluation?.minReviewers ?? null });
  }

  /** Community entries for a URL with provenance. Pure read; used by lists.matches, browser labels and the site-rule explain command. */
  matchesForUrl(url, workspaceId = this.workspace.activeWorkspaceId) {
    const matches = [];
    for (const sub of this.signedSubs(workspaceId)) {
      let payload;
      try { payload = this.release(sub.current, sub.listId).payload; } catch { continue; }
      for (const match of matchRelease(payload, url, this.options(sub))) {
        const rule = this.workspace.data.siteRules.find(item => this.ownsRule(item, sub) && item.provenance.entryId === match.entryId);
        matches.push({ listId: sub.id, listName: sub.name, groupType: sub.groupType, subscriptionMode: sub.mode, sequence: sub.current.sequence, publisherKeyId: sub.publisher.keyId, payloadSha256: sub.current.payloadSha256, enforcedByRuleId: rule?.id ?? null, ...match });
      }
    }
    return matches;
  }

  /** Every site rule and community entry that applies to a URL, in the order the browser resolves them. */
  explainUrl(value, workspaceId = this.workspace.activeWorkspaceId) {
    let url;
    try { url = new URL(value); } catch { throw new Error('Expected an absolute URL'); }
    const hostname = url.hostname.toLowerCase().replace(/\.$/, '');
    // Mirrors WorkspaceService.matchSiteRule; the regression test asserts both pick the same winner.
    const applies = rule => (rule.scope === 'global' || rule.workspaceId === workspaceId) && (hostname === rule.hostname || (rule.includeSubdomains && hostname.endsWith(`.${rule.hostname}`))) && (rule.path === '/' || url.pathname === rule.path || url.pathname.startsWith(`${rule.path.replace(/\/$/, '')}/`));
    const tier = rule => (rule.behavior === 'block' && rule.mode === 'connection' ? 1 : rule.behavior === 'block' ? 2 : 3);
    const matching = this.workspace.data.siteRules.filter(applies).map((rule, index) => ({ rule, index })).sort((a, b) => (a.rule.enabled === false) - (b.rule.enabled === false) || tier(a.rule) - tier(b.rule) || a.index - b.index);
    const rules = matching.map(({ rule }, position) => ({ id: rule.id, source: rule.provenance?.kind === 'community-list' ? 'community-list' : 'personal', scope: rule.scope, hostname: rule.hostname, includeSubdomains: rule.includeSubdomains, path: rule.path, behavior: rule.behavior, mode: rule.mode,
      enabled: rule.enabled !== false, precedenceTier: tier(rule), precedence: position + 1, winner: position === 0 && rule.enabled !== false, reason: rule.reason, provenance: rule.provenance ?? null }));
    return { url: url.href, hostname, workspaceId, rules, winner: rules.find(rule => rule.winner) ?? null, communityMatches: this.matchesForUrl(url.href, workspaceId),
      precedence: ['1. enabled block rules in connection mode', '2. other enabled block rules', '3. the first remaining enabled rule (warn)', 'Disabled rules never apply. Community entries without an enforcing rule (label, disputed, stale, excepted, under-reviewed) are listed but cannot block.'] };
  }

  // ---- Explicit and opt-in scheduled source checks ------------------------------------------------

  async check(input, context) {
    if (context.actor !== 'human') throw new Error('PERMISSION_REQUIRED: community lists require the trusted human interface');
    const args = schemas['lists.check'].parse(input);
    const workspaceId = args.workspaceId || context.workspaceId || this.workspace.activeWorkspaceId;
    if (context.workspaceId && context.workspaceId !== workspaceId) throw new Error('PERMISSION_REQUIRED: list is outside the authorized workspace');
    this.workspace.workspace(workspaceId);
    return this.checkSubscription(workspaceId, args.id, 'human');
  }

  /** One GET to the human-configured https URL; the response is verified and stored as a pending update, never applied. */
  async checkSubscription(workspaceId, id, trigger) {
    const sub = this.signedSubs(workspaceId).find(item => item.id === id);
    if (!sub) throw new Error('Signed community subscription not found');
    if (!sub.sourceUrl) throw new Error('This subscription has no sourceUrl; supply updates with lists.update');
    let text; let failure;
    try { text = await this.fetcher(sub.sourceUrl, { maxBytes: MAX_SOURCE_BYTES }); } catch (error) { failure = error; }
    const run = this.workspace.queue.then(() => {
      const live = this.signedSubs(workspaceId).find(item => item.id === id);
      if (!live) return null;
      const before = structuredClone(this.workspace.data);
      try {
        const at = new Date(this.clock()).toISOString();
        let outcome; let detail = '';
        if (failure) { outcome = 'error'; detail = String(failure.message || failure).slice(0, 300); }
        else {
          try {
            const prepared = this.prepare({ sub: live, data: text });
            if (prepared.unchanged) { outcome = 'unchanged'; live.pending = null; }
            else { outcome = 'update-available'; live.pending = { envelope: text, sequence: prepared.release.payload.sequence, payloadSha256: prepared.release.payloadSha256, fetchedAt: at, bytes: prepared.release.bytes }; detail = `sequence ${prepared.release.payload.sequence}; run lists.preview then lists.update`; }
          } catch (error) { outcome = 'rejected'; detail = String(error.message).slice(0, 300); }
        }
        live.lastCheck = { at, trigger, outcome, detail };
        this.workspace.log('lists.check', workspaceId, id, trigger === 'human' ? 'human' : 'scheduler', `${outcome}${detail ? `: ${detail}` : ''}; GET only, no workspace data sent`);
        this.workspace.save();
        return { ...this.signedSummary(live), checked: outcome };
      } catch (error) { this.workspace.data = before; throw error; }
    });
    this.workspace.queue = run.catch(() => {});
    return run;
  }

  /** Runs only for subscriptions where a human enabled scheduledCheck; fetched releases wait for human preview and apply. */
  async runScheduledChecks(now = this.clock()) {
    const results = [];
    for (const sub of this.signedSubs()) {
      const { enabled, intervalHours } = sub.scheduledCheck;
      if (!enabled || !sub.sourceUrl) continue;
      if (sub.lastCheck && now - Date.parse(sub.lastCheck.at) < intervalHours * 3_600_000) continue;
      try { results.push({ id: sub.id, workspaceId: sub.workspaceId, outcome: (await this.checkSubscription(sub.workspaceId, sub.id, 'scheduled'))?.checked }); }
      catch (error) { results.push({ id: sub.id, workspaceId: sub.workspaceId, outcome: 'error', detail: error.message }); }
    }
    return results;
  }
}
