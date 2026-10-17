import { randomBytes } from 'node:crypto';
import { buildEnvelope, keyIdOf, publicKeyOfPrivate, sha256 } from './list-signing.js';
import { entrySchema, governanceSchema, governanceViolations, payloadSchema, rolesOf, validApprovals } from './list-format.js';

/**
 * Maintainer-side governance for a file-based community list. State is a plain
 * JSON document (list.json) that a group can keep in any git repository; every
 * function is pure (clone, mutate, return) so history is reviewable as diffs.
 *
 * Roles are attestations recorded by the maintainers who hold the signing key.
 * This module does not authenticate the named member: authenticate contributors
 * with your git host (pull-request review, protected branches) and treat the
 * signature as the maintainers' statement that the recorded process happened.
 */
export class GovernanceError extends Error {
  constructor(code, message) { super(`${code}: ${message}`); this.name = 'GovernanceError'; this.code = code; }
}
const fail = (code, message) => { throw new GovernanceError(code, message); };
const stamp = now => new Date(now).toISOString();
const days = value => value * 86_400_000;
const clone = value => structuredClone(value);
const find = (state, id) => state.entries.find(entry => entry.id === id) || fail('ENTRY_NOT_FOUND', `No entry ${id}`);
const hasRole = (state, who, role) => rolesOf(state.governance).get(who)?.has(role) === true;
const needRole = (state, who, ...roles) => { if (!roles.some(role => hasRole(state, who, role))) fail('ROLE_REQUIRED', `${who} needs the ${roles.join(' or ')} role for this action`); };
const record = (entry, now, actor, action, summary = '') => { entry.history.push({ revision: entry.revision, at: stamp(now), actor, action, summary: summary.slice(0, 300), status: entry.status }); entry.updatedAt = stamp(now); };
const nextReview = (state, now) => stamp(Date.parse(stamp(now)) + days(state.governance.staleAfterDays));

export function createList({ listId, name, description = '', keyId, maintainer, minReviewers = 2, now = new Date(), limits = {}, staleAfterDays = 365 }) {
  const governance = governanceSchema.parse({ roles: [{ member: maintainer, role: 'maintainer', since: stamp(now) }, { member: maintainer, role: 'reviewer', since: stamp(now) }, { member: maintainer, role: 'submitter', since: stamp(now) }], minReviewers, staleAfterDays, limits });
  return { format: 'weft-community-list-source', formatVersion: 1, listId, name, description, keyId, sequence: 0, governance, entries: [] };
}

export function addRole(state, { actor, member, role, now = new Date() }) {
  const next = clone(state);
  needRole(next, actor, 'maintainer');
  if (hasRole(next, member, role)) fail('ROLE_EXISTS', `${member} already holds ${role}`);
  next.governance.roles.push({ member, role, since: stamp(now) });
  governanceSchema.parse(next.governance);
  return next;
}
export function removeRole(state, { actor, member, role }) {
  const next = clone(state);
  needRole(next, actor, 'maintainer');
  if (!hasRole(next, member, role)) fail('ROLE_MISSING', `${member} does not hold ${role}`);
  next.governance.roles = next.governance.roles.filter(item => !(item.member === member && item.role === role));
  if (!next.governance.roles.some(item => item.role === 'maintainer')) fail('LAST_MAINTAINER', 'A list needs at least one maintainer');
  return next;
}
export function setPolicy(state, { actor, minReviewers, staleAfterDays, limits }) {
  const next = clone(state);
  needRole(next, actor, 'maintainer');
  if (minReviewers !== undefined) next.governance.minReviewers = minReviewers;
  if (staleAfterDays !== undefined) next.governance.staleAfterDays = staleAfterDays;
  if (limits) next.governance.limits = { ...next.governance.limits, ...limits };
  governanceSchema.parse(next.governance);
  return next;
}

export function submitEntry(state, { actor, entry: fields, now = new Date() }) {
  const next = clone(state);
  needRole(next, actor, 'submitter', 'reviewer', 'maintainer');
  const { limits } = next.governance;
  if (next.entries.length >= limits.maxEntries) fail('LIMIT_ENTRIES', `List already holds ${limits.maxEntries} entries`);
  const mine = next.entries.filter(entry => entry.submitter === actor);
  if (mine.filter(entry => entry.status === 'proposed').length >= limits.maxPendingPerSubmitter) fail('LIMIT_PENDING', `${actor} already has ${limits.maxPendingPerSubmitter} pending proposals`);
  if (mine.filter(entry => Date.parse(entry.createdAt) > Date.parse(stamp(now)) - days(1)).length >= limits.maxSubmissionsPerDay) fail('LIMIT_RATE', `${actor} reached ${limits.maxSubmissionsPerDay} submissions in 24 hours`);
  if (typeof fields?.claim === 'string' && fields.claim.length > limits.maxClaimLength) fail('LIMIT_SIZE', `Claims are limited to ${limits.maxClaimLength} characters`);
  const created = stamp(now);
  const entry = entrySchema.parse({ recommended: 'label', sources: [], ...fields, id: `e-${randomBytes(5).toString('hex')}`, status: 'proposed', submitter: actor, lastEditor: actor, createdAt: created, updatedAt: created,
    reviewBy: nextReview(next, now), revision: 1, round: 1, reviews: [], disputes: [], history: [], correctionNote: '' });
  record(entry, now, actor, 'submitted', entry.claim);
  next.entries.push(entry);
  return { state: next, entry };
}

const openAppeal = entry => entry.disputes.some(dispute => dispute.appeal?.state === 'open');
const distinctReviewers = (entry, state, decision) => new Set(entry.reviews.filter(review => review.round === entry.round && review.decision === decision && hasRole(state, review.reviewer, 'reviewer') && review.reviewer !== entry.submitter && review.reviewer !== entry.lastEditor).map(review => review.reviewer));

export function reviewEntry(state, { actor, entryId, decision, note = '', now = new Date() }) {
  const next = clone(state);
  needRole(next, actor, 'reviewer');
  const entry = find(next, entryId);
  if (entry.status === 'retired') fail('ENTRY_RETIRED', 'Retired entries cannot be reviewed; appeal or resubmit');
  if (actor === entry.submitter || actor === entry.lastEditor) fail('CONFLICT_OF_INTEREST', 'Reviewers cannot review claims they submitted or last edited');
  if (entry.reviews.some(review => review.round === entry.round && review.reviewer === actor)) fail('ALREADY_REVIEWED', `${actor} already reviewed this round`);
  entry.reviews.push({ reviewer: actor, decision, at: stamp(now), round: entry.round, note });
  record(entry, now, actor, 'reviewed', `${decision}${note ? `: ${note}` : ''}`);
  const needed = next.governance.minReviewers;
  if (openAppeal(entry)) return { state: next, entry, transition: null };
  let transition = null;
  if (decision === 'approve' && validApprovals(entry, rolesOf(next.governance)).length >= needed) {
    if (['proposed', 'disputed', 'stale'].includes(entry.status)) {
      const was = entry.status;
      entry.status = 'accepted';
      for (const dispute of entry.disputes) if (dispute.state === 'open') { dispute.state = 'upheld'; dispute.resolvedAt = stamp(now); dispute.note = `Upheld by ${needed} independent reviewers`; }
      record(entry, now, actor, was === 'proposed' ? 'accepted' : was === 'disputed' ? 'upheld' : 'reaffirmed', `${needed} independent approvals`);
      transition = `${was} -> accepted`;
    }
    entry.reviewBy = nextReview(next, now);
  } else if (decision === 'reject' && distinctReviewers(entry, next, 'reject').size >= needed) {
    entry.status = 'retired';
    for (const dispute of entry.disputes) if (dispute.state === 'open') { dispute.state = 'retired'; dispute.resolvedAt = stamp(now); }
    record(entry, now, actor, 'rejected', `${needed} independent rejections`);
    transition = 'retired by review';
  }
  return { state: next, entry, transition };
}

const correctable = ['claim', 'claimType', 'category', 'recommended', 'subject', 'sources'];
export function correctEntry(state, { actor, entryId, changes, note, now = new Date() }) {
  const next = clone(state);
  const entry = find(next, entryId);
  if (!(hasRole(next, actor, 'reviewer') || hasRole(next, actor, 'maintainer') || (actor === entry.submitter && hasRole(next, actor, 'submitter')))) fail('ROLE_REQUIRED', 'Corrections come from a reviewer, maintainer or the original submitter');
  if (entry.status === 'retired') fail('ENTRY_RETIRED', 'Retired entries cannot be corrected; submit a new entry');
  if (typeof note !== 'string' || note.trim().length < 5) fail('NOTE_REQUIRED', 'A correction needs an explanatory note');
  for (const key of Object.keys(changes || {})) if (!correctable.includes(key)) fail('FIELD_NOT_CORRECTABLE', `${key} cannot be changed by a correction`);
  const corrected = { ...entry, ...changes, revision: entry.revision + 1, round: entry.round + 1, status: 'corrected', lastEditor: actor, correctionNote: note, reviewBy: nextReview(next, now), history: entry.history };
  // Corrections are re-reviewed like a new claim: until then the entry designates nothing.
  for (const dispute of corrected.disputes) if (dispute.state === 'open' && dispute.appeal?.state !== 'open') { dispute.state = 'corrected'; dispute.resolvedAt = stamp(now); dispute.note = note.slice(0, 500); }
  const parsed = entrySchema.parse(corrected);
  Object.assign(entry, parsed);
  record(entry, now, actor, 'corrected', note);
  return { state: next, entry };
}

export function disputeEntry(state, { actor, entryId, reason, reporter = '', now = new Date() }) {
  const next = clone(state);
  if (!rolesOf(next.governance).has(actor)) fail('ROLE_REQUIRED', 'Disputes are recorded by a list member; record outside reports with --reporter');
  const entry = find(next, entryId);
  if (!['accepted', 'corrected', 'stale', 'disputed'].includes(entry.status)) fail('NOT_DISPUTABLE', `A ${entry.status} entry cannot be disputed`);
  const open = next.entries.reduce((count, other) => count + other.disputes.filter(dispute => dispute.state === 'open' && dispute.openedBy === actor).length, 0);
  if (open >= next.governance.limits.maxOpenDisputesPerMember) fail('LIMIT_DISPUTES', `${actor} already has ${open} open disputes`);
  if (entry.status !== 'disputed') { entry.status = 'disputed'; entry.round += 1; }
  entry.disputes.push({ id: `d${entry.disputes.length + 1}`, openedBy: actor, reporter, at: stamp(now), reason, state: 'open' });
  record(entry, now, actor, 'disputed', reason);
  return { state: next, entry };
}

export function appealDispute(state, { actor, entryId, disputeId, reason, now = new Date() }) {
  const next = clone(state);
  const entry = find(next, entryId);
  const dispute = entry.disputes.find(item => item.id === disputeId) || fail('DISPUTE_NOT_FOUND', `No dispute ${disputeId}`);
  if (dispute.state === 'open') fail('DISPUTE_OPEN', 'A dispute can only be appealed after it has been resolved');
  if (dispute.appeal) fail('APPEAL_EXISTS', 'This dispute has already been appealed');
  if (actor !== dispute.openedBy && actor !== entry.submitter) fail('ROLE_REQUIRED', 'Only the disputing member or the entry submitter can appeal');
  dispute.appeal = { by: actor, at: stamp(now), reason, state: 'open', priorStatus: entry.status };
  if (entry.status !== 'retired') entry.status = 'disputed';
  record(entry, now, actor, 'appealed', reason);
  return { state: next, entry };
}

export function decideAppeal(state, { actor, entryId, disputeId, outcome, note = '', now = new Date() }) {
  const next = clone(state);
  needRole(next, actor, 'maintainer');
  const entry = find(next, entryId);
  const dispute = entry.disputes.find(item => item.id === disputeId);
  const appeal = dispute?.appeal;
  if (appeal?.state !== 'open') fail('NO_OPEN_APPEAL', 'There is no open appeal on that dispute');
  const involved = new Set([entry.submitter, entry.lastEditor, appeal.by, dispute.openedBy, ...entry.reviews.filter(review => review.round === entry.round).map(review => review.reviewer)]);
  if (involved.has(actor)) fail('CONFLICT_OF_INTEREST', 'Appeals are decided by a maintainer who was not involved in the entry, dispute or review');
  appeal.decidedBy = actor; appeal.decidedAt = stamp(now); appeal.note = note;
  if (outcome === 'deny') {
    appeal.state = 'denied'; entry.status = appeal.priorStatus;
    record(entry, now, actor, 'appeal-denied', note);
  } else {
    appeal.state = 'granted';
    if (appeal.priorStatus === 'retired') { entry.status = 'proposed'; entry.round += 1; } else { entry.status = 'retired'; }
    record(entry, now, actor, 'appeal-granted', note);
  }
  return { state: next, entry };
}

export function retireEntry(state, { actor, entryId, note = '', now = new Date() }) {
  const next = clone(state);
  needRole(next, actor, 'maintainer');
  const entry = find(next, entryId);
  if (entry.status === 'retired') fail('ENTRY_RETIRED', 'Entry is already retired');
  entry.status = 'retired';
  for (const dispute of entry.disputes) if (dispute.state === 'open') { dispute.state = 'retired'; dispute.resolvedAt = stamp(now); dispute.note = note.slice(0, 500); }
  record(entry, now, actor, 'retired', note || 'Retired by maintainer');
  return { state: next, entry };
}

/** Move accepted entries past their review date to stale; a fresh independent review round reaffirms them. */
export function markStale(state, { actor, now = new Date() }) {
  const next = clone(state);
  needRole(next, actor, 'maintainer', 'reviewer');
  const marked = [];
  for (const entry of next.entries) {
    if (['accepted', 'corrected'].includes(entry.status) && Date.parse(entry.reviewBy) < Date.parse(stamp(now))) {
      entry.status = 'stale'; entry.round += 1; record(entry, now, actor, 'stale', `Review date ${entry.reviewBy} passed`); marked.push(entry.id);
    }
  }
  return { state: next, marked };
}

export function listStatus(state, now = new Date()) {
  const byStatus = Object.fromEntries(['proposed', 'accepted', 'disputed', 'corrected', 'retired', 'stale'].map(status => [status, state.entries.filter(entry => entry.status === status).length]));
  const roles = rolesOf(state.governance);
  const needed = state.governance.minReviewers;
  return { listId: state.listId, name: state.name, sequence: state.sequence, keyId: state.keyId, minReviewers: needed, byStatus,
    awaitingReview: state.entries.filter(entry => ['proposed', 'corrected', 'stale', 'disputed'].includes(entry.status) && validApprovals(entry, roles).length < needed).map(entry => ({ id: entry.id, status: entry.status, approvals: validApprovals(entry, roles).length, needed })),
    staleDue: state.entries.filter(entry => ['accepted', 'corrected'].includes(entry.status) && Date.parse(entry.reviewBy) < Date.parse(stamp(now))).map(entry => entry.id),
    openDisputes: state.entries.flatMap(entry => entry.disputes.filter(dispute => dispute.state === 'open').map(dispute => ({ entry: entry.id, dispute: dispute.id, by: dispute.openedBy }))),
    openAppeals: state.entries.flatMap(entry => entry.disputes.filter(dispute => dispute.appeal?.state === 'open').map(dispute => ({ entry: entry.id, dispute: dispute.id, by: dispute.appeal.by }))),
    roles: [...roles].map(([member, set]) => ({ member, roles: [...set] })) };
}

const compact = entry => ({ ...entry, history: entry.history.length > 50 ? [entry.history[0], ...entry.history.slice(-49)] : entry.history });
function buildPayload(state, { now, keyId, extra = {}, expiresInDays }) {
  const payload = { format: 'weft-community-list', formatVersion: 1, listId: state.listId, name: state.name, description: state.description, publisher: { keyId },
    sequence: state.sequence + 1, issuedAt: stamp(now), ...(expiresInDays ? { expiresAt: stamp(Date.parse(stamp(now)) + days(expiresInDays)) } : {}),
    governance: state.governance, entries: state.entries.map(compact), ...extra };
  const parsed = payloadSchema.parse(payload);
  const blocking = [...governanceViolations(parsed)].flatMap(([id, items]) => items.filter(item => item.blocking).map(item => `${id}: ${item.code} (${item.detail})`));
  if (blocking.length) fail('GOVERNANCE_VIOLATION', `Refusing to publish entries that break list governance: ${blocking.join('; ')}`);
  return parsed;
}

/** Sign the next sequence number. The returned envelope is what a group hosts at any URL or repository path. */
export function publishRelease(state, { privateKeyPem, now = new Date(), expiresInDays }) {
  const signer = publicKeyOfPrivate(privateKeyPem);
  if (state.keyId && signer.keyId !== state.keyId) fail('WRONG_KEY', 'The signing key is not the list\'s current publisher key');
  const payload = buildPayload(state, { now, keyId: signer.keyId, expiresInDays });
  const payloadText = JSON.stringify(payload);
  return { state: { ...clone(state), keyId: signer.keyId, sequence: payload.sequence }, envelope: buildEnvelope(payloadText, [privateKeyPem]), payload, payloadSha256: sha256(payloadText) };
}

/** Rotation release: signed by the old key (authority) and the new key (proof of possession), announced with a statement. */
export function rotateKey(state, { currentPrivateKeyPem, nextPrivateKeyPem, statement, now = new Date() }) {
  const current = publicKeyOfPrivate(currentPrivateKeyPem);
  const successor = publicKeyOfPrivate(nextPrivateKeyPem);
  if (state.keyId && current.keyId !== state.keyId) fail('WRONG_KEY', 'The current key is not the list\'s publisher key');
  if (current.keyId === successor.keyId) fail('SAME_KEY', 'The replacement key must differ from the current key');
  if (typeof statement !== 'string' || statement.trim().length < 10) fail('NOTE_REQUIRED', 'A rotation needs a human-readable statement of why');
  const payload = buildPayload(state, { now, keyId: current.keyId, extra: { keyRotation: { fromKeyId: current.keyId, toKeyId: successor.keyId, toPublicKey: successor.publicKey, statement, issuedAt: stamp(now) } } });
  const payloadText = JSON.stringify(payload);
  keyIdOf(successor.publicKey);
  return { state: { ...clone(state), keyId: successor.keyId, sequence: payload.sequence }, envelope: buildEnvelope(payloadText, [currentPrivateKeyPem, nextPrivateKeyPem]), payload, payloadSha256: sha256(payloadText) };
}
