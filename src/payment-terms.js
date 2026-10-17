import { createHash } from 'node:crypto';

/**
 * Pure payment-term helpers (ADR 019): ISO 4217 currencies and minor units,
 * conservative parsing of amounts read from checkout pages, recurrence
 * detection, the approval fingerprint over every bound term, and the
 * classification of later charges against an approved recurrence. No I/O.
 * Page text is data: it is parsed, compared and shown, never followed.
 */
const ZERO = 'BIF CLP DJF GNF ISK JPY KMF KRW PYG RWF UGX UYI VND VUV XAF XOF XPF';
const THREE = 'BHD IQD JOD KWD LYD OMR TND';
const FOUR = 'CLF UYW';
const TWO = `AED AFN ALL AMD ANG AOA ARS AUD AWG AZN BAM BBD BDT BGN BMD BND BOB BOV BRL BSD BTN BWP BYN BZD CAD CDF CHE CHF CHW CNY COP COU CRC CUP CVE CZK
  DKK DOP DZD EGP ERN ETB EUR FJD FKP GBP GEL GHS GIP GMD GTQ GYD HKD HNL HTG HUF IDR ILS INR IRR JMD KES KGS KHR KPW KYD KZT LAK LBP LKR LRD LSL MAD MDL
  MGA MKD MMK MNT MOP MRU MUR MVR MWK MXN MXV MYR MZN NAD NGN NIO NOK NPR NZD PAB PEN PGK PHP PKR PLN QAR RON RSD RUB SAR SBD SCR SDG SEK SGD SHP SLE SOS
  SRD SSP STN SVC SYP SZL THB TJS TMT TOP TRY TTD TWD TZS UAH USD USN UYU UZS VED VES WST XCD XCG YER ZAR ZMW ZWG`;
/** Active ISO 4217 codes and their minor-unit exponents. */
export const CURRENCY_EXPONENTS = Object.freeze(Object.fromEntries([[ZERO, 0], [TWO, 2], [THREE, 3], [FOUR, 4]]
  .flatMap(([codes, exponent]) => codes.split(/\s+/).filter(Boolean).map(code => [code, exponent]))));
export const isCurrency = code => typeof code === 'string' && Object.hasOwn(CURRENCY_EXPONENTS, code);

// Symbols and the currencies each is consistent with. Prefixed dollar forms name one currency.
const DOLLAR = ['USD', 'CAD', 'AUD', 'NZD', 'SGD', 'HKD', 'MXN', 'TWD', 'CLP', 'COP', 'ARS', 'UYU', 'FJD', 'BSD', 'BBD', 'BZD', 'BMD', 'KYD', 'JMD', 'LRD', 'NAD', 'SBD', 'SRD', 'TTD', 'XCD', 'GYD', 'BND', 'CUP', 'DOP'];
const SYMBOLS = [
  ['US$', ['USD']], ['CA$', ['CAD']], ['C$', ['CAD']], ['AU$', ['AUD']], ['A$', ['AUD']], ['NZ$', ['NZD']], ['HK$', ['HKD']], ['S$', ['SGD']], ['MX$', ['MXN']], ['R$', ['BRL']],
  ['$', DOLLAR], ['€', ['EUR']], ['£', ['GBP', 'GIP', 'FKP', 'SHP', 'EGP', 'LBP', 'SYP', 'SSP']], ['¥', ['JPY', 'CNY']], ['₹', ['INR']], ['₩', ['KRW']], ['₽', ['RUB']],
  ['₺', ['TRY']], ['₪', ['ILS']], ['₫', ['VND']], ['₱', ['PHP']], ['฿', ['THB']], ['₴', ['UAH']], ['₦', ['NGN']], ['zł', ['PLN']], ['kr', ['SEK', 'NOK', 'DKK', 'ISK']], ['Fr', ['CHF']],
];
const clean = value => String(value ?? '').replace(/[\u0000-\u0008\u000b-\u001f\u007f‎‏‪-‮⁦-⁩]/g, '').replace(/\s+/g, ' ').trim();
export const pageText = (value, limit = 300) => clean(value).slice(0, limit);

/** Major-unit decimal string (as typed by an agent) to integer minor units; refuses more decimals than the currency has. */
export function toMinor(value, currency) {
  const exponent = CURRENCY_EXPONENTS[currency];
  const match = /^(\d{1,12})(?:\.(\d{1,4}))?$/.exec(String(value));
  if (exponent === undefined || !match || (match[2] ?? '').length > exponent) return null;
  const minor = Number(match[1]) * 10 ** exponent + Number((match[2] ?? '').padEnd(exponent, '0') || 0);
  return Number.isSafeInteger(minor) ? minor : null;
}
export function formatMinor(minor, currency) {
  const exponent = CURRENCY_EXPONENTS[currency] ?? 2;
  if (!Number.isSafeInteger(minor)) return 'unknown';
  const sign = minor < 0 ? '-' : '';
  const digits = String(Math.abs(minor)).padStart(exponent + 1, '0');
  return `${sign}${exponent ? `${digits.slice(0, -exponent)}.${digits.slice(-exponent)}` : digits} ${currency}`;
}

/** Currency indicators visible in a text: ISO codes and symbols (longest symbol first, so US$ is not read as $). */
function indicators(text) {
  const found = [];
  for (const match of text.matchAll(/(?<![A-Za-z])([A-Z]{3})(?![A-Za-z])/g)) if (isCurrency(match[1])) found.push({ text: match[1], currencies: [match[1]], index: match.index, end: match.index + 3 });
  let rest = text;
  for (const [symbol, currencies] of SYMBOLS) {
    let from = 0;
    for (;;) {
      const index = rest.indexOf(symbol, from);
      if (index < 0) break;
      // Letter symbols (kr, Fr, zł) must stand alone, not inside a word.
      const letters = /[a-z]/i.test(symbol);
      if (!letters || (!/[A-Za-z]/.test(rest[index - 1] ?? '') && !/[A-Za-z]/.test(rest[index + symbol.length] ?? ''))) {
        found.push({ text: symbol, currencies, index, end: index + symbol.length });
        // Blank the symbol so a shorter one ($ inside US$) is not counted again.
        rest = `${rest.slice(0, index)}${'\u0001'.repeat(symbol.length)}${rest.slice(index + symbol.length)}`;
      }
      from = index + symbol.length;
    }
  }
  return found.sort((a, b) => a.index - b.index);
}

const NUMBER = /\d{1,3}(?:[   '.,]\d{3})+(?:[.,]\d+)?|\d+(?:[.,]\d+)?/g;
/** One numeric token to minor units. Conservative: ambiguous separators are refused, not guessed. */
function tokenToMinor(token, exponent) {
  const separators = [...token.matchAll(/[^\d]/g)].map(match => match[0]);
  const groups = token.split(/[^\d]/);
  if (!separators.length) return { minor: Number(token) * 10 ** exponent };
  const last = separators.at(-1);
  const tail = groups.at(-1);
  const punctuation = [...new Set(separators.filter(item => ['.', ','].includes(item)))];
  let integerGroups = groups;
  let fraction = '';
  if (![',', '.'].includes(last)) integerGroups = groups;
  else if (punctuation.length === 2) { integerGroups = groups.slice(0, -1); fraction = tail; if (separators.slice(0, -1).includes(last)) return { reason: 'amount_unparseable' }; }
  else if (separators.filter(item => item === last).length > 1) integerGroups = groups;
  else if (exponent === 0) { if (tail.length !== 3) return { reason: 'amount_unparseable' }; integerGroups = groups; }
  // Three-decimal currencies (KWD, BHD, …) write three decimals; elsewhere one separator before three digits could be either.
  else if (tail.length === 3 && exponent !== 3) return { reason: 'amount_ambiguous' };
  else { integerGroups = groups.slice(0, -1); fraction = tail; }
  if (integerGroups.length > 1 && (integerGroups[0].length > 3 || integerGroups.slice(1).some(group => group.length !== 3))) return { reason: 'amount_unparseable' };
  if (fraction.length > exponent) return { reason: 'amount_unparseable' };
  const minor = Number(integerGroups.join('')) * 10 ** exponent + Number(fraction.padEnd(exponent, '0') || 0);
  return Number.isSafeInteger(minor) ? { minor } : { reason: 'amount_unparseable' };
}

/**
 * Read one amount from page text in the declared currency. The amount must be the only
 * number, or the only number written next to a currency indicator; any visible indicator
 * must be consistent with the declared currency.
 */
export function parseAmount(value, currency) {
  const text = clean(value);
  const exponent = CURRENCY_EXPONENTS[currency];
  if (exponent === undefined) return { ok: false, reason: 'currency_unknown' };
  if (!text) return { ok: false, reason: 'amount_missing' };
  const marks = indicators(text);
  if (marks.some(mark => !mark.currencies.includes(currency))) return { ok: false, reason: 'currency_mismatch', indicator: marks.find(mark => !mark.currencies.includes(currency)).text };
  const tokens = [...text.matchAll(NUMBER)].map(match => ({ token: match[0], index: match.index, end: match.index + match[0].length }));
  if (!tokens.length) return { ok: false, reason: 'amount_missing' };
  let chosen = tokens;
  if (tokens.length > 1) {
    const near = token => marks.some(mark => (mark.end <= token.index && /^\s?$/.test(text.slice(mark.end, token.index))) || (token.end <= mark.index && /^\s?$/.test(text.slice(token.end, mark.index))));
    chosen = tokens.filter(near);
  }
  if (chosen.length !== 1) return { ok: false, reason: 'amount_ambiguous' };
  const parsed = tokenToMinor(chosen[0].token.replace(/[  ]/g, ' '), exponent);
  if (parsed.reason) return { ok: false, reason: parsed.reason };
  return { ok: true, minor: parsed.minor, indicator: marks.map(mark => mark.text).join(' ') || null };
}

export const INTERVALS = Object.freeze(['day', 'week', 'month', 'year']);
const INTERVAL_MS = { day: 86400000, week: 7 * 86400000, month: 30 * 86400000, year: 365 * 86400000 };
const UNIT = { day: 'day', days: 'day', week: 'week', weeks: 'week', wk: 'week', wks: 'week', month: 'month', months: 'month', mo: 'month', mos: 'month', mth: 'month',
  year: 'year', years: 'year', yr: 'year', yrs: 'year', annum: 'year' };
const ADVERBS = { daily: ['day', 1], weekly: ['week', 1], biweekly: ['week', 2], fortnightly: ['week', 2], monthly: ['month', 1], quarterly: ['month', 3], yearly: ['year', 1], annually: ['year', 1], annual: ['year', 1] };
/** Recurrence wording in page text: { recurring, interval, intervalCount }. A recurring hint without an interval has interval null. */
export function detectRecurrence(value) {
  const text = clean(value).toLowerCase();
  const unit = /(?:\bper\b|\ba\b|\beach\b|\bevery\b|\/)\s*(\d{1,2}\s*)?(days?|weeks?|wks?|months?|mos?|mth|years?|yrs?|annum)\b/.exec(text);
  if (unit) return { recurring: true, interval: UNIT[unit[2]], intervalCount: unit[1] ? Number(unit[1]) : 1 };
  const adverb = /\b(daily|weekly|biweekly|fortnightly|monthly|quarterly|yearly|annually|annual)\b/.exec(text);
  if (adverb) return { recurring: true, interval: ADVERBS[adverb[1]][0], intervalCount: ADVERBS[adverb[1]][1] };
  if (/\b(subscription|subscribe|recurring|auto-?renew(?:s|al)?|renews|free trial|billed every)\b/.test(text)) return { recurring: true, interval: null, intervalCount: null };
  return { recurring: false, interval: null, intervalCount: null };
}
export function describeRecurrence(recurrence) {
  if (!recurrence || recurrence.type === 'none') return 'One-time payment (no recurrence)';
  const every = recurrence.intervalCount > 1 ? `every ${recurrence.intervalCount} ${recurrence.interval}s` : `every ${recurrence.interval}`;
  return `Recurring ${every}${recurrence.maxCharges ? `, at most ${recurrence.maxCharges} charge${recurrence.maxCharges === 1 ? '' : 's'}` : ''}${recurrence.endsAt ? `, ending ${recurrence.endsAt}` : ''}`;
}

const canonical = value => JSON.stringify(value, (_key, item) => item && typeof item === 'object' && !Array.isArray(item)
  ? Object.fromEntries(Object.keys(item).sort().map(name => [name, item[name]])) : item);
/** The fields every payment approval is bound to. Any difference changes the fingerprint and needs a new approval. */
export function boundTerms(record) {
  return { paymentId: record.id, attempt: record.attempt, workspaceId: record.workspaceId, tabId: record.tabId, actor: record.actor, taskId: record.taskId ?? null,
    merchant: { name: record.merchant.name, origin: record.merchant.origin, frameOrigin: record.merchant.frameOrigin },
    destination: { url: record.destination.url, digest: record.destination.digest }, purpose: record.purpose, currency: record.currency, ceilingMinor: record.ceilingMinor,
    recurrence: record.recurrence, observed: { totalMinor: record.observed.totalMinor, subtotalMinor: record.observed.subtotalMinor ?? null, taxMinor: record.observed.taxMinor ?? null,
      shippingMinor: record.observed.shippingMinor ?? null, indicator: record.observed.indicator ?? null, recurrenceText: record.observed.recurrenceText ?? null, submitLabel: record.observed.submitLabel ?? null },
    selectors: record.selectors };
}
export function termsFingerprint(record) {
  return createHash('sha256').update(canonical({ kind: 'weft.payment.v1', ...boundTerms(record) })).digest('hex');
}
export const urlDigest = url => createHash('sha256').update(url).digest('hex');

/**
 * Classify card transactions against the approved terms. Declined transactions do not count.
 * A one-time payment covers one charge; a recurring one covers charges no larger than the
 * ceiling, in the approved currency, spaced at least ~80% of the interval apart (months and
 * years vary in length), up to maxCharges and before endsAt.
 */
export function classifyCharges(record, transactions) {
  const rows = [...transactions].filter(item => item && Number.isSafeInteger(item.amountMinor)).sort((a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt));
  const recurrence = record.recurrence ?? { type: 'none' };
  const spacing = recurrence.type === 'recurring' ? INTERVAL_MS[recurrence.interval] * recurrence.intervalCount * 0.8 : Infinity;
  let counted = 0, previous = null;
  return rows.map(item => {
    if (['declined', 'voided', 'reversed'].includes(item.status)) return { ...item, assessment: 'not_charged', reasons: [] };
    const reasons = [];
    if (item.currency !== record.currency) reasons.push('currency');
    if (item.amountMinor > record.ceilingMinor) reasons.push('amount_over_ceiling');
    if (recurrence.type !== 'recurring' && counted >= 1) reasons.push('not_recurring');
    if (recurrence.type === 'recurring') {
      if (recurrence.maxCharges && counted >= recurrence.maxCharges) reasons.push('charge_count');
      if (recurrence.endsAt && Date.parse(item.createdAt) > Date.parse(recurrence.endsAt)) reasons.push('after_end');
      if (previous && Date.parse(item.createdAt) - Date.parse(previous.createdAt) < spacing) reasons.push('too_soon');
    }
    counted++;
    previous = item;
    return { ...item, assessment: reasons.length ? 'outside_terms' : 'within_terms', reasons };
  });
}
