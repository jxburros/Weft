import { addRole, createList, publishRelease, reviewEntry, submitEntry } from '../../src/list-governance.js';
import { generateKeyPair } from '../../src/list-signing.js';

export const T0 = new Date('2026-10-01T00:00:00.000Z');
export const later = (days, base = T0) => new Date(base.getTime() + days * 86_400_000);

/** A small group: one maintainer, three reviewers, one submitter; two reviewers required by default. */
export function newGroup({ minReviewers = 2, now = T0 } = {}) {
  const keys = generateKeyPair();
  let state = createList({ listId: 'group-list', name: 'Group safety list', description: 'Test group list', keyId: keys.keyId, maintainer: 'maint', minReviewers, now });
  for (const member of ['rev1', 'rev2', 'rev3']) state = addRole(state, { actor: 'maint', member, role: 'reviewer', now });
  state = addRole(state, { actor: 'maint', member: 'sub1', role: 'submitter', now });
  return { keys, state };
}

export const factualDomain = (hostname = 'bad.example', extra = {}) => ({
  subject: { type: 'domain', hostname, includeSubdomains: true, path: '/' },
  claim: `${hostname} served a credential-harvesting page imitating a bank login on 2026-09-20.`,
  claimType: 'factual', category: 'phishing', recommended: 'block',
  sources: [{ title: 'Incident write-up', url: 'https://reports.example.org/incidents/42', retrievedAt: '2026-09-21T00:00:00.000Z' }], ...extra,
});

/** Submit as sub1 and have rev1 + rev2 approve it, returning the accepted state and entry id. */
export function acceptEntry(state, fields, now = T0, reviewers = ['rev1', 'rev2']) {
  const submitted = submitEntry(state, { actor: 'sub1', entry: fields, now });
  let next = submitted.state;
  for (const reviewer of reviewers) next = reviewEntry(next, { actor: reviewer, entryId: submitted.entry.id, decision: 'approve', now }).state;
  return { state: next, id: submitted.entry.id };
}

export function release(group, state, now = T0) {
  const out = publishRelease(state, { privateKeyPem: group.keys.privateKeyPem, now });
  return { ...out, data: out.envelope };
}
