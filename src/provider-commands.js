import { z } from 'zod';

export const modelEndpoint = z.string().min(1).max(2048).refine(value => {
  try {
    const url = new URL(value);
    return ['http:', 'https:'].includes(url.protocol) && !url.username && !url.password && !url.search && !url.hash;
  } catch { return false; }
}, 'Expected an HTTP(S) API base URL without credentials, query or fragment (plain HTTP only for on-device or private-network hosts)');
const id = z.string().min(1).max(128);
const capabilities = z.strictObject({
  images: z.boolean().optional().describe('Accepts actual image input (overrides probed/default).'),
  streaming: z.boolean().optional().describe('Request incremental replies; off sends whole JSON requests.'),
  contextWindow: z.number().int().min(256).max(100000000).optional().describe('Total context window in tokens.'),
  maxOutputTokens: z.number().int().min(1).max(1000000).optional().describe('Reply tokens reserved per request.'),
});
const pricing = z.strictObject({
  currency: z.string().regex(/^[A-Z]{3}$/).describe('ISO currency code for the configured price.'),
  inputPerMillion: z.number().min(0).max(1000000).describe('Configured price per million input tokens.'),
  outputPerMillion: z.number().min(0).max(1000000).describe('Configured price per million output tokens.'),
});
const passage = z.strictObject({ kind: z.literal('passage'), title: z.string().trim().min(1).max(300), content: z.string().min(1).max(100000),
  source: z.string().max(2048).optional(), tabId: z.number().int().positive().optional(), localOnly: z.boolean().optional() });
export const attachmentSchema = z.discriminatedUnion('kind', [
  passage,
  z.strictObject({ kind: z.literal('tab'), tabId: z.number().int().positive().describe('Tab whose readable text snapshot is attached.') }),
  z.strictObject({ kind: z.literal('material'), id }),
  z.strictObject({ kind: z.literal('context'), id }),
  z.strictObject({ kind: z.literal('task'), id }),
  z.strictObject({ kind: z.literal('search'), query: z.string().trim().min(1).max(1000).describe('Search this conversation workspace and attach the cited results.'),
    limit: z.number().int().min(1).max(50).optional().describe('Results to request (default 10); retrieved context is capped at 0.4 of the window after the reserved reply.') }),
  z.strictObject({ kind: z.literal('artifact'), id, versionId: id.describe('Exact immutable artifact version.'),
    parts: z.array(z.enum(['text', 'image'])).min(1).max(2).optional().describe('Version components to attach; default both when present.') }),
]);
export const providerCommandDefinitions = {
  'models.discover': ['List every model visible to a connection key; sends no workspace data', { modelId: id.optional(), provider: z.enum(['openai', 'anthropic', 'ollama']).optional(), endpoint: modelEndpoint.optional(), apiKey: z.string().max(16384).optional(), apiKeyEnv: z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/).max(100).optional() }],
  'models.list': ['List model connections, destinations and capability records (never returns keys)', {}],
  'models.save': ['Save a model connection; keys require OS secure storage', {
    id: id.optional(), name: z.string().trim().min(1).max(100),
    provider: z.enum(['openai', 'anthropic', 'ollama']), endpoint: modelEndpoint,
    model: z.string().trim().min(1).max(200), apiKey: z.string().max(16384).optional(),
    apiKeyEnv: z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/).max(100).optional(),
    clearApiKey: z.boolean().optional(), tools: z.boolean().optional(),
    confirmKeyDestination: z.boolean().optional().describe('Keep sending apiKeyEnv after the endpoint moves to another host; without it the variable is dropped.'),
    capabilities: capabilities.optional(), pricing: pricing.optional(),
    visionFallbackId: id.optional().describe('Explicit image-capable connection used only for image items this model cannot read.'),
  }],
  'models.probe': ['Ask the connection endpoint for model capabilities and context window; sends no workspace data', { modelId: id }],
  'models.delete': ['Delete a saved model connection and its encrypted key', { modelId: id }],
  'chat.send': ['Send text, selected attachments and context to the selected model, streaming when supported, with optional scoped read-only tools', {
    conversationId: id, modelId: id, text: z.string().trim().min(1).max(100000),
    disclosureAck: z.union([z.boolean(), z.string().regex(/^[0-9a-f]{64}$/)]).optional().describe('Acknowledge the previewed cloud disclosure: agents pass disclosure.digest from chat.preview; the trusted interface may pass true.'),
    allowReadTools: z.boolean().optional(), allowAppTools: z.boolean().optional().describe("Allow command discovery and proposals; every proposed action requires human review."), tabId: z.number().int().positive().optional(),
    context: z.array(z.strictObject({
      title: z.string().max(300), content: z.string().max(100000),
      id: id.optional(), recordType: z.enum(['context', 'materials']).optional(), source: z.string().max(2048).optional(), localOnly: z.boolean().optional(),
    })).max(12).optional(),
    attachments: z.array(attachmentSchema).max(16).optional().describe('Selected passages, tab snapshots, stored materials, context, tasks, cited search results and exact artifact versions.'),
    exclude: z.array(z.string().min(1).max(300)).max(1000).optional().describe('Disclosure item keys (from chat.preview) to leave out of this turn.'),
  }],
  'chat.cancel': ['Cancel a running model request; any partial reply is kept and marked interrupted', { conversationId: id }],
};
providerCommandDefinitions['chat.preview'] = ['Preview destinations, capabilities, context-window plan and itemized outbound disclosure without sending', providerCommandDefinitions['chat.send'][1]];
export const providerSchemas = Object.fromEntries(Object.entries(providerCommandDefinitions)
  .map(([name, [, shape]]) => [name, z.strictObject(shape)]));
