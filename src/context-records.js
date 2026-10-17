import { createHash, randomUUID } from 'node:crypto';
import { stat } from 'node:fs/promises';
import { z } from 'zod';
import { buildCitation, importedOrigin, reanchorCitation } from './provenance.js';
import { isAbsolute } from 'node:path';
import { readLinked } from './linked-sources.js';

/**
 * Record-level helpers shared by the workspace store and the knowledge commands:
 * shared collection access, citation targets and re-anchoring, and the export/import
 * mapping of provenance, citations, links, proposals, conflicts and collections.
 */
export const TRUSTED_CATEGORIES = Object.freeze(['confirmed', 'instructions', 'decisions']);
export const SHAREABLE = Object.freeze(['context', 'materials', 'artifacts']);
const active = member => member && !member.revokedAt;

/** The caller workspace's role in a collection: owner, write, read or null. */
export function collectionRole(collection, workspaceId) {
  if (!collection || !workspaceId) return null;
  if (collection.workspaceId === workspaceId) return 'owner';
  return collection.members?.find(member => member.workspaceId === workspaceId && active(member))?.role ?? null;
}
/** Collections that make a record readable from another workspace; the strongest role first. */
export function sharedAccess(data, type, record, workspaceId) {
  if (!record || !workspaceId || record.workspaceId === workspaceId) return null;
  const found = (data.sharedCollections ?? []).filter(item => item.workspaceId === record.workspaceId && item.items?.some(entry => entry.type === type && entry.id === record.id))
    .map(collection => ({ collection, role: collectionRole(collection, workspaceId) })).filter(item => ['read', 'write'].includes(item.role));
  return found.sort((a, b) => (b.role === 'write') - (a.role === 'write'))[0] ?? null;
}
/** Every record shared into a workspace through active collection memberships. */
export function sharedInto(data, workspaceId) {
  const out = [];
  for (const collection of data.sharedCollections ?? []) {
    const role = collectionRole(collection, workspaceId);
    if (!['read', 'write'].includes(role)) continue;
    for (const entry of collection.items ?? []) out.push({ collectionId: collection.id, ownerWorkspaceId: collection.workspaceId, role, type: entry.type, id: entry.id });
  }
  return out;
}

/** Link paths are local machine detail: non-human callers receive the name only. */
export function forCaller(collection, record, context = {}) {
  if (collection !== 'materials' || !record || ['human', 'admin'].includes(context.actor ?? 'human')) return record;
  if (record.link?.path) record.link = { ...record.link, path: undefined, candidate: record.link.candidate ? { name: record.link.candidate.name, matchedBy: record.link.candidate.matchedBy } : undefined };
  if (record.link) record.link = Object.fromEntries(Object.entries(record.link).filter(([, value]) => value !== undefined));
  if (record.service?.versions) record.service = { ...record.service, versions: record.service.versions.map(({ textBase64, ...rest }) => rest) };
  return record;
}

// ---- Citations --------------------------------------------------------------------------
const contentAt = (record, revision) => {
  if (!Array.isArray(record.history) || !record.history.length) return revision === record.revision ? record.content ?? record.objective ?? null : null;
  const entry = record.history.filter(item => item.revision <= revision).at(-1);
  return entry ? entry.content : null;
};
const readable = (data, collection, record, workspaceId) => record && (record.workspaceId === workspaceId || sharedAccess(data, collection, record, workspaceId));
const safeText = read => { try { return read(); } catch { return undefined; } };
const serviceText = (material, sha256) => {
  const version = material.service?.versions?.find(item => item.sha256 === sha256);
  if (!version) return null;
  const base64 = safeText(() => version.textBase64);
  if (typeof base64 !== 'string') return null;
  const bytes = Buffer.from(base64, 'base64');
  try { return new TextDecoder('utf-8', { fatal: true }).decode(bytes); } catch { return null; }
};
const sourceSha = material => material.link ? material.link.fingerprint?.sha256 ?? null : material.service?.versions?.at(-1)?.sha256 ?? null;

/** Resolve a citation input to its pinned target and the exact text to anchor against. `texts` holds prefetched linked-file text by material ID. */
export function citationTarget(data, workspaceId, input, texts = new Map()) {
  if (input.type === 'capture') {
    const artifact = data.artifacts.find(item => item.id === input.captureId);
    if (!readable(data, 'artifacts', artifact, workspaceId)) return null;
    const version = input.versionId ? artifact.versions.find(item => item.id === input.versionId) : artifact.versions.at(-1);
    if (!version) return null;
    const text = safeText(() => version.text);
    return { pin: { captureId: artifact.id, versionId: version.id, version: version.number }, text: typeof text === 'string' ? text : null, anchorKey: { versionId: version.id },
      ...(typeof text !== 'string' && { unavailable: version.text === undefined ? 'capture_has_no_text' : 'component_unreadable' }) };
  }
  if (input.type === 'record') {
    const collection = input.collection ?? 'context';
    const record = data[collection]?.find(item => item.id === input.recordId);
    if (!readable(data, collection, record, workspaceId)) return null;
    const revision = input.revision ?? record.revision;
    if (revision > record.revision) return null;
    const text = contentAt(record, revision);
    return { pin: { collection, recordId: record.id, revision }, text, anchorKey: { revision }, ...(text === null && { unavailable: 'revision_text_unavailable' }) };
  }
  const material = data.materials.find(item => item.id === input.recordId);
  if (!readable(data, 'materials', material, workspaceId) || (!material.link && !material.service)) return null;
  const sha256 = input.sha256 ?? sourceSha(material);
  if (!sha256) return { pin: { recordId: material.id, sha256: null }, text: null, anchorKey: {}, unavailable: 'source_not_verified' };
  const known = material.link ? (material.link.versions ?? []).some(item => item.sha256 === sha256) || material.link.fingerprint?.sha256 === sha256 : material.service.versions?.some(item => item.sha256 === sha256);
  if (!known) return null;
  const prefetched = texts.get(material.id);
  const text = material.service ? serviceText(material, sha256) : prefetched?.sha256 === sha256 ? prefetched.text : null;
  return { pin: { recordId: material.id, sha256 }, text, anchorKey: { sha256 }, ...(typeof text !== 'string' && { unavailable: 'source_text_unavailable' }) };
}

/** Current state of a cited target for re-anchoring. `texts` may carry live linked text and fresh hashes. */
export function citationLatest(data, workspaceId, citation, texts = new Map()) {
  if (citation.type === 'capture') {
    const artifact = data.artifacts.find(item => item.id === citation.captureId);
    if (!readable(data, 'artifacts', artifact, workspaceId) || !artifact.versions.length) return null;
    const latest = artifact.versions.at(-1);
    const text = safeText(() => latest.text);
    return { key: { versionId: latest.id, version: latest.number }, changed: latest.id !== citation.versionId, text: typeof text === 'string' ? text : null, ...(typeof text !== 'string' && { unavailable: 'capture_has_no_text' }) };
  }
  if (citation.type === 'record') {
    const record = data[citation.collection ?? 'context']?.find(item => item.id === citation.recordId);
    if (!readable(data, citation.collection ?? 'context', record, workspaceId)) return null;
    const current = record.content ?? record.objective ?? null;
    const cited = contentAt(record, citation.revision);
    return { key: { revision: record.revision }, changed: record.revision !== citation.revision && cited !== current, text: current };
  }
  const material = data.materials.find(item => item.id === citation.recordId);
  if (!readable(data, 'materials', material, workspaceId) || (!material.link && !material.service)) return null;
  const live = texts.get(material.id);
  if (material.link && ['missing', 'inaccessible', 'unlinked'].includes(live?.status ?? material.link.status)) return { key: { sha256: null }, changed: true, unavailable: `source_${live?.status ?? material.link.status}` };
  const sha256 = live?.sha256 ?? sourceSha(material);
  const text = material.service ? serviceText(material, sha256) : live?.sha256 === sha256 ? live.text : null;
  return { key: { sha256 }, changed: Boolean(sha256 && citation.sha256 && sha256 !== citation.sha256), text: typeof text === 'string' ? text : null };
}

export function buildCitations(data, workspaceId, inputs = [], texts) {
  return inputs.map(input => buildCitation(input, value => citationTarget(data, workspaceId, value, texts)));
}
/** Re-check every citation of a record; returns {citations, changes} with the status transitions. */
export function recheckCitations(data, workspaceId, record, texts) {
  const changes = [];
  const citations = (record.citations ?? []).map(citation => {
    const next = reanchorCitation(citation, value => citationLatest(data, workspaceId, value, texts));
    if (next.status !== citation.status) changes.push({ citationId: citation.id, from: citation.status, to: next.status, reason: next.reason ?? null, current: next.current ?? null });
    return next;
  });
  return { citations, changes };
}

/**
 * Read linked-file text for citations that quote a linked source. Only files up to 1 MiB
 * are read, and the text is used only when its SHA-256 equals the hash it is matched with.
 */
export async function prefetchSourceTexts(data, workspaceId, materialIds, { protectedPaths = [] } = {}) {
  const texts = new Map();
  for (const id of new Set(materialIds)) {
    const material = data.materials.find(item => item.id === id);
    if (!material?.link?.path || material.link.kind !== 'file' || !readable(data, 'materials', material, workspaceId)) continue;
    try {
      const info = await stat(material.link.path);
      if (info.size > 1024 * 1024) continue;
      const read = await readLinked(material.link, { maxBytes: 1024 * 1024, protectedPaths });
      if (read.encoding !== 'utf8') continue;
      texts.set(id, { sha256: createHash('sha256').update(read.content).digest('hex'), text: read.content });
    } catch { /* unavailable: reported through status */ }
  }
  return texts;
}
export const quotedSources = citations => (Array.isArray(citations) ? citations : []).filter(item => item?.type === 'source' && typeof item.recordId === 'string').map(item => item.recordId);

// ---- Export / import ------------------------------------------------------------------
/** Export view of a material: local paths, candidates, credentials and cached service content are omitted. */
export function exportMaterial(record, { keepLocalPaths = false } = {}) {
  const copy = record;
  if (copy.link) {
    const { path, candidate, ...rest } = copy.link;
    copy.link = keepLocalPaths ? { ...rest, path, ...(candidate && { candidate }) } : { ...rest, status: 'unlinked', exportedStatus: rest.status };
  }
  if (copy.service) copy.service = { ...copy.service, credentialState: 'none', access: copy.service.access === 'none' ? 'none' : 'unknown',
    versions: (copy.service.versions ?? []).map(({ textBase64, ...rest }) => ({ ...rest, cached: false })) };
  return copy;
}
export const linkedOmissions = materials => materials.filter(item => item.link || item.service).map(item => ({ id: item.id, title: item.title, kind: item.link ? `linked-${item.link.kind}` : 'service',
  ...(item.link ? { name: item.link.name, sha256: item.link.fingerprint?.sha256 ?? null } : { url: item.service.url }), omitted: item.link ? 'local file/folder content and path' : 'cached content and credential' }));

const timestamp = z.string().max(100);
const storedCitation = z.object({ id: z.string().max(128).optional(), type: z.enum(['capture', 'record', 'source']), captureId: z.string().max(128).optional(), versionId: z.string().max(128).optional(), version: z.number().int().optional(),
  collection: z.enum(['materials', 'context', 'tasks']).optional(), recordId: z.string().max(128).optional(), revision: z.number().int().positive().optional(), sha256: z.string().regex(/^[0-9a-f]{64}$/).nullable().optional(),
  exact: z.string().max(4000).optional(), prefix: z.string().max(400).optional(), suffix: z.string().max(400).optional(), note: z.string().max(2000).optional(), status: z.string().max(30).optional() });
const remapOr = (mapping, value) => (value && mapping.has(value) ? mapping.get(value) : null);

/** Imported provenance and citations: IDs are remapped, claims kept as data and statuses recomputed after import. */
export function importContextFields(item, collection, { mapping, actor, loss, keepLocalPaths = false }) {
  const fields = {};
  if (item.origin !== undefined) fields.origin = importedOrigin(item.origin, actor, mapping);
  if (item.lastOrigin !== undefined) fields.lastOrigin = importedOrigin(item.lastOrigin, actor, mapping);
  for (const key of ['promotedFrom', 'superseded']) if (item[key] && typeof item[key] === 'object') {
    const target = remapOr(mapping, item[key].id ?? item[key].by);
    if (target) fields[key] = key === 'promotedFrom' ? { id: target, revision: Number.isSafeInteger(item[key].revision) ? item[key].revision : null } : { by: target, conflictId: remapOr(mapping, item[key].conflictId), at: timestamp.safeParse(item[key].at).success ? item[key].at : null };
    else loss(collection, key, 'related record not in export; link removed');
  }
  if (Array.isArray(item.derivedFrom)) fields.derivedFrom = item.derivedFrom.map(entry => remapOr(mapping, entry)).filter(Boolean);
  if (collection === 'context') {
    if (item.citations !== undefined) {
      const parsed = z.array(storedCitation).max(50).safeParse(item.citations);
      if (!parsed.success) loss('context', 'citations', 'malformed citations dropped', Array.isArray(item.citations) ? item.citations.length : 1);
      else fields.citations = parsed.data.map(citation => {
        const copy = { ...citation, id: `cite_${randomUUID()}` };
        delete copy.status;
        let unresolved = false;
        for (const key of ['captureId', 'versionId', 'recordId']) if (copy[key]) { const next = remapOr(mapping, copy[key]); if (next) copy[key] = next; else unresolved = true; }
        if (unresolved) loss('context', 'citations', 'cited record or capture not in export; citation kept as unverified');
        return { ...copy, status: 'unverified', reason: unresolved ? 'not_in_export' : 'imported_unchecked', importedFrom: citation.id ?? null };
      });
    }
    if (item.proposal && typeof item.proposal === 'object') {
      const proposal = z.object({ status: z.enum(['proposed', 'promoted', 'dismissed']), proposedCategory: z.enum(TRUSTED_CATEGORIES), rationale: z.string().max(4000).default(''), proposedAt: timestamp.optional(),
        promotedTo: z.string().max(128).optional(), decidedAt: timestamp.optional(), reason: z.string().max(2000).optional() }).safeParse(item.proposal);
      if (proposal.success) fields.proposal = { ...proposal.data, ...(proposal.data.promotedTo && { promotedTo: remapOr(mapping, proposal.data.promotedTo) }), imported: true };
      else loss('context', 'proposal', 'malformed proposal dropped');
    }
  }
  if (collection === 'materials') {
    if (item.link && typeof item.link === 'object') {
      const link = z.object({ kind: z.enum(['file', 'folder']), name: z.string().max(255), fingerprint: z.object({ size: z.number().optional(), sha256: z.string().regex(/^[0-9a-f]{64}$/).nullable().optional(), entries: z.number().optional(), hashKind: z.string().max(20).optional() }).passthrough().optional(),
        versions: z.array(z.object({ number: z.number().int(), sha256: z.string().regex(/^[0-9a-f]{64}$/).nullable().optional(), size: z.number().optional(), verifiedAt: timestamp.optional() })).max(100).optional(), verifiedAt: timestamp.optional() }).safeParse(item.link);
      if (link.success) fields.link = { kind: link.data.kind, name: link.data.name.split(/[\\/]/).pop(), fingerprint: { size: link.data.fingerprint?.size ?? null, sha256: link.data.fingerprint?.sha256 ?? null, ...(link.data.fingerprint?.hashKind && { hashKind: link.data.fingerprint.hashKind }) },
        versions: (link.data.versions ?? []).map(entry => ({ number: entry.number, sha256: entry.sha256 ?? null, size: entry.size ?? null, verifiedAt: entry.verifiedAt ?? null })), status: 'unlinked', verifiedAt: link.data.verifiedAt ?? null };
      // Duplicating a workspace in this profile keeps the person's local link; imports from files never do.
      if (link.success && keepLocalPaths && typeof item.link.path === 'string' && isAbsolute(item.link.path)) Object.assign(fields.link, { path: item.link.path, fingerprint: structuredClone(item.link.fingerprint), status: item.link.status ?? 'available', checkedAt: item.link.checkedAt ?? null });
      else loss('materials', 'link', 'malformed link metadata dropped');
    }
    if (item.service && typeof item.service === 'object') {
      const service = z.object({ adapter: z.enum(['http']), url: z.string().max(16384), versions: z.array(z.object({ id: z.string().max(128).optional(), number: z.number().int(), fetchedAt: timestamp.optional(), sha256: z.string().regex(/^[0-9a-f]{64}$/), size: z.number().optional(),
        contentType: z.string().max(200).optional(), etag: z.string().max(500).nullable().optional(), lastModified: z.string().max(100).nullable().optional() })).max(20).optional(), lastRefreshAt: timestamp.nullable().optional() }).safeParse(item.service);
      if (service.success) fields.service = { adapter: service.data.adapter, url: service.data.url, credentialState: 'none', access: 'none', autoRefresh: false, lastRefreshAt: service.data.lastRefreshAt ?? null,
        versions: (service.data.versions ?? []).map(entry => ({ ...entry, id: entry.id && mapping.get(entry.id) ? mapping.get(entry.id) : `svcv_${randomUUID()}`, cached: false })) };
      else loss('materials', 'service', 'malformed service reference dropped');
    }
  }
  return fields;
}

/** Shared collections are exported without participating workspaces: grants are authority and never travel with data. */
export function exportCollections(data, workspaceId) {
  return (data.sharedCollections ?? []).filter(item => item.workspaceId === workspaceId).map(({ members, ...rest }) => ({ ...structuredClone(rest), members: [], membersOmitted: (members ?? []).filter(active).length }));
}
export function importCollections(items, { workspaceId, mapping, actor, loss }) {
  if (items === undefined) return [];
  if (!Array.isArray(items) || items.length > 1000) throw new Error('Invalid imported shared collections');
  const schema = z.object({ id: z.string().max(128), name: z.string().min(1).max(240), description: z.string().max(2000).default(''), items: z.array(z.object({ type: z.enum(SHAREABLE), id: z.string().max(128), addedBy: z.string().max(200).optional(), addedAt: timestamp.optional() })).max(10000).default([]),
    membersOmitted: z.number().int().optional(), createdBy: z.string().max(200).optional(), createdAt: timestamp.optional() });
  return items.map(raw => {
    const item = schema.parse(raw);
    if (item.membersOmitted) loss('sharedCollections', 'members', 'participating workspaces and roles are authority and are not imported; grant access again', item.membersOmitted);
    const entries = item.items.filter(entry => { if (mapping.has(entry.id)) return true; loss('sharedCollections', 'items', 'collection item not in export; dropped'); return false; })
      .map(entry => ({ ...entry, id: mapping.get(entry.id) }));
    const now = new Date().toISOString();
    return { id: mapping.get(item.id), workspaceId, name: item.name, description: item.description, members: [], items: entries, sessionSharing: 'separate', createdBy: `${actor} (import)`,
      createdAt: item.createdAt ?? now, updatedAt: now, revision: 1, history: [{ revision: 1, actor, at: now, change: 'Imported without participating workspaces' }] };
  });
}
export function importConflicts(items, { workspaceId, mapping, actor, loss }) {
  if (items === undefined) return [];
  if (!Array.isArray(items) || items.length > 10000) throw new Error('Invalid imported conflicts');
  const schema = z.object({ id: z.string().max(128), kind: z.enum(['contradiction', 'edit', 'source_changed']), status: z.enum(['open', 'resolved']), note: z.string().max(4000).default(''),
    subjects: z.array(z.object({ collection: z.enum(['context', 'materials']), id: z.string().max(128), revision: z.number().int().positive().optional() })).min(1).max(10),
    proposed: z.object({ subjectId: z.string().max(128), changes: z.object({ title: z.string().max(240).optional(), content: z.string().max(500000).optional() }) }).optional(),
    evidence: z.record(z.string().max(100), z.unknown()).optional(), resolution: z.object({ decision: z.string().max(30), chosenId: z.string().max(128).nullable().optional(), mergedRecordId: z.string().max(128).nullable().optional(), note: z.string().max(4000).optional(), at: timestamp.optional() }).passthrough().optional(),
    createdAt: timestamp.optional(), revision: z.number().int().optional() });
  return items.map(raw => {
    const item = schema.parse(raw);
    const subjects = item.subjects.filter(subject => mapping.has(subject.id)).map(subject => ({ ...subject, id: mapping.get(subject.id) }));
    if (subjects.length !== item.subjects.length) loss('conflicts', 'subjects', 'conflict subject not in export; reference removed');
    const now = new Date().toISOString();
    const resolution = item.resolution ? { decision: item.resolution.decision, chosenId: item.resolution.chosenId === 'proposed' ? 'proposed' : remapOr(mapping, item.resolution.chosenId), mergedRecordId: remapOr(mapping, item.resolution.mergedRecordId),
      note: item.resolution.note ?? '', at: item.resolution.at ?? null, origin: importedOrigin(item.resolution.origin, actor, mapping) } : undefined;
    return { id: mapping.get(item.id), workspaceId, kind: item.kind, status: subjects.length ? item.status : 'resolved', note: item.note, subjects, ...(item.proposed && mapping.has(item.proposed.subjectId) && { proposed: { subjectId: mapping.get(item.proposed.subjectId), changes: item.proposed.changes } }),
      ...(item.evidence && { evidence: JSON.stringify(item.evidence).length <= 100000 ? structuredClone(item.evidence) : { omitted: 'evidence exceeded 100 KB' } }), ...(resolution && { resolution }),
      origin: importedOrigin(raw.origin, actor, mapping), createdAt: item.createdAt ?? now, updatedAt: now, revision: item.revision ?? 1 };
  });
}
