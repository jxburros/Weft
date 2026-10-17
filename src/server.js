import http from 'node:http';
import { timingSafeEqual } from 'node:crypto';
import { commands, validateCommand } from './commands.js';
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
  if (['human', 'automation', 'admin'].includes(event.actor)) result.actor = event.actor;
  if (['success', 'failure', 'blocked'].includes(event.status)) result.status = event.status;
  for (const key of ['workspaceId', 'targetId']) {
    const value = event[key];
    if (typeof value === 'string' && /^(?:ws|mate|cont|task|conv|work|site|artifact|record|version|event)_[a-f0-9-]{36}$/.test(value)) result[key] = value;
  }
  for (const key of ['tabId', 'version', 'revision']) if (Number.isSafeInteger(event[key]) && event[key] >= 0) result[key] = event[key];
  if (Number.isSafeInteger(event.targetId) && event.targetId > 0) result.targetId = event.targetId;
  return result;
}

export function createApiServer({ execute, token, subscribe }) {
  if (typeof token !== 'string' || !token.trim()) throw new Error('An API token is required');
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
    const supplied = Buffer.from(req.headers.authorization || '');
    if (supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) {
      reply(401, { error: { message: 'Unauthorized' } });
      return;
    }
    // Browser pages, including pages being automated, must not access the control plane.
    if (req.headers.origin || req.headers['sec-fetch-site']) {
      reply(403, { error: { message: 'Browser-origin requests are not allowed' } });
      return;
    }
    if (req.method === 'GET' && req.url === '/v1/openapi.json') {
      reply(200, createOpenApiDocument());
      return;
    }
    if (req.method === 'GET' && req.url === '/v1/events') {
      if (streams.size >= 16) { reply(503, { error: { message: 'Event subscriber limit reached' } }); return; }
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
      const heartbeat = setInterval(() => { if (!res.destroyed) res.write(': heartbeat\n\n'); }, 15000);
      heartbeat.unref();
      streams.add(res);
      res.on('close', cleanup);
      try {
        unsubscribe = sourceSubscribe(event => {
          const safe = sanitizeEvent(event);
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
      reply(404, { error: { message: 'Not found' } });
      return;
    }
    if (req.headers['content-type']?.split(';')[0].trim() !== 'application/json') {
      reply(415, { error: { message: 'Expected application/json' } });
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
      args = validateCommand(command, body.args);
    } catch (error) {
      reply(error.status || 400, { error: { message: error.message } });
      return;
    }
    try {
      const result = await execute(command, args);
      publish({ type: 'command', command, status: 'success', actor: 'automation', workspaceId: args.workspaceId });
      reply(200, { result: result ?? null });
    } catch (error) {
      publish({ type: 'command', command, status: 'failure', actor: 'automation', workspaceId: args.workspaceId });
      reply(422, { error: { message: error.message || 'Command failed' } });
    }
  });
  const close = server.close.bind(server);
  server.close = (...args) => { for (const response of streams) response.end(); return close(...args); };
  server.requestTimeout = 30000;
  server.headersTimeout = 10000;
  return server;
}
