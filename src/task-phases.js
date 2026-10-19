/**
 * One phase vocabulary for tasks, workflow runs and model turns, with the
 * permitted transitions. Pure: no I/O. The workspace store persists every
 * transition on the task record (actor, reason, time) and the task runtime
 * mirrors it into the durable activity log. See docs/decisions/016-durable-task-runtime.md.
 */
export const PHASES = Object.freeze(['queued', 'running', 'waiting_on_human', 'paused', 'completed', 'failed', 'cancelled', 'uncertain']);
export const TERMINAL_PHASES = Object.freeze(['completed', 'failed', 'cancelled']);
/** Phases in which a runtime-managed task holds work that a person or the runtime still has to resolve. */
// Record-only tasks (tracked by hand) may also be marked completed or failed directly; runtime tasks
// reach completed only through their runtime (tasks.transition is refused for them).
export const TRANSITIONS = Object.freeze({
  queued: Object.freeze(['running', 'waiting_on_human', 'paused', 'completed', 'failed', 'cancelled']),
  running: Object.freeze(['waiting_on_human', 'paused', 'completed', 'failed', 'cancelled', 'uncertain']),
  waiting_on_human: Object.freeze(['running', 'paused', 'completed', 'cancelled', 'failed', 'uncertain']),
  paused: Object.freeze(['running', 'queued', 'waiting_on_human', 'completed', 'cancelled', 'uncertain', 'failed']),
  // Uncertain work leaves only through a recorded determination, an explicitly confirmed retry, or a stop.
  uncertain: Object.freeze(['paused', 'running', 'failed', 'cancelled']),
  completed: Object.freeze(['queued']),
  failed: Object.freeze(['queued', 'running', 'paused']),
  cancelled: Object.freeze(['queued']),
});
/** Reason codes recorded with transitions. Free text goes in `note`. */
export const TRANSITION_REASONS = Object.freeze(['created', 'human_request', 'agent_request', 'started', 'step_completed', 'plan_completed', 'step_failed',
  'approval_required', 'approval_approved', 'approval_rejected', 'approval_expired', 'review_required', 'review_approved', 'review_rejected', 'review_edited',
  'handoff_waiting', 'handoff_completed', 'handoff_closed', 'disclosure_required', 'grant_inactive', 'permission_denied', 'invalidated_step',
  'destination_not_allowed', 'parameters_required', 'partial_output', 'external_outcome_unknown', 'server_restart', 'server_restart_uncertain',
  'emergency_stop', 'cancel_requested', 'pause_requested', 'continued', 'redirected', 'reassigned', 'reconciled', 'retry_confirmed', 'retry',
  'imported', 'expected_outputs_review', 'legacy', 'profile_locked', 'deadline_exceeded']);
const TIMELINE_LIMIT = 500;

export function canTransition(from, to) { return Object.hasOwn(TRANSITIONS, from) && TRANSITIONS[from].includes(to); }
/** Older stores used `waiting`; it is the same phase as `waiting_on_human`. */
export function normalizePhase(status) { return status === 'waiting' ? 'waiting_on_human' : status; }

/** Model turn manifest statuses expressed in the shared vocabulary. */
const TURN_PHASES = { running: 'running', complete: 'completed', partial: 'completed', cancelled: 'cancelled', stopped: 'cancelled', 'timed-out': 'failed', failed: 'failed' };
export function turnPhase(status) { return TURN_PHASES[status] ?? 'uncertain'; }

export function invalidTransition(from, to) {
  return Object.assign(new Error(`Task cannot move from ${from} to ${to}`), { code: 'stale_state', notStarted: true, details: { reason: 'invalid_transition' } });
}
/**
 * Apply one validated transition to a task record in place and append it to the
 * record timeline. Returns the timeline entry (for the activity log).
 */
export function applyTransition(record, to, { actor = 'human', reason = 'human_request', note = '', stepId = null, at = new Date().toISOString() } = {}) {
  const from = normalizePhase(record.status);
  if (!PHASES.includes(to)) throw Object.assign(new Error(`Unknown task phase ${to}`), { code: 'invalid_arguments' });
  if (from !== to && !canTransition(from, to)) throw invalidTransition(from, to);
  record.status = to;
  const entry = { type: 'transition', from, to, actor: String(actor).slice(0, 200), reason: TRANSITION_REASONS.includes(reason) ? reason : 'human_request',
    ...(note ? { note: String(note).slice(0, 2000) } : {}), ...(stepId ? { stepId } : {}), at };
  appendTimeline(record, entry);
  return entry;
}
export function appendTimeline(record, entry) {
  record.timeline = [...(Array.isArray(record.timeline) ? record.timeline : []), entry].slice(-TIMELINE_LIMIT);
  return entry;
}

/** The identity a runtime-managed task executes as. Never taken from command arguments of non-human callers. */
export function executorActor(executor, taskId) {
  if (!executor) return null;
  if (executor.type === 'client') return `client:${executor.clientId}`;
  if (executor.type === 'automation') return 'automation';
  return `task:${taskId}`;
}
/** Whether a caller acts as the task's executor (so may steer its own task without a human). */
export function sameIdentity(executor, context = {}) {
  if (!executor) return false;
  if (executor.type === 'client') return Boolean(context.clientId) && context.clientId === executor.clientId;
  if (executor.type === 'automation') return context.actor === 'automation' && !context.clientId;
  return false;
}
export const isHumanContext = context => ['human', 'admin'].includes(context?.actor);

/**
 * Result staleness: a task's recorded inputs (material revisions, workflow
 * revision, model) compared with current records. Derived on read; never stored.
 */
export function staleness(task, data) {
  const inputs = task?.run?.inputs;
  if (!inputs) return { stale: false, reasons: [] };
  const reasons = [];
  for (const [id, revision] of Object.entries(inputs.materials || {})) {
    const record = data.materials?.find(item => item.id === id);
    if (!record) reasons.push(`material ${id} was deleted`);
    else if (record.revision !== revision) reasons.push(`material ${id} changed (revision ${revision} → ${record.revision})`);
  }
  if (inputs.workflow) {
    const workflow = data.workflows?.find(item => item.id === inputs.workflow.id);
    if (!workflow) reasons.push(`workflow ${inputs.workflow.id} was deleted`);
    else if (workflow.revision !== inputs.workflow.revision) reasons.push(`workflow changed (revision ${inputs.workflow.revision} → ${workflow.revision})`);
  }
  if (inputs.modelId !== undefined && (task.modelId ?? null) !== inputs.modelId) reasons.push('model changed since the recorded steps ran');
  if (inputs.planDigest && task.run?.planDigest && inputs.planDigest !== task.run.planDigest) reasons.push('plan was redirected after earlier steps ran');
  return { stale: reasons.length > 0, reasons };
}
