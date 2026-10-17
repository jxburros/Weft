import { z } from 'zod';

export const modelEndpoint = z.string().min(1).max(2048).refine(value => {
  try {
    const url = new URL(value);
    return ['http:', 'https:'].includes(url.protocol) && !url.username && !url.password && !url.search && !url.hash;
  } catch { return false; }
}, 'Expected an HTTP(S) API base URL without credentials, query or fragment');
const id = z.string().min(1).max(128);
export const providerCommandDefinitions = {
  'models.list': ['List model connections and destinations (never returns keys)', {}],
  'models.save': ['Save a model connection; keys require OS secure storage', {
    id: id.optional(), name: z.string().trim().min(1).max(100),
    provider: z.enum(['openai', 'anthropic']), endpoint: modelEndpoint,
    model: z.string().trim().min(1).max(200), apiKey: z.string().max(16384).optional(),
    apiKeyEnv: z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/).max(100).optional(),
    clearApiKey: z.boolean().optional(), tools: z.boolean().optional(),
  }],
  'models.delete': ['Delete a saved model connection and its encrypted key', { modelId: id }],
  'chat.send': ['Send text/context to the selected model, with optional scoped read-only tools', {
    conversationId: id, modelId: id, text: z.string().trim().min(1).max(100000),
    allowReadTools: z.boolean().optional(), tabId: z.number().int().positive().optional(),
    context: z.array(z.strictObject({
      title: z.string().max(300), content: z.string().max(100000),
    })).max(12).optional(),
  }],
  'chat.cancel': ['Cancel a running model request', { conversationId: id }],
};
export const providerSchemas = Object.fromEntries(Object.entries(providerCommandDefinitions)
  .map(([name, [, shape]]) => [name, z.strictObject(shape)]));
