import { createHash } from 'node:crypto';
import { WATCH_EXECUTOR } from './task-runtime.js';
import { readCappedBody } from './helpers.js';

// Adapted from AI Server Studio's scheduledInternTurnBlocker (Apache-2.0).
// Busy, waiting and paused work must not be stacked or implicitly resumed.
export function watchRunBlocked(task) {
  return task && !['completed', 'failed', 'cancelled'].includes(task.status);
}

/** Local, opt-in web watches. No cookies, credentials, redirects or page scripts. */
export class Standby {
  constructor({ workspace, dispatch, admission, fetchImpl = globalThis.fetch, clock = Date.now }) {
    Object.assign(this, { workspace, dispatch, admission, fetch: fetchImpl, clock });
    this.active = new Set(); this.controllers = new Set(); this.closed = false;
  }
  start() { this.closed = false; this.timer ??= setInterval(() => void this.tick(), 15000); this.timer.unref?.(); }
  close() { this.closed = true; clearInterval(this.timer); this.timer = null; for (const c of this.controllers) c.abort(); }
  allowed(w) { return !this.closed && !this.workspace.locked && !this.admission?.status?.stopped && w?.enabled && w.watch && !this.workspace.workspace(w.workspaceId).archived; }
  async update(id, revision, state) {
    const job = this.workspace.queue.then(() => this.workspace.transact(() => {
      const w = this.workspace.record('workflows', id);
      if (w.revision !== revision || !this.allowed(w)) return false;
      w.watchState = state;
      return true;
    }));
    this.workspace.queue = job.catch(() => {});
    return job;
  }
  async tick() {
    if (this.closed || this.workspace.locked || this.admission?.status?.stopped) return;
    for (const w of this.workspace.data.workflows || []) {
      if (!this.allowed(w) || this.active.has(w.id)) continue;
      const s = w.watchState;
      if (s?.phase === 'dispatching' || s?.nextCheckAt > this.clock()) continue;
      if (this.workspace.data.tasks.some(t => (t.id === s?.taskId || t.workflowRun?.workflowId === w.id) && watchRunBlocked(t))) continue;
      await this.check(w).catch(() => {});
    }
  }
  async check(w) {
    this.active.add(w.id);
    const controller = new AbortController(); this.controllers.add(controller);
    const timeout = setTimeout(() => controller.abort(), 15000);
    let attempted = false;
    const revision = w.revision;
    const previous = w.watchState || {};
    const state = { ...previous, checkedAt: new Date(this.clock()).toISOString(), nextCheckAt: this.clock() + w.watch.intervalMinutes * 60000 };
    try {
      const response = await this.fetch(w.watch.url, { redirect: 'error', credentials: 'omit', signal: controller.signal, headers: { accept: 'text/plain, text/html, application/json, application/rss+xml' } });
      if (!response.ok) { await response.body?.cancel(); throw new Error(`HTTP ${response.status}`); }
      const body = (await readCappedBody(response, 1024 * 1024, { fail: () => new Error('Watch response exceeded 1 MiB') })).toString('utf8');
      const digest = createHash('sha256').update(body).digest('hex');
      const matches = !w.watch.contains || body.includes(w.watch.contains);
      // GWatch's per-trigger cooldown pattern: reserve a firing before dispatch, never on every poll.
      const fire = previous.digest && digest !== previous.digest && matches && (!w.watch.contains || !previous.matches)
        && this.clock() - (previous.firedAt || 0) >= w.watch.cooldownMinutes * 60000;
      Object.assign(state, { digest, matches, phase: 'watching', error: null });
      if (!fire) { await this.update(w.id, revision, state); return; }
      // A crash after this reservation is surfaced for human review, never blindly replayed.
      if (!await this.update(w.id, revision, { ...state, phase: 'dispatching', firedAt: this.clock() })) return;
      if (!this.allowed(this.workspace.record('workflows', w.id)) || this.workspace.record('workflows', w.id).revision !== revision || controller.signal.aborted) return;
      attempted = true;
      const outcome = await this.dispatch('workflows.run', { id: w.id, parameters: {} }, {
        actor: 'web-watch', source: 'watch', workspaceId: w.workspaceId, workspaceIds: [w.workspaceId], autonomy: 'scoped', [WATCH_EXECUTOR]: true,
      });
      if (outcome.error) throw new Error(outcome.error.message);
      await this.update(w.id, revision, { ...state, phase: 'watching', firedAt: this.clock(), taskId: outcome.result.id });
    } catch (error) {
      if (!controller.signal.aborted) await this.update(w.id, revision, { ...previous, checkedAt: state.checkedAt, nextCheckAt: state.nextCheckAt, phase: attempted ? 'dispatching' : 'error', error: String(error.message).slice(0, 300) }).catch(() => {});
    } finally { clearTimeout(timeout); this.controllers.delete(controller); this.active.delete(w.id); }
  }
}
