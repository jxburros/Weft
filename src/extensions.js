import { createHash, randomUUID } from 'node:crypto';
import { closeSync, fstatSync, lstatSync, mkdirSync, openSync, readFileSync, readSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { isAbsolute, join, resolve } from 'node:path';
import { z } from 'zod';
import { auditExtensionManifest, matchesPattern } from './extension-policy.js';
import { fileStamp, writeVerifiedJson } from './storage-safety.js';

const workspaceId = z.string().min(1).max(128).optional();
const path = z.string().min(1).max(4096).refine(value => isAbsolute(value) && !value.includes('\0'), 'Expected an absolute local directory path').describe('Absolute path of an unpacked extension directory on this computer.');
const hostGrants = z.array(z.string().min(1).max(2048)).max(100).default([]).describe('Exact host match patterns a person grants; must equal the requested hosts.');
const id = z.string().regex(/^ext_[a-f0-9-]{36}$/).describe('Installed extension id from extensions.list.');
export const extensionCommandDefinitions = {
  'extensions.list': ['Human lists unpacked Chromium extensions installed per workspace with their granted scope', { workspaceId }],
  'extensions.audit': ['Human audits an unpacked Manifest V3 extension directory against Weft policy without installing it', { path, workspaceId, hostGrants }],
  'extensions.install': ['Human installs a disabled, hash-pinned copy of an audited unpacked extension into one workspace', { path, workspaceId, hostGrants, sha256: z.string().regex(/^[a-f0-9]{64}$/).describe('Package digest returned by extensions.audit.') }],
  'extensions.enable': ['Human loads an installed extension into its workspace session after re-verifying files and scope', { id }],
  'extensions.disable': ['Human revokes an extension: it is unloaded from its workspace session immediately', { id }],
  'extensions.remove': ['Human unloads and deletes an installed extension copy', { id }],
};
const schemas = Object.fromEntries(Object.entries(extensionCommandDefinitions).map(([name, [, shape]]) => [name, z.strictObject(shape)]));
const recordSchema = z.strictObject({ id: z.string(), workspaceId: z.string(), name: z.string(), version: z.string(), sha256: z.string(), hostGrants: z.array(z.string()), permissions: z.array(z.string()),
  enabled: z.boolean(), installedAt: z.string(), source: z.string(), chromeId: z.string().nullable(), lastError: z.string().nullable() });
const LIMITS = { files: 1000, bytes: 50 * 1024 * 1024, file: 20 * 1024 * 1024, depth: 20 };
const failure = (code, message, details) => Object.assign(new Error(message), { code, ...(details && { details }) });
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');

function readBounded(file, limit) {
  const fd = openSync(file, 'r');
  try {
    const size = fstatSync(fd).size;
    if (size > limit) throw failure('invalid_arguments', `Extension file exceeds ${limit} bytes`);
    const buffer = Buffer.alloc(size);
    let offset = 0;
    while (offset < size) { const read = readSync(fd, buffer, offset, size - offset, offset); if (!read) break; offset += read; }
    return buffer.subarray(0, offset);
  } finally { closeSync(fd); }
}

/** Reads a package without following links; returns files and a deterministic tree digest. */
export function readPackage(root) {
  const files = new Map();
  let total = 0;
  const walk = (directory, prefix, depth) => {
    if (depth > LIMITS.depth) throw failure('invalid_arguments', 'Extension directory is nested too deeply');
    for (const entry of readdirSync(directory, { withFileTypes: true }).sort((a, b) => a.name < b.name ? -1 : 1)) {
      const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
      const full = join(directory, entry.name);
      const stat = lstatSync(full);
      if (stat.isSymbolicLink()) throw failure('invalid_arguments', `Extension package contains a link (${relative}); links are refused`);
      if (stat.isDirectory()) { walk(full, relative, depth + 1); continue; }
      if (!stat.isFile()) throw failure('invalid_arguments', `Extension package contains a special file (${relative})`);
      if (files.size >= LIMITS.files) throw failure('invalid_arguments', `Extension packages are limited to ${LIMITS.files} files`);
      const bytes = readBounded(full, LIMITS.file);
      total += bytes.length;
      if (total > LIMITS.bytes) throw failure('invalid_arguments', 'Extension packages are limited to 50 MiB');
      files.set(relative, bytes);
    }
  };
  let stat;
  try { stat = lstatSync(root); } catch { throw failure('not_found', 'Extension directory not found'); }
  if (!stat.isDirectory()) throw failure('invalid_arguments', 'Extension path must be a directory (unpacked extension), not a file or link');
  walk(root, '', 0);
  const digest = sha256([...files].map(([name, bytes]) => `${name}\0${sha256(bytes)}\n`).join(''));
  return { files, sha256: digest, bytes: total };
}

function parseManifest(files) {
  const bytes = files.get('manifest.json');
  if (!bytes) throw failure('invalid_arguments', 'manifest.json is missing from the extension directory');
  try { return JSON.parse(bytes.toString('utf8').replace(/^﻿/, '')); } catch { throw failure('invalid_arguments', 'manifest.json is not valid JSON'); }
}

/**
 * Per-workspace unpacked Chromium extensions. Every mutation is human-only;
 * extensions load only into their own workspace session partition, and their
 * service-worker requests are limited to granted hosts and site rules.
 */
export class WorkspaceExtensions {
  constructor({ directory, workspace, browser = null, chromiumVersion = process.versions.chrome ?? '0' }) {
    Object.assign(this, { workspace, browser, chromiumVersion });
    this.root = join(directory, 'extensions');
    mkdirSync(this.root, { recursive: true, mode: 0o700 });
    this.path = join(this.root, 'extensions.json');
    this.stamp = fileStamp(this.path);
    this.records = [];
    if (this.stamp) {
      const saved = JSON.parse(readFileSync(this.path, 'utf8'));
      if (saved.version !== 1 || !Array.isArray(saved.extensions)) throw new Error('Invalid extension store');
      this.records = saved.extensions.map(item => recordSchema.parse(item));
    }
    this.loaded = new Map();
    this.queue = Promise.resolve();
    if (browser) this.attachBrowser(browser);
  }

  attachBrowser(browser) {
    this.browser = browser;
    browser.extensionRequestAllowed = (workspace, details) => this.requestAllowed(workspace, details);
  }

  activity(action, record, detail) {
    const run = this.workspace.queue.then(() => { this.workspace.log(action, record.workspaceId, record.id, 'human', detail); this.workspace.save(); });
    this.workspace.queue = run.catch(() => {});
    return run;
  }

  save() { this.stamp = writeVerifiedJson(this.path, JSON.stringify({ version: 1, extensions: this.records }), this.stamp); }
  copyPath(record) { return join(this.root, record.id); }
  summary(record) {
    return structuredClone({ ...record, loaded: this.loaded.has(record.id), scope: { hosts: record.hostGrants, permissions: record.permissions, workspaceId: record.workspaceId } });
  }

  /** Called by the browser for http(s) requests initiated by an extension origin. Fails closed. */
  requestAllowed(workspace, details) {
    const chromeId = new URL(details.initiatorOrigin).host;
    const record = this.records.find(item => item.enabled && item.workspaceId === workspace && item.chromeId === chromeId && this.loaded.has(item.id));
    return Boolean(record && record.hostGrants.some(pattern => matchesPattern(pattern, details.url)));
  }

  execute(name, input, context = {}) {
    const run = this.queue.then(() => this.dispatch(name, input, context));
    this.queue = run.catch(() => {});
    return run;
  }

  async dispatch(name, input, context) {
    if (context.actor !== 'human') throw failure('human_required', 'Browser extensions are managed only from the trusted browser interface');
    const schema = schemas[name];
    if (!schema) throw failure('unknown_command', `Unknown extension command ${name}`);
    const args = schema.parse(input);
    if (name === 'extensions.list') {
      const target = args.workspaceId ?? this.workspace.activeWorkspaceId;
      return this.records.filter(item => item.workspaceId === target).map(item => this.summary(item));
    }
    if (name === 'extensions.audit' || name === 'extensions.install') {
      const target = args.workspaceId ?? this.workspace.activeWorkspaceId;
      this.workspace.workspace(target);
      const source = resolve(args.path);
      const pkg = readPackage(source);
      const audit = auditExtensionManifest(parseManifest(pkg.files), { hostGrants: args.hostGrants, files: new Set(pkg.files.keys()), chromiumVersion: this.chromiumVersion });
      const report = { ...audit, sha256: pkg.sha256, bytes: pkg.bytes, files: pkg.files.size, workspaceId: target };
      if (name === 'extensions.audit') return report;
      if (!audit.ok) throw failure('permission_required', `Extension refused: ${audit.refusals.map(item => `${item.key} (${item.kind}: ${item.reason})`).join('; ').slice(0, 2000)}`, { refusals: audit.refusals });
      if (args.sha256 !== pkg.sha256) throw failure('stale_state', 'Extension files changed after the audit; audit again and review the current scope');
      if (this.records.length >= 200) throw failure('invalid_arguments', 'Extension limit reached');
      const record = { id: `ext_${randomUUID()}`, workspaceId: target, name: audit.name, version: audit.version, sha256: pkg.sha256, hostGrants: [...new Set(args.hostGrants)],
        permissions: audit.scope.permissions.map(item => item.name), enabled: false, installedAt: new Date().toISOString(), source: source.slice(0, 4096), chromeId: null, lastError: null };
      const destination = this.copyPath(record);
      try {
        // Install the bytes that were hashed, never a later re-read of the source.
        for (const [relative, bytes] of pkg.files) {
          const target = join(destination, ...relative.split('/'));
          mkdirSync(join(target, '..'), { recursive: true, mode: 0o700 });
          writeFileSync(target, bytes, { flag: 'wx', mode: 0o600 });
        }
        if (readPackage(destination).sha256 !== record.sha256) throw failure('command_failed', 'Installed copy failed verification');
        this.records.push(record);
        this.save();
      } catch (error) {
        this.records = this.records.filter(item => item.id !== record.id);
        rmSync(destination, { recursive: true, force: true });
        throw error;
      }
      await this.activity(name, record, `${record.name} ${record.version} sha256 ${record.sha256}; hosts ${record.hostGrants.join(', ') || 'none'}; disabled until enabled`);
      return { ...this.summary(record), audit: report, notice: 'Installed disabled. Review the scope, then enable it for this workspace.' };
    }
    const record = this.records.find(item => item.id === args.id);
    if (!record) throw failure('not_found', 'Extension not found');
    if (name === 'extensions.enable') {
      await this.load(record);
      record.enabled = true; record.lastError = null;
      this.save();
      await this.activity(name, record, `${record.name} loaded into this workspace session`);
      return { ...this.summary(record), notice: 'Enabled for this workspace only. Pages already open receive content scripts after they reload.' };
    }
    await this.unload(record);
    record.enabled = false;
    if (name === 'extensions.remove') {
      this.records = this.records.filter(item => item.id !== record.id);
      rmSync(this.copyPath(record), { recursive: true, force: true });
    }
    this.save();
    await this.activity(name, record, `${record.name} unloaded${name === 'extensions.remove' ? ' and deleted' : ''}`);
    return { ...this.summary(record), removed: name === 'extensions.remove', notice: 'Unloaded. Scripts already injected into open pages stop working with the extension context and are gone after those pages reload.' };
  }

  session(record) {
    const session = this.browser?.sessions.get(record.workspaceId)?.session ?? this.browser?.sessionFor(record.workspaceId);
    if (!session?.extensions?.loadExtension) throw failure('unsupported', 'This browser engine does not support loading extensions into workspace sessions');
    return session;
  }

  async load(record) {
    if (this.loaded.has(record.id)) return;
    this.workspace.workspace(record.workspaceId);
    const pkg = readPackage(this.copyPath(record));
    if (pkg.sha256 !== record.sha256) throw failure('permission_required', 'Installed extension files changed since installation; remove and reinstall it');
    // Policy can tighten between Weft versions: re-audit before every load.
    const audit = auditExtensionManifest(parseManifest(pkg.files), { hostGrants: record.hostGrants, files: new Set(pkg.files.keys()), chromiumVersion: this.chromiumVersion });
    if (!audit.ok) throw failure('permission_required', `Extension no longer satisfies policy: ${audit.refusals.map(item => item.key).join(', ')}`, { refusals: audit.refusals });
    const session = this.session(record);
    const loaded = await session.extensions.loadExtension(this.copyPath(record), { allowFileAccess: false });
    record.chromeId = loaded.id;
    this.loaded.set(record.id, loaded.id);
  }

  async unload(record) {
    const chromeId = this.loaded.get(record.id);
    this.loaded.delete(record.id);
    if (chromeId) this.session(record).extensions.removeExtension(chromeId);
  }

  /** Startup: reload enabled extensions; anything that fails verification is disabled with a reason. */
  async restore() {
    let changed = false;
    for (const record of [...this.records]) {
      if (!this.workspace.snapshot().workspaces.some(item => item.id === record.workspaceId)) {
        this.records = this.records.filter(item => item.id !== record.id);
        rmSync(this.copyPath(record), { recursive: true, force: true });
        changed = true;
        continue;
      }
      if (!record.enabled) continue;
      try { await this.load(record); }
      catch (error) { record.enabled = false; record.lastError = String(error.message).slice(0, 2000); changed = true; }
    }
    if (changed) this.save();
  }
}
