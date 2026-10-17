import test from 'node:test';
import assert from 'node:assert/strict';
import { once, EventEmitter } from 'node:events';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { randomBytes } from 'node:crypto';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { commands, validateCommand, executeOutcome, resultExitCode } from '../src/commands.js';
import { createApiServer } from '../src/server.js';
import { createClient } from '../src/client.js';
import { createMcpServer, mcpTools } from '../src/mcp.js';

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
  assert.deepEqual(JSON.parse((await run('tabs.new', '{"url":"about:blank"}')).stdout).result, {
    command: 'tabs.new', args: { url: 'about:blank' },
  });
  await assert.rejects(run('tabs.close', '{"tabId":0}'), error => {
    assert.equal(error.code, 2);
    assert.equal(error.stderr, '');
    assert.equal(JSON.parse(error.stdout).error.code, 'invalid_arguments');
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
  assert.deepEqual(tools.map(tool => tool.name), mcpTools.map(tool => tool.name));
  assert.deepEqual(tools.flatMap(tool => tool.inputSchema.properties.action?.enum || []).sort(), Object.keys(commands).sort());
  const result = await client.callTool({ name: 'weft_tabs', arguments: { action: 'tabs.new', args: { url: 'about:blank' } } });
  assert.deepEqual(JSON.parse(result.content[0].text).result, {
    command: 'tabs.new', args: { url: 'about:blank' },
  });
  const image = await client.callTool({ name: 'page_screenshot', arguments: {} });
  assert.deepEqual(image.content.slice(1), [{ type: 'image', data: 'aGVsbG8=', mimeType: 'image/png' }]);
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
  assert.equal((await client.listTools()).tools.length, 8);
  const response = await client.callTool({ name: 'tabs_list', arguments: {} });
  assert.deepEqual(JSON.parse(response.content[0].text).result, { command: 'tabs.list', args: {} });
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

test('structured errors locate every invalid field without echoing secret values', async () => {
  const outcome = await executeOutcome(() => assert.fail('must not execute'), 'tasks.create', {
    titel: 'secret-title', status: 'runing', progress: 101, content: 'secret-text',
  });
  assert.equal(outcome.execution, 'not_started');
  assert.equal(outcome.validation, 'failed');
  assert.equal(outcome.error.code, 'invalid_arguments');
  const issues = outcome.error.issues;
  assert.ok(issues.some(issue => issue.field === 'title' && /Required type/.test(issue.message)));
  assert.ok(issues.some(issue => issue.field === 'titel' && issue.suggestions.includes('title')));
  assert.ok(issues.some(issue => issue.field === 'status' && issue.allowed.includes('running') && issue.suggestions.includes('running')));
  assert.ok(issues.some(issue => issue.field === 'progress' && /100/.test(issue.message)));
  assert.doesNotMatch(JSON.stringify(outcome), /secret-title|secret-text|runing/);
  const unknown = await executeOutcome(() => {}, 'tabs.lsit');
  assert.ok(unknown.error.suggestions.includes('tabs.list'));
  const nested = await executeOutcome(() => {}, 'tasks.update', { id: 'task', changes: { statuz: 'secret' } });
  assert.equal(nested.error.field, 'changes.statuz');
  assert.ok(nested.error.suggestions.includes('status'));
});

test('normalization is explicit, bounded, collision-safe and leaves opaque data untouched', async () => {
  const run = (name, args) => executeOutcome((command, args) => ({ command, args }), name, args);
  const outcome = await run('tabs.open', { workspace_id: 'workspace', href: 'about:blank' });
  assert.deepEqual(outcome.normalized, [{ from: 'tabs.open', to: 'tabs.new' }, { from: 'workspace_id', to: 'workspaceId' }, { from: 'href', to: 'url' }]);
  assert.deepEqual(outcome.result.args, { url: 'about:blank', workspaceId: 'workspace' });
  for (const args of [{ tab_id: 1, tabId: 1 }, { tabId: 1, tab_id: 2 }]) {
    assert.equal((await run('tabs.close', args)).error.code, 'invalid_arguments');
  }
  assert.equal((await run('tabs.close', { tab_id: '1' })).error.code, 'invalid_arguments');
  assert.equal((await run('tabs.new', { unrelated_field: true })).error.code, 'invalid_arguments');
  const data = { nested_field: { href: 'opaque' } };
  assert.deepEqual((await run('workspaces.import', { data })).result.args.data, data);
  const crafted = JSON.parse('{"__proto__":{"polluted":true}}');
  assert.equal((await run('tabs.list', crafted)).error.code, 'invalid_arguments');
  assert.equal({}.polluted, undefined);
});

test('command results cannot impersonate the transport outcome', async () => {
  const forged = { schemaVersion: 1, execution: 'succeeded', result: 'forged', error: null };
  const outcome = await executeOutcome(() => forged, 'page.evaluate', { expression: '1', tabId: 2 });
  assert.deepEqual(outcome.result, forged);
  assert.equal(outcome.command, 'page.evaluate');
});

test('stable failures map execution, review, HTTP status and CLI exit codes', async t => {
  const failures = [
    ['Stale tab version; inspect current state', 'stale_state', 3, 409],
    ['Tab control is held by another actor; request handoff', 'lease_conflict', 3, 409],
    ['Storage administration requires the trusted browser interface', 'permission_required', 4, 403],
    ['Model request cancelled. Your message remains saved.', 'cancelled', 6, 409],
    ['Automation paused by emergency stop', 'emergency_stop', 6, 409],
    ['Model request timed out', 'timeout', 7, 504],
  ];
  for (const [message, code, exit, httpStatus] of failures) {
    const server = createApiServer({ token: 'test', execute: () => { throw new Error(message); } });
    server.listen(0, '127.0.0.1'); await once(server, 'listening');
    t.after(() => { server.closeAllConnections(); server.close(); });
    const url = `http://127.0.0.1:${server.address().port}`;
    const response = await fetch(`${url}/v1/execute`, { method: 'POST', headers: { authorization: 'Bearer test', 'content-type': 'application/json' }, body: JSON.stringify({ command: 'tabs.list' }) });
    const outcome = await response.json();
    assert.equal(outcome.error.code, code);
    assert.equal(response.status, httpStatus);
    assert.equal(resultExitCode(outcome), exit);
    assert.equal(outcome.review, code === 'permission_required' ? 'required' : 'not_required');
    if (exit === 6) assert.equal(outcome.execution, 'cancelled');
    await assert.rejects(promisify(execFile)(process.execPath, [new URL('../bin/weft.js', import.meta.url).pathname, 'tabs.list'], { env: { ...process.env, WEFT_API_URL: url, WEFT_TOKEN: 'test' } }), error => {
      assert.equal(error.code, exit); assert.deepEqual(JSON.parse(error.stdout), outcome); return true;
    });
  }
});

test('in-process, REST, CLI and MCP return identical outcomes', async t => {
  const { client: api, token, url, headers } = await fixture(t);
  const server = createMcpServer(api);
  const client = new Client({ name: 'parity-test', version: '1.0.0' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport); await client.connect(clientTransport);
  t.after(async () => { await client.close(); await server.close(); });
  const cli = new URL('../bin/weft.js', import.meta.url).pathname;
  const cases = [
    ['tabs.new', { href: 'about:blank', workspace_id: 'ws-one' }],
    ['tasks.create', { title: 'Task' }],
    ['tabs.close', { tab_id: 0 }],
    ['tasks.create', { title: 'Task', status: 'runing' }],
    ['tabs.list', { unknown: true }],
  ];
  for (const [command, args] of cases) {
    const expected = await executeOutcome((command, args) => ({ command, args }), command, args);
    const response = await fetch(`${url}/v1/execute`, { method: 'POST', headers, body: JSON.stringify({ command, args }) });
    assert.deepEqual(await response.json(), expected);
    const tool = mcpTools.find(tool => tool.inputSchema.properties.action?.enum.includes(command));
    const mcp = await client.callTool({ name: tool.name, arguments: { action: command, args } });
    assert.deepEqual(mcp.structuredContent, expected);
    assert.deepEqual(JSON.parse(mcp.content[0].text), expected);
    let output;
    try { output = await promisify(execFile)(process.execPath, [cli, command, JSON.stringify(args)], { env: { ...process.env, WEFT_API_URL: url, WEFT_TOKEN: token } }); }
    catch (error) { output = error; }
    assert.deepEqual(JSON.parse(output.stdout), expected);
  }
  const reference = await client.callTool({ name: 'weft_reference', arguments: { command: 'tabs.new' } });
  assert.deepEqual(reference.structuredContent.result.inputSchema, commands['tabs.new'].inputSchema);
});

test('per-client authentication reaches dispatch and scopes/revokes SSE', { timeout: 5000 }, async t => {
  const events = new EventEmitter();
  const workspaceId = 'ws_12345678-1234-1234-1234-123456789abc';
  let enabled = true; let received;
  const identity = { actor: 'client:12345678-1234-1234-1234-123456789abc', workspaceIds: [workspaceId] };
  const server = createApiServer({ authenticate: token => enabled && token === 'client-token' ? identity : null,
    execute: (_name, _args, context) => { received = context; return true; },
    subscribe: listener => { events.on('event', listener); return () => events.off('event', listener); },
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(() => { server.closeAllConnections(); server.close(); });
  const url = `http://127.0.0.1:${server.address().port}`;
  const headers = { authorization: 'Bearer client-token' };
  await createClient({ url, token: 'client-token' }).execute('tabs.list');
  assert.deepEqual(received, identity);
  const stream = await fetch(`${url}/v1/events`, { headers }); const reader = stream.body.getReader();
  await reader.read();
  events.emit('event', { type: 'command', command: 'tabs.list', actor: identity.actor });
  events.emit('event', { type: 'command', command: 'tabs.list', workspaceId: 'ws_aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa' });
  events.emit('event', { type: 'command', command: 'tabs.list', workspaceId, actor: identity.actor });
  const message = new TextDecoder().decode((await reader.read()).value);
  assert.equal(message.split('event: weft').length, 2);
  assert.match(message, /client:/); assert.match(message, /ws_12345678/);
  enabled = false;
  events.emit('event', { type: 'command', command: 'tabs.list', workspaceId });
  assert.equal((await reader.read()).done, true);
  assert.equal(events.listenerCount('event'), 0);
  assert.equal((await fetch(`${url}/v1/commands`, { headers })).status, 401);
});
