import { createHash } from 'node:crypto';
import { z } from 'zod';

/**
 * Additive cursor pagination for collection commands (ADR 018).
 *
 * Without `page` a collection command returns its established unpaged array. With
 * `page: {limit?, cursor?}` it returns `{items, nextCursor, total}` in a documented, stable
 * order. Cursors are opaque keyset positions bound to the command and its scope, so inserts and
 * deletions between pages neither duplicate nor skip items that existed before the position.
 */
export const MAX_PAGE_LIMIT = 500;
export const DEFAULT_PAGE_LIMIT = 50;
export const pageField = z.strictObject({
  limit: z.number().int().min(1).max(MAX_PAGE_LIMIT).optional().describe(`Items per page (default ${DEFAULT_PAGE_LIMIT}, maximum ${MAX_PAGE_LIMIT}).`),
  cursor: z.string().min(1).max(1024).optional().describe('Opaque nextCursor from the previous page of this same command and scope.'),
}).describe('Request one page: the result becomes {items, nextCursor, total}. Omit for the unpaged list.');

const time = item => item?.createdAt ?? item?.visitedAt ?? item?.startedAt ?? item?.at ?? '';
const id = item => String(item?.id ?? '');
/** Paged order per command: `asc` creation order or `desc` newest first; key returns [time, id]. */
const ORDER = {
  'history.list': 'desc', 'approvals.list': 'desc', 'downloads.list': 'desc', 'events.list': 'asc',
};
export const PAGEABLE = Object.freeze(new Set(['materials.list', 'context.list', 'tasks.list', 'conversations.list', 'workflows.list', 'siteRules.list',
  'artifacts.list', 'bookmarks.list', 'history.list', 'handoffs.list', 'approvals.list', 'downloads.list', 'workspaces.list',
  'conversations.messages', 'artifacts.versions', 'search.query', 'transfers.list']));
export const orderFor = command => ORDER[command] ?? 'asc';

const fingerprint = value => createHash('sha256').update(JSON.stringify(value)).digest('base64url').slice(0, 16);
const invalid = message => Object.assign(new Error(message), { code: 'invalid_arguments', field: 'page.cursor' });

export function encodeCursor(command, scope, position) {
  return Buffer.from(JSON.stringify({ v: 1, c: command, s: fingerprint(scope), p: position })).toString('base64url');
}
/** Decode a cursor, refusing one minted for another command, scope or filter. */
export function decodeCursor(cursor, command, scope) {
  let parsed;
  try { parsed = JSON.parse(Buffer.from(String(cursor), 'base64url').toString('utf8')); } catch { parsed = null; }
  if (!parsed || parsed.v !== 1 || typeof parsed.c !== 'string' || !('p' in parsed)) throw invalid('Invalid page cursor; restart from the first page');
  if (parsed.c !== command || parsed.s !== fingerprint(scope)) throw invalid('This cursor belongs to a different command, workspace or filter; restart from the first page');
  return parsed.p;
}

const compare = (a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : a[1] < b[1] ? -1 : a[1] > b[1] ? 1 : 0);
/**
 * Keyset page over an in-memory list. `key(item)` returns a [time, id] tuple (ascending order is
 * creation order). Positional collections (messages, versions) pass `positional: true`.
 */
export function pageItems(items, page = {}, { command, scope = null, key = item => [String(time(item)), id(item)], order = orderFor(command), positional = false } = {}) {
  const limit = page.limit ?? DEFAULT_PAGE_LIMIT;
  if (positional) {
    const start = page.cursor ? decodeCursor(page.cursor, command, scope) : 0;
    if (!Number.isSafeInteger(start) || start < 0) throw invalid('Invalid page cursor; restart from the first page');
    const slice = items.slice(start, start + limit);
    const next = start + slice.length;
    return { items: slice, nextCursor: next < items.length ? encodeCursor(command, scope, next) : null, total: items.length };
  }
  const sign = order === 'desc' ? -1 : 1;
  const sorted = items.map(item => ({ item, k: key(item) })).sort((a, b) => sign * compare(a.k, b.k));
  let start = 0;
  if (page.cursor) {
    const after = decodeCursor(page.cursor, command, scope);
    if (!Array.isArray(after) || after.length !== 2) throw invalid('Invalid page cursor; restart from the first page');
    start = sorted.findIndex(entry => sign * compare(entry.k, after) > 0);
    if (start < 0) start = sorted.length;
  }
  const slice = sorted.slice(start, start + limit);
  const more = start + slice.length < sorted.length;
  return { items: slice.map(entry => entry.item), nextCursor: more && slice.length ? encodeCursor(command, scope, slice.at(-1).k) : null, total: sorted.length };
}
