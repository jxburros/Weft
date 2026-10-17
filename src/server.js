import http from 'node:http';
import { timingSafeEqual } from 'node:crypto';
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

export function sanitizeEvent(event) {
  if (!event || !['command', 'navigation', 'workspace', 'activity'].includes(event.type)) return null;
  const result = { type: event.type, createdAt: new Date().toISOString() };
  if (Object.hasOwn(commands, event.command)) result.command = event.command;
  if (['human', 'automation', 'admin'].includes(event.actor) || /^client:[a-f0-9-]{36}$/.test(event.actor)) result.actor = event.actor;
  if (['success', 'failure', 'blocked'].includes(event.status)) result.status = event.status;
  for (const key of ['workspaceId', 'targetId']) {
    const value = event[key];
    if (typeof value === 'string' && /^(?:ws|mate|cont|task|conv|work|site|artifact|record|version|event)_[a-f0-9-]{36}$/.test(value)) result[key] = value;
  }
  for (const key of ['tabId', 'version', 'revision']) if (Number.isSafeInteger(event[key]) && event[key] >= 0) result[key] = event[key];
  if (Number.isSafeInteger(event.targetId) && event.targetId > 0) result.targetId = event.targetId;
  return result;
}

export function createApiServer({ execute, token, subscribe, authenticate, executeReturnsOutcome = false }) {
  if (!authenticate && (typeof token !== 'string' || !token.trim())) throw new Error('An API token is required');
  const expected = Buffer.from('Bearer ' + token);
  const streams = new Set();
  const fallbackListeners = new Set();
  const sourceSubscribe = subscribe || (listener => { fallbackListeners.add(listener); return () => fallbackListeners.delete(listener); });
  const publish = event => { if (!subscribe) for (const listener of fallbackListeners) listener(event); };
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
    if (req.method === 'GET' && req.url === '/v1/openapi.json') {
      reply(200, createOpenApiDocument());
      return;
    }
    if (req.method === 'GET' && req.url === '/v1/events') {
      if (context.scopes && !context.scopes.includes('read')) { fail(403, 'permission_required', 'The read scope is required for events'); return; }
      if (streams.size >= 16) { fail(503, 'unavailable', 'Event subscriber limit reached'); return; }
      res.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff', connection: 'keep-alive' });
      res.write(': connected\n\n');
      let unsubscribe;
      let closed = false;
      const cleanup = () => {
        if (closed) return;
        closed = true;
        clearInterval(heartbeat);
        streams.delete(res);
        if (typeof unsubscribe === 'function') unsubscribe();
      };
      const currentIdentity = async () => {
        if (!authenticate) return context;
        try {
          const current = await authenticate(authorization.slice(7));
          if (!current) { cleanup(); res.end(); return null; }
          return current;
        } catch { cleanup(); res.end(); return null; }
      };
      const heartbeat = setInterval(async () => { if (await currentIdentity() && !res.destroyed && !closed) res.write(': heartbeat\n\n'); }, 15000);
      heartbeat.unref();
      streams.add(res);
      res.on('close', cleanup);
      try {
        unsubscribe = sourceSubscribe(async event => {
          const identity = await currentIdentity();
          if (!identity) return;
          const safe = sanitizeEvent(event);
          if (identity.workspaceIds && (!safe?.workspaceId || !identity.workspaceIds.includes(safe.workspaceId))) return;
          if (!safe || closed || res.destroyed) return;
          if (res.writableLength > 65536) { res.destroy(); return; }
          res.write(`event: weft\ndata: ${JSON.stringify(safe)}\n\n`);
        });
      } catch { cleanup(); res.end(); }
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
    const outcome = await executeOutcome((name, input) => execute(name, input, context), command, args, { returnsOutcome: executeReturnsOutcome });
    publish({ type: 'command', command: outcome.command, status: outcome.error ? 'failure' : 'success', actor: context.actor, workspaceId: outcome.workspaceId });
    reply(resultHttpStatus(outcome), outcome);
  });
  const close = server.close.bind(server);
  server.close = (...args) => { for (const response of streams) response.end(); return close(...args); };
  server.requestTimeout = 30000;
  server.headersTimeout = 10000;
  return server;
}
