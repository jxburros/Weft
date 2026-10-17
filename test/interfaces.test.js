import test from 'node:test';
import assert from 'node:assert/strict';
import { once, EventEmitter } from 'node:events';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { randomBytes } from 'node:crypto';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { commands, validateCommand } from '../src/commands.js';
import { createApiServer } from '../src/server.js';
import { createClient } from '../src/client.js';
import { createMcpServer } from '../src/mcp.js';

async function fixture(t, options = {}) {
  const calls = [];
  const token = randomBytes(32).toString('hex');
  const server = createApiServer({
    token,
    subscribe: options.subscribe,
    execute: async (command, args) => {
      calls.push({ command, args });
      if (command === 'page.title') throw new Error('No active tab');
      if (command === 'page.screenshot') return { data: 'aGVsbG8=', mimeType: 'image/png' };
      return { command, args };
    },
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => new Promise(resolve => {
    server.closeAllConnections();
    server.close(resolve);
  }));
  const url = `http://127.0.0.1:${server.address().port}`;
  const headers = { authorization: 'Bearer ' + token, 'content-type': 'application/json' };
  return { server, token, url, headers, calls, client: createClient({ url, token }) };
}

test('command catalog validates URLs, IDs, types and unknown properties', () => {
  assert.ok(Object.keys(commands).length > 20);
  assert.deepEqual(validateCommand('tabs.new'), {});
  assert.deepEqual(validateCommand('page.navigate', { url: 'https://example.com' }), {
    url: 'https://example.com',
  });
  for (const url of ['javascript:alert(1)', 'file:///etc/passwd', 'data:text/html,test',
    'not a URL']) {
    assert.throws(() => validateCommand('page.navigate', { url }));
  }
  const credentialUrl = new URL('https://example.com');
  credentialUrl.username = 'user';
  assert.throws(() => validateCommand('page.navigate', { url: credentialUrl.href }));
  assert.throws(() => validateCommand('cookies.set', { url: 'about:blank', name: 'x', value: 'x' }));
  assert.throws(() => validateCommand('tabs.close', { tabId: 0 }));
  assert.throws(() => validateCommand('tabs.close', { tabId: '1' }));
  assert.throws(() => validateCommand('tabs.list', { ignored: true }));
  assert.throws(() => validateCommand('toString'));
});

test('REST and client share command discovery and execution', async t => {
  const { client, calls } = await fixture(t);
  assert.deepEqual(await client.listCommands(), commands);
  assert.deepEqual(await client.execute('tabs.new', { url: 'about:blank' }), {
    command: 'tabs.new', args: { url: 'about:blank' },
  });
  assert.equal(calls.length, 1);
  await assert.rejects(client.execute('page.title'), /No active tab/);
  await assert.rejects(client.execute('tabs.close', { tabId: -1 }));
  assert.equal(calls.length, 2, 'invalid commands never reach Chromium');
});

test('REST rejects unauthorized, browser-origin and malformed requests', async t => {
  const { url, headers, calls } = await fixture(t);
  assert.equal((await fetch(`${url}/v1/commands`)).status, 401);
  for (const authorization of ['invalid', '', 'Basic invalid']) {
    assert.equal((await fetch(`${url}/v1/commands`, { headers: { authorization } })).status, 401);
  }
  assert.equal((await fetch(`${url}/v1/commands`, {
    headers: { ...headers, origin: 'https://evil.example' },
  })).status, 403);
  assert.equal((await fetch(`${url}/v1/commands`, {
    headers: { ...headers, 'sec-fetch-site': 'cross-site' },
  })).status, 403);
  const post = (body, extra = {}) => fetch(`${url}/v1/execute`, {
    method: 'POST', headers: { ...headers, ...extra }, body,
  });
  assert.equal((await post('{}', { 'content-type': 'text/plain' })).status, 415);
  for (const body of ['{', 'null', '[]', '{}', '{"command":"toString"}',
    '{"command":"tabs.list","extra":1}', '{"command":"tabs.list","args":null}']) {
    assert.equal((await post(body)).status, 400);
  }
  assert.equal((await post('x'.repeat(1024 * 1024 + 1))).status, 413);
  assert.equal((await fetch(`${url}/missing`, { headers })).status, 404);
  assert.equal(calls.length, 0);
});

test('client refuses to leak credentials to nonlocal or redirected endpoints', async t => {
  assert.throws(() => createClient({ url: 'https://example.com', token: 'test' }), /loopback/);
  assert.throws(() => createClient({ url: 'http://127.0.0.1/path', token: 'test' }), /loopback/);
  assert.throws(() => createClient({ token: '' }), /WEFT_TOKEN/);
  const { server, client } = await fixture(t);
  server.removeAllListeners('request');
  server.on('request', (_req, res) => {
    res.writeHead(302, { location: 'https://example.com' });
    res.end();
  });
  await assert.rejects(client.listCommands(), /fetch failed/);
});

test('CLI discovers and executes the same commands against the live REST server', async t => {
  const { url, token } = await fixture(t);
  const cli = new URL('../bin/weft.js', import.meta.url);
  const run = (...args) => promisify(execFile)(process.execPath, [cli.pathname, ...args], {
    env: { ...process.env, WEFT_API_URL: url, WEFT_TOKEN: token },
  });
  assert.deepEqual(JSON.parse((await run('commands')).stdout), commands);
  assert.deepEqual(JSON.parse((await run('tabs.new', '{"url":"about:blank"}')).stdout), {
    command: 'tabs.new', args: { url: 'about:blank' },
  });
  await assert.rejects(run('tabs.close', '{"tabId":0}'), error => {
    assert.equal(error.code, 1);
    assert.match(error.stderr, /weft:/);
    assert.equal(error.stdout, '');
    return true;
  });
});

test('MCP advertises all commands and executes through the same REST client', async t => {
  const { client: api, calls } = await fixture(t);
  const server = createMcpServer(api);
  const client = new Client({ name: 'weft-test', version: '1.0.0' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  t.after(async () => { await client.close(); await server.close(); });
  const { tools } = await client.listTools();
  assert.deepEqual(tools.map(tool => tool.name), Object.keys(commands).map(name => name.replaceAll('.', '_')));
  const result = await client.callTool({ name: 'tabs_new', arguments: { url: 'about:blank' } });
  assert.deepEqual(JSON.parse(result.content[0].text), {
    command: 'tabs.new', args: { url: 'about:blank' },
  });
  const image = await client.callTool({ name: 'page_screenshot', arguments: {} });
  assert.deepEqual(image.content, [{ type: 'image', data: 'aGVsbG8=', mimeType: 'image/png' }]);
  const invalid = await client.callTool({ name: 'tabs_close', arguments: { tabId: -1 } });
  assert.equal(invalid.isError, true);
  const unknown = await client.callTool({ name: 'toString', arguments: {} });
  assert.equal(unknown.isError, true);
  assert.equal(calls.length, 2);
});

test('MCP stdio entry point performs a real protocol handshake without stdout noise', async t => {
  const { url, token } = await fixture(t);
  const client = new Client({ name: 'stdio-test', version: '1.0.0' });
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [new URL('../bin/weft.js', import.meta.url).pathname, 'mcp'],
    env: { WEFT_API_URL: url, WEFT_TOKEN: token },
  });
  t.after(() => client.close());
  await client.connect(transport);
  assert.equal((await client.listTools()).tools.length, Object.keys(commands).length);
  const response = await client.callTool({ name: 'tabs_list', arguments: {} });
  assert.deepEqual(JSON.parse(response.content[0].text), { command: 'tabs.list', args: {} });
});

test('generated OpenAPI describes every canonical command and requires authorization', async t => {
  const { url, headers } = await fixture(t);
  assert.equal((await fetch(`${url}/v1/openapi.json`)).status, 401);
  assert.equal((await fetch(`${url}/v1/openapi.json`, { headers: { ...headers, origin: 'https://website.test' } })).status, 403);
  const response = await fetch(`${url}/v1/openapi.json`, { headers });
  assert.equal(response.status, 200);
  const document = await response.json();
  assert.equal(document.openapi, '3.1.0');
  assert.equal(document.components.securitySchemes.localBearer.scheme, 'bearer');
  assert.deepEqual(document.security, [{ localBearer: [] }]);
  const variants = document.paths['/v1/execute'].post.requestBody.content['application/json'].schema.oneOf;
  assert.equal(variants.length, Object.keys(commands).length);
  for (const variant of variants) {
    const name = variant.properties.command.const;
    const { $schema, ...expected } = commands[name].inputSchema;
    assert.deepEqual(document.components.schemas[name], expected);
    assert.equal(variant.properties.args.$ref, `#/components/schemas/${name}`);
  }
  assert.ok(variants.find(item => item.properties.command.const === 'page.navigate').required.includes('args'));
  assert.ok(!variants.find(item => item.properties.command.const === 'tabs.list').required.includes('args'));
  assert.ok(document.paths['/v1/events'].get.responses[200].content['text/event-stream']);
});

test('SSE authenticates, strips content and secrets, and unsubscribes disconnected clients', { timeout: 5000 }, async t => {
  const events = new EventEmitter();
  let removed;
  const removedPromise = new Promise(resolve => { removed = resolve; });
  const { url, headers } = await fixture(t, { subscribe: listener => {
    events.on('event', listener);
    return () => { events.off('event', listener); removed(); };
  } });
  assert.equal((await fetch(`${url}/v1/events`)).status, 401);
  assert.equal((await fetch(`${url}/v1/events`, { headers: { ...headers, 'sec-fetch-site': 'same-origin' } })).status, 403);
  const response = await fetch(`${url}/v1/events`, { headers });
  assert.equal(response.status, 200);
  assert.match(response.headers.get('content-type'), /text\/event-stream/);
  const reader = response.body.getReader();
  assert.match(new TextDecoder().decode((await reader.read()).value), /connected/);
  assert.equal(events.listenerCount('event'), 1);
  events.emit('event', { type: 'command', command: 'page.fill', actor: 'human', status: 'success', tabId: 7, version: 4, workspaceId: 'ws_12345678-1234-1234-1234-123456789abc', args: { value: 'secret-input' }, url: 'https://example.com/?token=secret', result: 'private transcript', error: 'provider key', title: 'Private title', targetId: 'secret-token' });
  const message = new TextDecoder().decode((await reader.read()).value);
  assert.match(message, /event: weft/);
  const event = JSON.parse(message.split('data: ')[1].trim());
  assert.equal(event.command, 'page.fill');
  assert.equal(event.tabId, 7);
  assert.equal(event.version, 4);
  assert.deepEqual(Object.keys(event).sort(), ['actor', 'command', 'createdAt', 'status', 'tabId', 'type', 'version', 'workspaceId']);
  assert.doesNotMatch(message, /secret|private|Private|provider/);
  await reader.cancel();
  await removedPromise;
  assert.equal(events.listenerCount('event'), 0);
});

test('standalone API events report successful and failed commands without result payloads', { timeout: 5000 }, async t => {
  const { url, headers, client } = await fixture(t);
  const response = await fetch(`${url}/v1/events`, { headers });
  const reader = response.body.getReader();
  await reader.read();
  await client.execute('tabs.new', { url: 'https://example.com/private' });
  const success = new TextDecoder().decode((await reader.read()).value);
  assert.match(success, /"status":"success"/);
  assert.doesNotMatch(success, /example\.com|private/);
  await assert.rejects(client.execute('page.title'), /No active tab/);
  const failure = new TextDecoder().decode((await reader.read()).value);
  assert.match(failure, /"status":"failure"/);
  assert.doesNotMatch(failure, /No active tab/);
  await reader.cancel();
});
