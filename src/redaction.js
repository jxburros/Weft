import { createHash } from 'node:crypto';
import { Script, createContext } from 'node:vm';

/**
 * Redaction building blocks: optional detection assistance, text span
 * selection and removal, and review of sensitive URL/path/query metadata.
 * Detection is pattern assistance only. It misses context-dependent personal
 * data and cannot classify secrets reliably; results never mean "clean".
 */
export const DETECTION_SCOPE = 'Detection assistance only: pattern matches for common formats (email addresses, phone numbers, payment-card numbers passing a Luhn check, API-key-like strings and JSON Web Tokens). It does not find names, addresses, free-form secrets or text inside images, and finding nothing does not mean the content is free of sensitive data.';
export const DETECTORS = Object.freeze(['email', 'phone', 'payment-card', 'api-key', 'jwt']);
export const REDACTION_MARK = '[REDACTED]';
const MAX_FINDINGS = 500;

function luhn(digits) {
  let sum = 0;
  for (let index = 0; index < digits.length; index++) {
    let digit = Number(digits[digits.length - 1 - index]);
    if (index % 2) { digit *= 2; if (digit > 9) digit -= 9; }
    sum += digit;
  }
  return sum % 10 === 0;
}
const patterns = {
  email: /[A-Za-z0-9._%+-]{1,64}@[A-Za-z0-9.-]{1,253}\.[A-Za-z]{2,24}/g,
  jwt: /\beyJ[A-Za-z0-9_-]{5,}\.eyJ[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}/g,
  'api-key': /\b(?:sk|pk|rk)[-_](?:live|test|proj|ant)?[-_]?[A-Za-z0-9_-]{16,}|\bgh[pousr]_[A-Za-z0-9]{30,}|\bgithub_pat_[A-Za-z0-9_]{40,}|\bxox[abprs]-[A-Za-z0-9-]{10,}|\bAKIA[0-9A-Z]{16}\b|\bAIza[0-9A-Za-z_-]{35}\b|\bglpat-[A-Za-z0-9_-]{20,}|\b(?:api[_-]?key|secret|token|password|passwd)\s*[:=]\s*["']?[A-Za-z0-9_\-./+=]{12,}/gi,
  'payment-card': /\b(?:\d[ -]?){12,18}\d\b/g,
  phone: /(?<![\w+])(?:\+\d{1,3}[\s.-]?)?(?:\(\d{2,4}\)[\s.-]?)?\d{2,4}[\s.-]\d{3,4}[\s.-]?\d{3,4}(?!\w)/g,
};
/** Mask a matched value for display: keep a little shape, never the whole value. */
export function maskValue(value) {
  const text = String(value);
  if (text.length <= 4) return '•'.repeat(text.length);
  return `${text.slice(0, 2)}${'•'.repeat(Math.min(12, text.length - 4))}${text.slice(-2)}`;
}

/** Pattern-based detection assistance over text. Overlapping matches keep the earliest, longest. */
export function detectSensitive(text, { detectors = DETECTORS } = {}) {
  const source = String(text ?? '');
  const found = [];
  for (const kind of detectors) {
    const pattern = patterns[kind];
    if (!pattern) continue;
    pattern.lastIndex = 0;
    for (const match of source.matchAll(pattern)) {
      const value = match[0];
      if (kind === 'payment-card') { const digits = value.replace(/\D/g, ''); if (digits.length < 13 || digits.length > 19 || !luhn(digits)) continue; }
      if (kind === 'phone' && value.replace(/\D/g, '').length < 7) continue;
      found.push({ kind, start: match.index, end: match.index + value.length });
      if (found.length > MAX_FINDINGS * 4) break;
    }
  }
  found.sort((a, b) => a.start - b.start || b.end - a.end);
  const kept = [];
  for (const item of found) if (!kept.length || item.start >= kept.at(-1).end) kept.push(item);
  return kept.slice(0, MAX_FINDINGS).map(item => ({ ...item, preview: maskValue(source.slice(item.start, item.end)) }));
}

const MATCH_SCRIPT = new Script(`(() => { const re = new RegExp(pattern, flags); const out = [];
  for (const m of text.matchAll(re)) { if (m[0].length) out.push([m.index, m.index + m[0].length]); if (out.length > 100000) break; }
  return JSON.stringify(out); })()`);
/** Caller-supplied regular expressions run in a separate context with a time limit, so a pathological pattern cannot stall Weft. */
function patternMatches(text, pattern, flags, index) {
  const invalid = message => Object.assign(new Error(`Redaction ${index}: ${message}`), { code: 'invalid_arguments' });
  try { new RegExp(pattern, String(flags || '').replace(/[^imsu]/g, '')); } catch { throw invalid('invalid regular expression'); }
  try {
    return JSON.parse(MATCH_SCRIPT.runInContext(createContext({ text, pattern, flags: `${String(flags || '').replace(/[^imsu]/g, '')}g` }), { timeout: 2000 }));
  } catch (error) { throw invalid(/timed out/i.test(error.message) ? 'regular expression took too long; simplify it' : 'regular expression failed'); }
}

/**
 * Resolve span selectors to concrete [start, end) ranges over `text`.
 * Selectors: { start, end } offsets; { literal, caseSensitive? } every occurrence;
 * { pattern, flags? } regular expression; { detector } every assistance match of a kind.
 */
export function resolveSpans(text, selectors = []) {
  const source = String(text ?? '');
  const spans = [];
  const unmatched = [];
  selectors.forEach((selector, index) => {
    const label = String(selector.label || selector.detector || (selector.pattern ? 'pattern' : selector.literal !== undefined ? 'text' : 'selection')).slice(0, 60);
    const before = spans.length;
    if (Number.isSafeInteger(selector.start) && Number.isSafeInteger(selector.end)) {
      if (selector.start < 0 || selector.end > source.length || selector.end <= selector.start) throw Object.assign(new Error(`Redaction ${index}: offsets are outside the text`), { code: 'invalid_arguments' });
      spans.push({ start: selector.start, end: selector.end, label, selector: index, method: 'offsets' });
    } else if (typeof selector.literal === 'string' && selector.literal.length) {
      const haystack = selector.caseSensitive === false ? source.toLocaleLowerCase() : source;
      const needle = selector.caseSensitive === false ? selector.literal.toLocaleLowerCase() : selector.literal;
      for (let at = haystack.indexOf(needle); at >= 0; at = haystack.indexOf(needle, at + needle.length)) spans.push({ start: at, end: at + needle.length, label, selector: index, method: 'literal' });
    } else if (typeof selector.pattern === 'string') {
      for (const [start, end] of patternMatches(source, selector.pattern, selector.flags, index)) spans.push({ start, end, label, selector: index, method: 'pattern' });
    } else if (selector.detector) {
      for (const item of detectSensitive(source, { detectors: [selector.detector] })) spans.push({ start: item.start, end: item.end, label, selector: index, method: 'detector' });
    } else throw Object.assign(new Error(`Redaction ${index}: supply offsets, literal, pattern or detector`), { code: 'invalid_arguments' });
    if (spans.length === before) unmatched.push(index);
  });
  spans.sort((a, b) => a.start - b.start || b.end - a.end);
  const merged = [];
  for (const span of spans) {
    const last = merged.at(-1);
    if (last && span.start <= last.end) { last.end = Math.max(last.end, span.end); if (!last.labels.includes(span.label)) last.labels.push(span.label); }
    else merged.push({ start: span.start, end: span.end, labels: [span.label], method: span.method });
  }
  return { spans: merged, unmatched };
}

/**
 * Remove spans from text, replacing each with a fixed marker. Redaction
 * metadata records only where the marker sits in the derivative and its
 * label: never the removed text, its length, or the selector that found it.
 */
export function redactText(text, selectors) {
  const source = String(text ?? '');
  const { spans, unmatched } = resolveSpans(source, selectors);
  let output = '';
  let cursor = 0;
  const redactions = [];
  for (const span of spans) {
    output += source.slice(cursor, span.start);
    redactions.push({ type: 'text', index: redactions.length, at: output.length, label: span.labels.join(', ').slice(0, 120), method: span.method });
    output += REDACTION_MARK;
    cursor = span.end;
  }
  output += source.slice(cursor);
  return { text: output, redactions, unmatched };
}

const SENSITIVE_PARAM = /token|secret|passw|credential|auth|api.?key|session|signature|sig$|code|key|otp|email|e-mail|user|account|phone|ssn|card|nonce|state|ticket|jwt/i;
/** Proposed URL forms for a derivative. */
export function reduceUrl(value, mode = 'keep') {
  if (!value || mode === 'remove') return mode === 'remove' ? '' : value || '';
  try {
    const url = new URL(value);
    if (mode === 'origin') return url.origin;
    if (mode === 'origin-path') return `${url.origin}${url.pathname}`;
    return url.href;
  } catch { return ''; }
}

/** Review one URL for query parameters, fragments, credentials and identifying path segments. */
export function reviewUrl(value, field) {
  const findings = [];
  let url;
  try { url = new URL(String(value)); } catch { return value ? [{ field, kind: 'unparseable-url', severity: 'review', detail: 'Value is not a parseable URL; review it manually.' }] : []; }
  if (url.username || url.password) findings.push({ field, kind: 'url-credentials', severity: 'high', detail: 'URL contains user information.' });
  for (const key of new Set(url.searchParams.keys())) {
    findings.push({ field, kind: 'url-query', severity: SENSITIVE_PARAM.test(key) ? 'high' : 'review', parameter: key.slice(0, 100), detail: SENSITIVE_PARAM.test(key) ? 'Query parameter name suggests an identifier, token or personal data.' : 'Query parameters can carry identifiers; review before sharing.' });
  }
  if (url.hash && url.hash.length > 1) findings.push({ field, kind: 'url-fragment', severity: 'review', detail: 'URL fragment can carry tokens or state.' });
  url.pathname.split('/').forEach((segment, index) => {
    if (!segment) return;
    const decoded = (() => { try { return decodeURIComponent(segment); } catch { return segment; } })();
    const kinds = detectSensitive(decoded).map(item => item.kind);
    if (kinds.length) findings.push({ field, kind: 'url-path', severity: 'high', segment: index, detail: `Path segment matches ${[...new Set(kinds)].join(', ')} detection.` });
    else if (/^[0-9a-f]{16,}$/i.test(decoded) || /^[A-Za-z0-9_-]{24,}$/.test(decoded) || /^\d{6,}$/.test(decoded)) findings.push({ field, kind: 'url-path', severity: 'review', segment: index, detail: 'Path segment looks like an identifier or token.' });
  });
  return findings;
}

/** Review free text with detection assistance; findings carry masked previews only. */
export function reviewText(value, field) {
  return detectSensitive(value).map(item => ({ field, kind: item.kind, severity: 'high', start: item.start, end: item.end, preview: item.preview, detail: 'Detection assistance match.' }));
}

/** Stable short digest used to refer to excluded content without revealing it. */
export const shortDigest = value => createHash('sha256').update(String(value)).digest('hex').slice(0, 16);
