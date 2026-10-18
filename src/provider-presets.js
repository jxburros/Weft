/** API destinations are explicit; custom endpoints remain first-class. No model IDs are hard-coded. */
export const PROVIDER_PRESETS = [
  { id: 'openai', name: 'OpenAI', provider: 'openai', endpoint: 'https://api.openai.com/v1' },
  { id: 'compatible', name: 'OpenAI-compatible endpoint', provider: 'openai', endpoint: '' },
  { id: 'anthropic', name: 'Anthropic', provider: 'anthropic', endpoint: 'https://api.anthropic.com/v1' },
  { id: 'gemini', name: 'Google Gemini', provider: 'openai', endpoint: 'https://generativelanguage.googleapis.com/v1beta/openai' },
  { id: 'deepseek', name: 'DeepSeek', provider: 'openai', endpoint: 'https://api.deepseek.com/v1' },
  { id: 'moonshot', name: 'Moonshot', provider: 'openai', endpoint: 'https://api.moonshot.ai/v1' },
  { id: 'meta', name: 'Meta Muse', provider: 'openai', endpoint: 'https://api.meta.ai/v1' },
  { id: 'ollama', name: 'Ollama', provider: 'ollama', endpoint: 'http://127.0.0.1:11434' },
  { id: 'jx', name: 'JX Runtime', provider: 'openai', endpoint: 'http://127.0.0.1:8712/v1' },
];

export function reportedCapabilities(model) {
  const caps = {};
  const modalities = model.architecture?.input_modalities ?? model.modalities?.input ?? model.input_modalities;
  if (Array.isArray(modalities)) caps.images = modalities.includes('image');
  if (Array.isArray(model.capabilities)) { caps.images = model.capabilities.includes('vision'); caps.tools = model.capabilities.includes('tools'); }
  if (typeof model.capabilities?.vision === 'boolean') caps.images = model.capabilities.vision;
  if (typeof model.capabilities?.image_input?.supported === 'boolean') caps.images = model.capabilities.image_input.supported;
  if (typeof model.capabilities?.tools === 'boolean') caps.tools = model.capabilities.tools;
  if (typeof model.supports_tool_calls === 'boolean') caps.tools = model.supports_tool_calls;
  const window = model.context_length ?? model.context_window ?? model.max_input_tokens ?? model.inputTokenLimit ?? model.top_provider?.context_length;
  if (Number.isSafeInteger(window) && window >= 256 && window <= 100000000) caps.contextWindow = window;
  return caps;
}
