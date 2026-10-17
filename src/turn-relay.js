import { EventEmitter } from 'node:events';
import { z } from 'zod';

export const TURN_FRAME_TYPES = Object.freeze(['start', 'request', 'phase', 'delta', 'end']);
export const TURN_STATUSES = Object.freeze(['complete', 'partial', 'interrupted', 'failed']);
export const TURN_ID = /^turn_[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/**
 * The turn frame contract, defined once: the relay validates every emitted frame against it and
 * tests parse consumed SSE frames with the same schema; OpenAPI publishes it as TurnFrame.
 */
const frameBase = { id: z.string().max(80), turnId: z.string().regex(TURN_ID), seq: z.number().int().positive(), at: z.string().max(40) };
const usage = z.strictObject({ inputTokens: z.number().int().nonnegative().nullable(), outputTokens: z.number().int().nonnegative().nullable() }).nullable();
const destination = { modelId: z.string().max(128), model: z.string().max(200), endpoint: z.string().max(2048), locality: z.string().max(40) };
export const turnFrameSchema = z.discriminatedUnion('type', [
  z.strictObject({ ...frameBase, type: z.literal('start'), conversationId: z.string().max(128), workspaceId: z.string().max(200).nullish(), ...destination, streaming: z.boolean() }),
  z.strictObject({ ...frameBase, type: z.literal('request'), round: z.number().int().positive() }),
  z.strictObject({ ...frameBase, type: z.literal('phase'), phase: z.enum(['vision_fallback', 'tools']), count: z.number().int().positive().optional(),
    ...Object.fromEntries(Object.entries(destination).map(([key, value]) => [key, value.optional()])) }),
  z.strictObject({ ...frameBase, type: z.literal('delta'), text: z.string() }),
  z.strictObject({ ...frameBase, type: z.literal('end'), status: z.enum(TURN_STATUSES), finishReason: z.string().max(40).nullish(), continuable: z.boolean().optional(),
    partialSaved: z.boolean().optional(), usage: usage.optional(), cost: z.strictObject({ estimate: z.literal(true), amount: z.number(), currency: z.string().max(3), basis: z.string().max(200) }).nullable().optional(),
    deadline: z.enum(['first_token', 'idle', 'total']).optional(), error: z.string().max(500).optional() }),
]);

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
    const seq = turn.seq + 1;
    // Emitter-side contract check: a malformed frame is a programming error, never sent.
    const frame = turnFrameSchema.parse({ ...payload, id: `${turnId}:${seq}`, turnId, seq, at: new Date().toISOString() });
    turn.seq = seq;
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
