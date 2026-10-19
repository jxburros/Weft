/**
 * Workspace export, packages, import with citation remapping, and verified backups and restores (ADR 011).
 * WorkspaceService methods moved verbatim from src/workspace.js (#119) and installed on WorkspaceService.prototype there, so
 * `this` is the service and every method keeps its name.
 */
import { CURRENT_SCHEMA_VERSION, migrateSchema } from './migrations.js';
import { DETECTION_SCOPE, reviewText, reviewUrl } from './redaction.js';
import { RECOVERY_DIR, canonicalJson } from './store.js';
import { appendTimeline } from './task-phases.js';
import { archiveManifest } from './archive.js';
import { componentPath } from './components.js';
import { createBackup, deleteBackup, listBackups, pruneBackups, recoverInterruptedRestore, restoreBackup, verifyBackup } from './backups.js';
import { existsSync, lstatSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { exportCollections, exportMaterial, importCollections, importConflicts, importContextFields, linkedOmissions, recheckCitations } from './context-records.js';
import { importHandoffs } from './handoffs.js';
import { importedOrigin } from './provenance.js';
import { inspectExportResidue, rejectSecretKeys } from './export-safety.js';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { recordShapes, workspaceSchemas } from './workspace-commands.js';
import { serialize } from './helpers.js';
import { syncDirectory } from './storage-safety.js';
import { z } from 'zod';
import { EXPORT_EXCLUDED, ID_TOKEN, KNOWLEDGE_COLLECTIONS, MAX_FILE, MAX_PACKAGE_RECORDS_FILE, NOT_EXPORTED, PLAINTEXT_EXPORT, PNG, SYSTEM_FIELDS, TRANSFERS_DIR, annotationSchema, artifactSchema, cleanExport, clone, collections, componentRef, createWorkspace, digest, fail, fsyncFile, historyEntry, messageSchema, now, packageManifest, ruleRevisionSchema, sanitizeUrl, timestamp, uuid, versionSchema } from './workspace-support.js';

export const workspaceTransferMethods = {
  // ---- Export and import -------------------------------------------------------------
  /** Exports leave the encrypted store as plaintext: only after a person confirms, never silently. */
  assertPlaintextExport(args) {
    if (this.storage.encrypted && args.acknowledgePlaintext !== true) {
      throw fail('invalid_arguments', 'ENCRYPTED_EXPORT: This profile is encrypted at rest, but exports are plaintext. Pass acknowledgePlaintext: true after the person confirms the warning.', { field: 'acknowledgePlaintext', notStarted: true });
    }
  },
  /**
   * Format 2 exports keep revisions, revision history, conversations, turn
   * manifests, exact artifact versions with component hashes and annotations,
   * site-rule provenance (creator, revision history, review state) and handoff
   * history.
   * `package` mode references components by digest instead of inlining them.
   */
  exportWorkspace(id, sensitiveTerms, { mode = 'inline', keepLocalPaths = false, captures = 'exclude-restricted', reviewMetadata = false } = {}) {
    const record = this.workspace(id);
    const excludedContent = [];
    // Capture policy: restricted originals stay out unless a person chooses 'all'; 'derivatives-only' keeps sanitized derivatives alone.
    const exportable = (name, item) => {
      if (name !== 'artifacts') return item;
      const versions = item.versions.filter(version => {
        const reason = captures !== 'all' && version.access === 'restricted' ? 'restricted original'
          : captures === 'derivatives-only' && !version.derivedFrom ? 'not a sanitized derivative' : null;
        if (reason) excludedContent.push({ collection: 'artifacts', id: item.id, versionId: version.id, number: version.number, reason });
        return !reason;
      });
      if (!versions.length) { excludedContent.push({ collection: 'artifacts', id: item.id, reason: 'no exportable versions under this capture policy' }); return null; }
      return versions.length === item.versions.length ? item : { ...item, versions };
    };
    const plain = (name, item) => {
      const copy = mode === 'inline' ? this.output(item) : JSON.parse(this.storage.serialize(name, item, { write: false }).doc);
      return name === 'materials' ? exportMaterial(copy, { keepLocalPaths }) : copy;
    };
    const notExported = Object.entries(this.data).filter(([key, value]) => !collections.includes(key) && !['workspaces', 'activity', 'history', 'handoffs', ...KNOWLEDGE_COLLECTIONS].includes(key) && !NOT_EXPORTED.has(key) && Array.isArray(value) && value.some(item => item?.workspaceId === id)).map(([key, value]) => `${key} (${value.filter(item => item?.workspaceId === id).length} records not supported by this export format)`);
    const exported = cleanExport({ format: 'weft-workspace', schemaVersion: CURRENT_SCHEMA_VERSION, formatVersion: 2, exportedAt: now(), workspace: clone(record),
      ...Object.fromEntries(collections.map(name => [name, this.data[name].filter(item => item.workspaceId === id && !(name === 'siteRules' && item.scope === 'global')).map(item => exportable(name, item)).filter(Boolean).map(item => plain(name, item))])),
      handoffs: (this.data.handoffs ?? []).filter(item => item.workspaceId === id).map(item => clone(item)),
      sharedCollections: exportCollections(this.data, id),
      conflicts: (this.data.conflicts ?? []).filter(item => item.workspaceId === id).map(item => clone(item)),
      linkedContentOmitted: linkedOmissions(this.data.materials.filter(item => item.workspaceId === id)),
      excluded: [...EXPORT_EXCLUDED, ...notExported, ...(excludedContent.length ? [`${excludedContent.length} capture versions or artifacts left out by the capture policy (${captures}); see excludedContent`] : [])],
      capturePolicy: captures, excludedContent,
      limitations: ['Browser sessions, cookies, credentials, provider keys, and global policies are excluded. Imported site rules and workflows remain inactive until reviewed and enabled.', 'Free-form content and screenshots can contain personal information. Review the export before sharing.',
        'Sanitized derivatives remove only the spans and regions a reviewer selected; record titles, notes, tags and annotations are exported as written.', ...(this.storage.encrypted ? [PLAINTEXT_EXPORT] : [])] });
    exported.linkedSourcesNotIncluded = this.linkedSources(exported);
    if (reviewMetadata) exported.metadataReview = this.reviewExport(exported);
    if (sensitiveTerms !== undefined) exported.residueScan = inspectExportResidue(JSON.stringify(mode === 'inline' ? exported : this.exportWorkspace(id, undefined, { captures }), null, 2), sensitiveTerms);
    return exported;
  },
  /** Web pages, linked files, services and cited URLs referenced by exported records but not included as content. */
  linkedSources(exported) {
    const items = [];
    for (const record of exported.materials || []) if (['website', 'linked-file', 'service'].includes(record.kind)) items.push({ collection: 'materials', id: record.id, kind: record.kind, ...(record.url ? { url: record.url } : {}), ...(record.filename ? { filename: record.filename } : {}) });
    for (const record of exported.context || []) for (const source of record.sources || []) if (/^https?:/i.test(source)) items.push({ collection: 'context', id: record.id, kind: 'source', url: source });
    for (const record of exported.artifacts || []) for (const version of record.versions || []) if (version.url) items.push({ collection: 'artifacts', id: record.id, versionId: version.id, kind: 'live page', url: version.url });
    return { count: items.length, items: items.slice(0, 1000), note: 'These records cite live pages, files or services. Only the saved records travel with the export; the linked sources themselves are not included and may have changed.' };
  },
  /** Export metadata review: URL query/path findings and detection-assistance matches in exported text fields (masked). */
  reviewExport(exported) {
    const findings = [];
    const visit = (value, path, key = '') => {
      if (findings.length >= 1000) return;
      if (Array.isArray(value)) { value.forEach((item, index) => visit(item, `${path}.${index}`)); return; }
      if (value && typeof value === 'object') { for (const [name, item] of Object.entries(value)) if (!/Base64$/.test(name) && name !== '$component' && !['excluded', 'limitations', 'excludedContent', 'linkedSourcesNotIncluded'].includes(name)) visit(item, `${path}.${name}`, name); return; }
      if (typeof value !== 'string' || !value) return;
      if (/url|endpoint|source/i.test(key) || /^https?:\/\//i.test(value)) findings.push(...reviewUrl(value, path).filter(item => item.kind !== 'unparseable-url'));
      else if (!['id', 'workspaceId', 'sha256', 'createdAt', 'updatedAt'].includes(key)) findings.push(...reviewText(value, path));
    };
    visit(exported, '$');
    return { findings: findings.slice(0, 1000), truncated: findings.length >= 1000, scope: DETECTION_SCOPE };
  },
  transferPath(name) {
    if (typeof name !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/.test(name) || name.includes('..')) throw fail('invalid_arguments', 'Invalid package name');
    return join(this.directory, TRANSFERS_DIR, name);
  },
  /** Large-project transfer: a folder of verified component files plus a manifest, beyond REST/JSON size limits. */
  exportPackage(id, name, sensitiveTerms, { captures } = {}) {
    const target = this.transferPath(name);
    if (existsSync(target)) throw fail('invalid_arguments', 'A package with this name already exists; existing packages are never overwritten');
    const exported = this.exportWorkspace(id, undefined, { mode: 'package', captures });
    const markers = new Map();
    const collect = value => {
      if (Array.isArray(value)) value.forEach(collect);
      else if (value && typeof value === 'object') { if (componentRef.safeParse(value).success) markers.set(value.$component.sha256, value.$component.size); else Object.values(value).forEach(collect); }
    };
    collect(exported);
    const root = join(this.directory, TRANSFERS_DIR);
    mkdirSync(root, { recursive: true, mode: 0o700 });
    const temp = join(root, `.tmp-${randomUUID()}`);
    mkdirSync(temp, { mode: 0o700 });
    try {
      const files = [];
      for (const [hash, size] of markers) { this.storage.components.exportTo(hash, join(temp, 'components'), size); files.push({ path: `components/${hash.slice(0, 2)}/${hash}`, size, sha256: hash }); }
      const records = JSON.stringify(exported, null, 2);
      writeFileSync(join(temp, 'workspace.json'), records, { flag: 'wx', mode: 0o600 });
      fsyncFile(join(temp, 'workspace.json'));
      files.unshift({ path: 'workspace.json', size: Buffer.byteLength(records), sha256: digest(records) });
      const manifest = { format: 'weft-package', formatVersion: 1, createdAt: now(), workspace: { name: exported.workspace.name }, files };
      writeFileSync(join(temp, 'manifest.json'), JSON.stringify(manifest, null, 2), { flag: 'wx', mode: 0o600 });
      fsyncFile(join(temp, 'manifest.json'));
      renameSync(temp, target);
      syncDirectory(root);
      const result = { name, path: target, formatVersion: 1, files: files.length, bytes: files.reduce((sum, file) => sum + file.size, 0), excluded: exported.excluded, capturePolicy: exported.capturePolicy, excludedContent: exported.excludedContent,
        linkedSourcesNotIncluded: exported.linkedSourcesNotIncluded, limitations: exported.limitations, ...(this.storage.encrypted && { plaintext: true, warning: PLAINTEXT_EXPORT }) };
      if (sensitiveTerms !== undefined) result.residueScan = inspectExportResidue(JSON.stringify(this.exportWorkspace(id, undefined, { captures }), null, 2), sensitiveTerms);
      return result;
    } catch (error) { rmSync(temp, { recursive: true, force: true }); throw error; }
  },
  importPackage(name, actor) {
    const folder = this.transferPath(name);
    const regular = (path, limit) => {
      const stat = lstatSync(path, { throwIfNoEntry: false });
      if (!stat || stat.isSymbolicLink() || !stat.isFile()) throw fail('invalid_arguments', 'PACKAGE_INVALID: package entries must be regular files, not links');
      if (stat.size > limit) throw fail('request_too_large', 'PACKAGE_INVALID: package file exceeds its size limit');
      return stat;
    };
    const folderStat = lstatSync(folder, { throwIfNoEntry: false });
    if (!folderStat) throw fail('not_found', 'Package not found in the profile transfers folder');
    if (folderStat.isSymbolicLink() || !folderStat.isDirectory()) throw fail('invalid_arguments', 'PACKAGE_INVALID: package must be a folder, not a link');
    regular(join(folder, 'manifest.json'), 64 * 1024 * 1024);
    let manifest;
    try { manifest = packageManifest.parse(JSON.parse(readFileSync(join(folder, 'manifest.json'), 'utf8'))); }
    catch { throw fail('invalid_arguments', 'PACKAGE_INVALID: manifest is unreadable or unsupported'); }
    const files = new Map();
    for (const file of manifest.files) {
      const match = /^components\/([0-9a-f]{2})\/([0-9a-f]{64})$/.exec(file.path);
      if ((file.path !== 'workspace.json' && !match) || (match && (match[2] !== file.sha256 || !match[2].startsWith(match[1]))) || files.has(file.path)) throw fail('invalid_arguments', 'PACKAGE_INVALID: manifest lists a malformed or duplicate path');
      files.set(file.path, file);
    }
    const recordsEntry = files.get('workspace.json');
    if (!recordsEntry) throw fail('invalid_arguments', 'PACKAGE_INVALID: manifest does not list workspace.json');
    regular(join(folder, 'workspace.json'), MAX_PACKAGE_RECORDS_FILE);
    const records = readFileSync(join(folder, 'workspace.json'));
    if (records.length !== recordsEntry.size || digest(records) !== recordsEntry.sha256) throw fail('component_integrity', 'COMPONENT_INTEGRITY: package workspace.json failed SHA-256 verification');
    let data;
    try { data = JSON.parse(records.toString('utf8')); } catch { throw fail('invalid_arguments', 'PACKAGE_INVALID: workspace.json is not valid JSON'); }
    const resolver = { read: marker => {
      const entry = files.get(`components/${marker.sha256.slice(0, 2)}/${marker.sha256}`);
      if (!entry || entry.size !== marker.size) throw fail('invalid_arguments', 'PACKAGE_INVALID: a record references a component the manifest does not list');
      const path = componentPath(join(folder, 'components'), marker.sha256);
      regular(path, 64 * 1024 * 1024);
      const bytes = readFileSync(path);
      if (bytes.length !== entry.size || digest(bytes) !== entry.sha256) throw fail('component_integrity', `COMPONENT_INTEGRITY: package component ${marker.sha256.slice(0, 12)} failed SHA-256 verification`);
      return bytes;
    } };
    return this.importWorkspace(data, actor, true, { resolver, maxBytes: MAX_PACKAGE_RECORDS_FILE });
  },
  /**
   * Import format 1 or 2 as a new workspace with new IDs. Structured references
   * are remapped and must resolve; free-form citations of exported IDs are
   * rewritten. Every lossy mapping is reported. Policies/workflows stay inactive.
   */
  importWorkspace(input, actor, activate = true, { resolver = null, maxBytes = MAX_FILE, keepLocalPaths = false } = {}) {
    let raw = input;
    if (typeof input === 'string') { if (Buffer.byteLength(input) > MAX_FILE) throw new Error('Import exceeds 100 MiB'); raw = JSON.parse(input); }
    if (!raw || typeof raw !== 'object' || raw.format !== 'weft-workspace' || !raw.workspace) throw new Error('Expected a versioned Weft workspace export');
    if (Buffer.byteLength(JSON.stringify(raw)) > maxBytes) throw new Error(`Import exceeds ${Math.round(maxBytes / 1024 / 1024)} MiB; use a package import for larger projects`);
    rejectSecretKeys(raw);
    const formatVersion = raw.formatVersion ?? 1;
    if (!Number.isSafeInteger(formatVersion) || formatVersion < 1 || formatVersion > 2) throw new Error('Unsupported workspace export format; it may be from a newer Weft version');
    raw = migrateSchema(raw, { kind: 'export' });
    const lossy = new Map();
    const loss = (collection, field, reason, count = 1) => { const key = `${collection}\u0000${field}\u0000${reason}`; const item = lossy.get(key) || { collection, field, reason, count: 0 }; item.count += count; lossy.set(key, item); };
    const nested = (collection, field, schema, items) => { for (const entry of Array.isArray(items) ? items : []) if (entry && typeof entry === 'object') for (const key of Object.keys(entry)) if (!Object.hasOwn(schema.shape, key)) loss(collection, `${field}.${key}`, 'nested field not supported by import; dropped'); };
    const workspaceFields = workspaceSchemas['workspaces.create'].parse({ name: raw.workspace.name, description: raw.workspace.description, color: raw.workspace.color, icon: raw.workspace.icon, memory: [raw.workspace.memory, raw.workspace.instructions ? `Imported instructions (review before use):\n${raw.workspace.instructions}` : ''].filter(Boolean).join('\n\n').slice(0, 50000), workspaceType: raw.workspace.workspaceType, dueDate: raw.workspace.dueDate, contextLocalOnly: raw.workspace.contextLocalOnly });
    const workspace = { ...createWorkspace(), ...workspaceFields, importedFrom: { exportedAt: typeof raw.exportedAt === 'string' ? raw.exportedAt.slice(0, 100) : null, createdAt: timestamp.safeParse(raw.workspace.createdAt).success ? raw.workspace.createdAt ?? null : null, formatVersion } };
    const mapping = new Map([[raw.workspace.id, workspace.id]]);
    const knownKeys = new Set(['format', 'schemaVersion', 'formatVersion', 'exportedAt', 'workspace', 'limitations', 'excluded', 'residueScan', 'handoffs', 'sharedCollections', 'conflicts', 'linkedContentOmitted',
      'capturePolicy', 'excludedContent', 'linkedSourcesNotIncluded', 'metadataReview', ...collections]);
    for (const [key, value] of Object.entries(raw)) if (!knownKeys.has(key)) loss('export', key, Array.isArray(value) ? 'collection not supported by this Weft version; not imported' : 'unrecognized export field ignored', Array.isArray(value) ? value.length : 1);
    // First pass: allocate every new identifier so references resolve in any order.
    for (const collection of collections) {
      if (raw[collection] !== undefined && !Array.isArray(raw[collection])) throw new Error(`Invalid ${collection} collection`);
      if ((raw[collection]?.length || 0) > 10000) throw new Error('Import collection exceeds 10,000 records');
      for (const item of raw[collection] || []) {
        if (!item || typeof item !== 'object' || typeof item.id !== 'string') throw new Error('Invalid imported record');
        if (mapping.has(item.id)) throw new Error('Duplicate imported record ID');
        mapping.set(item.id, uuid(collection === 'artifacts' ? 'artifact' : collection.slice(0, 4)));
        if (collection === 'artifacts') for (const version of Array.isArray(item.versions) ? item.versions : []) if (typeof version?.id === 'string' && !mapping.has(version.id)) mapping.set(version.id, uuid('version'));
        if (collection === 'conversations') for (const message of Array.isArray(item.messages) ? item.messages : []) if (typeof message?.id === 'string' && !mapping.has(message.id)) mapping.set(message.id, uuid('msg'));
      }
    }
    for (const [key, prefix] of [['sharedCollections', 'coll'], ['conflicts', 'conflict']]) {
      if (raw[key] !== undefined && !Array.isArray(raw[key])) throw new Error(`Invalid ${key} collection`);
      for (const item of raw[key] || []) {
        if (!item || typeof item !== 'object' || typeof item.id !== 'string') throw new Error(`Invalid imported ${key} record`);
        if (mapping.has(item.id)) throw new Error('Duplicate imported record ID');
        mapping.set(item.id, uuid(prefix));
      }
    }
    if (raw.handoffs !== undefined && !Array.isArray(raw.handoffs)) throw new Error('Invalid handoffs collection');
    for (const item of raw.handoffs || []) {
      if (!item || typeof item !== 'object' || typeof item.id !== 'string') throw new Error('Invalid imported handoff');
      if (mapping.has(item.id)) throw new Error('Duplicate imported record ID');
      mapping.set(item.id, uuid('handoff'));
    }
    const heavy = (value, encoding) => {
      if (typeof value === 'string') return { inline: value };
      if (!resolver) throw new Error('Component references require a package import');
      const marker = value.$component;
      if (marker.encoding !== encoding) throw new Error('Imported component has the wrong encoding');
      const bytes = resolver.read(marker);
      return { bytes, marker };
    };
    const lazy = (object, key, ref) => { this.storage.putComponent(ref.bytes); this.storage.defineLazy(object, key, ref.marker); };
    const imported = {};
    const stats = { structuredReferences: 0, freeFormCitations: 0, unresolvedCitations: new Set(), versions: 0, revisions: 0 };
    for (const collection of collections) {
      imported[collection] = (raw[collection] || []).map(item => {
        const system = [...SYSTEM_FIELDS.common, ...(SYSTEM_FIELDS[collection] || [])];
        const shape = collection === 'artifacts' ? null : recordShapes[collection];
        for (const key of Object.keys(item)) if (!system.includes(key) && !(shape ? Object.hasOwn(shape, key) : ['title', 'note', 'tags'].includes(key))) loss(collection, key, 'field not supported by import; dropped');
        let fields;
        const deferred = [];
        if (collection === 'artifacts') { nested(collection, 'annotations', annotationSchema, item.annotations); fields = this.importArtifact(item, { heavy, lazy, deferred, mapping, loss, stats }); }
        else {
          // Provenance and citations are system-derived: they are remapped below, never parsed as caller input.
          const picked = Object.fromEntries(Object.keys(shape).filter(key => item[key] !== undefined && !['origin', 'citations'].includes(key)).map(key => [key, item[key]]));
          let fileRef = null;
          if (collection === 'materials' && picked.fileBase64 && typeof picked.fileBase64 === 'object') {
            fileRef = heavy(componentRef.parse(picked.fileBase64), 'base64');
            delete picked.fileBase64;
          }
          if (collection === 'tasks' && picked.status === 'waiting') picked.status = 'waiting_on_human';
          fields = z.strictObject(shape).parse(picked);
          if (collection === 'tasks') this.importTaskState(item, fields, actor, loss);
          if (collection === 'memories') fields.scope = 'workspace';
          if (collection === 'siteRules') {
            if (fields.enabled || fields.scope !== 'workspace') loss(collection, 'enabled/scope', 'imported site rules are workspace-scoped and disabled until reviewed');
            fields.scope = 'workspace'; fields.enabled = false; this.validateRule(fields);
            if (item.provenance) loss(collection, 'provenance', 'community-list provenance is not imported; reinstall the list to track it');
            // Rule provenance: keep the creator, revision history and review state, then record the import as a revision.
            const revisions = item.revisions === undefined ? [] : z.array(ruleRevisionSchema).max(50).parse(item.revisions);
            const revision = Number.isSafeInteger(item.revision) && item.revision >= 1 ? item.revision : 1;
            fields.createdBy = typeof item.createdBy === 'string' ? item.createdBy.slice(0, 200) : `${actor} (import)`;
            if (item.lastReviewedAt !== undefined) { fields.lastReviewedAt = timestamp.parse(item.lastReviewedAt); fields.lastReviewedBy = z.string().max(200).parse(item.lastReviewedBy ?? 'unknown'); }
            fields.revisions = [...revisions, { revision, actor, at: now(), summary: 'Imported inactive for review', changed: ['enabled', 'scope'] }].slice(-50);
            stats.revisions += revisions.length;
          }
          if (collection === 'workflows') { if (fields.enabled) loss(collection, 'enabled', 'imported workflows are disabled until reviewed'); fields.enabled = false; }
          if (collection === 'materials') {
            if (fileRef) {
              if (fileRef.bytes.length > 10 * 1024 * 1024) throw new Error('Stored materials are limited to 10 MiB');
              fields.size = fileRef.bytes.length; fields.sha256 = fileRef.marker.sha256;
              fields.filename = String(fields.filename || 'file').split(/[\\/]/).pop();
              deferred.push(record => lazy(record, 'fileBase64', fileRef));
            } else this.validateMaterial(fields);
            if (typeof item.sha256 === 'string' && fields.sha256 && item.sha256 !== fields.sha256) throw fail('component_integrity', 'COMPONENT_INTEGRITY: imported material file does not match its recorded SHA-256');
          }
          if (collection === 'conversations') {
            nested(collection, 'messages', messageSchema, item.messages);
            fields.messages = z.array(messageSchema).max(10000).parse(item.messages || []).map(message => ({ ...message, id: mapping.get(message.id) || uuid('msg') }));
            if (item.turnManifests !== undefined) {
              const manifests = z.array(z.record(z.string(), z.unknown())).max(1000).parse(item.turnManifests);
              if (Buffer.byteLength(JSON.stringify(manifests)) > 5 * 1024 * 1024) throw new Error('Imported turn manifests exceed 5 MiB');
              fields.turnManifests = manifests;
            }
          }
          if (['materials', 'context'].includes(collection)) {
            Object.assign(fields, importContextFields(item, collection, { mapping, actor, loss, keepLocalPaths }));
            fields.origin ??= importedOrigin(null, actor, mapping);
            if (item.history !== undefined) { nested(collection, 'history', historyEntry, item.history); fields.history = z.array(historyEntry).max(10000).parse(item.history).map(entry => ({ revision: entry.revision, content: entry.content, actor: entry.actor, createdAt: entry.createdAt, ...(entry.origin !== undefined && { origin: importedOrigin(entry.origin, actor, mapping) }) })); stats.revisions += fields.history.length; }
            else { loss(collection, 'history', 'revision history absent in source; started a new history'); fields.history = [{ revision: 1, content: fields.content, actor, createdAt: now() }]; }
          }
        }
        const record = { id: mapping.get(item.id), workspaceId: workspace.id, ...fields,
          createdAt: timestamp.safeParse(item.createdAt).success && item.createdAt ? item.createdAt : now(), updatedAt: timestamp.safeParse(item.updatedAt).success && item.updatedAt ? item.updatedAt : now(),
          revision: Number.isSafeInteger(item.revision) && item.revision >= 1 ? item.revision : 1 };
        for (const apply of deferred) apply(record);
        return record;
      });
    }
    // Structured references must resolve inside the export; free-form citations are rewritten.
    const remap = (collection, field, id) => { if (!mapping.has(id)) throw new Error(`Invalid imported record reference in ${collection}.${field}`); stats.structuredReferences++; return mapping.get(id); };
    for (const [collection, records] of Object.entries(imported)) for (const record of records) {
      for (const key of ['evidence', 'materialIds', 'outputs']) if (Array.isArray(record[key])) record[key] = record[key].map(id => remap(collection, key, id));
      if (collection === 'conversations') for (const message of record.messages) if (Array.isArray(message.attachments)) message.attachments = message.attachments.map(id => remap(collection, 'messages.attachments', id));
      this.rewriteCitations(record, mapping, stats);
    }
    const handoffs = importHandoffs(raw.handoffs, { workspaceId: workspace.id, mapping, actor, loss });
    for (const record of handoffs) this.rewriteCitations(record, mapping, stats);
    const sharedCollections = importCollections(raw.sharedCollections, { workspaceId: workspace.id, mapping, actor, loss });
    const conflicts = importConflicts(raw.conflicts, { workspaceId: workspace.id, mapping, actor, loss });
    if (stats.unresolvedCitations.size) loss('all', 'free-form citations', 'identifiers not present in the export were left unchanged and do not resolve in the new workspace', stats.unresolvedCitations.size);
    this.data.workspaces.push(workspace);
    for (const collection of collections) this.data[collection].push(...imported[collection]);
    this.data.handoffs = [...(this.data.handoffs ?? []), ...handoffs];
    this.data.sharedCollections.push(...sharedCollections);
    this.data.conflicts.push(...conflicts);
    // Imported citation statuses are recomputed against the imported versions; nothing is taken on trust.
    let citations = 0;
    for (const record of imported.context) if (record.citations?.length) {
      const unresolved = new Set(record.citations.filter(item => item.reason === 'not_in_export').map(item => item.id));
      record.citations = recheckCitations(this.data, workspace.id, record).citations.map(item => unresolved.has(item.id) ? { ...item, status: 'unverified', reason: 'not_in_export' } : item);
      citations += record.citations.length;
    }
    if (activate) this.data.activeWorkspaceId = workspace.id;
    if (formatVersion === 1) loss('export', 'formatVersion', 'format 1 export: fields absent from the older format were initialized');
    const linked = [];
    for (const record of imported.materials) if (['website', 'linked-file', 'linked-folder', 'service'].includes(record.kind) || record.link || record.service) linked.push({ collection: 'materials', id: record.id, kind: record.kind, title: record.title, ...(record.url ? { url: record.url } : {}), ...(record.filename ? { filename: record.filename } : {}) });
    for (const record of imported.context) for (const source of record.sources || []) if (/^https?:/i.test(source)) linked.push({ collection: 'context', id: record.id, kind: 'source', url: source });
    for (const record of imported.artifacts) for (const version of record.versions) if (version.url) linked.push({ collection: 'artifacts', id: record.id, versionId: version.id, kind: 'live page', url: version.url });
    const report = {
      formatVersion, sourceSchemaVersion: raw.schemaVersion, newIds: true,
      records: { ...Object.fromEntries(collections.map(name => [name, imported[name].length])), handoffs: handoffs.length, sharedCollections: sharedCollections.length, conflicts: conflicts.length }, artifactVersions: stats.versions, revisionHistoryEntries: stats.revisions, citations,
      remapped: { identifiers: mapping.size, structuredReferences: stats.structuredReferences, freeFormCitations: stats.freeFormCitations },
      lossy: [...lossy.values()],
      excluded: [...new Set([...EXPORT_EXCLUDED, ...(Array.isArray(raw.excluded) ? raw.excluded.filter(item => typeof item === 'string').map(item => item.slice(0, 300)).slice(0, 100) : [])])],
      linkedSourcesNotIncluded: { count: linked.length, items: linked.slice(0, 1000) },
      policies: {
        siteRules: imported.siteRules.map(rule => ({ id: rule.id, hostname: rule.hostname, path: rule.path, includeSubdomains: rule.includeSubdomains, behavior: rule.behavior, mode: rule.mode, reason: rule.reason, enabled: false })),
        workflows: imported.workflows.map(workflow => ({ id: workflow.id, title: workflow.title, steps: workflow.steps.length, allowedSites: workflow.allowedSites, parameters: workflow.parameters, enabled: false })),
        activation: 'Imported site rules and workflows are inactive until a human reviews and enables them.',
      },
    };
    this.log('workspaces.import', workspace.id, workspace.id, actor, `Imported format ${formatVersion} with new IDs; ${report.lossy.length} lossy mapping types reported; policies and workflows inactive; no sessions or credentials imported`);
    return { workspace, report };
  },
  /** Imported tasks keep their timeline as history but never their executor, run state or operations: they never resume on their own. */
  importTaskState(item, fields, actor, loss) {
    const timeline = z.array(z.record(z.string().max(100), z.unknown())).max(500).safeParse(item.timeline ?? []);
    fields.timeline = timeline.success ? timeline.data.map(entry => JSON.parse(JSON.stringify(entry, (key, value) => typeof value === 'string' ? value.slice(0, 2000) : value))) : [];
    if (!timeline.success) loss('tasks', 'timeline', 'invalid task timeline dropped');
    if (item.executor || item.run) loss('tasks', 'executor/run', 'task runtime bindings and run state are not imported; a person starts imported tasks again');
    if (Array.isArray(item.operations) && item.operations.length) loss('tasks', 'operations', 'operation records are local execution evidence and are not imported', item.operations.length);
    if (['running', 'waiting_on_human', 'uncertain'].includes(fields.status) && (item.executor || item.run || fields.status === 'uncertain')) {
      loss('tasks', 'status', `imported ${fields.status} runtime task paused for review`);
      appendTimeline(fields, { type: 'transition', from: fields.status, to: 'paused', actor, reason: 'imported', note: 'Imported tasks never resume execution automatically.', at: now() });
      fields.status = 'paused';
    }
  },
  importArtifact(item, { heavy, lazy, deferred, mapping, loss, stats }) {
    const fields = artifactSchema.parse(item);
    fields.annotations = fields.annotations.map(annotation => ({ note: annotation.note, ...(annotation.tags ? { tags: annotation.tags } : {}), revision: annotation.revision ?? 1, actor: annotation.actor ?? 'human', createdAt: annotation.createdAt ?? now() }));
    const versionKeys = new Set(Object.keys(versionSchema.shape));
    fields.versions = fields.versions.map((version, index) => {
      const original = item.versions[index];
      for (const key of Object.keys(original)) if (!versionKeys.has(key)) loss('artifacts', `versions.${key}`, 'version field not supported by import; dropped');
      const components = [];
      let text; let png;
      if (version.text !== undefined) {
        text = heavy(version.text, 'utf8');
        if (text.bytes) {
          try { text.value = new TextDecoder('utf-8', { fatal: true }).decode(text.bytes); } catch { throw fail('component_integrity', 'COMPONENT_INTEGRITY: imported text component is not valid UTF-8'); }
          if (text.value.length > 2000000) throw new Error('Artifact text exceeds 2 million characters');
        }
        const bytes = text.bytes || Buffer.from(text.inline);
        components.push({ type: 'text/plain', size: bytes.length, sha256: text.marker?.sha256 || digest(bytes) });
      }
      if (version.pngBase64) {
        png = heavy(version.pngBase64, 'base64');
        const bytes = png.bytes || Buffer.from(png.inline, 'base64');
        if (bytes.length > 20 * 1024 * 1024 || !bytes.subarray(0, 8).equals(PNG)) throw new Error('Invalid imported PNG');
        if (png.inline !== undefined) png.inline = bytes.toString('base64');
        components.push({ type: 'image/png', size: bytes.length, sha256: png.marker?.sha256 || digest(bytes) });
      }
      let archive;
      if (version.archive) {
        archive = { ...version.archive, resources: version.archive.resources.map(resource => {
          const { bodyBase64, ...entry } = resource;
          if (bodyBase64 === undefined) return entry;
          const ref = heavy(bodyBase64, 'base64');
          const bytes = ref.bytes || Buffer.from(ref.inline, 'base64');
          if (entry.size !== bytes.length || entry.sha256 !== digest(bytes)) throw fail('component_integrity', `COMPONENT_INTEGRITY: imported archive resource ${String(entry.url).slice(0, 200)} does not match its recorded SHA-256; the export is damaged or was altered`);
          if (ref.inline !== undefined) return { ...entry, bodyBase64: bytes.toString('base64') };
          deferred.push(() => lazy(entry, 'bodyBase64', ref));
          return entry;
        }) };
        const manifest = canonicalJson(archiveManifest(archive));
        components.push({ type: 'application/x-weft-archive-manifest', size: Buffer.byteLength(manifest), sha256: digest(manifest) });
      }
      if (!components.length && !version.purged) throw new Error('Imported artifact has no offline content');
      if (version.components) {
        for (const claimed of version.components) {
          const actual = components.find(component => component.type === claimed.type);
          if (actual && (actual.sha256 !== claimed.sha256 || actual.size !== claimed.size)) throw fail('component_integrity', `COMPONENT_INTEGRITY: imported ${claimed.type} component does not match its recorded SHA-256; the export is damaged or was altered`);
        }
      } else loss('artifacts', 'versions.components', 'source had no component hashes; hashes computed at import');
      const previous = version.previousVersionId ? mapping.get(version.previousVersionId) : null;
      if (version.previousVersionId && !previous) loss('artifacts', 'versions.previousVersionId', 'previous version not in export; link removed');
      const derivedFrom = version.derivedFrom ? mapping.get(version.derivedFrom) ?? null : undefined;
      if (version.derivedFrom && !derivedFrom) loss('artifacts', 'versions.derivedFrom', 'source version of a sanitized derivative not in export (excluded or restricted); the derivative keeps its redaction metadata');
      stats.versions++;
      const stored = { id: (version.id && mapping.get(version.id)) || uuid('version'), number: version.number ?? index + 1, createdAt: version.createdAt ?? now(), actor: version.actor ?? 'human', method: version.method ?? 'import',
        url: version.url ? sanitizeUrl(version.url) : '', title: version.title ?? fields.title, components, ...(text?.inline !== undefined ? { text: text.inline } : {}), ...(png?.inline !== undefined ? { pngBase64: png.inline } : {}),
        navigationVersion: version.navigationVersion ?? undefined, limitations: version.limitations ?? ['Imported content has not been independently verified.'], redactionStatus: version.redactionStatus ?? 'not-reviewed', previousVersionId: previous,
        provenance: { imported: true, sourceVersionId: version.id ?? null }, ...(version.origin !== undefined && { origin: importedOrigin(version.origin, 'import', mapping) }),
        ...(archive ? { archive } : {}), ...(version.capture ? { capture: version.capture } : {}), ...(derivedFrom !== undefined ? { derivedFrom } : {}), ...(version.derivedFromNumber ? { derivedFromNumber: version.derivedFromNumber } : {}),
        ...(version.redactions ? { redactions: version.redactions } : {}), ...(version.inaccessibleRegions ? { inaccessibleRegions: version.inaccessibleRegions } : {}),
        ...(version.access ? { access: version.access, accessChangedAt: version.accessChangedAt ?? now(), accessChangedBy: version.accessChangedBy ?? 'import' } : {}), ...(version.purged ? { purged: version.purged } : {}), ...(version.review ? { review: version.review } : {}) };
      if (text?.bytes) deferred.push(() => lazy(stored, 'text', text));
      if (png?.bytes) deferred.push(() => lazy(stored, 'pngBase64', png));
      return stored;
    });
    return fields;
  },
  /** Rewrite exported identifiers cited inside free-form text. Captured text and hashed bytes are never altered. */
  rewriteCitations(record, mapping, stats) {
    const skip = new Set(['id', 'workspaceId', 'evidence', 'materialIds', 'outputs', 'attachments', 'previousVersionId', 'provenance', 'components', 'sha256', 'text', 'pngBase64', 'fileBase64', 'taskId', 'revisions',
      'origin', 'lastOrigin', 'citations', 'proposal', 'promotedFrom', 'superseded', 'derivedFrom', 'link', 'service', 'subjects', 'resolution', 'items', 'members', 'archive', 'capture', 'redactions']);
    const visit = value => {
      if (typeof value === 'string') return value.replace(ID_TOKEN, token => { if (mapping.has(token)) { stats.freeFormCitations++; return mapping.get(token); } stats.unresolvedCitations.add(token); return token; });
      if (Array.isArray(value)) return value.map(visit);
      if (value && typeof value === 'object') { for (const name of Object.keys(value)) if (!skip.has(name)) value[name] = visit(value[name]); }
      return value;
    };
    visit(record);
  },
  // ---- Backups -----------------------------------------------------------------------
  async backupCommand(name, args, dryRun) {
    if (name === 'backups.create') {
      const result = createBackup(this.storage, { kind: 'manual', note: args.note || '', clock: this.clock });
      if (result.status !== 'verified') throw fail('command_failed', `BACKUP_INVALID: the new backup failed verification (${result.problems.map(item => item.problem).join(', ')})`);
      return result;
    }
    if (name === 'backups.list') return { backups: listBackups(this.directory), policy: { ...this.backupPolicy }, location: join(this.directory, 'backups') };
    if (name === 'backups.verify') return verifyBackup(this.directory, args.id);
    if (name === 'backups.delete') return deleteBackup(this.directory, args.id);
    const verification = verifyBackup(this.directory, args.id);
    if (verification.status !== 'verified') throw fail('command_failed', `BACKUP_INVALID: backup failed verification; nothing was changed (${verification.problems.slice(0, 5).map(item => `${item.path}: ${item.problem}`).join('; ')})`);
    if (dryRun) {
      const current = Object.fromEntries(Object.entries(this.data).filter(([, value]) => Array.isArray(value)).map(([key, value]) => [key, value.length]));
      return { dryRun: true, applied: false, result: { backup: verification }, changes: { current, restored: verification.counts, encryption: { current: this.storage.encrypted ? 'encrypted' : 'plaintext', restored: verification.encrypted ? 'encrypted' : 'plaintext' } } };
    }
    return this.restoreFrom(args.id);
  },
  restoreFrom(id) {
    const previousWorkspaces = new Set(this.data.workspaces.map(item => item.id));
    this.sealedStoreStep('beforeRestore');
    this.storage.close();
    let result;
    let failure;
    try { result = restoreBackup(this.directory, id, { clock: this.clock }); }
    catch (error) { failure = error; try { recoverInterruptedRestore(this.directory); } catch { /* reported below */ } }
    // The backup carries its own keyring (or none): reuse the in-memory profile key if it still fits, else lock.
    const keys = this.encryption.keys;
    this.encryption.keys = null;
    const encryption = this.encryption.adoptRestored(keys);
    if (encryption === 'locked') {
      this.storage = null; this._data = null; this.locked = true;
      this.sealedStoreStep('afterRestore');
      if (failure) throw failure;
      return Promise.resolve().then(async () => {
        await this.encryptionHooks.beforeLock?.({ persist: false });
        return { ...result, encryption, notice: 'The restored backup is encrypted with keys this session does not hold. Unlock with the recovery key or passphrase that was valid when the backup was made.' };
      });
    }
    try { this.openStorage(); }
    catch (error) { throw fail('command_failed', `RESTORE_INCOMPLETE: ${failure?.message || error.message}. Restart Weft to finish recovery; originals are preserved under ${RECOVERY_DIR}/.`); }
    if (failure) throw failure;
    this.storage.sweepOrphans();
    this.sealedStoreStep('afterRestore');
    result.encryption = this.storage.encrypted ? 'encrypted' : 'plaintext';
    // A backup taken mid-rotation carries both data keys; finish re-encrypting under the newest.
    if (this.encryption.keyring?.rotation) this.resumeRotation().catch(() => {});
    this.log('backups.restore', this.activeWorkspaceId, this.activeWorkspaceId, 'human', `Restored ${id}; previous data preserved in ${result.preservedOriginal}`);
    this.save();
    const remaining = new Set(this.data.workspaces.map(item => item.id));
    return Promise.resolve().then(async () => {
      for (const workspaceId of previousWorkspaces) if (!remaining.has(workspaceId)) await this.browser?.closeWorkspace?.(workspaceId);
      await this.browser?.switchWorkspace?.(this.activeWorkspaceId);
      return { ...result, activeWorkspaceId: this.activeWorkspaceId };
    });
  },
  runAutomaticBackup() {
    return serialize(this, () => {
      if (this.closed || this.locked || !this.backupPolicy.automatic) return;
      try {
        const latest = listBackups(this.directory).find(item => item.kind === 'automatic' && item.status !== 'invalid');
        if (latest && this.clock() - Date.parse(latest.createdAt) < this.backupPolicy.intervalHours * 3600 * 1000) return;
        const result = createBackup(this.storage, { kind: 'automatic', clock: this.clock });
        if (result.status !== 'verified') throw new Error(`automatic backup failed verification: ${result.problems.map(item => item.problem).join(', ')}`);
        pruneBackups(this.directory, { kind: 'automatic', keep: this.backupPolicy.keep });
        this.backupPolicy.lastRunAt = new Date(this.clock()).toISOString();
        this.backupPolicy.lastError = null;
      } catch (error) {
        this.backupPolicy.lastError = error.message;
        this.onWarning({ code: 'BACKUP_FAILED', message: `Automatic backup failed: ${error.message}` });
      }
    });
  },
};
