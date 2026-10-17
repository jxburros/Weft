/** Local FTS5 document extraction and injection-safe query compilation. */
// Version 2 adds handoff records; a changed version rebuilds the index on open.
export const SEARCH_INDEX_VERSION = 2;
// Profile policy and logs are not project text: storage modes and list subscriptions are not searchable records.
const NOT_INDEXED = new Set(['workspaces', 'activity', 'history', 'siteLists', 'storagePolicies']);
const MAX_BODY = 4 * 1024 * 1024;
const join = (...values) => values.flat(Infinity).filter(value => typeof value === 'string' && value.trim()).join('\n').slice(0, MAX_BODY);
const strings = value => Array.isArray(value) ? value.filter(item => typeof item === 'string') : [];

export const indexable = (collection, record) => !NOT_INDEXED.has(collection) && typeof record?.workspaceId === 'string' && typeof record.id === 'string';

/**
 * One searchable document per record, plus one per immutable artifact version
 * so results can cite an exact capture. Conversation messages are not indexed:
 * they can mix local-only and shareable content inside one record.
 */
export function recordDocument(collection, record) {
  const base = { versionId: '', versionNumber: null, revision: Number.isSafeInteger(record.revision) ? record.revision : null, localOnly: record.localOnly === true, updatedAt: typeof record.updatedAt === 'string' ? record.updatedAt : null };
  let title = record.title;
  let body;
  if (collection === 'materials') body = join(record.content, record.note, strings(record.tags), record.url, record.filename);
  else if (collection === 'context') body = join(record.content, record.category, strings(record.tags), strings(record.sources));
  else if (collection === 'tasks') body = join(record.objective, record.blocker, record.checkpoint, record.nextStep, record.status, record.assignee);
  else if (collection === 'conversations') body = '';
  else if (collection === 'workflows') body = join(record.description, record.expectedOutputs, strings(record.parameters), (Array.isArray(record.steps) ? record.steps : []).map(step => [step?.title, step?.instruction]));
  else if (collection === 'siteRules') { title = record.hostname; body = join(record.reason, record.note, record.path); }
  else if (collection === 'handoffs') {
    title = `${record.kind === 'takeover' ? 'Takeover' : 'Handoff'}: ${String(record.objective || record.blocker || record.nextStep || '').split('\n')[0].slice(0, 200)}`;
    body = join(record.objective, strings(record.completedActions), strings(record.findings), record.blocker, record.nextStep, record.note, record.status, record.from, record.to,
      (Array.isArray(record.evidence) ? record.evidence : []).map(item => item?.note));
  }
  else if (collection === 'artifacts') body = join(record.note, strings(record.tags), (Array.isArray(record.annotations) ? record.annotations : []).map(item => item?.note));
  else { title ??= record.name; body = join(record.content, record.description, record.text, record.note, record.objective, record.summary, strings(record.tags)); }
  if (typeof title !== 'string' || !title.trim()) title = typeof record.hostname === 'string' ? record.hostname : '';
  return { ...base, title: title.slice(0, 1000), body };
}

export function versionDocument(record, version, text) {
  return { versionId: version.id, versionNumber: Number.isSafeInteger(version.number) ? version.number : null, revision: Number.isSafeInteger(record.revision) ? record.revision : null, localOnly: record.localOnly === true,
    updatedAt: typeof version.createdAt === 'string' ? version.createdAt : null, title: String(version.title || record.title || '').slice(0, 1000), body: typeof text === 'string' ? text.slice(0, MAX_BODY) : '' };
}

/**
 * User text never reaches FTS5 syntax: each whitespace-separated chunk becomes
 * a quoted phrase of letter/number tokens, with prefix matching on its final
 * token. Operators, column filters, NEAR and quotes are therefore inert.
 * The index does not stem (stemmed prefixes miss partially typed words);
 * prefix matching covers common inflections such as run/running.
 */
export function compileQuery(input) {
  const chunks = String(input).normalize('NFKC').toLocaleLowerCase().split(/\s+/)
    .map(chunk => chunk.match(/[\p{L}\p{N}]+/gu) || []).filter(tokens => tokens.length).slice(0, 32);
  if (!chunks.length) return null;
  const phrases = chunks.map(tokens => `"${tokens.slice(0, 16).join(' ')}"*`);
  return { all: phrases.join(' AND '), any: phrases.length > 1 ? phrases.join(' OR ') : null, tokens: chunks.flat().slice(0, 64) };
}
