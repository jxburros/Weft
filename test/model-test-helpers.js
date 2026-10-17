import { createServer } from 'node:http';
import { once } from 'node:events';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { crc32 } from 'node:zlib';
import { WorkspaceService } from '../src/workspace.js';
import { Providers } from '../src/providers.js';
import { TurnRelay } from '../src/turn-relay.js';
import { beforeRemoval, removeAfter } from './temp-profile.js';

/** A fake model endpoint on loopback. Handlers receive the parsed JSON body. */
export async function fakeEndpoint(t, handler) {
  const requests = [];
  const server = createServer(async (req, res) => {
    let body = '';
    for await (const chunk of req) body += chunk;
    const parsed = body ? JSON.parse(body) : null;
    requests.push({ url: req.url, method: req.method, headers: req.headers, body: parsed });
    try { await handler(req, res, parsed, requests.length); } catch { if (!res.headersSent) res.writeHead(500); res.end(); }
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  beforeRemoval(t, async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); });
  return { server, requests, base: `http://127.0.0.1:${server.address().port}` };
}

export const sse = (res, frames, { end = true, event } = {}) => {
  if (!res.headersSent) res.writeHead(200, { 'content-type': 'text/event-stream' });
  for (const frame of frames) res.write(`${event ? `event: ${frame.type}\n` : ''}data: ${typeof frame === 'string' ? frame : JSON.stringify(frame)}\n\n`);
  if (end) res.end();
};
export const ndjson = (res, frames, { end = true } = {}) => {
  if (!res.headersSent) res.writeHead(200, { 'content-type': 'application/x-ndjson' });
  for (const frame of frames) res.write(`${JSON.stringify(frame)}\n`);
  if (end) res.end();
};
export const json = (res, value) => { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify(value)); };
export const openaiDelta = content => ({ choices: [{ index: 0, delta: { content } }] });
export const openaiFinish = reason => ({ choices: [{ index: 0, delta: {}, finish_reason: reason }] });
export const tick = (ms = 10) => new Promise(resolve => setTimeout(resolve, ms));
export async function until(predicate, ms = 3000) {
  const end = Date.now() + ms;
  while (!(await predicate())) { if (Date.now() > end) throw new Error('Timed out waiting for condition'); await tick(5); }
}

/** A valid PNG with a correct IHDR (pixel data is irrelevant to the transport bounds). */
export function png(width = 4, height = 3, filler = 0) {
  const chunk = (type, data) => {
    const length = Buffer.alloc(4); length.writeUInt32BE(data.length);
    const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(Buffer.concat([Buffer.from(type), data])) >>> 0);
    return Buffer.concat([length, Buffer.from(type), data, crc]);
  };
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0); header.writeUInt32BE(height, 4); header[8] = 8; header[9] = 6;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', header), chunk('IDAT', Buffer.alloc(16, filler)), chunk('IEND', Buffer.alloc(0))]);
}

/** Real workspace service + providers; every outbound model request is recorded. */
export async function modelFixture(t, options = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'weft-models-'));
  const workspace = new WorkspaceService({ directory });
  const relay = new TurnRelay(options.relay);
  const outbound = [];
  const events = [];
  const fetchImpl = async (url, init) => { outbound.push(String(url)); return (options.fetchImpl || globalThis.fetch)(url, init); };
  const providers = await new Providers({ directory, workspace, env: {}, relay, fetchImpl, onEvent: event => events.push(event), ...options.providers }).init();
  removeAfter(t, directory);
  beforeRemoval(t, async () => { providers.close(); relay.close(); await tick(20); workspace.close(); });
  const conversation = await workspace.execute('conversations.create', { title: 'Fixture' });
  const save = fields => providers.execute('models.save', { name: 'Fixture', provider: 'openai', model: 'fixture-model', ...fields });
  return { directory, workspace, providers, relay, outbound, events, conversation, save,
    send: (modelId, extra = {}, caller = {}) => providers.execute('chat.send', { conversationId: conversation.id, modelId, text: 'Hello', ...extra }, caller),
    preview: (modelId, extra = {}) => providers.execute('chat.preview', { conversationId: conversation.id, modelId, text: 'Hello', ...extra }).then(result => result.disclosure),
    messages: () => workspace.getConversation(conversation.id).messages,
    manifests: () => workspace.getConversation(conversation.id).turnManifests || [] };
}
