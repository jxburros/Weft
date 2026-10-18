import { z } from 'zod';
import { AUTONOMY_LEVELS } from './autonomy.js';

/**
 * Schemas for runtime-managed task plans, workflow parameters/steps and the
 * task-runtime commands. Behavior lives in src/task-runtime.js. Zod only, so
 * workspace-commands.js and commands.js can both import it.
 */
const id = z.string().min(1).max(128);
const note = z.string().max(2000);
export const stepIdField = z.string().regex(/^[A-Za-z0-9_-]{1,40}$/, 'Use 1-40 letters, digits, dashes or underscores');
export const STEP_KINDS = Object.freeze(['command', 'model', 'review', 'handoff']);
const expect = z.strictObject({
  urlPattern: z.string().min(1).max(2048).optional().describe('Expected page URL before this step: an origin and path, * matches any characters (for example https://example.com/orders/*).'),
}).describe('Assumptions checked before the step runs; a mismatch pauses the task as an invalidated step.');
const stepFields = {
  id: stepIdField.optional().describe('Stable step identifier; assigned when omitted.'),
  kind: z.enum(STEP_KINDS).describe('command: one catalog command; model: a chat.send turn; review: a human checkpoint; handoff: a handoffs.create record that the task waits on.'),
  title: z.string().trim().min(1).max(240),
  command: z.string().min(1).max(100).optional().describe('Catalog command for a command step.'),
  args: z.record(z.string(), z.unknown()).optional().describe('Command arguments; {{name}} placeholders are workflow parameters.'),
  prompt: z.string().min(1).max(100000).optional().describe('Message for a model step.'),
  modelId: id.optional().describe('Model connection for this model step; defaults to the task model.'),
  instruction: z.string().max(20000).optional().describe('What a reviewer or handoff recipient should do.'),
  to: z.string().min(1).max(200).optional().describe('Handoff recipient: human, any-agent or an actor identity.'),
  reviewRequired: z.boolean().optional().describe('A person approves in Weft before this step runs.'),
  deadlineMs: z.number().int().min(1).max(600000).optional().describe('Request deadline for a command step (the deadlineMs contract): an expired deadline before start pauses the step; after start it reports rolled back, stopped or uncertain.'),
  expect: expect.optional(),
};
function checkStep(step, ctx) {
  const need = (field, message) => { if (step[field] === undefined) ctx.addIssue({ code: 'custom', path: [field], message }); };
  if (step.kind === 'command') need('command', 'Command steps need a command');
  if (step.kind === 'model') need('prompt', 'Model steps need a prompt');
  if (step.kind !== 'command' && step.args !== undefined) ctx.addIssue({ code: 'custom', path: ['args'], message: 'Only command steps take args' });
}
export const taskStep = z.strictObject(stepFields).superRefine(checkStep);
export const taskPlan = z.array(taskStep).max(100);

/** Who executes a runtime-managed task. Only a human may bind a task to another identity. */
export const executorSchema = z.discriminatedUnion('type', [
  z.strictObject({ type: z.literal('runner'), autonomy: z.enum(AUTONOMY_LEVELS).default('scoped').describe('Autonomy level of the built-in task runner identity for this task.') }),
  z.strictObject({ type: z.literal('client'), clientId: z.string().uuid().describe('Existing agent connection grant the task runs under.') }),
  z.strictObject({ type: z.literal('automation') }).describe('The bootstrap-token automation identity.'),
]);

export const PARAMETER_TYPES = Object.freeze(['string', 'number', 'boolean', 'url', 'enum', 'credential']);
export const parameterName = z.string().regex(/^[A-Za-z][A-Za-z0-9_]{0,63}$/, 'Use a letter followed by letters, digits or underscores');
const parameterValue = z.union([z.string().max(10000), z.number(), z.boolean()]);
export const workflowParameter = z.union([
  z.string().trim().min(1).max(200).describe('Legacy free-text parameter; treated as a required string.'),
  z.strictObject({
    name: parameterName, label: z.string().max(200).optional(), type: z.enum(PARAMETER_TYPES).default('string'), required: z.boolean().default(true),
    default: parameterValue.optional(), options: z.array(z.string().max(200)).max(100).optional().describe('Allowed values for an enum parameter.'),
    description: z.string().max(2000).optional(),
    sensitive: z.boolean().optional().describe('Value is kept only in memory for the run and never written to records or logs.'),
  }),
]);
export const workflowStep = z.strictObject({
  title: z.string().trim().min(1).max(240), instruction: z.string().max(500000).default(''), reviewRequired: z.boolean().default(true),
  kind: z.enum(['instruction', ...STEP_KINDS]).optional().describe('Omitted or instruction: a human checkpoint with this instruction.'),
  command: stepFields.command, args: stepFields.args, prompt: stepFields.prompt, modelId: stepFields.modelId, to: stepFields.to, expect: expect.optional(),
  recorded: z.strictObject({ source: z.enum(['command', 'navigation', 'page']), at: z.string().max(40), note: z.string().max(500).optional() }).optional().describe('Provenance of a recorded step.'),
});
export const credentialRef = z.strictObject({
  name: parameterName, ref: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,199}$/, 'Opaque credential reference id from credentials.list; never a secret value'),
  purpose: z.string().max(500).optional(),
});
const parameters = z.record(parameterName, parameterValue).describe('Workflow parameter values by name.');

export const taskCommandDefinitions = {
  'tasks.start': ['Start executing a task plan through the shared gate as a bound identity; agents may bind only themselves', {
    id, executor: executorSchema.optional().describe('Identity the task runs as. Humans choose; agents are bound to their own identity.'),
    modelId: id.optional().describe('Default model connection for model steps.'),
  }],
  'tasks.pause': ['Pause a runtime task; no new steps are scheduled and work already submitted is reported', { id, note: note.optional() }],
  'tasks.continue': ['Continue a paused or waiting runtime task (not an uncertain one: reconcile or confirm a retry first)', {
    id, note: note.optional(), disclosureAck: z.boolean().optional().describe('Human acknowledgement of a pending cloud model disclosure for the next model step.'),
    parameters: parameters.optional().describe('Human re-entry of sensitive workflow parameter values after a restart.'),
  }],
  'tasks.cancel': ['Cancel a runtime task; no new steps are scheduled and already-submitted work is reported, not undone', { id, note: note.optional() }],
  'tasks.redirect': ['Change a runtime task objective, model or remaining steps; completed steps and evidence stay', {
    id, objective: z.string().max(500000).optional(), nextStep: z.string().max(500000).optional(), modelId: id.optional(),
    steps: taskPlan.optional().describe('Replaces every step that has not started.'), note: note.optional(),
  }],
  'tasks.reassign': ['Human rebinds a task to another identity or assignee; takes effect from the next step', {
    id, executor: executorSchema.optional(), assignee: z.string().max(200).optional(), note: note.optional(),
  }],
  'tasks.review': ['Human decides a review checkpoint: approve, reject or edit the remaining steps and approve', {
    id, stepId: stepIdField, decision: z.enum(['approve', 'reject', 'edit']), note: note.optional(),
    steps: taskPlan.optional().describe('For edit: replacement for the remaining steps, including this one.'),
  }],
  'tasks.reconcile': ['Human records the outcome of uncertain work, or runs a recorded lookup; never repeats the work', {
    id, operationId: z.string().regex(/^op_[0-9a-f-]{36}$/), determination: z.enum(['completed', 'not_completed', 'lookup']).describe('completed: it happened; not_completed: it did not happen; lookup: ask the registered reconciler.'),
    note: note.optional(), evidence: z.array(id).max(20).optional().describe('Record or artifact IDs supporting the determination.'),
    continue: z.boolean().optional().describe('Resume the task after recording the determination.'),
  }],
  'tasks.retryStep': ['Human retries a failed step; uncertain external work needs confirmDuplicateRisk: true', {
    id, stepId: stepIdField.optional(), confirmDuplicateRisk: z.boolean().optional().describe('Required for uncertain external work: you accept that it may happen twice.'), note: note.optional(),
  }],
  'workflows.run': ['Run an enabled workflow with typed parameters as a runtime task under current grants', {
    id, parameters: parameters.default({}), executor: executorSchema.optional(), modelId: id.optional(), tabId: z.number().int().positive().optional().describe('Tab the run starts in.'),
    start: z.boolean().default(true).describe('Create the task without starting it when false.'),
  }],
  'workflows.validate': ['Validate a workflow and optional parameter values without running it', { id, parameters: parameters.optional() }],
  'workflows.recordStart': ['Human starts recording their own actions in a tab as secret-free workflow steps', { tabId: z.number().int().positive(), title: z.string().trim().min(1).max(240).optional() }],
  'workflows.recordStop': ['Human stops recording; saves an inactive workflow for review unless discard is true', { tabId: z.number().int().positive(), discard: z.boolean().optional() }],
};
export const taskSchemas = Object.fromEntries(Object.entries(taskCommandDefinitions).map(([name, [, shape]]) => [name, z.strictObject(shape)]));
