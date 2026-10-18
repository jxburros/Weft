import { randomUUID } from 'node:crypto';
import { z } from 'zod';

/**
 * Resource scheduling (#30): global, per-client and per-task agent concurrency, a bounded capture
 * queue with progress and cancellation, and the shared capture/image resolution limits. Limits are
 * human settings (settings.update resources); refusals are typed backpressure, never silent waits.
 */
export const CAPTURE_LIMITS = Object.freeze({ defaultMaxEdge: 4096, absoluteMaxEdge: 8192, maxPngBytes: 20 * 1024 * 1024 });
/** Images sent to a model: bounded bytes and edge (downscaled locally when a decoder exists). */
export const MODEL_IMAGE_LIMITS = Object.freeze({ maxBytes: 4 * 1024 * 1024, maxEdge: 2048, maxImages: 4 });
export const RESOURCE_DEFAULTS = Object.freeze({
  maxAgentCommands: 8, maxPerClient: 4, maxPerTask: 2,
  captureConcurrency: 1, captureQueueLimit: 8,
  idleSuspendMinutes: 30, memoryBudgetMb: null, systemMemoryPressure: true, maxCaptureEdge: CAPTURE_LIMITS.defaultMaxEdge,
});
export const resourceSettingsShape = z.strictObject({
  maxAgentCommands: z.number().int().min(1).max(64).optional().describe('Agent commands that may run at once across all clients (default 8).'),
  maxPerClient: z.number().int().min(1).max(32).optional().describe('Agent commands one client grant may run at once (default 4).'),
  maxPerTask: z.number().int().min(1).max(16).optional().describe('Agent commands one task-bound grant may run at once (default 2).'),
  captureConcurrency: z.number().int().min(1).max(4).optional().describe('Screenshots, PDFs and artifact captures that run at once (default 1).'),
  captureQueueLimit: z.number().int().min(0).max(50).optional().describe('Agent captures that may wait; more are refused with resource_busy (default 8).'),
  idleSuspendMinutes: z.number().int().min(0).max(1440).optional().describe('Suspend eligible background tabs idle this long; 0 disables (default 30).'),
  memoryBudgetMb: z.number().int().min(64).max(65536).nullable().optional().describe('When page renderers exceed this, eligible background tabs are suspended least recently used first; null disables.'),
  systemMemoryPressure: z.boolean().optional().describe('Also suspend a few idle background tabs when the operating system reports memory pressure (Linux pressure-stall data and available memory; available memory on Windows; a conservative free-page heuristic on macOS). Default true.'),
  maxCaptureEdge: z.number().int().min(16).max(CAPTURE_LIMITS.absoluteMaxEdge).optional().describe('Largest capture width or height in pixels for any caller (default 4096).'),
}).describe('Resource scheduling limits (human only).');

export function resourceSettings(settings = {}) {
  const value = settings?.resources ?? {};
  const out = { ...RESOURCE_DEFAULTS };
  for (const key of Object.keys(RESOURCE_DEFAULTS)) if (value[key] !== undefined) out[key] = value[key];
  return out;
}

const busy = (message, details) => Object.assign(new Error(message), { code: 'resource_busy', notStarted: true, details });
const CAPTURE_COMMANDS = new Set(['page.screenshot', 'page.pdf', 'artifacts.capture']);
const human = actor => ['human', 'admin'].includes(actor);
// Internal model tools run nested inside a turn that already holds a slot.
const exempt = actor => human(actor) || actor === 'model-reader';

export const resourceCommandDefinitions = {
  'resources.status': ['Read scheduler limits, running and queued agent work, capture queue, suspended tabs and the caller’s budgets', {}],
  'captures.list': ['List queued, running and recent capture jobs with progress', { workspaceId: z.string().min(1).max(200).optional() }],
  'captures.cancel': ['Cancel a queued capture job; a running screenshot or PDF is discarded, a running artifact capture cannot be cancelled', {
    jobId: z.string().regex(/^capture_[0-9a-f-]{36}$/).describe('Capture job identifier from captures.list or a resource_busy/cancelled outcome.') }],
};

export class ResourceScheduler {
  constructor({ settings = () => ({}), onEvent = () => {}, clock = Date.now } = {}) {
    this.settings = settings;
    this.onEvent = onEvent;
    this.clock = clock;
    this.active = new Map(); // token -> { actor, clientId, taskId, command, startedAt }
    this.jobs = new Map();
    this.queue = [];
    this.running = 0;
  }
  limits() { return resourceSettings(this.settings()); }

  /** Admit one agent command or refuse it with typed backpressure. Returns a release function. */
  admit(command, context) {
    if (exempt(context.actor)) return () => {};
    const limits = this.limits();
    const all = [...this.active.values()];
    const clientKey = context.clientId ?? (context.actor || 'automation');
    const check = (resource, limit, count) => {
      if (count >= limit) throw busy(`${resource === 'agent_commands' ? 'Too many agent commands are running' : resource === 'client' ? 'This client already has its maximum concurrent commands running' : 'This task already has its maximum concurrent commands running'} (${count}/${limit}); retry after one finishes`,
        { resource, limit, active: count, retryAfterMs: 500 });
    };
    check('agent_commands', limits.maxAgentCommands, all.length);
    check('client', limits.maxPerClient, all.filter(item => item.clientKey === clientKey).length);
    if (context.taskId) check('task', limits.maxPerTask, all.filter(item => item.taskId === context.taskId).length);
    const token = Symbol(command);
    const entry = { clientKey, taskId: context.taskId ?? null, command, actor: String(context.actor).slice(0, 64), startedAt: this.clock(), afterDeadline: false };
    this.active.set(token, entry);
    let released = false;
    const release = () => { if (!released) { released = true; this.active.delete(token); } };
    // A command whose deadline passed while it still runs keeps its slot until it settles; status shows it as such.
    release.overdue = () => { entry.afterDeadline = true; };
    return release;
  }

  isCapture(command) { return CAPTURE_COMMANDS.has(command); }

  /** Run a costly capture through the bounded queue. Humans are queued ahead of agents and never refused. */
  async capture({ command, context, workspaceId, tabId }, work) {
    const limits = this.limits();
    const waiting = this.queue.length;
    if (!human(context.actor) && this.running >= limits.captureConcurrency && waiting >= limits.captureQueueLimit) {
      throw busy(`The capture queue is full (${waiting} waiting, limit ${limits.captureQueueLimit}); retry later`, { resource: 'capture_queue', limit: limits.captureQueueLimit, active: this.running, queued: waiting, retryAfterMs: 1000 });
    }
    const job = { id: `capture_${randomUUID()}`, command, actor: String(context.actor).slice(0, 64), clientId: context.clientId ?? null, workspaceId: workspaceId ?? null, tabId: tabId ?? null,
      state: 'queued', queuedAt: new Date(this.clock()).toISOString(), startedAt: null, finishedAt: null, error: null, cancelRequested: false };
    this.jobs.set(job.id, job);
    this.prune();
    context.captureJobId = job.id;
    await new Promise((resolve, reject) => {
      job.start = resolve; job.abort = reject;
      if (human(context.actor)) this.queue.splice(this.queue.findIndex(item => !human(item.actor)) >>> 0, 0, job);
      else this.queue.push(job);
      this.emit(job);
      this.pump();
    });
    try {
      const result = await work(job);
      if (job.cancelRequested) throw Object.assign(new Error('Capture was cancelled while running; its result was discarded'), { code: 'cancelled', details: { jobId: job.id } });
      this.finish(job, 'succeeded');
      return result;
    } catch (error) {
      this.finish(job, error.code === 'cancelled' ? 'cancelled' : 'failed', error.message);
      throw error;
    }
  }
  pump() {
    while (this.running < this.limits().captureConcurrency && this.queue.length) {
      const job = this.queue.shift();
      this.running++;
      job.state = 'running';
      job.startedAt = new Date(this.clock()).toISOString();
      this.emit(job);
      job.start();
    }
  }
  finish(job, state, error = null) {
    if (job.state === 'running') this.running--;
    Object.assign(job, { state, finishedAt: new Date(this.clock()).toISOString(), error: error ? String(error).slice(0, 300) : null });
    this.emit(job);
    this.pump();
  }
  cancel(jobId, context) {
    const job = this.jobs.get(jobId);
    if (!job || (!human(context.actor) && job.actor !== String(context.actor).slice(0, 64))) throw Object.assign(new Error('Capture job not found'), { code: 'not_found' });
    if (job.state === 'queued') {
      this.queue = this.queue.filter(item => item !== job);
      Object.assign(job, { state: 'cancelled', finishedAt: new Date(this.clock()).toISOString() });
      job.abort(Object.assign(new Error('Capture was cancelled before it started'), { code: 'cancelled', notStarted: true, details: { jobId } }));
      this.emit(job);
      return { ...this.describe(job), cancelled: true };
    }
    if (job.state === 'running') {
      if (job.command === 'artifacts.capture') return { ...this.describe(job), cancelled: false, cancellable: false, notice: 'A running artifact capture finishes or fails as a whole; it cannot be cancelled part way.' };
      job.cancelRequested = true;
      return { ...this.describe(job), cancelled: true, notice: 'The running capture will finish in the browser, but its result is discarded and reported as cancelled.' };
    }
    return { ...this.describe(job), cancelled: false, notice: `The job already ${job.state}.` };
  }
  describe(job) {
    const position = job.state === 'queued' ? this.queue.indexOf(job) + 1 : 0;
    const { start, abort, ...rest } = job;
    return { ...rest, position, progress: job.state === 'queued' ? `waiting (${position} in queue)` : job.state === 'running' ? 'capturing' : job.state };
  }
  list(filter = {}) {
    return [...this.jobs.values()].filter(job => (!filter.workspaceId || job.workspaceId === filter.workspaceId) && (!filter.workspaceIds || filter.workspaceIds.includes(job.workspaceId)))
      .map(job => this.describe(job)).reverse();
  }
  prune() {
    const finished = [...this.jobs.values()].filter(job => !['queued', 'running'].includes(job.state));
    for (const job of finished.slice(0, Math.max(0, finished.length - 100))) this.jobs.delete(job.id);
  }
  emit(job) { try { this.onEvent({ type: 'capture', status: job.state, jobId: job.id, workspaceId: job.workspaceId, tabId: job.tabId ?? undefined, command: job.command, createdAt: new Date(this.clock()).toISOString() }); } catch { /* events are best effort */ } }

  status(context = {}) {
    const all = [...this.active.values()];
    const visible = job => !context.workspaceIds || context.workspaceIds.includes(job.workspaceId);
    return { limits: this.limits(),
      agentCommands: { running: all.length, afterDeadline: all.filter(item => item.afterDeadline).length, byCommand: Object.entries(all.reduce((acc, item) => ({ ...acc, [item.command]: (acc[item.command] ?? 0) + 1 }), {})).map(([command, count]) => ({ command, count })) },
      captures: { running: this.running, queued: this.queue.length, jobs: this.list(context.workspaceIds ? { workspaceIds: context.workspaceIds } : {}).filter(visible).slice(0, 50) } };
  }
}
