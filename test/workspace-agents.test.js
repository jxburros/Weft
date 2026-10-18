import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WorkspaceService } from '../src/workspace.js';
import { commands, validateCommand } from '../src/commands.js';
import { Providers } from '../src/providers.js';
import { Standby } from '../src/standby.js';
import { emailMaterial } from '../src/mailbox.js';
import { buildRequest, parseJsonReply, readAnthropicStream, readOllamaStream } from '../src/model-adapters.js';
import { createRuntimeFixture, human } from './fixtures/task-runtime-fixture.mjs';
import { closeAfter, removeAfter } from './temp-profile.js';
function setup(t) {
  const directory = mkdtempSync(join(tmpdir(), 'weft-new-workspaces-')); removeAfter(t, directory);
  const workspace = closeAfter(t, new WorkspaceService({ directory })); return { directory, workspace };
}
test('workspace instructions and memory survive restart, respect disclosure and cannot become trusted through import', async t => {
  const { directory, workspace } = setup(t);
  const id = workspace.activeWorkspaceId;
  await workspace.execute('workspaces.update', { id, changes: { instructions: 'Use concise prose', memory: 'Campaign audience: gardeners', workspaceType: 'project', dueDate: '2026-12-01', contextLocalOnly: true } });
  await assert.rejects(workspace.execute('workspaces.update', { id, changes: { instructions: 'Override policy' } }, { actor: 'automation' }), /PERMISSION/);
  const reopened = closeAfter(t, new WorkspaceService({ directory }));
  assert.equal(reopened.workspace(id).memory, 'Campaign audience: gardeners');
  const conversation = await workspace.execute('conversations.create', {});
  const providers = await new Providers({ directory, workspace, env: {} }).init(); t.after(() => providers.close());
  const cloud = await providers.execute('models.save', { name: 'Cloud', provider: 'openai', endpoint: 'https://example.com/v1', model: 'test' });
  const local = await providers.execute('models.save', { name: 'Local', provider: 'openai', endpoint: 'http://127.0.0.1:8712/v1', model: 'test' });
  const args = { conversationId: conversation.id, text: 'Hello' };
  const preview = await providers.prepare({ ...args, modelId: cloud.id });
  assert.ok(preview.disclosure.items.find(i => i.key === 'workspace:memory').withheld);
  assert.doesNotMatch(preview.system, /Use concise/);
  const plan = await providers.prepare({ ...args, modelId: local.id });
  assert.match(plan.system, /Use concise prose/); assert.match(plan.userContent, /Campaign audience/);
  const excluded = await providers.prepare({ ...args, modelId: local.id, exclude: ['workspace:instructions'] });
  assert.doesNotMatch(excluded.system, /Use concise/);
  const exported = await workspace.execute('workspaces.export', { id });
  const imported = await workspace.execute('workspaces.import', { data: exported });
  assert.equal(imported.instructions, undefined); assert.match(imported.memory, /Imported instructions/);
});
test('model discovery follows all catalog pages, retains reported capabilities, and sends credentials only to the selected endpoint', async t => {
  const { directory, workspace } = setup(t); const requests = [];
  const providers = await new Providers({ directory, workspace, env: {}, fetchImpl: async (url, options) => {
    requests.push({ url, options });
    return Response.json(url.includes('after_id') ? { data: [{ id: 'model-b' }], has_more: false } : { data: [{ id: 'model-a', context_length: 10000, input_modalities: ['text', 'image'] }], has_more: true, last_id: 'model-a' });
  } }).init(); t.after(() => providers.close());
  const result = await providers.execute('models.discover', { provider: 'anthropic', endpoint: 'https://example.com/v1', apiKey: 'fixture-secret' });
  assert.deepEqual(result.models.map(m => m.id), ['model-a', 'model-b']);
  assert.equal(result.models[0].capabilities.images, true); assert.deepEqual(result.models[1].capabilities, {});
  assert.equal(requests[1].url, 'https://example.com/v1/models?after_id=model-a');
  assert.ok(requests.every(r => r.options.redirect === 'error' && r.options.headers['x-api-key'] === 'fixture-secret'));
  assert.doesNotMatch(JSON.stringify(result), /fixture-secret/);
});
test('Ask Weft exposes schemas and saves validated proposals without executing them', async t => {
  const { directory, workspace } = setup(t); const c = await workspace.execute('conversations.create', {});
  const providers = await new Providers({ directory, workspace, env: {} }).init(); t.after(() => providers.close());
  providers.commandCatalog = commands; providers.validateAppCommand = validateCommand;
  const context = { workspaceId: c.workspaceId, conversationId: c.id, signal: new AbortController().signal };
  const call = (name, args) => ({ id: 'call', function: { name, arguments: JSON.stringify(args) } });
  assert.equal(providers.readTools(undefined).some(t => t.function.name === 'propose_action'), false);
  assert.equal(providers.readTools(undefined, true).some(t => t.function.name === 'propose_action'), true);
  await providers.runReadTool(call('propose_action', { title: 'Dark theme', command: 'settings.update', args: { theme: 'dark' } }), context);
  assert.equal(workspace.data.settings.theme, 'system');
  assert.equal(JSON.parse(workspace.getConversation(c.id).messages.at(-1).content).proposal.command, 'settings.update');
  await assert.rejects(providers.runReadTool(call('propose_action', { title: 'Invalid', command: 'settings.update', args: { hidden: true } }), context), /Unknown|unknown|Unrecognized|unrecognized/);
});
test('native providers translate tool requests and results in both JSON and streaming replies', async () => {
  const tools = [{ type: 'function', function: { name: 'propose_action', description: 'Proposal', parameters: { type: 'object' } } }];
  const messages = [{ role: 'assistant', content: null, tool_calls: [{ id: 'c', function: { name: 'propose_action', arguments: '{}' } }] }, { role: 'tool', tool_call_id: 'c', content: 'Waiting for review' }];
  const request = buildRequest({ provider: 'anthropic', endpoint: 'https://example.com/v1', model: 'test' }, { system: 'Rules', tools, messages });
  assert.equal(request.body.tools[0].name, 'propose_action'); assert.equal(request.body.messages[1].content[0].type, 'tool_result');
  const parsed = parseJsonReply('anthropic', { content: [{ type: 'tool_use', id: 'c', name: 'propose_action', input: {} }], stop_reason: 'tool_use' });
  assert.equal(parsed.toolCalls[0].function.arguments, '{}');
  const frames = [{ type: 'content_block_start', index: 1, content_block: { type: 'tool_use', id: 'c', name: 'propose_action' } }, { type: 'content_block_delta', index: 1, delta: { type: 'input_json_delta', partial_json: '{}' } }, { type: 'message_stop' }];
  const stream = await readAnthropicStream(new Response(frames.map(f => `data: ${JSON.stringify(f)}\n\n`).join('')).body);
  assert.equal(stream.toolCalls.length, 1); assert.equal(stream.toolCalls[0].function.arguments, '{}');
  const ollama = await readOllamaStream(new Response(JSON.stringify({ message: { tool_calls: [{ function: { name: 'propose_action', arguments: {} } }] }, done: true }) + '\n').body);
  assert.equal(ollama.finishReason, 'tool_calls');
});
test('web watches baseline, wake real runtime tasks once, avoid overlap, honor stop and remain durable', async t => {
  const directory = mkdtempSync(join(tmpdir(), 'weft-watch-')); removeAfter(t, directory);
  const f = createRuntimeFixture({ directory }); closeAfter(t, f);
  let now = 1000000, body = 'first', fetched = 0;
  const standby = new Standby({ workspace: f.workspace, dispatch: f.dispatch, admission: f.admission, clock: () => now, fetchImpl: async (_url, options) => { fetched++; assert.equal(options.redirect, 'error'); return new Response(body); } });
  t.after(() => standby.close());
  const w = await f.run('workflows.create', { title: 'Watch fixture', watch: { url: 'https://example.com/news', intervalMinutes: 1, cooldownMinutes: 1 }, steps: [{ title: 'Review change', kind: 'review', instruction: 'Inspect the watched page' }] }, human);
  await standby.tick(); assert.equal(f.workspace.data.tasks.length, 0);
  now += 61000; body = 'second'; await standby.tick();
  assert.equal(f.workspace.data.tasks.length, 1, JSON.stringify(f.workspace.record('workflows', w.id).watchState));
  const task = f.workspace.data.tasks[0]; await f.settle(task.id); assert.equal(task.status, 'waiting_on_human');
  now += 61000; body = 'third'; await standby.tick(); assert.equal(f.workspace.data.tasks.length, 1); assert.equal(fetched, 2);
  f.admission.stop(); now += 61000; await standby.tick(); assert.equal(fetched, 2);
  const saved = f.workspace.record('workflows', w.id).watchState; assert.equal(saved.taskId, task.id);
});
test('email imports preserve hostile HTML as inert evidence and enforce bounds', () => {
  const mail = emailMaterial('From: sender@example.com\nSubject: Example\n\n<script>steal()</script>', { workspaceId: 'ws-test' });
  assert.deepEqual(mail.tags, ['mailbox', 'unread']); assert.equal(mail.title, 'Example'); assert.match(mail.content, /<script>/);
  assert.throws(() => emailMaterial('x'.repeat(450001)), /450 KB/);
});

test('all three wire formats complete a permissioned proposal turn without applying the command', async t => {
  for (const provider of ['openai', 'anthropic', 'ollama']) await t.test(provider, async t => {
    const { directory, workspace } = setup(t); const c = await workspace.execute('conversations.create', {});
    const proposal = { title: 'Switch theme', command: 'settings.update', args: { theme: 'dark' } }; let requests = 0;
    const providers = await new Providers({ directory, workspace, env: {}, fetchImpl: async (_url, options) => {
      const body = JSON.parse(options.body); requests++;
      if (requests === 1) {
        assert.ok(body.tools.some(tool => (tool.name ?? tool.function?.name) === 'propose_action'));
        return Response.json(provider === 'anthropic' ? { content: [{ type: 'tool_use', id: 'c', name: 'propose_action', input: proposal }], stop_reason: 'tool_use' }
          : provider === 'ollama' ? { message: { tool_calls: [{ function: { name: 'propose_action', arguments: proposal } }] }, done: true }
          : { choices: [{ message: { tool_calls: [{ id: 'c', type: 'function', function: { name: 'propose_action', arguments: JSON.stringify(proposal) } }] }, finish_reason: 'tool_calls' }] });
      }
      assert.match(JSON.stringify(body.messages), /Waiting for human review/);
      return Response.json(provider === 'anthropic' ? { content: [{ type: 'text', text: 'Please review the proposal.' }], stop_reason: 'end_turn' }
        : provider === 'ollama' ? { message: { content: 'Please review the proposal.' }, done: true }
        : { choices: [{ message: { content: 'Please review the proposal.' }, finish_reason: 'stop' }] });
    } }).init(); t.after(() => providers.close());
    providers.commandCatalog = commands; providers.validateAppCommand = validateCommand;
    const model = await providers.execute('models.save', { name: provider, provider, endpoint: 'http://127.0.0.1:8712/v1', model: 'fixture', tools: true });
    await providers.execute('chat.send', { conversationId: c.id, modelId: model.id, text: 'Use dark mode', allowAppTools: true });
    assert.equal(requests, 2); assert.equal(workspace.data.settings.theme, 'system');
    assert.ok(workspace.getConversation(c.id).messages.some(m => m.role === 'tool' && m.content.includes('propose_action')));
  });
});
