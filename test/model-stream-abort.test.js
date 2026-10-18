import test from 'node:test';
import assert from 'node:assert/strict';
import { readOpenAIStream, readOllamaStream } from '../src/model-adapters.js';

// A deadline or stop must end a model stream even when the fetch implementation leaves a body read pending after
// the request is aborted (an intermittent hang seen with Node 22's fetch): the readers race each read against the
// turn's abort signal.
const stalledBody = () => new ReadableStream({
  start(controller) { controller.enqueue(new TextEncoder().encode('data: {"choices":[{"index":0,"delta":{"content":"Half "}}]}\n\n')); },
  pull() { return new Promise(() => {}); },
});

for (const [name, read, body] of [
  ['OpenAI SSE', readOpenAIStream, stalledBody],
  ['Ollama NDJSON', readOllamaStream, () => new ReadableStream({ start(c) { c.enqueue(new TextEncoder().encode('{"message":{"content":"Half "}}\n')); }, pull() { return new Promise(() => {}); } })],
]) {
  test(`${name}: aborting the signal ends a stream whose read never settles`, async () => {
    const controller = new AbortController();
    const deltas = [];
    const reading = read(body(), { signal: controller.signal, onDelta: text => deltas.push(text) });
    await new Promise(resolve => setTimeout(resolve, 50));
    assert.deepEqual(deltas, ['Half '], 'frames before the stall are delivered');
    const started = Date.now();
    controller.abort();
    await assert.rejects(reading, error => error.name === 'AbortError');
    assert.ok(Date.now() - started < 1000, 'the abort ends the read promptly');
  });
}
