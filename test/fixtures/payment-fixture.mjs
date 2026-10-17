// Shared helpers for payment tests: a deterministic stand-in for OS-protected storage, a fake card
// issuer HTTP server (Lithic/Privacy.com-style endpoints) and a scripted checkout for the browser half.
import { createServer } from 'node:http';
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

export const ISSUER_KEY = 'issuer-test-key-5531';
export const PAN = '4242424242424242';
export const CVC = '987';

/** Test-only key protector (AES wrapper); a fixed key lets a restarted process open what a killed one wrapped. */
export function testProtector(keyHex = null) {
  const key = keyHex ? Buffer.from(keyHex, 'hex') : randomBytes(32);
  return {
    status: () => ({ available: true, backend: 'test-keychain', protected: true }),
    wrap(text) { const iv = randomBytes(12); const cipher = createCipheriv('aes-256-gcm', key, iv); const data = Buffer.concat([cipher.update(text, 'utf8'), cipher.final()]); return Buffer.concat([iv, cipher.getAuthTag(), data]); },
    unwrap(bytes) { const decipher = createDecipheriv('aes-256-gcm', key, bytes.subarray(0, 12)); decipher.setAuthTag(bytes.subarray(12, 28)); return Buffer.concat([decipher.update(bytes.subarray(28)), decipher.final()]).toString('utf8'); },
  };
}

/** Fake card issuer: POST /v1/cards, PATCH /v1/cards/{token}, GET /v1/transactions?card_token=. */
export async function fakeIssuer() {
  const state = { cards: new Map(), transactions: new Map(), requests: [], mode: 'ok', next: 1 };
  const server = createServer(async (request, response) => {
    let body = '';
    for await (const chunk of request) body += chunk;
    const url = new URL(request.url, 'http://issuer.invalid');
    state.requests.push({ method: request.method, path: url.pathname, query: url.search, body: body ? JSON.parse(body) : null, authorization: request.headers.authorization });
    const send = (status, value) => { response.writeHead(status, { 'content-type': 'application/json' }); response.end(JSON.stringify(value)); };
    if (request.headers.authorization !== ISSUER_KEY) return send(401, { message: 'bad key' });
    if (state.mode === 'reject') return send(422, { message: 'merchant category not supported for account 99-1234' });
    if (request.method === 'POST' && url.pathname === '/v1/cards') {
      const token = `card_tok_${state.next++}`;
      const card = { token, type: JSON.parse(body).type, state: 'OPEN', spend_limit: JSON.parse(body).spend_limit, spend_limit_duration: JSON.parse(body).spend_limit_duration,
        pan: PAN, cvv: CVC, exp_month: '12', exp_year: '2031', last_four: PAN.slice(-4) };
      state.cards.set(token, card);
      return send(200, card);
    }
    const patch = /^\/v1\/cards\/([\w-]+)$/.exec(url.pathname);
    if (request.method === 'PATCH' && patch) { const card = state.cards.get(patch[1]); if (!card) return send(404, {}); card.state = JSON.parse(body).state; return send(200, { token: card.token, state: card.state }); }
    if (request.method === 'GET' && url.pathname === '/v1/transactions') return send(200, { data: state.transactions.get(url.searchParams.get('card_token')) ?? [], has_more: false });
    send(404, {});
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  return { state, url: `http://127.0.0.1:${server.address().port}`, close: () => new Promise(resolve => { server.closeAllConnections?.(); server.close(resolve); }),
    charge(token, amount, { status = 'SETTLED', at = new Date().toISOString(), currency = 'USD' } = {}) {
      const list = state.transactions.get(token) ?? [];
      list.push({ token: `txn_${list.length + 1}_${token}`, status, amount, currency, merchant: { descriptor: 'EXAMPLE SHOP' }, created: at });
      state.transactions.set(token, list);
    } };
}

/**
 * Scripted checkout standing in for Browser.paymentObserve/paymentSubmit. The real browser half
 * (isolated-world reads, frames, the click) runs against Chromium in payments-browser.test.js.
 * `click`: ok | fail | hang | missing.
 */
export function scriptedCheckout(f, directory, overrides = {}) {
  const page = { topOrigin: 'https://shop.example.com', url: 'https://shop.example.com/checkout?step=pay', frameOrigin: null,
    text: { total: 'Total: $49.99', tax: '$4.00', shipping: '$5.00', submit: 'Pay $49.99' }, counts: {}, enabled: true, clicks: 0, click: 'ok', events: [], release: null, ...overrides };
  const observe = (selectors, frameOrigin) => {
    const fields = {};
    for (const field of Object.keys(selectors)) {
      const text = page.text[field];
      fields[field] = text === undefined ? { count: 0, text: '' } : { count: page.counts[field] ?? 1, text, ...(field === 'submit' ? { label: text, enabled: page.enabled } : {}) };
    }
    const frame = frameOrigin && frameOrigin !== page.topOrigin ? (page.frameOrigin === frameOrigin ? frameOrigin : null) : page.topOrigin;
    return { topOrigin: page.topOrigin, url: page.url, frameOrigin: frame, fields };
  };
  f.browser.paymentObserve = async (_args, _context, { frameOrigin, targets }) => {
    const selectors = Object.fromEntries(Object.entries(targets).map(([key, value]) => [key, value.selector ?? `[data-ref="${value.ref}"]`]));
    return { ...observe(selectors, frameOrigin), selectors, version: 3 };
  };
  f.browser.paymentSubmit = async (_args, _context, { frameOrigin, selectors, verify, onAttempt }) => {
    page.events.push('read');
    verify(observe(selectors, frameOrigin));
    await page.beforeAttempt?.();
    await onAttempt();
    // The attempt must be on disk before the click.
    const stored = JSON.parse(readFileSync(join(directory, 'payments', 'payments.json'), 'utf8')).records.map(record => record.status);
    page.events.push(`durable:${stored.includes('submitting')}:clicks=${page.clicks}`);
    page.onAttempt?.();
    if (page.click === 'missing') return { clicked: false, reason: 'missing' };
    if (page.click === 'hang') return new Promise((resolve, reject) => { page.clicks++; page.release = { resolve, reject }; });
    page.clicks++;
    if (page.click === 'fail') throw Object.assign(new Error('Renderer connection lost'), { code: 'command_failed', paymentStage: 'click_unknown' });
    return { clicked: true, navigation: 'committed', url: 'https://shop.example.com/thanks?order=1' };
  };
  return page;
}
