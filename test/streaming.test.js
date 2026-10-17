import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { once } from 'node:events';
import { createApiServer } from '../src/server.js';
import { executeOutcome } from '../src/commands.js';
import { AutomationAdmission } from '../src/admission.js';
import { TURN_FRAME_TYPES, TurnRelay, turnFrameSchema } from '../src/turn-relay.js';
import { fakeEndpoint, modelFixture, sse, ndjson, json, openaiDelta, openaiFinish, tick, until } from './model-test-helpers.js';

const outcomeOf = (fixture, args, caller) => executeOutcome((name, input) => fixture.providers.execute(name, input, caller), 'chat.send', { conversationId: fixture.conversation.id, text: 'Hello', ...args });

test('OpenAI-compatible SSE deltas stream in order, persist one complete reply and report actual usage', async t => {
  const endpoint = await fakeEndpoint(t, (_req, res) => sse(res, [
    openaiDelta('Hel'), openaiDelta('lo, '), openaiDelta('world.'), openaiFinish('stop'),
    { choices: [], usage: { prompt_tokens: 21, completion_tokens: 3 } }, '[DONE]',
  ]));
  const fixture = await modelFixture(t);
  const model = await fixture.save({ endpoint: `${endpoint.base}/v1`, pricing: { currency: 'USD', inputPerMillion: 1, outputPerMillion: 2 } });
  const frames = [];
  const result = await fixture.send(model.id, {}, { onProgress: frame => frames.push(frame), actor: 'human' });
  assert.equal(endpoint.requests[0].body.stream, true);
  assert.deepEqual(endpoint.requests[0].body.stream_options, { include_usage: true });
  assert.deepEqual(frames.filter(frame => frame.type === 'delta').map(frame => frame.text), ['Hel', 'lo, ', 'world.']);
  assert.deepEqual(frames.map(frame => frame.seq), frames.map((_, index) => index + 1), 'frame sequence is gapless');
  assert.ok(frames.every(frame => frame.id === `${result.turnId}:${frame.seq}` && TURN_FRAME_TYPES.includes(frame.type)));
  // Consumer-side contract check with the same schema the relay enforces on emit.
  for (const frame of JSON.parse(JSON.stringify(frames))) turnFrameSchema.parse(frame);
  assert.deepEqual(frames.at(-1), { ...frames.at(-1), type: 'end', status: 'complete', finishReason: 'stop' });
  assert.equal(result.message.content, 'Hello, world.');
  assert.equal(result.status, 'complete');
  assert.deepEqual(result.usage, { inputTokens: 21, outputTokens: 3 });
  assert.deepEqual(result.cost, { estimate: true, amount: 0.000027, currency: 'USD', basis: 'Configured pricing × provider-reported tokens; not a bill.' });
  assert.equal(result.locality, 'on-device endpoint');
  const messages = fixture.messages();
  assert.deepEqual(messages.map(message => [message.role, message.turnId]), [['user', result.turnId], ['assistant', result.turnId]]);
  assert.equal(messages[1].finishReason, 'stop');
  const manifest = fixture.manifests().at(-1);
  assert.equal(manifest.status, 'complete');
  assert.deepEqual(manifest.usage, { inputTokens: 21, outputTokens: 3 });
  assert.deepEqual(fixture.events.map(event => event.status), ['started', 'completed']);
  // The relay retains the same frames for followers.
  assert.deepEqual(fixture.relay.replay(result.turnId).frames.map(frame => frame.id), frames.map(frame => frame.id));
});

test('Anthropic streaming normalizes stop reasons, sums usage, and length stops are saved partial and continuable', async t => {
  let reason = 'end_turn';
  const endpoint = await fakeEndpoint(t, (_req, res) => sse(res, [
    { type: 'message_start', message: { usage: { input_tokens: 9, output_tokens: 1 } } },
    { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
    { type: 'ping' },
    { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'First ' } },
    { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'part' } },
    { type: 'message_delta', delta: { stop_reason: reason }, usage: { output_tokens: 7 } },
    { type: 'message_stop' },
  ], { event: true }));
  const fixture = await modelFixture(t, { providers: { env: { FIXTURE_KEY: 'anthropic-secret' } } });
  const model = await fixture.save({ provider: 'anthropic', endpoint: `${endpoint.base}/v1`, apiKeyEnv: 'FIXTURE_KEY' });
  const complete = await fixture.send(model.id);
  assert.equal(endpoint.requests[0].url, '/v1/messages');
  assert.equal(endpoint.requests[0].body.stream, true);
  assert.equal(complete.message.content, 'First part');
  assert.equal(complete.finishReason, 'stop');
  assert.deepEqual(complete.usage, { inputTokens: 9, outputTokens: 7 });
  reason = 'max_tokens';
  const partial = await fixture.send(model.id, { text: 'Longer please' });
  assert.equal(partial.status, 'partial');
  assert.equal(partial.finishReason, 'length');
  assert.equal(partial.continuable, true);
  const saved = fixture.messages().at(-1);
  assert.deepEqual([saved.status, saved.finishReason, saved.continuable], ['interrupted', 'length', true]);
  assert.equal(JSON.stringify(fixture.workspace.getConversation(fixture.conversation.id)).includes('anthropic-secret'), false);
});

test('Ollama native NDJSON streams text and in-band error frames become failed turns, never replies', async t => {
  let fail = false;
  const endpoint = await fakeEndpoint(t, (_req, res) => ndjson(res, fail
    ? [{ message: { role: 'assistant', content: 'Partial words' }, done: false }, { error: 'model runner has unexpectedly stopped' }]
    : [{ message: { role: 'assistant', content: 'Local ' }, done: false }, { message: { role: 'assistant', content: 'answer' }, done: false },
      { message: { role: 'assistant', content: '' }, done: true, done_reason: 'stop', prompt_eval_count: 11, eval_count: 2 }]));
  const fixture = await modelFixture(t);
  const model = await fixture.save({ provider: 'ollama', endpoint: endpoint.base, model: 'llava', capabilities: { contextWindow: 8192 } });
  const result = await fixture.send(model.id);
  assert.equal(endpoint.requests[0].url, '/api/chat');
  assert.equal(endpoint.requests[0].body.options.num_ctx, 8192, 'a known context window is negotiated with Ollama');
  assert.equal(result.message.content, 'Local answer');
  assert.deepEqual(result.usage, { inputTokens: 11, outputTokens: 2 });
  fail = true;
  const outcome = await outcomeOf(fixture, { modelId: model.id, text: 'Again' });
  assert.equal(outcome.execution, 'failed');
  assert.match(outcome.error.message, /reported an error during the reply.*unexpectedly stopped.*No fallback/);
  assert.deepEqual(fixture.messages().map(message => message.role), ['user', 'assistant', 'user']);
  const manifest = fixture.manifests().at(-1);
  assert.equal(manifest.status, 'failed');
  assert.equal(manifest.partialDiscarded, true);
  assert.match(manifest.error, /unexpectedly stopped/);
});

test('OpenAI error frames mid-stream and truncated streams fail without saving the partial as a reply', async t => {
  let mode = 'error';
  const endpoint = await fakeEndpoint(t, (_req, res) => mode === 'error'
    ? sse(res, [openaiDelta('Some text'), { error: { message: 'upstream overloaded', type: 'server_error' } }])
    : sse(res, [openaiDelta('Cut off')]));
  const fixture = await modelFixture(t);
  const model = await fixture.save({ endpoint: `${endpoint.base}/v1` });
  await assert.rejects(fixture.send(model.id), /upstream overloaded/);
  mode = 'truncated';
  await assert.rejects(fixture.send(model.id), /stream ended before the reply finished/);
  assert.deepEqual(fixture.messages().map(message => message.role), ['user', 'user']);
  assert.deepEqual(fixture.manifests().map(manifest => manifest.status), ['failed', 'failed']);
});

test('cancellation mid-stream stops the request and keeps the partial reply, marked interrupted', async t => {
  let closed;
  const endpoint = await fakeEndpoint(t, (req, res) => {
    closed = once(req.socket, 'close');
    sse(res, [openaiDelta('Thinking about '), openaiDelta('your question')], { end: false });
  });
  const fixture = await modelFixture(t);
  const model = await fixture.save({ endpoint: `${endpoint.base}/v1` });
  const frames = [];
  const pending = outcomeOf(fixture, { modelId: model.id }, { onProgress: frame => frames.push(frame) });
  await until(() => frames.filter(frame => frame.type === 'delta').length === 2);
  const cancel = await fixture.providers.execute('chat.cancel', { conversationId: fixture.conversation.id });
  const outcome = await pending;
  await closed;
  assert.equal(outcome.execution, 'cancelled');
  assert.equal(outcome.error.code, 'cancelled');
  assert.deepEqual(outcome.error.details, { turnId: cancel.turnId, partialSaved: true, continuable: false });
  const reply = fixture.messages().at(-1);
  assert.deepEqual([reply.role, reply.content, reply.status, reply.finishReason], ['assistant', 'Thinking about your question', 'interrupted', 'cancelled']);
  assert.equal(frames.at(-1).type, 'end');
  assert.equal(frames.at(-1).status, 'interrupted');
  assert.equal(fixture.manifests().at(-1).status, 'cancelled');
});

test('first-token, idle and total deadlines stop silent streams; partials are continuable', async t => {
  let mode;
  const endpoint = await fakeEndpoint(t, (_req, res) => {
    if (mode === 'first') { res.writeHead(200, { 'content-type': 'text/event-stream' }); res.write(': keep-alive comment\n\n'); }
    else if (mode === 'idle') sse(res, [openaiDelta('Half an ')], { end: false });
    else { const timer = setInterval(() => sse(res, [openaiDelta('.')], { end: false }), 5); res.on('close', () => clearInterval(timer)); }
  });
  const fixture = await modelFixture(t, { providers: { timeoutMs: 400, deadlines: { firstTokenMs: 60, idleMs: 60 } } });
  const model = await fixture.save({ endpoint: `${endpoint.base}/v1` });
  mode = 'first';
  let outcome = await outcomeOf(fixture, { modelId: model.id });
  assert.equal(outcome.error.code, 'timeout');
  assert.equal(outcome.error.details.deadline, 'first_token');
  assert.equal(outcome.error.details.partialSaved, false);
  mode = 'idle';
  outcome = await outcomeOf(fixture, { modelId: model.id });
  assert.equal(outcome.error.details.deadline, 'idle');
  assert.equal(outcome.error.details.partialSaved, true);
  assert.equal(outcome.error.details.continuable, true);
  assert.deepEqual([fixture.messages().at(-1).content, fixture.messages().at(-1).finishReason, fixture.messages().at(-1).continuable], ['Half an ', 'timeout', true]);
  mode = 'trickle';
  outcome = await outcomeOf(fixture, { modelId: model.id });
  assert.equal(outcome.error.details.deadline, 'total');
  assert.match(fixture.messages().at(-1).content, /^\.+$/);
  assert.deepEqual(fixture.manifests().slice(-3).map(manifest => manifest.deadline), ['first_token', 'idle', 'total']);
});

test('emergency stop and the admission latch abort running streams and persist partial replies', async t => {
  const admission = new AutomationAdmission();
  const endpoint = await fakeEndpoint(t, (_req, res) => {
    const timer = setInterval(() => sse(res, [openaiDelta('tick ')], { end: false }), 10);
    res.on('close', () => clearInterval(timer));
  });
  const fixture = await modelFixture(t, { providers: { admission } });
  const model = await fixture.save({ endpoint: `${endpoint.base}/v1` });
  const frames = [];
  let pending = outcomeOf(fixture, { modelId: model.id }, { onProgress: frame => frames.push(frame) });
  await until(() => frames.some(frame => frame.type === 'delta'));
  fixture.providers.stopAll('emergency_stop');
  let outcome = await pending;
  assert.equal(outcome.error.code, 'emergency_stop');
  assert.equal(outcome.execution, 'cancelled');
  assert.equal(fixture.messages().at(-1).finishReason, 'emergency_stop');
  assert.equal(fixture.manifests().at(-1).status, 'stopped');
  // The latch alone (set by another surface) also stops a stream at its next frame.
  frames.length = 0;
  pending = outcomeOf(fixture, { modelId: model.id }, { onProgress: frame => frames.push(frame) });
  await until(() => frames.some(frame => frame.type === 'delta'));
  admission.stop();
  outcome = await pending;
  assert.equal(outcome.error.code, 'emergency_stop');
  assert.equal(outcome.error.details.partialSaved, true);
  // While stopped, new model requests are refused before any network request.
  const before = endpoint.requests.length;
  outcome = await outcomeOf(fixture, { modelId: model.id });
  assert.equal(outcome.error.code, 'emergency_stop');
  assert.equal(endpoint.requests.length, before);
});

test('REST streaming: originating disconnect stops the turn; followers replay with Last-Event-ID and may leave freely', { timeout: 10000 }, async t => {
  let release;
  const endpoint = await fakeEndpoint(t, async (_req, res) => {
    sse(res, [openaiDelta('one '), openaiDelta('two ')], { end: false });
    await new Promise(resolve => { release = resolve; });
    sse(res, [openaiDelta('three'), openaiFinish('stop'), '[DONE]']);
  });
  const fixture = await modelFixture(t);
  const model = await fixture.save({ endpoint: `${endpoint.base}/v1` });
  const token = 'stream-test-token';
  const server = createApiServer({ token, turns: fixture.relay, execute: (name, args, context) => fixture.providers.execute(name, args, context) });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(() => new Promise(resolve => { server.closeAllConnections(); server.close(resolve); }));
  const url = `http://127.0.0.1:${server.address().port}`;
  const headers = { authorization: `Bearer ${token}`, 'content-type': 'application/json' };
  const read = async (reader, predicate) => {
    let text = '';
    const decoder = new TextDecoder();
    while (!predicate(text)) { const { value, done } = await reader.read(); if (done) break; text += decoder.decode(value); }
    return text;
  };
  const parse = text => text.split('\n\n').filter(block => block.includes('data: ')).map(block => {
    const frame = { id: /^id: (.*)$/m.exec(block)?.[1], event: /^event: (.*)$/m.exec(block)?.[1], data: JSON.parse(/^data: (.*)$/m.exec(block)[1]) };
    if (frame.event.startsWith('turn.')) {
      turnFrameSchema.parse(frame.data);
      assert.equal(frame.event, `turn.${frame.data.type}`);
      assert.equal(frame.id, frame.data.id);
    }
    return frame;
  });

  // 1. A follower can join, leave, and resume without affecting the turn; the originator finishes it.
  const origin = await fetch(`${url}/v1/execute`, { method: 'POST', headers: { ...headers, accept: 'text/event-stream' },
    body: JSON.stringify({ command: 'chat.send', args: { conversationId: fixture.conversation.id, modelId: model.id, text: 'Count' } }) });
  assert.match(origin.headers.get('content-type'), /text\/event-stream/);
  assert.match(origin.headers.get('cache-control'), /no-transform/);
  assert.equal(origin.headers.get('x-accel-buffering'), 'no');
  const originReader = origin.body.getReader();
  const early = parse(await read(originReader, text => text.split('event: turn.delta').length > 2));
  const turnId = early[0].data.turnId;
  assert.deepEqual(early.map(frame => frame.event), ['turn.start', 'turn.request', 'turn.delta', 'turn.delta']);
  const follower = await fetch(`${url}/v1/turns/${turnId}/events`, { headers: { authorization: headers.authorization, 'last-event-id': early[1].id } });
  const followerReader = follower.body.getReader();
  const replayed = parse(await read(followerReader, text => text.split('event: turn.delta').length > 2));
  assert.deepEqual(replayed.map(frame => frame.id), early.slice(2).map(frame => frame.id), 'replay starts after Last-Event-ID');
  await followerReader.cancel();
  await tick(30);
  assert.equal(fixture.providers.running.has(fixture.conversation.id), true, 'a follower disconnect does not stop the turn');
  release();
  const rest = parse(await read(originReader, text => text.includes('event: outcome')));
  const outcome = rest.at(-1).data;
  assert.equal(outcome.execution, 'succeeded');
  assert.equal(outcome.result.message.content, 'one two three');
  assert.deepEqual(rest.filter(frame => frame.event === 'turn.end').map(frame => frame.data.status), ['complete']);
  const resumed = await fetch(`${url}/v1/turns/${turnId}/events`, { headers: { authorization: headers.authorization, 'last-event-id': early[3].id } });
  const after = parse(await read(resumed.body.getReader(), text => text.includes('turn.end')));
  assert.deepEqual(after.map(frame => frame.event), ['turn.delta', 'turn.end']);
  assert.equal((await fetch(`${url}/v1/turns/turn_00000000-0000-0000-0000-000000000000/events`, { headers: { authorization: headers.authorization } })).status, 404);

  // 2. The originating client disconnecting is a stop: the partial reply is kept.
  const second = await fetch(`${url}/v1/execute`, { method: 'POST', headers: { ...headers, accept: 'text/event-stream' },
    body: JSON.stringify({ command: 'chat.send', args: { conversationId: fixture.conversation.id, modelId: model.id, text: 'Count again' } }) });
  const secondReader = second.body.getReader();
  await read(secondReader, text => text.split('event: turn.delta').length > 2);
  await secondReader.cancel();
  await until(() => !fixture.providers.running.has(fixture.conversation.id));
  release();
  const reply = fixture.messages().at(-1);
  assert.deepEqual([reply.content, reply.status, reply.finishReason], ['one two ', 'interrupted', 'disconnected']);
  assert.equal(fixture.manifests().at(-1).status, 'cancelled');
});

test('/v1/events assigns ids, replays retained events after Last-Event-ID, reports gaps and keeps workspace scope', { timeout: 10000 }, async t => {
  const events = new EventEmitter();
  const workspaceA = 'ws_12345678-1234-1234-1234-123456789abc';
  const workspaceB = 'ws_aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
  let now = Date.now();
  const identities = { master: { actor: 'automation' }, scoped: { actor: 'client:12345678-1234-1234-1234-123456789abc', workspaceIds: [workspaceA], scopes: ['read'] } };
  const server = createApiServer({ authenticate: token => identities[token] || null, execute: () => true,
    subscribe: listener => { events.on('event', listener); return () => events.off('event', listener); },
    eventRetention: { maxEvents: 5, maxAgeMs: 60000, now: () => now } });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(() => new Promise(resolve => { server.closeAllConnections(); server.close(resolve); }));
  const url = `http://127.0.0.1:${server.address().port}`;
  const emit = (status, workspaceId = workspaceA, extra = {}) => events.emit('event', { type: 'turn', status, workspaceId, turnId: 'turn_11111111-2222-3333-4444-555555555555', conversationId: 'conv_11111111-2222-3333-4444-555555555555', text: 'never streamed', ...extra });
  const collect = async (token, lastEventId, count) => {
    const response = await fetch(`${url}/v1/events`, { headers: { authorization: `Bearer ${token}`, ...(lastEventId ? { 'last-event-id': lastEventId } : {}) } });
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let text = '';
    while (text.split('\n\n').filter(block => /^(event|id): /m.test(block)).length < count) text += decoder.decode((await reader.read()).value);
    await reader.cancel();
    return text.split('\n\n').filter(block => /^event: /m.test(block)).map(block => ({ id: /^id: (.*)$/m.exec(block)?.[1], event: /^event: (.*)$/m.exec(block)[1], data: JSON.parse(/^data: (.*)$/m.exec(block)[1]) }));
  };
  emit('started');
  emit('completed');
  emit('started', workspaceB);
  const live = await collect('master', 'x', 4);
  assert.equal(live[0].event, 'gap', 'an unknown id is reported, then everything retained is replayed');
  const [first, second, third] = live.slice(1);
  assert.deepEqual([first.data.status, second.data.status, third.data.status], ['started', 'completed', 'started']);
  assert.equal(first.data.turnId, 'turn_11111111-2222-3333-4444-555555555555');
  assert.equal(JSON.stringify(live).includes('never streamed'), false, 'metadata allowlist still applies');
  const [boot, seq] = first.id.split('-');
  assert.equal(second.id, `${boot}-${Number(seq) + 1}`);
  // Resume after the first event: exactly the later ones, without a gap.
  const resumed = await collect('master', first.id, 2);
  assert.deepEqual(resumed.map(item => item.id), [second.id, third.id]);
  // Scoped clients only replay their workspace.
  const scoped = await collect('scoped', first.id, 1);
  assert.deepEqual(scoped.map(item => item.id), [second.id]);
  emit('completed', workspaceA);
  const scopedLater = await collect('scoped', second.id, 1);
  assert.equal(scopedLater[0].data.status, 'completed');
  assert.notEqual(scopedLater[0].id, third.id);
  // Retention is bounded by count and age; expired positions produce an explicit gap.
  for (let index = 0; index < 6; index++) emit('started');
  const expired = await collect('master', first.id, 6);
  assert.deepEqual([expired[0].event, expired[0].data.reason], ['gap', 'expired']);
  assert.equal(expired.length - 1, 5);
  now += 120000;
  emit('failed');
  const aged = await collect('master', expired.at(-1).id, 1);
  assert.equal(aged[0].data.status, 'failed');
  assert.equal(server.eventStats().retained, 1);
  const restarted = await collect('master', `000000000000-${seq}`, 2);
  assert.deepEqual([restarted[0].event, restarted[0].data.reason], ['gap', 'restarted']);
});

test('a local endpoint outage fails explicitly and never falls back to a configured cloud model', async t => {
  const fixture = await modelFixture(t, { fetchImpl: async url => {
    if (String(url).startsWith('https://')) return new Response(JSON.stringify({ choices: [{ message: { content: 'cloud' } }] }));
    throw new TypeError('fetch failed');
  } });
  const cloud = await fixture.save({ name: 'Cloud', endpoint: 'https://cloud.example/v1', capabilities: { images: true } });
  const local = await fixture.save({ name: 'Local', endpoint: 'http://127.0.0.1:9/v1', visionFallbackId: cloud.id });
  const outcome = await outcomeOf(fixture, { modelId: local.id });
  assert.equal(outcome.execution, 'failed');
  assert.match(outcome.error.message, /Unable to reach the selected model endpoint.*No fallback was used/);
  assert.deepEqual(fixture.outbound, ['http://127.0.0.1:9/v1/chat/completions']);
  assert.deepEqual(fixture.messages().map(message => message.role), ['user']);
  assert.equal(fixture.manifests().at(-1).status, 'failed');
});

test('model switches keep durable originals; small context windows omit oldest history visibly', async t => {
  const endpoint = await fakeEndpoint(t, (_req, res, body) => json(res, { choices: [{ message: { content: `Reply from ${body.model}` }, finish_reason: 'stop' }], usage: { prompt_tokens: 5, completion_tokens: 2 } }));
  const fixture = await modelFixture(t);
  const large = await fixture.save({ name: 'Large', endpoint: `${endpoint.base}/v1`, model: 'large-model' });
  const small = await fixture.save({ name: 'Small', endpoint: `${endpoint.base}/v1`, model: 'small-model', capabilities: { contextWindow: 2200, maxOutputTokens: 256 } });
  for (let index = 0; index < 4; index++) await fixture.send(large.id, { text: `Message ${index} ${'x'.repeat(1500)}` });
  const original = structuredClone(fixture.messages());
  const disclosure = await fixture.preview(small.id, { text: 'Summarize' });
  assert.equal(disclosure.context.window, 2200);
  assert.equal(disclosure.context.windowSource, 'configured');
  assert.ok(disclosure.context.omitted > 0 && disclosure.context.omitted < original.length);
  assert.deepEqual(disclosure.context.omittedKeys, original.slice(0, disclosure.context.omitted).map(message => message.id), 'oldest history is omitted first');
  assert.equal(disclosure.context.summarized, false);
  assert.ok(disclosure.items.filter(item => item.omitted).every(item => /original remains saved/.test(item.reason)));
  const result = await fixture.send(small.id, { text: 'Summarize' });
  assert.equal(result.context.omitted, disclosure.context.omitted);
  const request = endpoint.requests.at(-1).body;
  assert.equal(request.model, 'small-model');
  assert.equal(request.max_tokens, 256);
  assert.equal(JSON.stringify(request).includes('Message 0'), false);
  assert.ok(JSON.stringify(request).includes('Message 3'));
  assert.deepEqual(fixture.messages().slice(0, original.length), original, 'stored originals are never rewritten');
  assert.equal(fixture.manifests().at(-1).context.omitted, disclosure.context.omitted);
  // Item-level exclusion of a single history message.
  const keep = fixture.messages().at(-1).id;
  const excluded = await fixture.preview(large.id, { text: 'Again', exclude: [keep] });
  assert.equal(excluded.items.find(item => item.key === keep).delivery, 'excluded');
  await fixture.send(large.id, { text: 'Again', exclude: [keep] });
  assert.equal(JSON.stringify(endpoint.requests.at(-1).body).includes('Reply from small-model'), false);
  // A turn that cannot fit is an explicit unsupported-capability outcome, not a silent cut.
  const tiny = await fixture.save({ name: 'Tiny', endpoint: `${endpoint.base}/v1`, capabilities: { contextWindow: 300, maxOutputTokens: 200 } });
  const outcome = await outcomeOf(fixture, { modelId: tiny.id, text: 'y'.repeat(2000) });
  assert.equal(outcome.error.code, 'unsupported_capability');
  assert.deepEqual(outcome.error.details, { capability: 'contextWindow', modelId: tiny.id });
});

test('usage absent from the provider is reported as unavailable and no cost is invented', async t => {
  const endpoint = await fakeEndpoint(t, (_req, res) => sse(res, [openaiDelta('ok'), openaiFinish('stop'), '[DONE]']));
  const fixture = await modelFixture(t);
  const priced = await fixture.save({ endpoint: `${endpoint.base}/v1`, pricing: { currency: 'EUR', inputPerMillion: 3, outputPerMillion: 15 } });
  const result = await fixture.send(priced.id);
  assert.equal(result.usage, null);
  assert.equal(result.cost, null);
  const listed = (await fixture.providers.execute('models.list')).find(item => item.id === priced.id);
  assert.equal(listed.capabilities.streaming, true);
  assert.equal(listed.capabilities.sources.contextWindow, 'assumed default');
  assert.equal(listed.requiresDisclosure, false);
});

test('the turn relay bounds frames, reports gaps for dropped frames and expires finished turns', async () => {
  const relay = new TurnRelay({ maxFrames: 3, retainMs: 30 });
  const turnId = 'turn_12345678-1234-1234-1234-123456789abc';
  relay.start(turnId, { conversationId: 'conv_1', modelId: 'm', model: 'm', endpoint: 'http://127.0.0.1/v1', locality: 'on-device endpoint', streaming: true });
  for (const text of ['a', 'b', 'c', 'd']) relay.push(turnId, { type: 'delta', text });
  assert.throws(() => relay.push(turnId, { type: 'delta', text: 1 }), 'malformed frames are never emitted');
  assert.deepEqual(relay.replay(turnId).frames.map(frame => frame.seq), [3, 4, 5], 'only the newest frames are retained');
  assert.deepEqual(relay.replay(turnId, `${turnId}:3`), { frames: relay.replay(turnId).frames.slice(1), gap: null, done: false });
  const late = relay.replay(turnId, `${turnId}:1`);
  assert.equal(late.gap, 'expired');
  assert.deepEqual(late.frames.map(frame => frame.text), ['b', 'c', 'd']);
  assert.equal(relay.replay(turnId, 'turn_other:1').gap, 'unknown_event_id');
  relay.end(turnId, { status: 'complete', finishReason: 'stop' });
  assert.equal(relay.push(turnId, { type: 'delta', text: 'after end' }), null);
  await tick(60);
  assert.equal(relay.info(turnId), null, 'finished turns are retained only briefly');
});
