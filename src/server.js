import http from 'node:http';
import { timingSafeEqual } from 'node:crypto';
import { commands, validateCommand } from './commands.js';

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

export function createApiServer({ execute, token }) {
  if (typeof token !== 'string' || !token.trim()) throw new Error('An API token is required');
  const expected = Buffer.from('Bearer ' + token);
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
      reply(200, { result: result ?? null });
    } catch (error) {
      reply(422, { error: { message: error.message || 'Command failed' } });
    }
  });
  server.requestTimeout = 30000;
  server.headersTimeout = 10000;
  return server;
}
