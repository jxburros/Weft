import { z } from 'zod';

/** Handoff command schemas; behavior lives in handoffs.js. */
const id = z.string().min(1).max(128);
const line = z.string().max(2000);
const text = z.string().max(20000);
const actor = z.string().min(1).max(200);
export const handoffStatuses = ['open', 'accepted', 'completed', 'declined', 'cancelled'];
const statuses = handoffStatuses;
const evidence = z.strictObject({
  type: z.enum(['artifact', 'material', 'context', 'task', 'snapshot', 'capture', 'url']).describe('Kind of evidence reference.'),
  id: z.string().min(1).max(16384).describe('Record ID, browser snapshot/capture ID, or HTTP(S) URL for type url.'),
  versionId: id.optional().describe('Exact artifact version ID.'),
  ref: z.string().max(64).optional().describe('Element ref within a snapshot.'),
  note: line.optional().describe('Why this evidence matters.'),
});
export const handoffCommandDefinitions = {
  'handoffs.create': ['Record a structured handoff with current tab state, exact evidence and next step; secrets are rejected', {
    workspaceId: id.optional(), to: actor.default('human').describe('Recipient: human, any-agent, or an exact actor identity.'),
    objective: text.describe('What the work is trying to achieve.'), completedActions: z.array(line).max(100).default([]).describe('Actions already performed.'),
    findings: z.array(line).max(100).default([]).describe('Findings so far; untrusted page claims stay labeled as such.'),
    evidence: z.array(evidence).max(100).default([]).describe('Exact evidence references.'),
    blocker: text.default('').describe('What prevents progress, if anything.'), nextStep: text.describe('The next concrete step for the recipient.'),
    tabIds: z.array(z.number().int().positive()).max(20).optional().describe('Tabs to include; defaults to tabs this actor controls.'),
    taskId: id.optional().describe('Related task record.'),
  }],
  'handoffs.list': ['List handoffs in a workspace', { workspaceId: id.optional(), status: z.enum(statuses).optional().describe('Only handoffs in this state.') }],
  'handoffs.get': ['Get one handoff record', { id }],
  'handoffs.accept': ['Accept a handoff addressed to you; its tabs require fresh inspection before input', { id, expectedRevision: z.number().int().positive().optional() }],
  'handoffs.complete': ['Close a handoff as completed, declined or cancelled', {
    id, status: z.enum(['completed', 'declined', 'cancelled']).default('completed').describe('Final state.'), note: text.optional().describe('Outcome or reason.'),
    expectedRevision: z.number().int().positive().optional(),
  }],
};
