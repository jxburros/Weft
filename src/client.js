import { readFileSync } from 'node:fs';
import { CommandError, errorOutcome } from './commands.js';
/** WEFT_TOKEN_FILE: the owner-only file a browser started with the same variable wrote its generated token to. */
function tokenFromFile(path) {
  if (!path) return undefined;
  try { return readFileSync(path, 'utf8').trim(); } catch { throw new Error(`WEFT_TOKEN_FILE ${path} could not be read`); }
}
export function createClient({
  url = process.env.WEFT_API_URL || 'http://127.0.0.1:9222',
  token = process.env.WEFT_TOKEN || tokenFromFile(process.env.WEFT_TOKEN_FILE),
} = {}) {
  const base = new URL(url);
  if (base.protocol !== 'http:' || !['127.0.0.1', 'localhost', '[::1]'].includes(base.hostname)
      || base.username || base.password || base.pathname !== '/' || base.search || base.hash) {
    throw new Error('WEFT_API_URL must be a loopback HTTP origin');
  }
  // The server listens only on 127.0.0.1 (#126): `localhost` may resolve to ::1 first, so it is
  // pinned to IPv4 loopback, and an IPv6 address is refused with the reason instead of failing to connect.
  if (base.hostname === '[::1]') throw new Error('WEFT_API_URL: Weft listens only on 127.0.0.1, not on IPv6 [::1]; use http://127.0.0.1:<port>');
  if (base.hostname === 'localhost') base.hostname = '127.0.0.1';
  if (!token?.trim()) throw new Error('Set WEFT_TOKEN (or WEFT_TOKEN_FILE) to the browser API token');
  async function request(path, body, allowOutcome = false, { deadlineMs } = {}) {
    const response = await fetch(new URL(path, base), {
      method: body ? 'POST' : 'GET',
      headers: { authorization: 'Bearer ' + token, ...(body && { 'content-type': 'application/json' }), ...(deadlineMs !== undefined && { 'weft-deadline-ms': String(deadlineMs) }) },
      ...(body && { body: JSON.stringify(body) }),
      redirect: 'error',
      // With a deadline the server answers by then (plus a short stop grace); otherwise the transport waits 60 s.
      signal: AbortSignal.timeout(deadlineMs !== undefined ? deadlineMs + 5000 : 60000),
    });
    const data = await response.json();
    if (!response.ok && !allowOutcome) throw new CommandError(data.error || { code: 'transport_error', message: `HTTP ${response.status}` });
    return data;
  }
  return {
    async listCommands() { return (await request('/v1/commands')).commands; },
    async capabilities() { return request('/v1/capabilities', null, true); },
    async executeOutcome(command, args = {}, options = {}) {
      try { return await request('/v1/execute', { command, args }, true, options); }
      catch (error) { return errorOutcome(Object.assign(new Error(error.message), { code: 'transport_error' }), command, args, [], 'not_run'); }
    },
    async execute(command, args = {}, options = {}) {
      const outcome = await this.executeOutcome(command, args, options);
      if (outcome.error) throw new CommandError(outcome.error);
      return outcome.result;
    },
  };
}
