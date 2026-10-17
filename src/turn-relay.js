import { EventEmitter } from 'node:events';

/** Turn frame types. Payload fields are defined once here and checked by tests on both sides. */
export const TURN_FRAME_TYPES = Object.freeze(['start', 'request', 'phase', 'delta', 'end']);
export const TURN_STATUSES = Object.freeze(['complete', 'partial', 'interrupted', 'failed']);
export const TURN_ID = /^turn_[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/**
 * Bounded per-turn frame relay. Frame ids are `<turnId>:<seq>` so a follower can resume with
 * Last-Event-ID. Bounds follow the streaming contract: at most 10k frames / 4 MiB per turn, kept
 * 60 s after the turn ends. Dropped frames produce an explicit gap on replay, never silent loss.
 */
export class TurnRelay extends EventEmitter {
  constructor({ maxFrames = 10000, maxBytes = 4 * 1024 * 1024, retainMs = 60000, maxTurns = 128 } = {}) {
    super();
    this.setMaxListeners(64);
    Object.assign(this, { maxFrames, maxBytes, retainMs, maxTurns });
    this.turns = new Map();
  }

  start(turnId, meta) {
    if (!TURN_ID.test(turnId)) throw new Error('Invalid turn id');
    while (this.turns.size >= this.maxTurns) {
      const oldest = [...this.turns.entries()].find(([, turn]) => turn.done) || this.turns.entries().next().value;
      this.delete(oldest[0]);
    }
    this.turns.set(turnId, { meta: { ...meta }, frames: [], bytes: 0, seq: 0, dropped: 0, done: false, timer: null });
    return this.push(turnId, { type: 'start', ...meta });
  }

  push(turnId, payload) {
    const turn = this.turns.get(turnId);
    if (!turn || turn.done) return null;
    if (!TURN_FRAME_TYPES.includes(payload.type)) throw new Error(`Unknown turn frame type: ${payload.type}`);
    const seq = ++turn.seq;
    const frame = { ...payload, id: `${turnId}:${seq}`, turnId, seq, at: new Date().toISOString() };
    const size = Buffer.byteLength(JSON.stringify(frame));
    turn.frames.push({ frame, size });
    turn.bytes += size;
    while (turn.frames.length > this.maxFrames || (turn.bytes > this.maxBytes && turn.frames.length > 1)) {
      turn.bytes -= turn.frames.shift().size;
      turn.dropped++;
    }
    if (payload.type === 'end') {
      turn.done = true;
      turn.timer = setTimeout(() => this.delete(turnId), this.retainMs);
      turn.timer.unref?.();
    }
    this.emit('frame', frame);
    return frame;
  }

  end(turnId, payload) { return this.push(turnId, { ...payload, type: 'end' }); }

  delete(turnId) {
    const turn = this.turns.get(turnId);
    if (turn?.timer) clearTimeout(turn.timer);
    this.turns.delete(turnId);
  }

  info(turnId) {
    const turn = this.turns.get(turnId);
    return turn ? { ...turn.meta, done: turn.done, frames: turn.seq, dropped: turn.dropped } : null;
  }

  /** Frames after Last-Event-ID; `gap` is set when requested frames are no longer retained. */
  replay(turnId, lastEventId) {
    const turn = this.turns.get(turnId);
    if (!turn) return null;
    let after = 0;
    let gap = null;
    if (lastEventId) {
      const match = /^(turn_[0-9a-f-]{36}):(\d{1,9})$/.exec(String(lastEventId));
      if (!match || match[1] !== turnId) gap = 'unknown_event_id';
      else after = Number(match[2]);
      if (after > turn.seq) { gap = 'unknown_event_id'; after = 0; }
    }
    const frames = turn.frames.map(item => item.frame).filter(frame => frame.seq > after);
    const first = turn.frames[0]?.frame.seq ?? turn.seq + 1;
    if (!gap && first > after + 1) gap = 'expired';
    return { frames, gap, done: turn.done };
  }

  close() { for (const turnId of [...this.turns.keys()]) this.delete(turnId); }
}
