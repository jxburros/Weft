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
export const EVENT_TYPES = new Set(['command', 'navigation', 'workspace', 'activity', 'task', 'handoff', 'policy', 'artifact', 'turn', 'approval', 'collection', 'conflict', 'credential', 'capture', 'tab', 'display', 'payment', 'indexing']);
export function registerEventType(type) {
  if (typeof type !== 'string' || !/^[a-z][a-z_]{1,31}$/.test(type)) throw new Error('Event types are short lowercase identifiers');
  EVENT_TYPES.add(type);
}
const RECORD_ID = /^(?:ws|mate|cont|task|conv|work|site|artifact|record|version|event|turn|handoff|approval|appr|policy|msg|coll|conflict|op|capture|pay)_[a-f0-9-]{36}$/;
const ID_FIELDS = ['workspaceId', 'targetId', 'taskId', 'conversationId', 'artifactId', 'versionId', 'turnId', 'handoffId', 'approvalId', 'collectionId', 'conflictId', 'jobId', 'paymentId'];

export function sanitizeEvent(event) {
  if (!event || !EVENT_TYPES.has(event.type)) return null;
  const result = { type: event.type, createdAt: new Date().toISOString() };
  if (Object.hasOwn(commands, event.command)) result.command = event.command;
  if (['human', 'automation', 'admin', 'model', 'system'].includes(event.actor) || /^(?:client:|task:task_)[a-f0-9-]{36}$/.test(event.actor)) result.actor = event.actor;
  // Status is a short machine token produced by Weft itself (success, failure, blocked, started, ...).
  if (typeof event.status === 'string' && /^[a-z][a-z_]{0,31}$/.test(event.status)) result.status = event.status;
  // Stable outcome taxonomy token of the command (succeeded, partial, blocked, ...).
  if (typeof event.outcome === 'string' && /^[a-z][a-z_]{0,31}$/.test(event.outcome)) result.outcome = event.outcome;
  for (const key of ID_FIELDS) {
    const value = event[key];
    if (typeof value === 'string' && RECORD_ID.test(value)) result[key] = value;
  }
  // processed/total: counts of a background job (search index rebuild), never content.
  for (const key of ['tabId', 'version', 'revision', 'processed', 'total']) if (Number.isSafeInteger(event[key]) && event[key] >= 0) result[key] = event[key];
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
    return { entries, gap: first > after + 1 ? { reason: this.cleared && after < this.cleared.seq ? this.cleared.reason : 'expired', oldestEventId } : null };
  }
  subscribe(listener) { this.listeners.add(listener); return () => this.listeners.delete(listener); }
  /** Drop every retained event (for example when an encrypted profile locks); a later replay from before reports this reason as its gap. */
  reset(reason) {
    this.entries = [];
    this.bytes = 0;
    this.cleared = { seq: this.seq, reason: /^[a-z][a-z_]{0,31}$/.test(reason) ? reason : 'expired' };
  }
}

export function setSseHeaders(res) {
  res.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8', 'cache-control': 'no-store, no-transform',
    'x-content-type-options': 'nosniff', 'x-accel-buffering': 'no', connection: 'keep-alive' });
}
export function sseFrame({ id, event, data }) {
  const line = value => String(value).replace(/[\r\n]+/g, ' ');
  return `${id ? `id: ${line(id)}\n` : ''}event: ${line(event)}\ndata: ${typeof data === 'string' ? data : JSON.stringify(data)}\n\n`;
}

/** Parse a deadline from the Weft-Deadline-Ms header or the deadlineMs body field (milliseconds, 1..600000). */
export function parseDeadline(value) {
  if (value === undefined || value === null || value === '') return undefined;
  const number = typeof value === 'number' ? value : /^\d{1,7}$/.test(String(value).trim()) ? Number(String(value).trim()) : NaN;
  if (!Number.isSafeInteger(number) || number < 1 || number > 600000) throw Object.assign(new Error('Weft-Deadline-Ms / deadlineMs must be an integer from 1 to 600000 milliseconds'), { status: 400, code: 'invalid_arguments' });
  return number;
}
const DOWNLOAD_SOURCES = { artifact: ['id', 'versionId', 'part'], material: ['id'], package: ['name', 'path'] };

export function createApiServer({ execute, token, subscribe, authenticate, executeReturnsOutcome = false, turns = null, eventRetention = {}, eventLog: sharedEventLog = null }) {
  if (!authenticate && (typeof token !== 'string' || !token.trim())) throw new Error('An API token is required');
  const expected = Buffer.from('Bearer ' + token);
  const streams = new Set();
  const fallbackListeners = new Set();
  const sourceSubscribe = subscribe || (listener => { fallbackListeners.add(listener); return () => fallbackListeners.delete(listener); });
  const publish = event => { if (!subscribe) for (const listener of fallbackListeners) listener(event); };
  // One retained subscription feeds every stream so reconnecting clients can replay missed events.
  // A shared log (fed by the application) also serves events.list for CLI and MCP callers.
  const eventLog = sharedEventLog ?? new EventLog(eventRetention);
  const unsubscribeSource = sharedEventLog && subscribe ? null : sourceSubscribe(event => { eventLog.append(sanitizeEvent(event)); });
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
    if (req.method === 'GET' && req.url === '/v1/capabilities') {
      const outcome = await executeOutcome((name, input) => execute(name, input, { ...context }), 'weft.capabilities', {}, { returnsOutcome: executeReturnsOutcome });
      reply(resultHttpStatus(outcome), outcome);
      return;
    }
    if (req.method === 'GET' && req.url.startsWith('/v1/download?')) {
      // Streamed download of stored bytes. Every chunk is read through transfers.read, so the
      // caller's authority, scope and data-class checks apply exactly as for the command.
      const query = new URL(req.url, 'http://127.0.0.1').searchParams;
      const kind = query.get('kind');
      const source = Object.hasOwn(DOWNLOAD_SOURCES, kind) ? Object.fromEntries([['kind', kind], ...DOWNLOAD_SOURCES[kind].map(key => [key, query.get(key) ?? undefined])]) : { kind };
      const controller = new AbortController();
      res.on('close', () => { if (!res.writableFinished) controller.abort(); });
      let offset = 0;
      let headers = false;
      for (;;) {
        const outcome = await executeOutcome((name, input) => execute(name, input, { ...context, signal: controller.signal }), 'transfers.read', { source, offset }, { returnsOutcome: executeReturnsOutcome });
        if (res.destroyed) return;
        if (outcome.error) {
          if (!headers) reply(resultHttpStatus(outcome), outcome);
          else res.destroy();
          return;
        }
        const chunk = Buffer.from(outcome.result.dataBase64, 'base64');
        if (!headers) {
          res.writeHead(200, { 'content-type': outcome.result.mimeType || 'application/octet-stream', 'content-length': String(outcome.result.totalBytes), 'cache-control': 'no-store',
            'x-content-type-options': 'nosniff', 'content-disposition': 'attachment', 'x-weft-sha256': outcome.result.sha256 });
          headers = true;
        }
        if (!res.write(chunk)) await new Promise(resolve => { res.once('drain', resolve); res.once('close', resolve); });
        offset += chunk.length;
        if (outcome.result.done || !chunk.length) { res.end(); return; }
      }
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
    let deadlineMs;
    try {
      const body = await readJson(req);
      if (!body || typeof body !== 'object' || Array.isArray(body)
          || typeof body.command !== 'string'
          || Object.keys(body).some(key => !['command', 'args', 'deadlineMs'].includes(key))) {
        throw new Error('Expected {command, args, deadlineMs?}');
      }
      command = body.command;
      args = body.args;
      if (body.deadlineMs !== undefined && req.headers['weft-deadline-ms'] !== undefined) throw Object.assign(new Error('Send the deadline as the Weft-Deadline-Ms header or the deadlineMs field, not both'), { status: 400, code: 'invalid_arguments' });
      deadlineMs = parseDeadline(body.deadlineMs ?? req.headers['weft-deadline-ms']);
    } catch (error) {
      fail(error.status || 400, error.status === 413 ? 'request_too_large' : error.code === 'invalid_arguments' ? 'invalid_arguments' : 'invalid_json', error.message);
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
    const callContext = { ...context, signal: controller.signal, ...(onProgress ? { onProgress } : {}), ...(deadlineMs !== undefined ? { deadlineMs } : {}) };
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
