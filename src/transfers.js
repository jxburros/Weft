import { createHash, randomUUID } from 'node:crypto';
import { closeSync, existsSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, readSync, renameSync, rmSync, writeSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { z } from 'zod';
import { pageField, pageItems } from './pagination.js';
import { requestIdField } from './workspace-commands.js';
import { syncDirectory } from './storage-safety.js';

/**
 * Large-file transfer beyond the 1 MiB REST request cap (ADR 018, issue #14).
 *
 * Uploads are sessions of base64 chunks appended at explicit byte offsets, verified against the
 * declared size and SHA-256 before anything is created. Downloads read stored components in
 * bounded chunks with per-chunk and whole-file digests (REST also streams them). Package uploads
 * stage the files of a `workspaces.exportPackage` folder; importing a package stays human-only.
 */
export const CHUNK_BYTES = 512 * 1024;
export const MAX_READ_BYTES = 4 * 1024 * 1024;
const MAX_CHUNK_BASE64 = Math.ceil(CHUNK_BYTES / 3) * 4;
const LIMITS = { material: 10 * 1024 * 1024, artifact: 20 * 1024 * 1024, package: 256 * 1024 * 1024 };
export const TRANSFER_LIMITS = Object.freeze({ chunkBytes: CHUNK_BYTES, maxReadBytes: MAX_READ_BYTES, maxBytes: { ...LIMITS }, maxOpenPerCaller: 4, maxOpenBytes: 1024 * 1024 * 1024, idleMs: 60 * 60 * 1000 });
const UPLOADS = '.uploads';
const id = z.string().min(1).max(128);
const transferId = z.string().regex(/^xfer_[0-9a-f-]{36}$/).describe('Upload session from transfers.begin.');
const hex = z.string().regex(/^[0-9a-f]{64}$/, 'Expected a lowercase hex SHA-256 digest');
const packageName = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/, 'Use 1-100 letters, digits, dots, dashes or underscores; no paths').refine(value => !value.includes('..'), 'Package names cannot contain ..');
const packagePath = z.string().regex(/^(?:manifest\.json|workspace\.json|components\/[0-9a-f]{2}\/[0-9a-f]{64})$/, 'Expected manifest.json, workspace.json or components/<aa>/<sha256>');
const source = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('artifact'), id, versionId: id.describe('Exact immutable version.'), part: z.enum(['text', 'image']).describe('Version component to read.') }),
  z.strictObject({ kind: z.literal('material'), id: id.describe('Material with a stored file.') }),
  z.strictObject({ kind: z.literal('package'), name: packageName.describe('Package folder in the profile transfers folder.'), path: packagePath }),
]).describe('Stored bytes to read.');
export const transferCommandDefinitions = {
  'transfers.begin': ['Start a chunked upload larger than one request; transfers.commit verifies its size and SHA-256 before creating anything', {
    workspaceId: id.optional(), purpose: z.enum(['material', 'artifact', 'package']).describe('material: a stored file; artifact: capture text or PNG; package: one file of a package folder.'),
    size: z.number().int().min(1).max(LIMITS.package).describe('Exact byte length of the whole upload.'), sha256: hex.describe('SHA-256 of the whole upload.'),
    mimeType: z.string().max(128).optional().describe('artifact: text/plain or image/png; material: the file type.'), filename: z.string().max(255).optional(),
    packageName: packageName.optional().describe('package purpose: folder name the package is staged under.'), path: packagePath.optional().describe('package purpose: file path inside the package.') }],
  'transfers.append': ['Append one base64 chunk at its byte offset (at most 512 KiB per chunk); retrying the same chunk is harmless', {
    transferId, offset: z.number().int().min(0).max(LIMITS.package).describe('Byte offset of this chunk; must equal the bytes received so far.'),
    dataBase64: z.string().min(1).max(MAX_CHUNK_BASE64).describe('Chunk bytes, base64 encoded.') }],
  'transfers.commit': ['Verify a complete upload and create its material, artifact (version) or package file', {
    transferId, title: z.string().trim().min(1).max(240).optional(), note: z.string().max(500000).optional(), tags: z.array(z.string().max(100)).max(100).optional(),
    artifactId: id.optional().describe('artifact purpose: append a version to this artifact.'), url: z.string().max(16384).optional().describe('artifact purpose: source HTTP(S) URL.'),
    requestId: requestIdField.optional() }],
  'transfers.abort': ['Discard an unfinished upload', { transferId }],
  'transfers.list': ['List your unfinished uploads', { page: pageField.optional() }],
  'transfers.read': ['Read stored bytes (artifact component, material file, package file) in chunks with whole-file and chunk SHA-256', {
    source, offset: z.number().int().min(0).default(0).describe('Byte offset to start reading.'), length: z.number().int().min(1).max(MAX_READ_BYTES).optional().describe(`Bytes to read (default and maximum ${MAX_READ_BYTES}).`) }],
};
const schemas = Object.fromEntries(Object.entries(transferCommandDefinitions).map(([name, [, shape]]) => [name, z.strictObject(shape)]));
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const fail = (code, message, extra = {}) => Object.assign(new Error(message), { code, ...extra });
const callerKey = context => `${String(context.actor || 'human')}${context.clientId ? `:${context.clientId}` : ''}`;

export class Transfers {
  constructor({ workspace, clock = Date.now } = {}) {
    this.workspace = workspace;
    this.clock = clock;
    this.sessions = new Map();
    this.root = join(workspace.directory, 'transfers');
    // Upload sessions do not survive a restart; remove their partial files.
    rmSync(join(this.root, UPLOADS), { recursive: true, force: true });
    this.cached = null;
  }
  expire() {
    const now = this.clock();
    for (const [key, session] of this.sessions) if (now - session.touchedAt > TRANSFER_LIMITS.idleMs) this.discard(key);
  }
  discard(key) {
    const session = this.sessions.get(key);
    this.sessions.delete(key);
    if (session?.buffer) session.buffer.fill(0);
    if (session?.file) rmSync(session.file, { force: true });
  }
  /** Drop every unfinished upload (an encrypted profile is locking): in-memory parts are zeroed. */
  discardAll() { for (const key of [...this.sessions.keys()]) this.discard(key); this.cached = null; }
  /** Encrypted profiles (ADR 014) keep material and artifact upload parts in memory only; package files are plaintext exports by nature. */
  inMemory(purpose) { return purpose !== 'package' && Boolean(this.workspace.storage?.encrypted); }
  session(transferId, context) {
    this.expire();
    const session = this.sessions.get(transferId);
    // Another caller's session is indistinguishable from a missing one.
    if (!session || session.owner !== callerKey(context)) throw fail('not_found', 'Upload session not found or expired; start again with transfers.begin');
    if (context.workspaceIds && !context.workspaceIds.includes(session.workspaceId)) throw fail('not_found', 'Upload session not found or expired; start again with transfers.begin');
    return session;
  }
  describe(session) {
    const { file, owner, buffer, ...rest } = session;
    return { ...rest, createdAt: new Date(session.createdAt).toISOString(), expiresAt: new Date(session.touchedAt + TRANSFER_LIMITS.idleMs).toISOString(), chunkBytes: CHUNK_BYTES };
  }

  async execute(name, input, context) {
    const args = schemas[name].parse(input);
    if (name === 'transfers.begin') return this.begin(args, context);
    if (name === 'transfers.append') return this.append(args, context);
    if (name === 'transfers.commit') return this.commit(args, context);
    if (name === 'transfers.abort') { const session = this.session(args.transferId, context); this.discard(session.transferId); return { transferId: session.transferId, aborted: true }; }
    if (name === 'transfers.list') {
      this.expire();
      const own = [...this.sessions.values()].filter(session => session.owner === callerKey(context) && (!context.workspaceIds || context.workspaceIds.includes(session.workspaceId)));
      const page = pageItems(own.map(session => this.describe(session)), args.page, { command: name, scope: callerKey(context) });
      return page;
    }
    if (name === 'transfers.read') return this.read(args, context);
    throw fail('unknown_command', 'Unknown transfer command');
  }

  begin(args, context) {
    this.expire();
    const workspaceId = args.workspaceId ?? context.workspaceId ?? this.workspace.activeWorkspaceId;
    this.workspace.workspace(workspaceId);
    if (context.workspaceId && context.workspaceId !== workspaceId) throw fail('permission_required', 'Workspace is outside the authorized scope');
    if (args.size > LIMITS[args.purpose]) throw fail('request_too_large', `${args.purpose} uploads are limited to ${LIMITS[args.purpose] / 1024 / 1024} MiB`);
    if (args.purpose === 'package' ? !(args.packageName && args.path) : (args.packageName || args.path)) throw fail('invalid_arguments', 'packageName and path are required for (and only for) package uploads', { field: args.purpose === 'package' ? 'packageName' : 'path' });
    if (args.purpose === 'artifact' && !['text/plain', 'image/png'].includes(args.mimeType)) throw fail('invalid_arguments', 'Artifact uploads need mimeType text/plain or image/png', { field: 'mimeType' });
    if (args.purpose === 'package' && existsSync(join(this.root, args.packageName))) throw fail('invalid_arguments', 'A package with this name already exists; existing packages are never overwritten', { field: 'packageName' });
    const owner = callerKey(context);
    const open = [...this.sessions.values()];
    if (open.filter(session => session.owner === owner).length >= TRANSFER_LIMITS.maxOpenPerCaller) throw fail('unavailable', `At most ${TRANSFER_LIMITS.maxOpenPerCaller} unfinished uploads per caller; commit or abort one first`);
    if (open.reduce((sum, session) => sum + session.size, 0) + args.size > TRANSFER_LIMITS.maxOpenBytes) throw fail('unavailable', 'Too many bytes are being uploaded; try again after current uploads finish');
    const transferId = `xfer_${randomUUID()}`;
    let file = null, buffer = null;
    if (this.inMemory(args.purpose)) buffer = Buffer.alloc(args.size);
    else {
      const directory = join(this.root, UPLOADS);
      mkdirSync(directory, { recursive: true, mode: 0o700 });
      file = join(directory, `${transferId}.part`);
      closeSync(openSync(file, 'wx', 0o600));
    }
    const now = this.clock();
    const session = { transferId, owner, workspaceId, purpose: args.purpose, size: args.size, sha256: args.sha256, received: 0, mimeType: args.mimeType ?? null, filename: args.filename ?? null,
      packageName: args.packageName ?? null, path: args.path ?? null, createdAt: now, touchedAt: now, file, buffer };
    this.sessions.set(transferId, session);
    return this.describe(session);
  }

  append(args, context) {
    const session = this.session(args.transferId, context);
    if (!/^(?:[A-Za-z\d+/]{4})*(?:[A-Za-z\d+/]{2}==|[A-Za-z\d+/]{3}=)?$/.test(args.dataBase64)) throw fail('invalid_arguments', 'dataBase64 is not valid base64', { field: 'dataBase64' });
    const bytes = Buffer.from(args.dataBase64, 'base64');
    if (bytes.length > CHUNK_BYTES) throw fail('request_too_large', `Chunks are limited to ${CHUNK_BYTES} bytes`);
    // A retried chunk that was already written is accepted only if it is byte-identical.
    if (args.offset + bytes.length <= session.received) {
      const existing = Buffer.alloc(bytes.length);
      if (session.buffer) session.buffer.copy(existing, 0, args.offset, args.offset + bytes.length);
      else {
        const fd = openSync(session.file, 'r');
        try { readSync(fd, existing, 0, bytes.length, args.offset); } finally { closeSync(fd); }
      }
      if (!existing.equals(bytes)) throw fail('stale_state', 'A different chunk was already received at this offset', { details: { reason: 'offset_conflict' } });
      session.touchedAt = this.clock();
      return { ...this.describe(session), duplicate: true };
    }
    if (args.offset !== session.received) throw fail('stale_state', `Expected offset ${session.received}; resume from there`, { details: { reason: 'offset_mismatch' } });
    if (session.received + bytes.length > session.size) throw fail('invalid_arguments', 'Chunk extends past the declared size', { field: 'dataBase64' });
    if (session.buffer) bytes.copy(session.buffer, args.offset);
    else {
      const fd = openSync(session.file, 'r+');
      try { writeSync(fd, bytes, 0, bytes.length, args.offset); fsyncSync(fd); } finally { closeSync(fd); }
    }
    session.received += bytes.length;
    session.touchedAt = this.clock();
    return this.describe(session);
  }

  verified(session) {
    if (session.received !== session.size) throw fail('invalid_arguments', `Upload incomplete: ${session.received} of ${session.size} bytes received`, { field: 'transferId', notStarted: true });
    const bytes = session.buffer ? Buffer.from(session.buffer) : readFileSync(session.file);
    if (bytes.length !== session.size || sha(bytes) !== session.sha256) throw fail('component_integrity', 'Uploaded bytes do not match the declared SHA-256; nothing was created. Abort and upload again.', { notStarted: true });
    return bytes;
  }

  async commit(args, context) {
    const session = this.session(args.transferId, context);
    const bytes = this.verified(session);
    let result;
    if (session.purpose === 'package') {
      if (args.title || args.note || args.tags || args.artifactId || args.url) throw fail('invalid_arguments', 'Package uploads take no record fields', { field: 'transferId' });
      result = this.stagePackageFile(session, bytes);
    } else if (session.purpose === 'material') {
      if (args.artifactId || args.url) throw fail('invalid_arguments', 'artifactId and url apply to artifact uploads', { field: args.artifactId ? 'artifactId' : 'url' });
      result = await this.workspace.commitUpload('materials.create', { workspaceId: session.workspaceId, title: args.title ?? session.filename ?? 'Uploaded file', kind: 'file',
        filename: session.filename ?? 'file', ...(session.mimeType ? { mimeType: session.mimeType } : {}), fileBase64: bytes.toString('base64'), ...(args.note !== undefined ? { note: args.note } : {}), ...(args.tags ? { tags: args.tags } : {}) }, context, args.requestId);
    } else {
      const content = session.mimeType === 'image/png' ? { pngBase64: bytes.toString('base64') } : { text: bytes.toString('utf8') };
      if (content.text !== undefined && Buffer.from(content.text, 'utf8').length !== bytes.length) throw fail('invalid_arguments', 'Text uploads must be valid UTF-8', { field: 'transferId', notStarted: true });
      result = await this.workspace.commitUpload('artifacts.create', { workspaceId: session.workspaceId, title: args.title ?? session.filename ?? 'Uploaded content', ...content,
        ...(args.artifactId ? { artifactId: args.artifactId } : {}), ...(args.url ? { url: args.url } : {}), ...(args.note !== undefined ? { note: args.note } : {}), ...(args.tags ? { tags: args.tags } : {}) }, context, args.requestId);
    }
    this.discard(session.transferId);
    return { transferId: session.transferId, purpose: session.purpose, bytes: session.size, sha256: session.sha256, verified: true, result };
  }

  /** Stage one package file; committing manifest.json last verifies every listed file and publishes the folder. */
  stagePackageFile(session, bytes) {
    const staging = join(this.root, `.incoming-${session.packageName}`);
    const target = join(staging, ...session.path.split('/'));
    const component = /^components\/([0-9a-f]{2})\/([0-9a-f]{64})$/.exec(session.path);
    if (component && (component[2] !== session.sha256 || !component[2].startsWith(component[1]))) throw fail('component_integrity', 'A component file must be named by its own SHA-256', { notStarted: true });
    mkdirSync(dirname(target), { recursive: true, mode: 0o700 });
    const temp = `${target}.${randomUUID()}.tmp`;
    try {
      const fd = openSync(temp, 'wx', 0o600);
      try { writeSync(fd, bytes); fsyncSync(fd); } finally { closeSync(fd); }
      renameSync(temp, target);
    } finally { rmSync(temp, { force: true }); }
    if (session.path !== 'manifest.json') return { packageName: session.packageName, path: session.path, staged: true, ready: false };
    let manifest;
    try { manifest = JSON.parse(bytes.toString('utf8')); } catch { throw fail('invalid_arguments', 'PACKAGE_INVALID: manifest.json is not valid JSON'); }
    const files = Array.isArray(manifest?.files) ? manifest.files : [];
    const missing = [];
    for (const file of files) {
      if (typeof file?.path !== 'string' || !packagePath.safeParse(file.path).success || file.path === 'manifest.json') throw fail('invalid_arguments', 'PACKAGE_INVALID: manifest lists a malformed path');
      const path = join(staging, ...file.path.split('/'));
      const stat = lstatSync(path, { throwIfNoEntry: false });
      if (!stat?.isFile() || stat.size !== file.size || sha(readFileSync(path)) !== file.sha256) missing.push(file.path);
    }
    if (missing.length) return { packageName: session.packageName, path: session.path, staged: true, ready: false, missing: missing.slice(0, 100), missingCount: missing.length };
    const published = join(this.root, session.packageName);
    if (existsSync(published)) throw fail('invalid_arguments', 'A package with this name already exists; existing packages are never overwritten');
    renameSync(staging, published);
    syncDirectory(this.root);
    return { packageName: session.packageName, path: session.path, staged: true, ready: true, files: files.length,
      next: 'A person can preview and import it with workspaces.importPackage (dryRun first); importing is human-only.' };
  }

  /** Bytes and digest of one stored source, scoped like the corresponding read command. */
  resolve(source, context) {
    const workspace = this.workspace;
    if (source.kind === 'package') {
      const folder = workspace.transferPath(source.name);
      const path = join(folder, ...source.path.split('/'));
      for (const item of [folder, path]) {
        const stat = lstatSync(item, { throwIfNoEntry: false });
        if (!stat || stat.isSymbolicLink()) throw fail('not_found', 'Package file not found');
      }
      const bytes = readFileSync(path);
      return { bytes, sha256: sha(bytes), mimeType: source.path.endsWith('.json') ? 'application/json' : 'application/octet-stream' };
    }
    if (source.kind === 'material') {
      const record = workspace.record('materials', source.id, context);
      if (context.workspaceIds && !context.workspaceIds.includes(record.workspaceId)) throw fail('permission_required', 'Record is outside the authorized workspace');
      if (!record.fileBase64) throw fail('not_found', 'This material has no stored file');
      const bytes = this.componentBytes(record, 'fileBase64', 'base64');
      return { bytes, sha256: record.sha256 ?? sha(bytes), mimeType: record.mimeType ?? 'application/octet-stream', workspaceId: record.workspaceId };
    }
    const record = workspace.record('artifacts', source.id, context);
    if (context.workspaceIds && !context.workspaceIds.includes(record.workspaceId)) throw fail('permission_required', 'Record is outside the authorized workspace');
    const version = record.versions.find(item => item.id === source.versionId);
    if (!version) throw fail('not_found', 'Artifact version not found');
    // Restricted originals (#17) are withheld from agents on every read path, including downloads; purged content is gone.
    workspace.assertReadable(version, context, 'transfers.read');
    if (version.purged) throw fail('not_found', 'This version\u2019s content was purged');
    const key = source.part === 'image' ? 'pngBase64' : 'text';
    const component = version.components?.find(item => item.type === (source.part === 'image' ? 'image/png' : 'text/plain'));
    if (!component) throw fail('not_found', `This artifact version has no ${source.part} component`);
    const bytes = this.componentBytes(version, key, source.part === 'image' ? 'base64' : 'utf8');
    return { bytes, sha256: component.sha256, mimeType: source.part === 'image' ? 'image/png' : 'text/plain; charset=utf-8', workspaceId: record.workspaceId };
  }
  componentBytes(object, key, encoding) {
    const marker = this.workspace.storage.componentMarker(object, key);
    if (marker) {
      if (this.cached?.sha256 === marker.sha256) return this.cached.bytes;
      const bytes = this.workspace.storage.components.read(marker.sha256, marker.size);
      this.cached = { sha256: marker.sha256, bytes };
      return bytes;
    }
    return Buffer.from(object[key], encoding);
  }
  read(args, context) {
    const { bytes, sha256, mimeType, workspaceId } = this.resolve(args.source, context);
    if (args.offset > bytes.length) throw fail('invalid_arguments', 'offset is past the end of the data', { field: 'offset' });
    const chunk = bytes.subarray(args.offset, args.offset + (args.length ?? MAX_READ_BYTES));
    return { source: args.source, ...(workspaceId ? { workspaceId } : {}), mimeType, totalBytes: bytes.length, sha256, offset: args.offset, length: chunk.length,
      chunkSha256: sha(chunk), done: args.offset + chunk.length >= bytes.length, dataBase64: chunk.toString('base64') };
  }
}
