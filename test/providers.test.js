import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Providers } from '../src/providers.js';

async function fixture(t, handler, options = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'weft-providers-'));
  const server = createServer(async (req, res) => {
    let body = '';
    for await (const chunk of req) body += chunk;
    handler(req, res, body ? JSON.parse(body) : null);
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const conversations = new Map([['conversation-1', { id: 'conversation-1', messages: [] }]]);
  const workspace = {
    getConversation(id) {
      if (!conversations.has(id)) throw new Error('Conversation not found');
      return structuredClone(conversations.get(id));
    },
    async appendMessage(id, message) { conversations.get(id).messages.push(structuredClone(message)); },
  };
  const providers = await new Providers({ directory, workspace, env: {}, ...options }).init();
  const endpoint = `http://127.0.0.1:${server.address().port}/v1`;
  const model = await providers.execute('models.save', { name: 'Fixture', provider: 'openai', endpoint, model: 'fixture-model' });
  t.after(async () => {
    providers.close();
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    await rm(directory, { recursive: true, force: true });
  });
  const send = (extra = {}) => providers.execute('chat.send', { conversationId: 'conversation-1', modelId: model.id, text: 'Hello', ...extra });
  return { providers, directory, workspace, conversations, model, endpoint, send };
}

function reply(res, value) { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify(value)); }

test('OpenAI-compatible requests use the selected local endpoint and persist actual text and explicit context', async t => {
  const requests = [];
  const { send, conversations, model, endpoint } = await fixture(t, (req, res, body) => {
    requests.push({ url: req.url, body, authorization: req.headers.authorization });
    reply(res, { choices: [{ message: { content: 'Actual fixture answer' } }], usage: { prompt_tokens: 12, completion_tokens: 4 } });
  });
  const result = await send({ context: [{ title: 'Selected material', content: 'The answer is 42.' }] });
  assert.equal(result.message.content, 'Actual fixture answer');
  assert.equal(result.endpoint, endpoint);
  assert.deepEqual(result.usage, { inputTokens: 12, outputTokens: 4 });
  assert.equal(requests[0].url, '/v1/chat/completions');
  assert.equal(requests[0].body.model, model.model);
  assert.equal(requests[0].authorization, undefined);
  assert.equal(requests[0].body.tools, undefined);
  assert.match(requests[0].body.messages.at(-1).content, /The answer is 42/);
  assert.equal(conversations.get('conversation-1').messages.length, 2);
  await send({ text: 'Continue' });
  assert.equal(requests[1].body.messages.length, 4, 'saved conversation is retained across sends');
});

test('keys require real secure storage, remain absent from returned metadata, and survive encrypted reload', async t => {
  const safeStorage = {
    isEncryptionAvailable: () => true, getSelectedStorageBackend: () => 'test_secure_backend',
    encryptString: value => Buffer.from([...value].reverse().join('')),
    decryptString: value => [...value.toString()].reverse().join(''),
  };
  let authorization;
  const fixtureData = await fixture(t, (req, res) => {
    authorization = req.headers.authorization;
    reply(res, { choices: [{ message: { content: 'Saved key worked' } }] });
  }, { safeStorage });
  const { providers, directory, workspace, model, send } = fixtureData;
  const saved = await providers.execute('models.save', {
    id: model.id, name: model.name, provider: model.provider, endpoint: model.endpoint, model: model.model, apiKey: 'secret-provider-key',
  });
  assert.equal(saved.hasApiKey, true);
  assert.equal(JSON.stringify(saved).includes('secret-provider-key'), false);
  const disk = await readFile(join(directory, 'model-connections.json'), 'utf8');
  assert.equal(disk.includes('secret-provider-key'), false);
  assert.equal(disk.includes('encryptedKey'), true);
  const reopened = await new Providers({ directory, workspace, safeStorage, env: {} }).init();
  assert.equal((await reopened.execute('models.list')).find(item => item.id === model.id).hasApiKey, true);
  await send();
  assert.equal(authorization, 'Bearer secret-provider-key');
  const moved = await providers.execute('models.save', {
    id: model.id, name: model.name, provider: model.provider, endpoint: 'http://127.0.0.1:1/v1', model: model.model,
  });
  assert.equal(moved.hasApiKey, false, 'changing destinations must not forward a saved key');
});

test('unavailable or basic_text key storage refuses plaintext keys and permits environment references', async t => {
  const { providers, model } = await fixture(t, (_req, res) => reply(res, {}));
  const fields = { id: model.id, name: model.name, provider: model.provider, endpoint: model.endpoint, model: model.model };
  await assert.rejects(providers.execute('models.save', { ...fields, apiKey: 'never-save' }), /OS secure storage is unavailable/);
  providers.safeStorage = { isEncryptionAvailable: () => true, getSelectedStorageBackend: () => 'basic_text' };
  await assert.rejects(providers.execute('models.save', { ...fields, apiKey: 'never-save' }), /OS secure storage is unavailable/);
  await providers.execute('models.save', { ...fields, apiKeyEnv: 'TEST_MODEL_KEY' });
  await assert.rejects(providers.execute('chat.send', { conversationId: 'conversation-1', modelId: model.id, text: 'Hello' }), /Set TEST_MODEL_KEY/);
});

test('Anthropic uses its adapter and environment key without exposing the key in metadata or transcripts', async t => {
  let request;
  const { providers, model, send, conversations } = await fixture(t, (req, res, body) => {
    request = { headers: req.headers, url: req.url, body };
    reply(res, { content: [{ type: 'text', text: 'Anthropic answer' }], usage: { input_tokens: 5, output_tokens: 2 } });
  }, { env: { TEST_MODEL_KEY: 'env-secret' } });
  await providers.execute('models.save', { id: model.id, name: model.name, provider: 'anthropic', endpoint: model.endpoint, model: 'fixture-claude', apiKeyEnv: 'TEST_MODEL_KEY' });
  assert.equal((await send()).message.content, 'Anthropic answer');
  assert.equal(request.url, '/v1/messages');
  assert.equal(request.headers['x-api-key'], 'env-secret');
  assert.equal(request.headers['anthropic-version'], '2023-06-01');
  assert.ok(request.body.system);
  assert.equal(JSON.stringify(conversations.get('conversation-1')).includes('env-secret'), false);
  assert.equal(JSON.stringify(await providers.execute('models.list')).includes('env-secret'), false);
});

test('failed endpoint replies remain failures, preserve the user message, and never invent an assistant reply', async t => {
  let calls = 0;
  const { send, conversations } = await fixture(t, (_req, res) => {
    calls++;
    res.writeHead(401); res.end('Sensitive provider error body');
  });
  await assert.rejects(send(), /HTTP 401/);
  assert.equal(calls, 1);
  assert.deepEqual(conversations.get('conversation-1').messages.map(item => item.role), ['user']);
});

test('redirects cannot forward model requests', async t => {
  let calls = 0;
  const { send } = await fixture(t, (_req, res) => {
    calls++;
    res.writeHead(307, { location: '/stolen' }); res.end();
  });
  await assert.rejects(send(), /No fallback was used/);
  assert.equal(calls, 1);
});

test('cancellation, concurrent-send exclusion, and bounded timeout terminate actual pending requests', async t => {
  let requestArrived;
  const arrived = new Promise(resolve => { requestArrived = resolve; });
  const { providers, send, conversations } = await fixture(t, () => requestArrived(), { timeoutMs: 1000 });
  const pending = send();
  const rejection = assert.rejects(pending, /cancelled/);
  await arrived;
  await assert.rejects(send(), /already has a running/);
  assert.deepEqual(await providers.execute('chat.cancel', { conversationId: 'conversation-1' }), { cancelled: true });
  await rejection;
  assert.equal(conversations.get('conversation-1').messages.length, 1);
  providers.timeoutMs = 20;
  await assert.rejects(send(), /timed out/);
});

test('text-only adapters reject tool-only responses without executing anything', async t => {
  const { send, conversations } = await fixture(t, (_req, res) => reply(res, {
    choices: [{ message: { content: null, tool_calls: [{ function: { name: 'browser.close' } }] } }],
  }));
  await assert.rejects(send(), /tools are not executed/);
  assert.equal(conversations.get('conversation-1').messages.length, 1);
});

async function enableTools(fixtureData) {
  const { providers, model, conversations } = fixtureData;
  conversations.get('conversation-1').workspaceId = 'project-a';
  await providers.execute('models.save', { id: model.id, name: model.name, provider: model.provider,
    endpoint: model.endpoint, model: model.model, tools: true });
}
const toolReply = (name, args = {}, id = 'read-1') => ({ choices: [{ message: { role: 'assistant', content: null,
  tool_calls: [{ id, type: 'function', function: { name, arguments: JSON.stringify(args) } }] } }],
  usage: { prompt_tokens: 2, completion_tokens: 3 } });

test('explicit read-only tool loop uses fixed tab/workspace scope, persists evidence, and sums usage', async t => {
  const requests = [];
  const reads = [];
  const fixtureData = await fixture(t, (_req, res, body) => {
    requests.push(body);
    if (requests.length === 1) reply(res, toolReply('page_readable'));
    else if (requests.length === 2) reply(res, toolReply('workspace_search', { query: 'decision' }, 'read-2'));
    else reply(res, { choices: [{ message: { content: 'The selected page and saved decision agree.' } }], usage: { prompt_tokens: 4, completion_tokens: 5 } });
  }, {
    readPage: async args => { reads.push(args); return { url: 'https://example.com', text: 'A page result' }; },
    searchWorkspace: async args => { reads.push(args); return [{ id: 'context-1', title: 'Saved decision', content: 'Choose A' }]; },
  });
  await enableTools(fixtureData);
  const result = await fixtureData.send({ allowReadTools: true, tabId: 7 });
  assert.deepEqual(reads, [{ tabId: 7, workspaceId: 'project-a' }, { query: 'decision', workspaceId: 'project-a' }]);
  assert.equal(result.toolCalls, 2);
  assert.deepEqual(result.usage, { inputTokens: 8, outputTokens: 11 });
  assert.deepEqual(requests[0].tools.map(tool => tool.function.name), ['page_readable', 'workspace_search']);
  assert.equal(requests[1].messages.at(-1).tool_call_id, 'read-1');
  assert.equal(JSON.parse(requests[1].messages.at(-1).content).untrusted, true);
  const persisted = fixtureData.conversations.get('conversation-1').messages;
  assert.deepEqual(persisted.map(item => item.role), ['user', 'tool', 'tool', 'assistant']);
  assert.match(persisted[1].content, /https:\/\/example.com/);
  await fixtureData.send({ text: 'Continue without tools' });
  assert.equal(requests[3].tools, undefined);
  assert.ok(requests[3].messages.some(message => message.content?.includes('Previous read-only tool result')));
});

test('tools need explicit request consent plus enabled model capability', async t => {
  let reads = 0;
  const fixtureData = await fixture(t, (_req, res) => reply(res, toolReply('page_readable')), {
    readPage: async () => { reads++; return {}; },
  });
  await assert.rejects(fixtureData.send({ allowReadTools: true, tabId: 1 }), /not enabled/);
  await enableTools(fixtureData);
  await assert.rejects(fixtureData.send({ tabId: 1 }), /tools are not executed/);
  assert.equal(reads, 0);
});

test('unknown write tools and model attempts to change workspace or tab are refused before any callback', async t => {
  for (const [name, args] of [
    ['page_navigate', { url: 'https://example.com' }],
    ['workspace_search', { query: 'secret', workspaceId: 'project-b' }],
    ['page_readable', { tabId: 999 }],
  ]) {
    let reads = 0;
    const fixtureData = await fixture(t, (_req, res) => reply(res, toolReply(name, args)), {
      readPage: async () => { reads++; return {}; }, searchWorkspace: async () => { reads++; return []; },
    });
    await enableTools(fixtureData);
    await assert.rejects(fixtureData.send({ allowReadTools: true, tabId: 7 }), /unsupported tool|scope cannot be changed/);
    assert.equal(reads, 0);
    assert.deepEqual(fixtureData.conversations.get('conversation-1').messages.map(item => item.role), ['user']);
  }
});

test('conversation workspace changes during inference prevent cross-workspace tool reads', async t => {
  let reads = 0;
  let fixtureData;
  fixtureData = await fixture(t, (_req, res) => {
    fixtureData.conversations.get('conversation-1').workspaceId = 'project-b';
    reply(res, toolReply('workspace_search', { query: 'secret' }));
  }, { searchWorkspace: async () => { reads++; return []; } });
  await enableTools(fixtureData);
  await assert.rejects(fixtureData.send({ allowReadTools: true }), /workspace changed/);
  assert.equal(reads, 0);
});

test('read-only loops stop after five tool calls and preserve actual results', async t => {
  let reads = 0;
  let requests = 0;
  const fixtureData = await fixture(t, (_req, res) => {
    requests++;
    reply(res, toolReply('workspace_search', { query: 'decision' }, `call-${requests}`));
  }, { searchWorkspace: async () => { reads++; return []; } });
  await enableTools(fixtureData);
  await assert.rejects(fixtureData.send({ allowReadTools: true }), /limit reached \(5 calls\)/);
  assert.equal(reads, 5);
  assert.equal(requests, 6);
  assert.equal(fixtureData.conversations.get('conversation-1').messages.filter(message => message.role === 'tool').length, 5);
});

test('read tools propagate scoped access denial without sending protected data', async t => {
  let requests = 0;
  const fixtureData = await fixture(t, (_req, res) => { requests++; reply(res, toolReply('page_readable')); }, {
    readPage: async ({ tabId, workspaceId }) => {
      assert.equal(tabId, 99); assert.equal(workspaceId, 'project-a');
      throw new Error('Tab is outside the conversation workspace');
    },
  });
  await enableTools(fixtureData);
  await assert.rejects(fixtureData.send({ allowReadTools: true, tabId: 99 }), /outside the conversation workspace/);
  assert.equal(requests, 1);
  assert.equal(fixtureData.conversations.get('conversation-1').messages.length, 1);
});
