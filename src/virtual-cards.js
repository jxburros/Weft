/**
 * Virtual-card provider interface (ADR 019) and one issuer adapter.
 *
 * A provider creates a card limited to one payment (merchant-locked, single-use
 * or amount-limited), closes it, and lists its transactions so Weft can
 * reconcile an uncertain submission or check later charges against an approved
 * recurrence. Card numbers returned by the issuer go straight into the
 * credential vault; this module never logs or stores them.
 *
 * `IssuerApiProvider` speaks a generic card-issuing REST shape modelled on
 * Lithic/Privacy.com-style endpoints (POST /v1/cards, PATCH /v1/cards/{token},
 * GET /v1/transactions?card_token=). It is implemented and tested against a fake
 * HTTP server only and has NOT been validated against a real issuer account.
 */
export const PROVIDER_KINDS = Object.freeze(['issuer_api']);
export const PROVIDER_REASONS = Object.freeze(['provider_not_configured', 'provider_disabled', 'currency_unsupported', 'recurrence_unsupported', 'merchant_unsupported',
  'provider_auth_failed', 'provider_unavailable', 'provider_rejected', 'provider_response_invalid']);

const failure = (code, reason, message) => Object.assign(new Error(message), { code, notStarted: code !== 'unavailable', details: { payment: reason } });
export const unsupported = (reason, message) => failure('unsupported', reason, message);

/**
 * The interface every provider implements.
 *   capabilities() -> { currencies: string[], singleUse, merchantLocked, durations: string[] }
 *   supports({ currency, recurrence, merchant }) -> { supported: true } | { supported: false, reason, message }
 *   createCard({ memo, spendLimitMinor, currency, singleUse, duration }) -> { token, last4, number, cvc, expMonth, expYear, state }
 *   closeCard(token) -> { token, state }
 *   listTransactions(token) -> [{ token, status, amountMinor, currency, merchant, createdAt }]
 */
export class VirtualCardProvider {
  capabilities() { return { currencies: [], singleUse: false, merchantLocked: false, durations: [] }; }
  supports() { return { supported: false, reason: 'provider_not_configured', message: 'No virtual-card provider is configured' }; }
  async createCard() { throw unsupported('provider_not_configured', 'No virtual-card provider is configured'); }
  async closeCard() { throw unsupported('provider_not_configured', 'No virtual-card provider is configured'); }
  async listTransactions() { throw unsupported('provider_not_configured', 'No virtual-card provider is configured'); }
}

/** Map an approved recurrence onto the issuer's spend-limit durations. */
export function cardPlan(recurrence) {
  if (!recurrence || recurrence.type === 'none') return { singleUse: true, duration: 'TRANSACTION' };
  // A monthly or yearly limit lets the issuer decline a second charge inside one period; other schedules are limited per transaction and checked by Weft.
  if (recurrence.intervalCount === 1 && recurrence.interval === 'month') return { singleUse: false, duration: 'MONTHLY' };
  if (recurrence.intervalCount === 1 && recurrence.interval === 'year') return { singleUse: false, duration: 'ANNUALLY' };
  return { singleUse: false, duration: 'TRANSACTION' };
}

const STATUS = { APPROVED: 'approved', SETTLED: 'settled', PENDING: 'pending', AUTHORIZATION: 'pending', DECLINED: 'declined', VOIDED: 'voided', EXPIRED: 'voided', REVERSED: 'reversed' };
const text = (value, max = 120) => String(value ?? '').replace(/[\u0000-\u001f\u007f]/g, ' ').slice(0, max);

export class IssuerApiProvider extends VirtualCardProvider {
  constructor({ baseUrl, apiKey, currencies = ['USD'], fetchImpl = globalThis.fetch, timeoutMs = 15000 } = {}) {
    super();
    if (!baseUrl || !apiKey) throw unsupported('provider_not_configured', 'The card issuer needs an API base URL and key');
    Object.assign(this, { baseUrl: baseUrl.replace(/\/+$/, ''), apiKey, currencies: [...currencies], fetchImpl, timeoutMs });
  }
  capabilities() { return { currencies: [...this.currencies], singleUse: true, merchantLocked: true, durations: ['TRANSACTION', 'MONTHLY', 'ANNUALLY'] }; }
  supports({ currency, recurrence }) {
    if (!this.currencies.includes(currency)) return { supported: false, reason: 'currency_unsupported', message: `The configured card issuer supports ${this.currencies.join(', ')} only` };
    if (recurrence?.type === 'recurring' && !['day', 'week', 'month', 'year'].includes(recurrence.interval)) return { supported: false, reason: 'recurrence_unsupported', message: 'The card issuer cannot limit this recurrence' };
    return { supported: true };
  }
  async request(method, path, body) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    let response;
    try {
      response = await this.fetchImpl(`${this.baseUrl}${path}`, { method, redirect: 'error', signal: controller.signal,
        headers: { authorization: this.apiKey, accept: 'application/json', ...(body ? { 'content-type': 'application/json' } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) });
    } catch { throw failure('unavailable', 'provider_unavailable', 'The card issuer could not be reached'); }
    finally { clearTimeout(timer); }
    // Issuer error bodies are never echoed: they can contain account details.
    if ([401, 403].includes(response.status)) throw failure('unavailable', 'provider_auth_failed', 'The card issuer refused the configured API key');
    if (response.status === 422 || response.status === 400) throw unsupported('provider_rejected', `The card issuer rejected the request (HTTP ${response.status})`);
    if (!response.ok) throw failure('unavailable', 'provider_unavailable', `The card issuer returned HTTP ${response.status}`);
    let value;
    try { value = await response.json(); } catch { throw failure('unavailable', 'provider_response_invalid', 'The card issuer returned an unreadable response'); }
    if (!value || typeof value !== 'object') throw failure('unavailable', 'provider_response_invalid', 'The card issuer returned an unreadable response');
    return value;
  }
  async createCard({ memo, spendLimitMinor, currency, singleUse, duration }) {
    const supported = this.supports({ currency });
    if (!supported.supported) throw unsupported(supported.reason, supported.message);
    const card = await this.request('POST', '/v1/cards', { type: singleUse ? 'SINGLE_USE' : 'MERCHANT_LOCKED', memo: text(memo, 120), spend_limit: spendLimitMinor,
      spend_limit_duration: duration, state: 'OPEN' });
    const number = String(card.pan ?? '');
    const valid = typeof card.token === 'string' && /^[\w-]{4,128}$/.test(card.token) && /^\d{12,19}$/.test(number) && /^\d{3,4}$/.test(String(card.cvv ?? ''))
      && /^\d{1,2}$/.test(String(card.exp_month ?? '')) && /^\d{2,4}$/.test(String(card.exp_year ?? ''));
    // Issuers that do not return the full card number (no PAN access on the account) cannot be filled by Weft.
    if (!valid) throw unsupported('provider_response_invalid', 'The card issuer did not return a usable card (full card number and security code are required)');
    return { token: card.token, last4: number.slice(-4), number, cvc: String(card.cvv), expMonth: Number(card.exp_month), expYear: Number(String(card.exp_year).slice(-2)), state: text(card.state ?? 'OPEN', 20) };
  }
  async closeCard(token) {
    const card = await this.request('PATCH', `/v1/cards/${encodeURIComponent(token)}`, { state: 'CLOSED' });
    return { token, state: text(card.state ?? 'CLOSED', 20) };
  }
  async listTransactions(token) {
    const rows = [];
    let page = 1;
    for (; page <= 10; page++) {
      const value = await this.request('GET', `/v1/transactions?card_token=${encodeURIComponent(token)}&page=${page}&page_size=50`);
      const data = Array.isArray(value.data) ? value.data : [];
      for (const item of data) {
        const amount = Number(item.amount ?? item.settled_amount);
        if (!Number.isSafeInteger(amount)) continue;
        rows.push({ token: text(item.token, 128), status: STATUS[String(item.status).toUpperCase()] ?? 'pending', amountMinor: Math.abs(amount),
          currency: /^[A-Z]{3}$/.test(item.currency ?? '') ? item.currency : this.currencies[0], merchant: text(item.merchant?.descriptor ?? item.merchant?.name ?? ''),
          createdAt: Number.isFinite(Date.parse(item.created)) ? new Date(item.created).toISOString() : new Date(0).toISOString() });
      }
      if (!value.has_more) break;
    }
    return rows.slice(0, 500);
  }
}
