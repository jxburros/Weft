import { formatProviderStreamError } from './provider-safety.js';

/**
 * Wire adapters for the supported model APIs. Each adapter builds one request for exactly the
 * selected connection and normalizes streamed (SSE/NDJSON) or whole JSON replies into
 * `{ text, toolCalls, finishReason, rawFinishReason, usage, complete }`. Nothing here selects
 * another destination: failures are thrown to the caller.
 */
export const ADAPTERS = Object.freeze({
  openai: { label: 'OpenAI-compatible', path: 'chat/completions', streaming: true, images: true, tools: true },
  anthropic: { label: 'Anthropic Messages', path: 'messages', streaming: true, images: true, tools: true },
  ollama: { label: 'Ollama native', path: 'api/chat', streaming: true, images: true, tools: true },
});

const MAX_STREAM_BYTES = 8 * 1024 * 1024;
const MAX_LINE = 1024 * 1024;
const MAX_TOOL_ARGUMENT_BYTES = 65536;

export function normalizeFinishReason(value) {
  if (value === null || value === undefined || value === '') return null;
  const reason = String(value).toLowerCase();
  if (['stop', 'end_turn', 'stop_sequence', 'eos', 'end'].includes(reason)) return 'stop';
  if (['length', 'max_tokens', 'model_length', 'max_output_tokens'].includes(reason)) return 'length';
  if (['content_filter', 'refusal', 'safety', 'recitation'].includes(reason)) return 'content_filter';
  if (['tool_calls', 'tool_use', 'function_call'].includes(reason)) return 'tool_calls';
  return 'other';
}

export function usageFrom(usage, provider) {
  if (!usage || typeof usage !== 'object') return null;
  const pick = (...names) => { for (const name of names) if (Number.isSafeInteger(usage[name]) && usage[name] >= 0) return usage[name]; return null; };
  const inputTokens = provider === 'anthropic' ? pick('input_tokens') : provider === 'ollama' ? pick('prompt_eval_count') : pick('prompt_tokens', 'input_tokens');
  const outputTokens = provider === 'anthropic' ? pick('output_tokens') : provider === 'ollama' ? pick('eval_count') : pick('completion_tokens', 'output_tokens');
  return inputTokens === null && outputTokens === null ? null : { inputTokens, outputTokens };
}

class StreamError extends Error {}
const streamError = value => new StreamError(formatProviderStreamError(value));
const parseFrame = data => {
  try { return JSON.parse(data); } catch { throw new StreamError('Model stream contained an invalid JSON frame. No fallback was used.'); }
};

/** Split a response body into lines with total and per-line bounds. */
export async function* readLines(body, { onBytes, signal, maxBytes = MAX_STREAM_BYTES } = {}) {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let total = 0;
  // A deadline or stop must end the read even if the fetch implementation does not reject a read already in
  // flight when its request is aborted (seen with Node 22's fetch): race every read against the signal.
  let stopped = null;
  if (signal) {
    stopped = new Promise((_, reject) => {
      const abort = () => reject(signal.reason ?? Object.assign(new Error('The model stream was aborted'), { name: 'AbortError' }));
      if (signal.aborted) abort(); else signal.addEventListener('abort', abort, { once: true });
    });
    stopped.catch(() => {});
  }
  try {
    for (;;) {
      const { done, value } = await (stopped ? Promise.race([reader.read(), stopped]) : reader.read());
      if (done) break;
      total += value.byteLength;
      onBytes?.(value.byteLength);
      if (total > maxBytes) throw new StreamError(`Model stream exceeded the ${Math.round(maxBytes / 1048576)} MB limit`);
      buffer += decoder.decode(value, { stream: true });
      let index;
      while ((index = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, index);
        buffer = buffer.slice(index + 1);
        yield line.endsWith('\r') ? line.slice(0, -1) : line;
      }
      if (buffer.length > MAX_LINE) throw new StreamError('Model stream frame exceeded the 1 MB limit');
    }
    buffer += decoder.decode();
    if (buffer) yield buffer.endsWith('\r') ? buffer.slice(0, -1) : buffer;
  } finally {
    // Not awaited: cancelling can stall in the same state as the read; the request itself is already aborted or done.
    reader.cancel().catch(() => {});
  }
}

/** Minimal WHATWG server-sent-event parser (event/data fields; comments ignored). */
export async function* readSse(body, options) {
  let event = '';
  let data = [];
  for await (const line of readLines(body, options)) {
    if (line === '') {
      if (data.length) yield { event: event || 'message', data: data.join('\n') };
      event = ''; data = [];
      continue;
    }
    if (line.startsWith(':')) continue;
    const colon = line.indexOf(':');
    const field = colon < 0 ? line : line.slice(0, colon);
    let value = colon < 0 ? '' : line.slice(colon + 1);
    if (value.startsWith(' ')) value = value.slice(1);
    if (field === 'event') event = value;
    else if (field === 'data') data.push(value);
  }
  if (data.length) yield { event: event || 'message', data: data.join('\n') };
}

const emptyResult = () => ({ text: '', toolCalls: [], finishReason: null, rawFinishReason: null, usage: null, complete: false });
function appendText(result, text, onDelta) {
  if (typeof text !== 'string' || !text) return;
  result.text += text;
  onDelta?.(text);
}
function mergeUsage(result, usage) {
  if (!usage) return;
  result.usage ||= { inputTokens: null, outputTokens: null };
  for (const field of ['inputTokens', 'outputTokens']) if (usage[field] !== null) result.usage[field] = usage[field];
}

export async function readOpenAIStream(body, { onDelta, onFrame, onBytes, signal } = {}) {
  const result = emptyResult();
  const calls = [];
  let argumentBytes = 0;
  for await (const { data } of readSse(body, { onBytes, signal })) {
    onFrame?.();
    if (data.trim() === '[DONE]') { result.complete = true; break; }
    const frame = parseFrame(data);
    if (frame?.error) throw streamError(frame);
    mergeUsage(result, usageFrom(frame?.usage, 'openai'));
    const choice = frame?.choices?.[0];
    if (!choice) continue;
    const delta = choice.delta || choice.message || {};
    appendText(result, delta.content, onDelta);
    for (const call of Array.isArray(delta.tool_calls) ? delta.tool_calls : []) {
      const index = Number.isSafeInteger(call?.index) && call.index >= 0 && call.index < 16 ? call.index : calls.length;
      const target = calls[index] ||= { id: '', type: 'function', function: { name: '', arguments: '' } };
      if (typeof call.id === 'string') target.id = call.id;
      if (typeof call.type === 'string') target.type = call.type;
      if (typeof call.function?.name === 'string') target.function.name += call.function.name;
      if (typeof call.function?.arguments === 'string') {
        argumentBytes += call.function.arguments.length;
        if (argumentBytes > MAX_TOOL_ARGUMENT_BYTES) throw new StreamError('Streamed tool arguments exceeded the limit; no tools were executed.');
        target.function.arguments += call.function.arguments;
      }
    }
    if (choice.finish_reason) {
      result.rawFinishReason = String(choice.finish_reason).slice(0, 64);
      result.finishReason = normalizeFinishReason(choice.finish_reason);
    }
  }
  // Some compatible servers omit [DONE] but always send a finish reason.
  if (result.finishReason) result.complete = true;
  if (result.complete && !result.finishReason) result.finishReason = calls.length ? 'tool_calls' : 'stop';
  result.toolCalls = calls.filter(Boolean);
  return result;
}

export async function readAnthropicStream(body, { onDelta, onFrame, onBytes, signal } = {}) {
  const result = emptyResult();
  for await (const { event, data } of readSse(body, { onBytes, signal })) {
    onFrame?.();
    const frame = parseFrame(data);
    const type = frame?.type || event;
    if (type === 'error' || frame?.error) throw streamError(frame);
    if (type === 'message_start') mergeUsage(result, usageFrom(frame.message?.usage, 'anthropic'));
    else if (type === 'content_block_start' && frame.content_block?.type === 'tool_use') {
      if (!Number.isSafeInteger(frame.index) || frame.index < 0 || frame.index > 15) throw new StreamError('Too many tool calls');
      result.toolCalls[frame.index] = { id: frame.content_block.id, type: 'function', function: { name: frame.content_block.name, arguments: '' } };
    }
    else if (type === 'content_block_delta' && frame.delta?.type === 'input_json_delta') {
      const call = result.toolCalls[frame.index];
      if (!call) throw new StreamError('Tool argument delta without a tool call');
      call.function.arguments += frame.delta.partial_json || '';
      if (call.function.arguments.length > MAX_TOOL_ARGUMENT_BYTES) throw new StreamError('Tool arguments exceeded the limit');
    }
    else if (type === 'content_block_delta' && frame.delta?.type === 'text_delta') appendText(result, frame.delta.text, onDelta);
    else if (type === 'message_delta') {
      if (frame.delta?.stop_reason) {
        result.rawFinishReason = String(frame.delta.stop_reason).slice(0, 64);
        result.finishReason = normalizeFinishReason(frame.delta.stop_reason);
      }
      const output = usageFrom(frame.usage, 'anthropic');
      if (output) mergeUsage(result, { inputTokens: output.inputTokens, outputTokens: output.outputTokens });
    } else if (type === 'message_stop') { result.complete = true; break; }
  }
  result.toolCalls = result.toolCalls.filter(Boolean);
  if (result.complete && !result.finishReason) result.finishReason = result.toolCalls.length ? 'tool_calls' : 'stop';
  return result;
}

export async function readOllamaStream(body, { onDelta, onFrame, onBytes, signal } = {}) {
  const result = emptyResult();
  for await (const line of readLines(body, { onBytes, signal })) {
    if (!line.trim()) continue;
    onFrame?.();
    const frame = parseFrame(line);
    // Ollama reports failures as in-band {error} frames after HTTP 200.
    if (frame?.error) throw streamError(frame);
    appendText(result, frame?.message?.content, onDelta);
    for (const c of frame?.message?.tool_calls || []) result.toolCalls.push({ id: `ollama_${result.toolCalls.length}`, type: 'function', function: { name: c.function.name, arguments: JSON.stringify(c.function.arguments) } });
    if (frame?.done) {
      result.rawFinishReason = String(frame.done_reason || 'stop').slice(0, 64);
      result.finishReason = result.toolCalls.length ? 'tool_calls' : normalizeFinishReason(frame.done_reason || 'stop');
      mergeUsage(result, usageFrom(frame, 'ollama'));
      result.complete = true;
      break;
    }
  }
  return result;
}

/** Normalize a complete (non-streamed) JSON reply. A whole body is complete by construction. */
export function parseJsonReply(provider, json, { onDelta } = {}) {
  const result = emptyResult();
  if (!json || typeof json !== 'object') throw new StreamError('Model endpoint did not return a JSON object. No fallback was used.');
  if (json.error) throw streamError(json);
  result.complete = true;
  if (provider === 'anthropic') {
    result.toolCalls = (json.content || []).filter(c => c.type === 'tool_use').map(c => ({ id: c.id, type: 'function', function: { name: c.name, arguments: JSON.stringify(c.input) } }));
    appendText(result, Array.isArray(json.content) ? json.content.filter(block => block?.type === 'text').map(block => block.text).join('\n') : '', onDelta);
    result.rawFinishReason = json.stop_reason ?? null;
    result.finishReason = normalizeFinishReason(json.stop_reason) || 'stop';
    result.usage = usageFrom(json.usage, 'anthropic');
  } else if (provider === 'ollama') {
    result.toolCalls = (json.message?.tool_calls || []).map((c, i) => ({ id: `ollama_${i}`, type: 'function', function: { name: c.function.name, arguments: JSON.stringify(c.function.arguments) } }));
    appendText(result, json.message?.content, onDelta);
    result.rawFinishReason = json.done_reason ?? null;
    result.finishReason = result.toolCalls.length ? 'tool_calls' : normalizeFinishReason(json.done_reason) || 'stop';
    result.usage = usageFrom(json, 'ollama');
  } else {
    const choice = json.choices?.[0];
    const message = choice?.message;
    if (Array.isArray(message?.tool_calls)) result.toolCalls = message.tool_calls;
    appendText(result, typeof message?.content === 'string' ? message.content : '', onDelta);
    result.rawFinishReason = choice?.finish_reason ?? null;
    result.finishReason = normalizeFinishReason(choice?.finish_reason) || (result.toolCalls.length ? 'tool_calls' : 'stop');
    result.usage = usageFrom(json.usage, 'openai');
  }
  return result;
}

/** Content for the user message that carries images, in each API's supported transport. */
function withImages(provider, message, images) {
  if (!images.length) return message;
  if (provider === 'anthropic') return { role: 'user', content: [
    ...images.map(image => ({ type: 'image', source: { type: 'base64', media_type: image.mimeType, data: image.base64 } })),
    { type: 'text', text: message.content },
  ] };
  if (provider === 'ollama') return { ...message, images: images.map(image => image.base64) };
  return { role: 'user', content: [{ type: 'text', text: message.content },
    ...images.map(image => ({ type: 'image_url', image_url: { url: `data:${image.mimeType};base64,${image.base64}` } }))] };
}

export function buildRequest(profile, { system, messages, imageIndex = -1, images = [], tools = [], maxTokens = 4096, stream = false, contextWindow = null }) {
  const provider = profile.provider;
  const adapter = ADAPTERS[provider];
  if (!adapter) throw new Error(`Unsupported model API format: ${provider}`);
  let outbound = messages.map((message, index) => index === imageIndex ? withImages(provider, message, images) : message);
  if (provider === 'anthropic') outbound = outbound.map(m => {
    if (m.role === 'tool') return { role: 'user', content: [{ type: 'tool_result', tool_use_id: m.tool_call_id, content: m.content }] };
    if (m.tool_calls?.length) return { role: 'assistant', content: [...(m.content ? [{ type: 'text', text: m.content }] : []), ...m.tool_calls.map(c => ({ type: 'tool_use', id: c.id, name: c.function.name, input: JSON.parse(c.function.arguments) }))] };
    return m;
  });
  if (provider === 'ollama') outbound = outbound.map(m => m.tool_calls ? { ...m, tool_calls: m.tool_calls.map(c => ({ function: { name: c.function.name, arguments: JSON.parse(c.function.arguments) } })) } : m);
  let body;
  if (provider === 'anthropic') body = { model: profile.model, max_tokens: maxTokens, system, messages: outbound, ...(tools.length ? { tools: tools.map(t => ({ name: t.function.name, description: t.function.description, input_schema: t.function.parameters })) } : {}), ...(stream ? { stream: true } : {}) };
  else if (provider === 'ollama') body = { model: profile.model, messages: [{ role: 'system', content: system }, ...outbound], stream, ...(tools.length ? { tools } : {}),
    options: { num_predict: maxTokens, ...(contextWindow ? { num_ctx: contextWindow } : {}) } };
  else body = { model: profile.model, max_tokens: maxTokens, messages: [{ role: 'system', content: system }, ...outbound], stream,
    ...(stream ? { stream_options: { include_usage: true } } : {}),
    ...(tools.length ? { tools, tool_choice: 'auto', parallel_tool_calls: false } : {}) };
  return { url: `${profile.endpoint}/${adapter.path}`, body };
}

export function requestHeaders(profile, key) {
  const headers = { 'content-type': 'application/json', accept: 'application/json, text/event-stream, application/x-ndjson' };
  if (profile.provider === 'anthropic') {
    headers['anthropic-version'] = '2023-06-01';
    if (key) headers['x-api-key'] = key;
  } else if (key) headers.authorization = `Bearer ${key}`;
  return headers;
}

/** Choose the parser from the actual response media type; servers may ignore `stream`. */
export function streamKind(response) {
  const type = (response.headers.get('content-type') || '').toLowerCase();
  if (type.includes('text/event-stream')) return 'sse';
  if (type.includes('ndjson') || type.includes('jsonl')) return 'ndjson';
  return 'json';
}

export async function readStreamedReply(provider, response, handlers) {
  const kind = streamKind(response);
  if (kind === 'sse') return provider === 'anthropic' ? readAnthropicStream(response.body, handlers) : readOpenAIStream(response.body, handlers);
  if (kind === 'ndjson') return readOllamaStream(response.body, handlers);
  return null;
}

export { StreamError };
