import http from 'node:http';
import { timingSafeEqual, randomBytes } from 'node:crypto';
import { commands, executeOutcome, errorOutcome, resultHttpStatus } from './commands.js';
import { createOpenApiDocument } from './openapi.js';

const MAX_BODY = 1024 * 1024;

function readJson(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', chunk => {
      size += chunk.length;
      if (size > MAX_BODY) {
        reject(Object.assign(new Error('Request exceeds 1 MiB'), { status: 413 }));
      } else {
        chunks.push(chunk);
      }
    });
    req.on('end', () => {
      if (size > MAX_BODY) return;
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      } catch {
        reject(Object.assign(new Error('Invalid JSON body'), { status: 400 }));
      }
    });
    req.on('error', reject);
  });
}

/**
 * Event types any Weft component may publish on the authenticated event stream. Other components
 * register new metadata-only types here; payloads still pass the field allowlist below.
 */
export const EVENT_TYPES = new Set(['command', 'navigation', 'workspace', 'activity', 'task', 'handoff', 'policy', 'artifact', 'turn', 'approval', 'capture', 'tab', 'display']);
export function registerEventType(type) {
  if (typeof type !== 'string' || !/^[a-z][a-z_]{1,31}$/.test(type)) throw new Error('Event types are short lowercase identifiers');
  EVENT_TYPES.add(type);
}
const RECORD_ID = /^(?:ws|mate|cont|task|conv|work|site|artifact|record|version|event|turn|handoff|approval|policy|msg|capture)_[a-f0-9-]{36}$/;
const ID_FIELDS = ['workspaceId', 'targetId', 'taskId', 'conversationId', 'artifactId', 'versionId', 'turnId', 'handoffId', 'approvalId', 'jobId'];

export function sanitizeEvent(event) {
  if (!event || !EVENT_TYPES.has(event.type)) return null;
  const result = { type: event.type, createdAt: new Date().toISOString() };
  if (Object.hasOwn(commands, event.command)) result.command = event.command;
  if (['human', 'automation', 'admin', 'model'].includes(event.actor) || /^client:[a-f0-9-]{36}$/.test(event.actor)) result.actor = event.actor;
  // Status is a short machine token produced by Weft itself (success, failure, blocked, started, ...).
  if (typeof event.status === 'string' && /^[a-z][a-z_]{0,31}$/.test(event.status)) result.status = event.status;
  for (const key of ID_FIELDS) {
    const value = event[key];
    if (typeof value === 'string' && RECORD_ID.test(value)) result[key] = value;
  }
  for (const key of ['tabId', 'version', 'revision']) if (Number.isSafeInteger(event[key]) && event[key] >= 0) result[key] = event[key];
  if (Number.isSafeInteger(event.targetId) && event.targetId > 0) result.targetId = event.targetId;
  return result;
}

/**
 * Bounded retention for /v1/events replay. Ids are `<boot>-<seq>`; a reconnecting client sends
 * Last-Event-ID and receives retained later events, or an explicit gap when they expired or the
 * process restarted. Retention is metadata only and never written to disk.
 */
export class EventLog {
  constructor({ maxEvents = 1000, maxAgeMs = 15 * 60 * 1000, maxBytes = 1024 * 1024, now = Date.now } = {}) {
    Object.assign(this, { maxEvents, maxAgeMs, maxBytes, now });
    this.boot = randomBytes(6).toString('hex');
    this.seq = 0;
    this.entries = [];
    this.bytes = 0;
    this.listeners = new Set();
  }
  append(event) {
    if (!event) return null;
    const data = JSON.stringify(event);
    const entry = { id: `${this.boot}-${++this.seq}`, seq: this.seq, at: this.now(), event, data };
    this.entries.push(entry);
    this.bytes += data.length;
    this.prune();
    for (const listener of this.listeners) listener(entry);
    return entry;
  }
  prune() {
    const oldest = this.now() - this.maxAgeMs;
    while (this.entries.length && (this.entries.length > this.maxEvents || this.bytes > this.maxBytes || this.entries[0].at < oldest)) {
      this.bytes -= this.entries.shift().data.length;
    }
  }
  since(lastEventId) {
    this.prune();
    if (!lastEventId) return { entries: [], gap: null };
    const match = /^([a-f0-9]{12})-(\d{1,15})$/.exec(String(lastEventId).trim());
    const oldestEventId = this.entries[0]?.id ?? null;
    if (!match) return { entries: [...this.entries], gap: { reason: 'unknown_event_id', oldestEventId } };
    if (match[1] !== this.boot) return { entries: [...this.entries], gap: { reason: 'restarted', oldestEventId } };
    const after = Number(match[2]);
    if (after > this.seq) return { entries: [], gap: { reason: 'unknown_event_id', oldestEventId } };
    const entries = this.entries.filter(entry => entry.seq > after);
    const first = this.entries[0]?.seq ?? this.seq + 1;
    return { entries, gap: first > after + 1 ? { reason: 'expired', oldestEventId } : null };
  }
  subscribe(listener) { this.listeners.add(listener); return () => this.listeners.delete(listener); }
}

export function setSseHeaders(res) {
  res.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8', 'cache-control': 'no-store, no-transform',
    'x-content-type-options': 'nosniff', 'x-accel-buffering': 'no', connection: 'keep-alive' });
}
export function sseFrame({ id, event, data }) {
  const line = value => String(value).replace(/[\r\n]+/g, ' ');
  return `${id ? `id: ${line(id)}\n` : ''}event: ${line(event)}\ndata: ${typeof data === 'string' ? data : JSON.stringify(data)}\n\n`;
}

export function createApiServer({ execute, token, subscribe, authenticate, executeReturnsOutcome = false, turns = null, eventRetention = {} }) {
  if (!authenticate && (typeof token !== 'string' || !token.trim())) throw new Error('An API token is required');
  const expected = Buffer.from('Bearer ' + token);
  const streams = new Set();
  const fallbackListeners = new Set();
  const sourceSubscribe = subscribe || (listener => { fallbackListeners.add(listener); return () => fallbackListeners.delete(listener); });
  const publish = event => { if (!subscribe) for (const listener of fallbackListeners) listener(event); };
  // One retained subscription feeds every stream so reconnecting clients can replay missed events.
  const eventLog = new EventLog(eventRetention);
  const unsubscribeSource = sourceSubscribe(event => { eventLog.append(sanitizeEvent(event)); });
  const server = http.createServer(async (req, res) => {
    const reply = (status, body) => {
      res.writeHead(status, {
        'content-type': 'application/json; charset=utf-8',
        'cache-control': 'no-store',
        'x-content-type-options': 'nosniff',
      });
      res.end(JSON.stringify(body));
    };
    const fail = (status, code, message) => reply(status, errorOutcome(Object.assign(new Error(message), { code }), null, {}, [], 'not_run'));
    const authorization = req.headers.authorization || '';
    const supplied = Buffer.from(authorization);
    let context;
    try {
      context = authenticate ? await authenticate(authorization.startsWith('Bearer ') ? authorization.slice(7) : '')
        : supplied.length === expected.length && timingSafeEqual(supplied, expected) ? { actor: 'automation' } : null;
    } catch { context = null; }
    if (!context) {
      fail(401, 'unauthorized', 'Unauthorized');
      return;
    }
    // Browser pages, including pages being automated, must not access the control plane.
    if (req.headers.origin || req.headers['sec-fetch-site']) {
      fail(403, 'permission_required', 'Browser-origin requests are not allowed');
      return;
    }
    const currentIdentity = async () => {
      if (!authenticate) return context;
      try { return await authenticate(authorization.slice(7)) || null; } catch { return null; }
    };
    const visible = (identity, workspaceId) => !identity.workspaceIds || (workspaceId && identity.workspaceIds.includes(workspaceId));
    const lastEventId = typeof req.headers['last-event-id'] === 'string' ? req.headers['last-event-id'].slice(0, 200) : '';
    if (req.method === 'GET' && req.url === '/v1/openapi.json') {
      reply(200, createOpenApiDocument());
      return;
    }
    if (req.method === 'GET' && req.url === '/v1/events') {
      if (context.scopes && !context.scopes.includes('read')) { fail(403, 'permission_required', 'The read scope is required for events'); return; }
      if (streams.size >= 16) { fail(503, 'unavailable', 'Event subscriber limit reached'); return; }
      setSseHeaders(res);
      res.write(': connected\n\n');
      let closed = false;
      let chain = Promise.resolve();
      let unsubscribe;
      const cleanup = () => {
        if (closed) return;
        closed = true;
        clearInterval(heartbeat);
        streams.delete(res);
        unsubscribe?.();
      };
      const end = () => { cleanup(); res.end(); };
      // Serialize identity checks so asynchronous re-authentication cannot reorder frames.
      const enqueue = write => { chain = chain.then(async () => {
        if (closed || res.destroyed) return;
        const identity = await currentIdentity();
        if (!identity) { end(); return; }
        if (closed || res.destroyed) return;
        if (res.writableLength > 65536) { cleanup(); res.destroy(); return; }
        write(identity);
      }); };
      const deliver = entry => enqueue(identity => {
        if (!visible(identity, entry.event.workspaceId)) return;
        res.write(sseFrame({ id: entry.id, event: 'weft', data: entry.data }));
      });
      const heartbeat = setInterval(() => enqueue(() => res.write(': heartbeat\n\n')), 15000);
      heartbeat.unref();
      streams.add(res);
      res.on('close', cleanup);
      // Register before computing the replay in the same tick: no event falls between them.
      unsubscribe = eventLog.subscribe(deliver);
      const { entries, gap } = eventLog.since(lastEventId);
      if (gap) enqueue(() => res.write(sseFrame({ event: 'gap', data: { ...gap, lastEventId } })));
      for (const entry of entries) deliver(entry);
      return;
    }
    const turnMatch = req.method === 'GET' && /^\/v1\/turns\/(turn_[0-9a-f-]{36})\/events$/.exec(req.url);
    if (turnMatch) {
      if (context.scopes && !context.scopes.includes('read')) { fail(403, 'permission_required', 'The read scope is required for turn streams'); return; }
      const info = turns?.info(turnMatch[1]);
      // Unknown, expired and out-of-scope turns are indistinguishable to the caller.
      if (!info || !visible(context, info.workspaceId)) { fail(404, 'not_found', 'Turn stream not found or no longer retained'); return; }
      if (streams.size >= 16) { fail(503, 'unavailable', 'Event subscriber limit reached'); return; }
      setSseHeaders(res);
      res.write(': connected\n\n');
      let closed = false;
      const cleanup = () => { if (closed) return; closed = true; clearInterval(recheck); streams.delete(res); turns.off('frame', live); };
      // Expiry or revocation of a client grant ends its follower stream too.
      const recheck = setInterval(async () => {
        const identity = await currentIdentity();
        if (!closed && (!identity || !visible(identity, info.workspaceId))) { cleanup(); res.end(); }
        else if (!closed) res.write(': heartbeat\n\n');
      }, 15000);
      recheck.unref();
      const write = frame => {
        if (closed || res.destroyed) return;
        if (res.writableLength > 4 * 1024 * 1024) { cleanup(); res.destroy(); return; }
        res.write(sseFrame({ id: frame.id, event: `turn.${frame.type}`, data: frame }));
        if (frame.type === 'end') { cleanup(); res.end(); }
      };
      const live = frame => { if (frame.turnId === turnMatch[1]) write(frame); };
      streams.add(res);
      // A follower disconnect never stops the turn; only the originating request can.
      res.on('close', cleanup);
      turns.on('frame', live);
      const replay = turns.replay(turnMatch[1], lastEventId);
      if (replay.gap) res.write(sseFrame({ event: 'gap', data: { reason: replay.gap, lastEventId } }));
      for (const frame of replay.frames) write(frame);
      return;
    }
    if (req.method === 'GET' && req.url === '/v1/commands') {
      reply(200, { commands });
      return;
    }
    if (req.method !== 'POST' || req.url !== '/v1/execute') {
      fail(404, 'not_found', 'Not found');
      return;
    }
    if (req.headers['content-type']?.split(';')[0].trim() !== 'application/json') {
      fail(415, 'unsupported_media_type', 'Expected application/json');
      return;
    }
    let command;
    let args;
    try {
      const body = await readJson(req);
      if (!body || typeof body !== 'object' || Array.isArray(body)
          || typeof body.command !== 'string'
          || Object.keys(body).some(key => !['command', 'args'].includes(key))) {
        throw new Error('Expected {command, args}');
      }
      command = body.command;
      args = body.args;
    } catch (error) {
      fail(error.status || 400, error.status === 413 ? 'request_too_large' : 'invalid_json', error.message);
      return;
    }
    // The originating request owns cancellation: a disconnect before the response finishes aborts
    // the command (`req` closes once the body is read, so watch the response instead).
    const controller = new AbortController();
    res.on('close', () => { if (!res.writableFinished) controller.abort(); });
    const streaming = /(^|,)\s*text\/event-stream/.test(req.headers.accept || '');
    let onProgress;
    if (streaming) {
      setSseHeaders(res);
      res.write(': accepted\n\n');
      onProgress = frame => {
        if (res.destroyed || res.writableEnded) return;
        if (res.writableLength > 4 * 1024 * 1024) { res.destroy(); return; }
        res.write(sseFrame({ id: frame.id, event: `turn.${frame.type}`, data: frame }));
      };
    }
    const callContext = { ...context, signal: controller.signal, ...(onProgress ? { onProgress } : {}) };
    const outcome = await executeOutcome((name, input) => execute(name, input, callContext), command, args, { returnsOutcome: executeReturnsOutcome });
    publish({ type: 'command', command: outcome.command, status: outcome.error ? 'failure' : 'success', actor: context.actor, workspaceId: outcome.workspaceId });
    if (streaming) {
      if (!res.destroyed && !res.writableEnded) res.end(sseFrame({ event: 'outcome', data: outcome }));
      return;
    }
    if (!res.destroyed) reply(resultHttpStatus(outcome), outcome);
  });
  const close = server.close.bind(server);
  server.close = (...args) => { unsubscribeSource?.(); for (const response of streams) response.end(); return close(...args); };
  server.eventStats = () => ({ subscribers: streams.size, retained: eventLog.entries.length, lastEventId: eventLog.entries.at(-1)?.id ?? null });
  server.requestTimeout = 30000;
  server.headersTimeout = 10000;
  return server;
}
