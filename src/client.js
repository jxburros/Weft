import { CommandError, errorOutcome } from './commands.js';
export function createClient({
  url = process.env.WEFT_API_URL || 'http://127.0.0.1:9222',
  token = process.env.WEFT_TOKEN,
} = {}) {
  const base = new URL(url);
  if (base.protocol !== 'http:' || !['127.0.0.1', 'localhost', '[::1]'].includes(base.hostname)
      || base.username || base.password || base.pathname !== '/' || base.search || base.hash) {
    throw new Error('WEFT_API_URL must be a loopback HTTP origin');
  }
  if (!token?.trim()) throw new Error('Set WEFT_TOKEN to the browser API token');
  async function request(path, body, allowOutcome = false) {
    const response = await fetch(new URL(path, base), {
      method: body ? 'POST' : 'GET',
      headers: { authorization: 'Bearer ' + token, ...(body && { 'content-type': 'application/json' }) },
      ...(body && { body: JSON.stringify(body) }),
      redirect: 'error',
      signal: AbortSignal.timeout(60000),
    });
    const data = await response.json();
    if (!response.ok && !allowOutcome) throw new CommandError(data.error || { code: 'transport_error', message: `HTTP ${response.status}` });
    return data;
  }
  return {
    async listCommands() { return (await request('/v1/commands')).commands; },
    async executeOutcome(command, args = {}) {
      try { return await request('/v1/execute', { command, args }, true); }
      catch (error) { return errorOutcome(Object.assign(new Error(error.message), { code: 'transport_error' }), command, args, [], 'not_run'); }
    },
    async execute(command, args = {}) {
      const outcome = await this.executeOutcome(command, args);
      if (outcome.error) throw new CommandError(outcome.error);
      return outcome.result;
    },
  };
}
