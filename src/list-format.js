import { domainToASCII } from 'node:url';
import { z } from 'zod';
import { ListError, keyIdOf, parseEnvelope, sha256, signatureValid } from './list-signing.js';

/**
 * Signed community-list payload: schema, governance evaluation, effective
 * behaviour, rule materialisation and release diffing. Everything here is pure
 * (no I/O, no clocks other than the `now` argument) so subscribers and the
 * maintainer CLI evaluate a list identically.
 */
export const BEHAVIORS = ['none', 'label', 'warn', 'block'];
export const STATUSES = ['proposed', 'accepted', 'disputed', 'corrected', 'retired', 'stale'];
export const ROLES = ['maintainer', 'reviewer', 'submitter'];
const rank = value => BEHAVIORS.indexOf(value);
const minBehavior = (...values) => values.reduce((a, b) => (rank(b) < rank(a) ? b : a));

export function normalizeHostname(value) {
  if (/[\s/@?#:\\]/.test(value)) throw new Error('Use a hostname without scheme, port or path');
  const hostname = domainToASCII(value.toLowerCase().replace(/\.$/, ''));
  if (!hostname || hostname.length > 253 || hostname.split('.').some(label => !/^[a-z\d](?:[a-z\d-]{0,61}[a-z\d])?$/i.test(label))) throw new Error('Invalid hostname');
  return hostname;
}
const iso = z.string().regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/).refine(value => !Number.isNaN(Date.parse(value)), 'Invalid date');
export const member = z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9_.@:-]{0,63}$/);
const slug = z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,99}$/);
const hostname = z.string().min(1).max(253).refine(value => { try { return normalizeHostname(value) === value; } catch { return false; } }, 'Expected a canonical lowercase ASCII hostname');
const entryPath = z.string().max(2048).refine(value => value.startsWith('/') && !/[?#\\]/.test(value), 'Expected an absolute path without query or fragment');
const httpUrl = z.string().max(2000).refine(value => { try { const url = new URL(value); return ['http:', 'https:'].includes(url.protocol) && !url.username && !url.password; } catch { return false; } }, 'Expected an http(s) URL without credentials');

export const sourceSchema = z.strictObject({ title: z.string().min(1).max(200), url: httpUrl, retrievedAt: iso, excerpt: z.string().max(500).default('') });
export const subjectSchema = z.discriminatedUnion('type', [
  z.strictObject({ type: z.literal('domain'), hostname, includeSubdomains: z.boolean().default(true), path: entryPath.default('/') }),
  z.strictObject({ type: z.literal('entity'), name: z.string().min(1).max(120), entityKind: z.enum(['organization', 'person', 'product', 'service', 'project', 'other']).default('organization'), domains: z.array(hostname).max(20).default([]) }),
]);
const reviewSchema = z.strictObject({ reviewer: member, decision: z.enum(['approve', 'reject']), at: iso, round: z.number().int().min(1), note: z.string().max(500).default('') });
const appealSchema = z.strictObject({ by: member, at: iso, reason: z.string().min(1).max(1000), state: z.enum(['open', 'granted', 'denied']), priorStatus: z.enum(STATUSES), decidedBy: member.optional(), decidedAt: iso.optional(), note: z.string().max(500).optional() });
const disputeSchema = z.strictObject({
  id: slug, openedBy: member, reporter: z.string().max(100).default(''), at: iso, reason: z.string().min(1).max(1000),
  state: z.enum(['open', 'upheld', 'corrected', 'retired']), resolvedAt: iso.optional(), note: z.string().max(500).optional(), appeal: appealSchema.optional(),
});
const historySchema = z.strictObject({ revision: z.number().int().min(1), at: iso, actor: member, action: z.enum(['submitted', 'reviewed', 'accepted', 'corrected', 'disputed', 'upheld', 'retired', 'stale', 'reaffirmed', 'appealed', 'appeal-granted', 'appeal-denied', 'rejected']), summary: z.string().max(300).default(''), status: z.enum(STATUSES) });
export const entrySchema = z.strictObject({
  id: slug, subject: subjectSchema,
  claim: z.string().min(10).max(500), claimType: z.enum(['factual', 'opinion']),
  category: z.enum(['malware', 'phishing', 'scam', 'misinformation', 'harassment', 'tracking', 'accuracy', 'other']),
  recommended: z.enum(['label', 'warn', 'block']).default('label'),
  sources: z.array(sourceSchema).max(10).default([]),
  status: z.enum(STATUSES), submitter: member, lastEditor: member, createdAt: iso, updatedAt: iso, reviewBy: iso,
  revision: z.number().int().min(1), round: z.number().int().min(1),
  reviews: z.array(reviewSchema).max(100).default([]), disputes: z.array(disputeSchema).max(50).default([]),
  history: z.array(historySchema).max(100).default([]), correctionNote: z.string().max(1000).default(''),
}).superRefine((entry, ctx) => {
  const bad = message => ctx.addIssue({ code: 'custom', message });
  if (entry.claimType === 'factual' && !entry.sources.length) bad('A factual claim requires at least one source');
  if (entry.recommended === 'block' && (entry.claimType !== 'factual' || entry.subject.type !== 'domain')) bad('Only a sourced factual claim about a domain may recommend blocking');
  if (entry.recommended === 'warn' && entry.subject.type === 'entity') bad('A claim about an entity may only recommend a label');
});
export const governanceSchema = z.strictObject({
  roles: z.array(z.strictObject({ member, role: z.enum(ROLES), since: iso })).min(1).max(400),
  minReviewers: z.number().int().min(1).max(10).default(2),
  staleAfterDays: z.number().int().min(7).max(1095).default(365),
  limits: z.strictObject({
    maxEntries: z.number().int().min(1).max(5000).default(2000), maxPendingPerSubmitter: z.number().int().min(1).max(100).default(10),
    maxSubmissionsPerDay: z.number().int().min(1).max(100).default(5), maxOpenDisputesPerMember: z.number().int().min(1).max(100).default(10),
    maxClaimLength: z.number().int().min(20).max(500).default(500),
  }).prefault({}),
  appealsContact: z.string().max(300).default(''),
});
export const payloadSchema = z.strictObject({
  format: z.literal('weft-community-list'), formatVersion: z.literal(1),
  listId: slug, name: z.string().min(1).max(120), description: z.string().max(2000).default(''),
  publisher: z.strictObject({ keyId: z.string().regex(/^[a-f0-9]{64}$/) }),
  sequence: z.number().int().min(1), issuedAt: iso, expiresAt: iso.optional(),
  governance: governanceSchema, entries: z.array(entrySchema).max(5000),
  keyRotation: z.strictObject({ fromKeyId: z.string().regex(/^[a-f0-9]{64}$/), toKeyId: z.string().regex(/^[a-f0-9]{64}$/), toPublicKey: z.string().max(200), statement: z.string().min(1).max(1000), issuedAt: iso }).optional(),
}).superRefine((payload, ctx) => {
  const ids = new Set();
  for (const entry of payload.entries) { if (ids.has(entry.id)) ctx.addIssue({ code: 'custom', message: `Duplicate entry id ${entry.id}` }); ids.add(entry.id); }
  if (payload.entries.length > payload.governance.limits.maxEntries) ctx.addIssue({ code: 'custom', message: 'Entry count exceeds the list\'s own maxEntries limit' });
  if (!payload.governance.roles.some(role => role.role === 'maintainer')) ctx.addIssue({ code: 'custom', message: 'A list needs at least one maintainer' });
});

/** Verify the pinned-key signature (and both keys for a rotation), then schema-validate. Never applies anything. */
export function verifyRelease(text, { pinned, listId }) {
  const { envelope, payload: raw } = parseEnvelope(text);
  if (raw?.publisher?.keyId !== pinned.keyId) throw new ListError('LIST_KEY_UNPINNED', 'Release names a publisher key that is not the key pinned at subscription time');
  if (!signatureValid(envelope, pinned.keyId, pinned.publicKey)) throw new ListError('LIST_SIGNATURE', 'Signature does not verify against the pinned publisher key; the list is unsigned, tampered or from another publisher');
  let rotation = null;
  if (raw.keyRotation !== undefined) {
    const request = raw.keyRotation;
    if (request?.fromKeyId !== pinned.keyId) throw new ListError('LIST_ROTATION', 'Key rotation statement does not start from the pinned key');
    let derived;
    try { derived = keyIdOf(request.toPublicKey); } catch { throw new ListError('LIST_ROTATION', 'Key rotation names an invalid replacement key'); }
    if (derived !== request.toKeyId) throw new ListError('LIST_ROTATION', 'Key rotation key ID does not match the replacement key');
    if (!signatureValid(envelope, request.toKeyId, request.toPublicKey)) throw new ListError('LIST_ROTATION', 'Key rotation must be signed by both the pinned key and the replacement key');
    rotation = { fromKeyId: request.fromKeyId, toKeyId: request.toKeyId, toPublicKey: request.toPublicKey, statement: request.statement, issuedAt: request.issuedAt };
  }
  const parsed = payloadSchema.safeParse(raw);
  if (!parsed.success) throw new ListError('LIST_FORMAT', `Invalid community list: ${parsed.error.issues[0]?.path.join('.') || 'payload'}: ${parsed.error.issues[0]?.message}`);
  if (listId && parsed.data.listId !== listId) throw new ListError('LIST_IDENTITY', `Release is for list "${parsed.data.listId}", not "${listId}"`);
  return { payload: parsed.data, payloadText: envelope.payload, payloadSha256: sha256(envelope.payload), rotation, bytes: Buffer.byteLength(text), envelopeText: text, pinnedPublicKey: pinned.publicKey };
}

export const rolesOf = governance => {
  const roles = new Map();
  for (const item of governance.roles) { if (!roles.has(item.member)) roles.set(item.member, new Set()); roles.get(item.member).add(item.role); }
  return roles;
};
const holds = (roles, who, role) => roles.get(who)?.has(role) === true;

/** Distinct, authorised, independent approvals for the entry's current review round. */
export function validApprovals(entry, roles) {
  const approvers = new Set();
  for (const review of entry.reviews) {
    if (review.round !== entry.round || review.decision !== 'approve') continue;
    if (!holds(roles, review.reviewer, 'reviewer') || review.reviewer === entry.submitter || review.reviewer === entry.lastEditor) continue;
    approvers.add(review.reviewer);
  }
  return [...approvers];
}

/** Anti-abuse and role checks shared by publication and subscription. `blocking` violations disable the entry. */
export function governanceViolations(payload) {
  const roles = rolesOf(payload.governance);
  const { limits } = payload.governance;
  const out = new Map();
  const add = (id, code, blocking, detail) => { if (!out.has(id)) out.set(id, []); out.get(id).push({ code, blocking, detail }); };
  const bySubmitter = new Map();
  for (const entry of payload.entries) {
    if (!roles.has(entry.submitter)) add(entry.id, 'submitter-unknown', true, `${entry.submitter} holds no role in this list`);
    if (entry.claim.length > limits.maxClaimLength) add(entry.id, 'claim-size', true, `claim exceeds ${limits.maxClaimLength} characters`);
    if (!bySubmitter.has(entry.submitter)) bySubmitter.set(entry.submitter, []);
    bySubmitter.get(entry.submitter).push(entry);
    for (const review of entry.reviews) if (review.round === entry.round && review.decision === 'approve' && (!holds(roles, review.reviewer, 'reviewer') || review.reviewer === entry.submitter || review.reviewer === entry.lastEditor)) add(entry.id, 'approval-ignored', false, `approval by ${review.reviewer} does not count`);
  }
  const day = 86_400_000;
  for (const entries of bySubmitter.values()) {
    const sorted = [...entries].sort((a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt));
    sorted.forEach((entry, index) => {
      const at = Date.parse(entry.createdAt);
      if (sorted.filter((other, j) => j <= index && Date.parse(other.createdAt) > at - day).length > limits.maxSubmissionsPerDay) add(entry.id, 'rate-limit', true, `more than ${limits.maxSubmissionsPerDay} submissions by ${entry.submitter} within 24 hours`);
    });
    sorted.filter(entry => entry.status === 'proposed').forEach((entry, index) => { if (index >= limits.maxPendingPerSubmitter) add(entry.id, 'pending-cap', true, `more than ${limits.maxPendingPerSubmitter} pending proposals by ${entry.submitter}`); });
  }
  const openDisputes = new Map();
  for (const entry of payload.entries) for (const dispute of entry.disputes) if (dispute.state === 'open') openDisputes.set(dispute.openedBy, (openDisputes.get(dispute.openedBy) || 0) + 1);
  for (const [who, count] of openDisputes) if (count > limits.maxOpenDisputesPerMember) for (const entry of payload.entries) for (const dispute of entry.disputes) if (dispute.state === 'open' && dispute.openedBy === who) add(entry.id, 'dispute-limit', false, `${who} has more than ${limits.maxOpenDisputesPerMember} open disputes`);
  return out;
}

export const effectiveMinReviewers = (payload, floor = 1) => Math.max(payload.governance.minReviewers, floor, 1);

/**
 * What an entry may do for this subscriber. A single report never designates:
 * an accepted/corrected entry needs `minReviewers` independent approvals of its
 * current round, disputed and stale entries are label-only, and the ceiling is
 * further reduced by claim type, subject type, the publisher's recommendation
 * and the subscriber's own mode.
 */
export function entryEffect(entry, { payload, now, minReviewers, mode, violations }) {
  const roles = rolesOf(payload.governance);
  const approvals = validApprovals(entry, roles);
  const blocking = (violations?.get(entry.id) || []).filter(item => item.blocking);
  const reasons = [];
  let cap = 'none';
  const expired = Date.parse(entry.reviewBy) < now.getTime();
  if (blocking.length) reasons.push(...blocking.map(item => `${item.code}: ${item.detail}`));
  else if (entry.status === 'retired') reasons.push('retired');
  else if (entry.status === 'proposed') reasons.push('proposed: not yet accepted by reviewers');
  else if (entry.status === 'disputed') { cap = 'label'; reasons.push('disputed: shown as a label only until re-reviewed'); }
  else if (entry.status === 'stale' || expired) { cap = 'label'; reasons.push(`stale: review date ${entry.reviewBy} has passed`); }
  else if (approvals.length < minReviewers) reasons.push(`insufficient review: ${approvals.length} of ${minReviewers} independent reviewer approvals`);
  else if (entry.subject.type === 'entity') { cap = 'label'; reasons.push('entity claim: describes a party, so it can only label'); }
  else if (entry.claimType === 'opinion') { cap = 'warn'; reasons.push('opinion: cannot block'); }
  else cap = 'block';
  const behavior = cap === 'none' ? 'none' : minBehavior(cap, entry.recommended, mode);
  return { active: cap !== 'none', cap, behavior, reasons, approvals, approvalsNeeded: minReviewers };
}

export function subjectLabel(subject) {
  return subject.type === 'domain' ? `${subject.includeSubdomains ? '*.' : ''}${subject.hostname}${subject.path === '/' ? '' : subject.path}` : `entity "${subject.name}"${subject.domains.length ? ` (${subject.domains.join(', ')})` : ''}`;
}
export function subjectMatches(subject, host, pathname) {
  if (subject.type === 'entity') return subject.domains.some(domain => host === domain || host.endsWith(`.${domain}`));
  if (!(host === subject.hostname || (subject.includeSubdomains && host.endsWith(`.${subject.hostname}`)))) return false;
  return subject.path === '/' || pathname === subject.path || pathname.startsWith(`${subject.path.replace(/\/$/, '')}/`);
}

/** Evaluate a payload for one subscriber: per-entry effects and the site rules that enforce them. */
export function evaluateRelease(payload, { mode, exceptions = [], minReviewers = 1, now = new Date() }) {
  const floor = effectiveMinReviewers(payload, minReviewers);
  const violations = governanceViolations(payload);
  const excepted = new Set(exceptions.map(item => item.hostname));
  const entries = payload.entries.map(entry => {
    const effect = entryEffect(entry, { payload, now, minReviewers: floor, mode, violations });
    const isExcepted = entry.subject.type === 'domain' ? excepted.has(entry.subject.hostname) : entry.subject.domains.some(domain => excepted.has(domain));
    const behavior = isExcepted ? 'none' : effect.behavior;
    let rule = null;
    if (entry.subject.type === 'domain' && ['warn', 'block'].includes(behavior)) {
      const label = entry.claimType === 'opinion' ? 'Opinion' : 'Factual claim';
      rule = { hostname: entry.subject.hostname, includeSubdomains: entry.subject.includeSubdomains, path: entry.subject.path, behavior, mode: 'navigation',
        reason: `${payload.name}: ${label} - ${entry.claim}`.slice(0, 240), note: `${label} (${entry.category}); entry ${entry.id} revision ${entry.revision}; ${effect.approvals.length} reviewer approval(s); list sequence ${payload.sequence}` };
    }
    return { entry, effect, excepted: isExcepted, behavior, violations: violations.get(entry.id) || [], rule };
  });
  return { entries, rules: entries.filter(item => item.rule), minReviewers: floor, violations };
}

/** Community-list matches for one URL, including labels, disputed/stale and inactive entries, with provenance. */
export function matchRelease(payload, urlValue, options) {
  let url;
  try { url = new URL(urlValue); } catch { return []; }
  const host = url.hostname.toLowerCase().replace(/\.$/, '');
  const evaluation = evaluateRelease(payload, options);
  return evaluation.entries.filter(item => subjectMatches(item.entry.subject, host, url.pathname)).map(item => ({
    entryId: item.entry.id, revision: item.entry.revision, status: item.entry.status,
    subject: item.entry.subject, subjectLabel: subjectLabel(item.entry.subject), subjectType: item.entry.subject.type,
    claim: item.entry.claim, claimType: item.entry.claimType, claimKind: item.entry.claimType === 'opinion' ? 'Opinion' : 'Factual claim', category: item.entry.category,
    recommended: item.entry.recommended, effectiveBehavior: item.behavior, active: item.effect.active && !item.excepted, excepted: item.excepted,
    reasons: item.excepted ? ['per-site exception set by this subscriber', ...item.effect.reasons] : item.effect.reasons,
    provenance: { submitter: item.entry.submitter, lastEditor: item.entry.lastEditor, approvals: item.effect.approvals, approvalsNeeded: item.effect.approvalsNeeded,
      sources: item.entry.sources, createdAt: item.entry.createdAt, updatedAt: item.entry.updatedAt, reviewBy: item.entry.reviewBy,
      disputes: item.entry.disputes.map(({ id, state, reason, openedBy, appeal }) => ({ id, state, reason, openedBy, appeal: appeal ? appeal.state : null })),
      correctionNote: item.entry.correctionNote, history: item.entry.history.slice(-8) },
  }));
}

const summarise = item => ({ id: item.entry.id, subject: subjectLabel(item.entry.subject), subjectType: item.entry.subject.type, claim: item.entry.claim, claimType: item.entry.claimType, status: item.entry.status, revision: item.entry.revision, behavior: item.behavior, reasons: item.effect.reasons });
const comparable = ['claim', 'claimType', 'category', 'recommended', 'status', 'subject', 'sources', 'reviewBy', 'revision'];
const ruleKey = rule => JSON.stringify([rule.hostname, rule.includeSubdomains, rule.path]);

/** Everything a human needs before applying a release: entry changes, newly blocked domains, governance and key changes. */
export function diffReleases(before, after, options) {
  const next = evaluateRelease(after, options);
  const prev = before ? evaluateRelease(before, options) : { entries: [], rules: [] };
  const old = new Map(prev.entries.map(item => [item.entry.id, item]));
  const fresh = new Map(next.entries.map(item => [item.entry.id, item]));
  const added = next.entries.filter(item => !old.has(item.entry.id)).map(summarise);
  const removed = prev.entries.filter(item => !fresh.has(item.entry.id)).map(summarise);
  const changed = [];
  for (const item of next.entries) {
    const was = old.get(item.entry.id);
    if (!was) continue;
    const fields = comparable.filter(field => JSON.stringify(was.entry[field]) !== JSON.stringify(item.entry[field]));
    if (was.behavior !== item.behavior) fields.push('behavior');
    if (fields.length) changed.push({ id: item.entry.id, fields, before: { ...summarise(was), reviewBy: was.entry.reviewBy }, after: { ...summarise(item), reviewBy: item.entry.reviewBy }, correctionNote: item.entry.correctionNote });
  }
  const blockedBefore = new Set(prev.rules.filter(item => item.rule.behavior === 'block').map(item => ruleKey(item.rule)));
  const blockedAfter = new Set(next.rules.filter(item => item.rule.behavior === 'block').map(item => ruleKey(item.rule)));
  const describeRule = item => ({ hostname: item.rule.hostname, includeSubdomains: item.rule.includeSubdomains, path: item.rule.path, entryId: item.entry.id, claim: item.entry.claim, claimType: item.entry.claimType });
  const newlyBlocked = next.rules.filter(item => item.rule.behavior === 'block' && !blockedBefore.has(ruleKey(item.rule))).map(describeRule);
  const noLongerBlocked = prev.rules.filter(item => item.rule.behavior === 'block' && !blockedAfter.has(ruleKey(item.rule))).map(describeRule);
  const newlyWarned = next.rules.filter(item => item.rule.behavior === 'warn' && !prev.rules.some(was => was.rule.behavior !== 'label' && ruleKey(was.rule) === ruleKey(item.rule))).map(describeRule);
  const governanceChanges = [];
  if (before) {
    const roleSet = payload => new Set(payload.governance.roles.map(item => `${item.member}:${item.role}`));
    const [a, b] = [roleSet(before), roleSet(after)];
    for (const role of b) if (!a.has(role)) governanceChanges.push(`role added: ${role}`);
    for (const role of a) if (!b.has(role)) governanceChanges.push(`role removed: ${role}`);
    if (before.governance.minReviewers !== after.governance.minReviewers) governanceChanges.push(`minReviewers ${before.governance.minReviewers} -> ${after.governance.minReviewers}`);
    if (JSON.stringify(before.governance.limits) !== JSON.stringify(after.governance.limits)) governanceChanges.push('anti-abuse limits changed');
  }
  const warnings = [];
  if (before && after.governance.minReviewers < before.governance.minReviewers) warnings.push('The list lowered its reviewer threshold.');
  if (next.violations.size) warnings.push(`${[...next.violations.values()].filter(items => items.some(item => item.blocking)).length} entries violate list governance limits and are disabled.`);
  return { added, removed, changed, newlyBlocked, noLongerBlocked, newlyWarned, governanceChanges, warnings,
    counts: { entries: after.entries.length, previousEntries: before?.entries.length ?? 0, enforcedRules: next.rules.length, blockRules: blockedAfter.size, labelOnly: next.entries.filter(item => item.behavior === 'label').length } };
}
