import { createHash } from 'node:crypto';
import { typedError } from './helpers.js';

/**
 * Resource archives (weft-archive format 1).
 *
 * Chromium serializes the rendered page to MHTML (webContents.savePage). Blink's
 * serializer drops script elements and takes subresources from the renderer's
 * memory cache, so archiving does not fetch anything again. Weft parses the
 * MHTML into parts, removes sensitive form values, and stores every part as a
 * content-addressed component listed in a manifest with its URL, MIME type,
 * size, SHA-256 and status. Resources the page referenced that Chromium did
 * not serialize (failed, never loaded, scripts, oversized) are listed with an
 * explicit status instead of disappearing.
 *
 * Hashes show that stored bytes are unchanged since capture. They do not prove
 * that a source served those bytes or when it did.
 */
export const ARCHIVE_FORMAT = 'weft-archive';
export const ARCHIVE_FORMAT_VERSION = 1;
export const ARCHIVE_LIMITS = Object.freeze({ maxResourceBytes: 8 * 1024 * 1024, maxArchiveBytes: 64 * 1024 * 1024, maxResources: 2000, maxReferences: 5000 });
export const CID_HOST = 'cid.weft-archive.invalid';
export const FALLBACK_DOCUMENT_URL = 'https://document.weft-archive.invalid/';
/** Response policy for every archived document and frame served in the offline preview. */
export const ARCHIVE_CSP = "sandbox; default-src 'none'; img-src http: https: data:; style-src http: https: 'unsafe-inline'; font-src http: https: data:; media-src http: https: data:; frame-src http: https:; script-src 'none'; connect-src 'none'; form-action 'none'; base-uri 'none'; object-src 'none'; worker-src 'none'; manifest-src 'none'";
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
const failure = typedError;
const SECRET_PARAM = /token|secret|password|credential|authorization|api.?key|session|signature|^code$|^key$/i;

/** Lookup key for a resource URL: credentials, fragment and secret-named parameters removed (the same rule as stored URLs). */
export function archiveKey(value) {
  try {
    const url = new URL(value);
    if (url.hostname === CID_HOST) return url.href;
    if (!['http:', 'https:'].includes(url.protocol)) return null;
    url.username = ''; url.password = ''; url.hash = '';
    for (const key of [...url.searchParams.keys()]) if (SECRET_PARAM.test(key)) url.searchParams.delete(key);
    return url.href;
  } catch { return null; }
}
export const cidUrl = contentId => `https://${CID_HOST}/${encodeURIComponent(contentId)}`;

function headers(block) {
  const result = {};
  for (const line of block.replace(/\r?\n[ \t]+/g, ' ').split(/\r?\n/)) {
    const at = line.indexOf(':');
    if (at > 0) result[line.slice(0, at).trim().toLowerCase()] = line.slice(at + 1).trim();
  }
  return result;
}
function decodeQuotedPrintable(text) {
  const out = Buffer.alloc(text.length);
  let length = 0;
  for (let index = 0; index < text.length; index++) {
    const char = text.charCodeAt(index);
    if (char === 61 /* = */) {
      if (text[index + 1] === '\r' && text[index + 2] === '\n') { index += 2; continue; }
      if (text[index + 1] === '\n') { index += 1; continue; }
      const hex = text.slice(index + 1, index + 3);
      if (/^[0-9A-Fa-f]{2}$/.test(hex)) { out[length++] = parseInt(hex, 16); index += 2; continue; }
    }
    out[length++] = char & 255;
  }
  return out.subarray(0, length);
}

/** Parse a Chromium MHTML file into its parts. Bodies are decoded bytes. */
export function parseMhtml(bytes, { maxParts = ARCHIVE_LIMITS.maxResources } = {}) {
  const text = Buffer.isBuffer(bytes) ? bytes.toString('latin1') : String(bytes);
  const split = text.search(/\r?\n\r?\n/);
  if (split < 0) throw failure('archive_invalid', 'MHTML has no header block');
  const top = headers(text.slice(0, split));
  const boundary = /boundary="?([^";]+)"?/i.exec(top['content-type'] || '')?.[1];
  if (!/^multipart\/related/i.test(top['content-type'] || '') || !boundary) throw failure('archive_invalid', 'MHTML is not multipart/related');
  const delimiter = `--${boundary}`;
  const sections = text.slice(split).split(delimiter);
  const parts = [];
  for (const section of sections.slice(1)) {
    if (section.startsWith('--')) break;
    const body = section.replace(/^\r?\n/, '');
    const end = body.search(/\r?\n\r?\n/);
    if (end < 0) continue;
    const head = headers(body.slice(0, end));
    const content = body.slice(end).replace(/^\r?\n\r?\n/, '').replace(/\r?\n$/, '');
    const encoding = (head['content-transfer-encoding'] || 'binary').toLowerCase();
    let decoded;
    if (encoding === 'base64') decoded = Buffer.from(content.replace(/\s+/g, ''), 'base64');
    else if (encoding === 'quoted-printable') decoded = decodeQuotedPrintable(content);
    else decoded = Buffer.from(content, 'latin1');
    parts.push({ contentType: String(head['content-type'] || 'application/octet-stream').split(';')[0].trim().toLowerCase().slice(0, 128),
      contentId: head['content-id'] ? head['content-id'].replace(/^<|>$/g, '').slice(0, 512) : null, location: head['content-location'] || null, bytes: decoded });
    if (parts.length > maxParts) throw failure('archive_too_large', `MHTML has more than ${maxParts} parts`);
  }
  if (!parts.length) throw failure('archive_invalid', 'MHTML has no parts');
  return { snapshotUrl: top['snapshot-content-location'] || parts[0].location || null, parts };
}

const SENSITIVE_AUTOCOMPLETE = /\b(cc-[a-z-]+|one-time-code|current-password|new-password)\b/i;
const SENSITIVE_NAME = /pass(word|code|phrase)?|\botp\b|one.?time|\bcvc|\bcvv|\bcsc\b|card.?(number|num|no)\b|security.?code|\bpin\b|\bssn\b|secret|token|api.?key|csrf|xsrf|nonce/i;
const ATTRIBUTE = /([^\s"'>/=]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/g;
function attributes(source) {
  const result = {};
  for (const match of source.matchAll(ATTRIBUTE)) result[match[1].toLowerCase()] = match[2] ?? match[3] ?? match[4] ?? '';
  return result;
}
const sensitiveField = (tag, attrs) => (tag === 'input' && ['password', 'hidden'].includes(String(attrs.type || '').toLowerCase()))
  || SENSITIVE_AUTOCOMPLETE.test(attrs.autocomplete || '') || SENSITIVE_NAME.test([attrs.name, attrs.id, attrs['aria-label'], attrs.placeholder].filter(Boolean).join(' '));

/**
 * Remove values of password, hidden, payment-card, one-time-code and
 * secret-named fields from serialized HTML, and rewrite MHTML frame (cid:)
 * references to archive-local URLs. Works on byte-preserving latin1 text.
 */
export function sanitizeArchivedHtml(bytes) {
  let html = Buffer.from(bytes).toString('latin1');
  let removedValues = 0, clearedTextareas = 0, rewrittenFrames = 0;
  html = html.replace(/<input\b((?:[^>"']|"[^"]*"|'[^']*')*)>/gi, (tag, inner) => {
    const attrs = attributes(inner);
    if (!Object.hasOwn(attrs, 'value') || !sensitiveField('input', attrs)) return tag;
    removedValues++;
    return `<input${inner.replace(/\svalue\s*=\s*(?:"[^"]*"|'[^']*'|[^\s"'=<>`]+)/gi, '')}>`;
  });
  html = html.replace(/<textarea\b((?:[^>"']|"[^"]*"|'[^']*')*)>([\s\S]*?)<\/textarea>/gi, (tag, inner, content) => {
    if (!content || !sensitiveField('textarea', attributes(inner))) return tag;
    clearedTextareas++;
    return `<textarea${inner}></textarea>`;
  });
  html = html.replace(/(["'])cid:([^"']{1,512})\1/gi, (match, quote, id) => { rewrittenFrames++; return `${quote}${cidUrl(id)}${quote}`; });
  return { bytes: Buffer.from(html, 'latin1'), removedValues, clearedTextareas, rewrittenFrames };
}

/**
 * Build the archive manifest. Every part becomes a resource entry with its
 * bytes as `bodyBase64` (stored as a component by the workspace store) unless
 * a size limit applies. Referenced resources absent from the MHTML are listed
 * as missing, failed or not archived (scripts).
 */
export function buildArchive({ mhtml, references = [], resourceLog = [], limits = {} }) {
  const bounds = { ...ARCHIVE_LIMITS, ...Object.fromEntries(Object.entries(limits).filter(([, value]) => Number.isSafeInteger(value) && value > 0)) };
  const parsed = parseMhtml(mhtml, { maxParts: bounds.maxResources });
  const resources = [];
  const seen = new Set();
  let stored = 0, storedBytes = 0;
  const transformations = { sensitiveValuesRemoved: 0, sensitiveTextareasCleared: 0, frameReferencesRewritten: 0 };
  let documentIndex = -1;
  parsed.parts.forEach((part, index) => {
    const html = part.contentType === 'text/html' || part.contentType === 'application/xhtml+xml';
    const url = part.location && !/^cid:/i.test(part.location) ? archiveKey(part.location) : null;
    if (part.location && !/^cid:/i.test(part.location) && !url) return; // data:, blob: and other non-web parts are not served.
    const key = url || (part.contentId ? cidUrl(part.contentId) : null);
    if (!key || seen.has(key + (part.contentId || ''))) return;
    seen.add(key + (part.contentId || ''));
    let body = part.bytes;
    const entry = { url: url || cidUrl(part.contentId), role: html ? (documentIndex < 0 ? 'document' : 'frame') : 'subresource', mimeType: part.contentType, ...(part.contentId ? { contentId: part.contentId } : {}) };
    if (html) {
      const clean = sanitizeArchivedHtml(body);
      body = clean.bytes;
      transformations.sensitiveValuesRemoved += clean.removedValues;
      transformations.sensitiveTextareasCleared += clean.clearedTextareas;
      transformations.frameReferencesRewritten += clean.rewrittenFrames;
      if (clean.removedValues || clean.clearedTextareas || clean.rewrittenFrames) entry.transformed = [...(clean.removedValues || clean.clearedTextareas ? ['sensitive-form-values-removed'] : []), ...(clean.rewrittenFrames ? ['frame-references-rewritten'] : [])];
      if (documentIndex < 0) documentIndex = resources.length;
    }
    entry.size = body.length;
    entry.sha256 = sha256(body);
    if (body.length > bounds.maxResourceBytes) Object.assign(entry, { status: 'omitted-size', reason: `Larger than the ${bounds.maxResourceBytes}-byte resource limit` });
    else if (storedBytes + body.length > bounds.maxArchiveBytes) Object.assign(entry, { status: 'omitted-budget', reason: `Archive reached its ${bounds.maxArchiveBytes}-byte total limit` });
    else { entry.status = 'stored'; entry.bodyBase64 = body.toString('base64'); stored++; storedBytes += body.length; }
    resources.push(entry);
  });
  if (documentIndex < 0) throw failure('archive_invalid', 'MHTML has no HTML document part');
  if (documentIndex > 0) resources.unshift(...resources.splice(documentIndex, 1));
  const present = new Set(resources.map(item => item.url));
  const failures = new Map();
  for (const item of resourceLog) {
    const key = archiveKey(item.url);
    if (key && (item.error || item.statusCode >= 400)) failures.set(key, item);
  }
  const missing = new Map();
  for (const reference of references.slice(0, bounds.maxReferences)) {
    const key = archiveKey(reference.url);
    if (!key || present.has(key) || missing.has(key)) continue;
    const failed = failures.get(key);
    const script = ['script', 'fetch', 'xmlhttprequest', 'beacon'].includes(reference.kind);
    missing.set(key, { url: key, role: 'subresource', referencedAs: String(reference.kind || 'resource').slice(0, 30),
      status: script ? 'not-archived-script' : failed ? 'failed' : 'missing',
      ...(failed?.statusCode ? { httpStatus: failed.statusCode } : {}), ...(failed?.error ? { error: String(failed.error).slice(0, 200) } : {}),
      reason: script ? (reference.kind === 'script' ? 'Scripts are never archived or replayed.' : 'Script-initiated requests are not archived; scripts are never replayed.') : failed ? 'The page request failed during browsing.' : 'Referenced by the page but not present in Chromium’s serialized archive (not loaded, lazy, blocked or evicted).' });
  }
  for (const [key, failed] of failures) if (!present.has(key) && !missing.has(key) && missing.size < bounds.maxReferences) {
    missing.set(key, { url: key, role: 'subresource', referencedAs: String(failed.resourceType || 'request').slice(0, 30), status: 'failed', ...(failed.statusCode ? { httpStatus: failed.statusCode } : {}), ...(failed.error ? { error: String(failed.error).slice(0, 200) } : {}), reason: 'The page request failed during browsing.' });
  }
  const all = [...resources, ...missing.values()];
  const counts = {};
  for (const item of all) counts[item.status] = (counts[item.status] || 0) + 1;
  const unstored = all.filter(item => item.status !== 'stored' && item.status !== 'not-archived-script');
  return { format: ARCHIVE_FORMAT, formatVersion: ARCHIVE_FORMAT_VERSION, generator: 'chromium-mhtml', documentUrl: resources[0].url, snapshotUrl: archiveKey(parsed.snapshotUrl) || resources[0].url,
    resources: all, counts, storedBytes, limits: { maxResourceBytes: bounds.maxResourceBytes, maxArchiveBytes: bounds.maxArchiveBytes, maxResources: bounds.maxResources },
    transformations, complete: unstored.length === 0, stored };
}

/** Manifest view of an archive without resource bodies. */
export function archiveManifest(archive) {
  if (!archive || typeof archive !== 'object') return null;
  const { resources = [], ...rest } = archive;
  return { ...structuredClone(rest), resources: resources.map(({ bodyBase64, ...item }) => ({ ...item })) };
}

// ---- Comparison ------------------------------------------------------------------
function lines(text) { return String(text ?? '').replace(/\r\n?/g, '\n').split('\n'); }
/**
 * Line diff with common prefix/suffix trimming and an LCS core. Inputs whose
 * changed middle is too large for an exact LCS fall back to a multiset
 * comparison marked approximate.
 */
export function diffText(before, after, { maxCells = 4_000_000, maxOutputLines = 2000, context = 3 } = {}) {
  const a = lines(before), b = lines(after);
  let start = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) start++;
  let endA = a.length, endB = b.length;
  while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) { endA--; endB--; }
  const midA = a.slice(start, endA), midB = b.slice(start, endB);
  const ops = [];
  for (let i = 0; i < start; i++) ops.push(['=', a[i]]);
  let approximate = false;
  if (midA.length * midB.length <= maxCells) {
    const n = midA.length, m = midB.length;
    const table = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1));
    for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--) table[i][j] = midA[i] === midB[j] ? table[i + 1][j + 1] + 1 : Math.max(table[i + 1][j], table[i][j + 1]);
    let i = 0, j = 0;
    while (i < n && j < m) {
      if (midA[i] === midB[j]) { ops.push(['=', midA[i]]); i++; j++; }
      else if (table[i + 1][j] >= table[i][j + 1]) ops.push(['-', midA[i++]]);
      else ops.push(['+', midB[j++]]);
    }
    while (i < n) ops.push(['-', midA[i++]]);
    while (j < m) ops.push(['+', midB[j++]]);
  } else {
    approximate = true;
    const counts = new Map();
    for (const line of midB) counts.set(line, (counts.get(line) || 0) + 1);
    for (const line of midA) { const count = counts.get(line) || 0; if (count) counts.set(line, count - 1); else ops.push(['-', line]); }
    const remaining = new Map(); for (const line of midA) remaining.set(line, (remaining.get(line) || 0) + 1);
    for (const line of midB) { const count = remaining.get(line) || 0; if (count) remaining.set(line, count - 1); else ops.push(['+', line]); }
  }
  for (let i = endA; i < a.length; i++) ops.push(['=', a[i]]);
  const added = ops.filter(([op]) => op === '+').length, removed = ops.filter(([op]) => op === '-').length;
  // Hunks: changed lines with surrounding context; long unchanged runs collapse.
  const hunks = [];
  let emitted = 0, truncated = false;
  const keep = new Uint8Array(ops.length);
  ops.forEach(([op], index) => { if (op !== '=') for (let k = Math.max(0, index - context); k <= Math.min(ops.length - 1, index + context); k++) keep[k] = 1; });
  let current = null;
  ops.forEach(([op, text], index) => {
    if (!keep[index]) { current = null; return; }
    if (emitted >= maxOutputLines) { truncated = true; return; }
    if (!current) { current = { lines: [] }; hunks.push(current); }
    current.lines.push({ op: op === '=' ? 'context' : op === '+' ? 'added' : 'removed', text: text.slice(0, 2000) });
    emitted++;
  });
  return { identical: added === 0 && removed === 0, added, removed, unchanged: ops.length - added - removed, approximate, hunks, truncated };
}

/** Resource-list comparison by URL: added, removed, changed bytes and changed status. */
export function diffResources(before = [], after = []) {
  const index = list => new Map(list.map(item => [item.url, item]));
  const a = index(before), b = index(after);
  const added = [], removed = [], changed = [], statusChanged = [];
  let unchanged = 0;
  for (const [url, item] of b) {
    const prior = a.get(url);
    if (!prior) { added.push({ url, status: item.status, size: item.size ?? null }); continue; }
    if (prior.status !== item.status) statusChanged.push({ url, from: prior.status, to: item.status });
    else if (prior.sha256 && item.sha256 && prior.sha256 !== item.sha256) changed.push({ url, fromSha256: prior.sha256, toSha256: item.sha256, fromSize: prior.size, toSize: item.size });
    else unchanged++;
  }
  for (const [url, item] of a) if (!b.has(url)) removed.push({ url, status: item.status, size: item.size ?? null });
  const limit = list => list.slice(0, 500);
  return { added: limit(added), removed: limit(removed), changed: limit(changed), statusChanged: limit(statusChanged), unchanged,
    totals: { added: added.length, removed: removed.length, changed: changed.length, statusChanged: statusChanged.length } };
}
