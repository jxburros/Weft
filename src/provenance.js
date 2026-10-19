import { randomUUID } from 'node:crypto';
import { z } from 'zod';

/**
 * Record provenance and quote-selector citations (#66, #23).
 *
 * `origin` says who or what produced a record or revision. The actor and kind are
 * always derived from the authenticated caller; command arguments may only add
 * descriptive detail (model, provider, tool call, conversation, capture). Automation
 * and model transports can never claim human or pasted authorship.
 *
 * Citations into captures follow the W3C Web Annotation TextQuoteSelector shape
 * ({exact, prefix, suffix}) and re-anchor against newer versions after Unicode NFKC,
 * ligature, punctuation and whitespace normalization. A citation that cannot be
 * resolved is marked unverified; it never rejects the record that carries it.
 */
const id = z.string().min(1).max(128);
const short = z.string().max(200);
export const AUTHORING = Object.freeze(['human_written', 'pasted', 'ai_generated', 'ai_edited', 'imported']);
/** Authorship claims only a person may make (ByAuthorX lesson: transports cannot claim human/pasted). */
const HUMAN_CLAIMS = new Set(['human_written', 'pasted']);
export const originInput = z.strictObject({
  authoring: z.enum(AUTHORING.filter(item => item !== 'imported')).optional().describe('Authorship claim. Automation may not claim human_written or pasted.'),
  model: short.optional().describe('Model that produced the content, if any.'),
  provider: short.optional().describe('Provider or connection name for that model.'),
  toolCall: short.optional().describe('Tool call identifier that produced the content.'),
  conversationId: id.optional().describe('Conversation the content came from.'),
  captureId: id.optional().describe('Capture (artifact) the content was taken from.'),
}).describe('Descriptive provenance. Weft sets the actor from the authenticated caller; it cannot be supplied.');

export const citationInput = z.strictObject({
  type: z.enum(['capture', 'record', 'source']).describe('capture: an artifact version; record: a materials/context/tasks revision; source: a linked file or service reference version.'),
  captureId: id.optional().describe('Artifact ID for capture citations.'),
  versionId: id.optional().describe('Exact artifact version ID; defaults to the latest version.'),
  collection: z.enum(['materials', 'context', 'tasks']).optional().describe('Record collection for record citations.'),
  recordId: id.optional().describe('Record ID for record or source citations.'),
  revision: z.number().int().positive().optional().describe('Record revision; defaults to the current revision.'),
  sha256: z.string().regex(/^[0-9a-f]{64}$/).optional().describe('Linked source content hash; defaults to the current verified version.'),
  exact: z.string().min(1).max(4000).optional().describe('Exact quoted text (TextQuoteSelector exact).'),
  prefix: z.string().max(400).optional().describe('Text just before the quote, for disambiguation.'),
  suffix: z.string().max(400).optional().describe('Text just after the quote, for disambiguation.'),
  note: z.string().max(2000).optional().describe('Why this citation supports the record.'),
});

const human = actor => ['human', 'admin'].includes(actor);
const deny = message => Object.assign(new Error(`PERMISSION_REQUIRED: ${message}`), { code: 'permission_required' });

/** Server-side origin for a record or revision. `input` is the caller's descriptive origin (already schema-validated). */
export function originFor(context = {}, input = {}, extra = {}) {
  const actor = String(context.actor || 'human').slice(0, 200);
  const kind = human(actor) ? 'human' : actor.startsWith('system:') ? 'system' : actor === 'model-reader' || context.source === 'model' ? 'model' : 'agent';
  if (input.authoring && HUMAN_CLAIMS.has(input.authoring) && kind !== 'human') throw deny(`origin_claim: ${kind === 'model' ? 'a model' : 'automation'} cannot claim ${input.authoring} authorship`);
  const origin = { actor, kind, ...(context.clientId && { clientId: String(context.clientId).slice(0, 128) }) };
  for (const key of ['model', 'provider', 'toolCall', 'conversationId', 'captureId']) if (typeof input[key] === 'string') origin[key] = input[key];
  origin.authoring = input.authoring ?? (kind === 'human' ? 'human_written' : 'ai_generated');
  return { ...origin, ...extra, at: new Date().toISOString() };
}

const claimedOrigin = z.object({ actor: z.string().max(200).optional(), kind: z.string().max(40).optional(), authoring: z.string().max(40).optional(), clientId: z.string().max(128).optional(),
  model: short.optional(), provider: short.optional(), toolCall: short.optional(), conversationId: z.string().max(128).optional(), captureId: z.string().max(128).optional(), at: z.string().max(100).optional() });
/** Imported origin: the exporting profile's claim is kept as data, never as a trusted human origin. */
export function importedOrigin(value, actor, mapping) {
  const parsed = claimedOrigin.safeParse(value);
  const claimed = parsed.success ? Object.fromEntries(Object.entries(parsed.data).filter(([, item]) => item !== undefined)) : null;
  if (claimed) for (const key of ['conversationId', 'captureId']) if (claimed[key]) claimed[key] = mapping?.get(claimed[key]) ?? claimed[key];
  return { actor: String(actor).slice(0, 200), kind: 'import', authoring: 'imported', ...(claimed && { claimed }), at: new Date().toISOString() };
}

// ---- Text normalization with an offset map -------------------------------------------
// NFKC already folds ﬀ/ﬁ/ﬂ/ﬃ/ﬄ/ﬅ/ﬆ and ĳ; these remain distinct letters under NFKC.
const LIGATURES = { 'Æ': 'AE', 'æ': 'ae', 'Œ': 'OE', 'œ': 'oe', 'Ꜳ': 'AA', 'ꜳ': 'aa', 'ẞ': 'SS' };
const PUNCTUATION = { '‘': "'", '’': "'", '‚': "'", '‛': "'", '′': "'", 'ʼ': "'", '“': '"', '”': '"', '„': '"', '‟': '"', '″': '"',
  '«': '"', '»': '"', '‐': '-', '‑': '-', '‒': '-', '–': '-', '—': '-', '―': '-', '−': '-', '…': '...' };
const INVISIBLE = /^[­​-‍⁠﻿]$/u;
const CLUSTER = /\P{M}\p{M}*|\p{M}+/gsu;

/**
 * Normalize text for quote matching and keep, for every normalized UTF-16 unit, the
 * original [start, end) range it came from. Whitespace runs fold to one space.
 */
export function normalizeWithMap(text, { fold = false } = {}) {
  let output = '';
  const starts = [];
  const ends = [];
  let lastSpace = true;
  for (const match of String(text).matchAll(CLUSTER)) {
    const cluster = match[0];
    const start = match.index;
    const end = start + cluster.length;
    let value = cluster.normalize('NFKC');
    value = [...value].map(ch => LIGATURES[ch] ?? PUNCTUATION[ch] ?? (INVISIBLE.test(ch) ? '' : ch)).join('');
    if (fold) value = [...value].map(ch => { const lower = ch.toLowerCase(); return lower.length === ch.length ? lower : ch; }).join('');
    if (!value) continue;
    if (/^\s+$/u.test(value)) {
      if (lastSpace) { if (ends.length) ends[ends.length - 1] = Math.max(ends.at(-1), end); continue; }
      output += ' '; starts.push(start); ends.push(end); lastSpace = true; continue;
    }
    for (const unit of value.replace(/\s+/gu, ' ')) { output += unit; starts.push(start); ends.push(end); }
    lastSpace = false;
  }
  return { text: output, starts, ends };
}
export function normalizeText(text, options) { return normalizeWithMap(text, options).text.trim(); }

const commonSuffix = (a, b) => { let n = 0; while (n < a.length && n < b.length && a[a.length - 1 - n] === b[b.length - 1 - n]) n++; return n; };
const commonPrefix = (a, b) => { let n = 0; while (n < a.length && n < b.length && a[n] === b[n]) n++; return n; };

/**
 * Locate a TextQuoteSelector in `text`. Returns null when the quote is absent;
 * otherwise original offsets, the match method and whether the choice among
 * several occurrences was ambiguous.
 */
export function anchorQuote(text, { exact, prefix = '', suffix = '' }) {
  if (typeof text !== 'string' || typeof exact !== 'string' || !exact.trim()) return null;
  for (const [method, fold] of [['normalized', false], ['case-insensitive', true]]) {
    const doc = normalizeWithMap(text, { fold });
    const quote = normalizeText(exact, { fold });
    if (!quote) return null;
    const found = [];
    for (let index = doc.text.indexOf(quote); index >= 0 && found.length < 1000; index = doc.text.indexOf(quote, index + 1)) found.push(index);
    if (!found.length) continue;
    const before = normalizeText(prefix, { fold });
    const after = normalizeText(suffix, { fold });
    const scored = found.map(index => ({ index, score: commonSuffix(before, doc.text.slice(Math.max(0, index - before.length - 1), index).trimEnd()) + commonPrefix(after, doc.text.slice(index + quote.length).trimStart()) }));
    scored.sort((a, b) => b.score - a.score || a.index - b.index);
    const best = scored[0];
    const start = doc.starts[best.index];
    const end = doc.ends[best.index + quote.length - 1];
    const exactMatch = text.slice(start, end) === exact;
    return { start, end, method: exactMatch ? 'exact' : method, occurrences: found.length, ambiguous: found.length > 1 && scored[1].score === best.score };
  }
  return null;
}

/** Context around an anchored quote, so later re-anchoring can disambiguate. */
export function selectorFor(text, start, end, size = 32) {
  return { exact: text.slice(start, end), prefix: text.slice(Math.max(0, start - size), start), suffix: text.slice(end, end + size) };
}

/**
 * Build a stored citation from caller input. `resolve(input)` returns the cited target
 * ({targetVersion, text, latest}) or null when unknown. An unknown target or missing
 * quote is stored as unverified with a reason; the record is never rejected for it.
 */
export function buildCitation(input, resolve, now = new Date().toISOString()) {
  const citation = { id: `cite_${randomUUID()}`, type: input.type };
  for (const key of ['captureId', 'versionId', 'collection', 'recordId', 'revision', 'sha256', 'note']) if (input[key] !== undefined) citation[key] = input[key];
  let target = null;
  try { target = resolve(input); } catch { target = null; }
  if (!target) return { ...citation, ...(input.exact && { exact: input.exact, prefix: input.prefix ?? '', suffix: input.suffix ?? '' }), status: 'unverified', reason: 'unknown_target', checkedAt: now };
  Object.assign(citation, target.pin);
  if (!input.exact) return { ...citation, status: target.unavailable ? 'unverified' : 'verified', ...(target.unavailable && { reason: target.unavailable }), checkedAt: now };
  if (typeof target.text !== 'string') return { ...citation, exact: input.exact, prefix: input.prefix ?? '', suffix: input.suffix ?? '', status: 'unverified', reason: target.unavailable || 'text_unavailable', checkedAt: now };
  const anchor = anchorQuote(target.text, input);
  if (!anchor) return { ...citation, exact: input.exact, prefix: input.prefix ?? '', suffix: input.suffix ?? '', status: 'unverified', reason: 'quote_not_found', checkedAt: now };
  const selector = selectorFor(target.text, anchor.start, anchor.end);
  return { ...citation, exact: input.exact, prefix: input.prefix ?? selector.prefix, suffix: input.suffix ?? selector.suffix,
    anchor: { ...target.anchorKey, start: anchor.start, end: anchor.end, method: anchor.method, ...(anchor.ambiguous && { ambiguous: true }) }, status: 'verified', checkedAt: now };
}

/**
 * Re-check a stored citation against the newest available version of its target.
 * `latest(citation)` returns {key, text, changed, unavailable} for the current target
 * state, or null when the target is gone. Original evidence fields are never rewritten;
 * only status, the current anchor and the check time change.
 */
export function reanchorCitation(citation, latest, now = new Date().toISOString()) {
  const next = { ...citation, checkedAt: now };
  delete next.reason;
  let current;
  try { current = latest(citation); } catch { current = null; }
  if (!current) return { ...next, status: 'unverified', reason: 'unknown_target', current: null };
  if (current.unavailable && typeof current.text !== 'string') return { ...next, status: citation.status === 'verified' && !current.changed ? 'verified' : 'unverified', reason: current.unavailable };
  if (!current.changed) {
    if (!citation.exact) return { ...next, status: 'verified', current: null };
    const anchor = typeof current.text === 'string' ? anchorQuote(current.text, citation) : null;
    return anchor ? { ...next, status: 'verified', anchor: { ...current.key, start: anchor.start, end: anchor.end, method: anchor.method }, current: null }
      : { ...next, status: 'unverified', reason: 'quote_not_found', current: null };
  }
  // The target has a newer version than the one cited.
  if (!citation.exact) return { ...next, status: 'stale', reason: 'source_changed', current: current.key };
  const anchor = typeof current.text === 'string' ? anchorQuote(current.text, citation) : null;
  if (!anchor) return { ...next, status: 'stale', reason: typeof current.text === 'string' ? 'quote_removed' : 'source_changed', current: current.key };
  return { ...next, status: 'reanchored', current: { ...current.key, start: anchor.start, end: anchor.end, method: anchor.method } };
}
