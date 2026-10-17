import { createHmac, randomUUID, timingSafeEqual } from 'node:crypto';
import { readFileSync, mkdirSync } from 'node:fs';
import { fileStamp, writeVerifiedJson } from './storage-safety.js';
import { join } from 'node:path';
import { z } from 'zod';

const scopes = ['read', 'records.write', 'tabs.control'];
const id = z.string().uuid();
export const clientCommandDefinitions = {
  'clients.create': ['Human creates a scoped, expiring automation credential; returned token is shown once', {
    name: z.string().trim().min(1).max(100), scopes: z.array(z.enum(scopes)).min(1).max(3),
    workspaceIds: z.array(z.string().min(1).max(128)).min(1).max(100),
    ttlSeconds: z.number().int().min(60).max(2592000).default(3600),
  }],
  'clients.list': ['Human lists automation grants without tokens', {}],
  'clients.revoke': ['Human revokes an automation grant immediately', { clientId: id }],
};
const schemas = Object.fromEntries(Object.entries(clientCommandDefinitions).map(([name, [, shape]]) => [name, z.strictObject(shape)]));
const denied = message => Object.assign(new Error(message), { code: 'permission_required' });
const equal = (a, b) => {
  const left = Buffer.from(a || ''), right = Buffer.from(b || '');
  return left.length === right.length && timingSafeEqual(left, right);
};

export class ClientGrants {
  constructor({ directory, masterToken, workspace, clock = Date.now }) {
    this.masterToken = masterToken;
    this.workspace = workspace;
    this.clock = clock;
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    this.path = join(directory, 'client-grants.json');
    this.stamp = fileStamp(this.path);
    this.grants = [];
    try {
      const saved = JSON.parse(readFileSync(this.path, 'utf8'));
      if (saved.version !== 1 || !Array.isArray(saved.grants)) throw new Error('Invalid client grant store');
      const grantSchema = z.strictObject({ clientId: id, name: z.string().max(100), scopes: z.array(z.enum(scopes)), workspaceIds: z.array(z.string()), expiresAt: z.number().int(), revoked: z.boolean(), createdAt: z.number().int() });
      this.grants = saved.grants.map(value => grantSchema.parse(value));
    } catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
  save() {
    this.stamp = writeVerifiedJson(this.path, JSON.stringify({ version: 1, grants: this.grants }), this.stamp);
  }
  sign(payload) { return createHmac('sha256', this.masterToken).update(payload).digest('base64url'); }
  authenticate(token) {
    if (equal(token, this.masterToken)) return { actor: 'automation', source: 'api' };
    if (typeof token !== 'string' || token.length > 4096) return null;
    const parts = token.split('.');
    if (parts.length !== 3 || parts[0] !== 'weft1' || !equal(parts[2], this.sign(parts[1]))) return null;
    let claims;
    try { claims = JSON.parse(Buffer.from(parts[1], 'base64url').toString()); } catch { return null; }
    const grant = this.grants.find(item => item.clientId === claims.clientId);
    if (!grant || grant.revoked || grant.expiresAt <= this.clock() || claims.expiresAt !== grant.expiresAt) return null;
    return { actor: `client:${grant.clientId}`, source: 'api', clientId: grant.clientId, scopes: [...grant.scopes], workspaceIds: [...grant.workspaceIds], expiresAt: grant.expiresAt };
  }
  execute(name, input, context) {
    if (context.actor !== 'human' || context.source !== 'gui') throw denied('Client grants require the trusted browser interface');
    const args = schemas[name]?.parse(input);
    if (!args) throw new Error('Unknown client command');
    if (name === 'clients.list') return structuredClone(this.grants);
    const before = structuredClone(this.grants);
    try {
      if (name === 'clients.revoke') {
        const grant = this.grants.find(item => item.clientId === args.clientId);
        if (!grant) throw Object.assign(new Error('Client not found'), { code: 'not_found' });
        grant.revoked = true; this.save();
        return { clientId: grant.clientId, revoked: true };
      }
      for (const workspaceId of args.workspaceIds) this.workspace.workspace(workspaceId);
      const grant = { clientId: randomUUID(), name: args.name, scopes: [...new Set(args.scopes)], workspaceIds: [...new Set(args.workspaceIds)], expiresAt: this.clock() + args.ttlSeconds * 1000, revoked: false, createdAt: this.clock() };
      if (this.grants.length >= 1000) throw new Error('Client grant limit reached; use a fresh profile or archive expired grants');
      this.grants.push(grant); this.save();
      const payload = Buffer.from(JSON.stringify({ clientId: grant.clientId, expiresAt: grant.expiresAt })).toString('base64url');
      return { ...structuredClone(grant), token: `weft1.${payload}.${this.sign(payload)}` };
    } catch (error) { this.grants = before; throw error; }
  }
  assertAllowed(name, context, target = {}) {
    if (!context.clientId) return;
    const grant = this.grants.find(item => item.clientId === context.clientId);
    if (!grant || grant.revoked || grant.expiresAt <= this.clock()) throw denied('Client grant expired or revoked');
    if (target.workspaceId && !grant.workspaceIds.includes(target.workspaceId)) throw denied('Workspace is outside this client grant');
    // Explicit allowlists keep newly introduced commands denied until classified.
    const read = /^(materials|context|tasks|conversations|workflows|artifacts)\.(list|get)$/.test(name)
      || ['workspaces.list', 'workspaces.get', 'workspace.snapshot', 'history.list', 'bookmarks.list', 'activity.list', 'search.query', 'tabs.list', 'page.inspect', 'page.readable', 'page.title', 'page.content', 'page.screenshot', 'page.pdf', 'downloads.list', 'storage.info', 'browser.info', 'guide.get'].includes(name);
    // batch.execute is admitted here; dispatch checks every contained command individually as well.
    const records = /^(materials|context|tasks|conversations|workflows)\.(create|update|delete)$/.test(name)
      || ['batch.execute', 'tasks.transition', 'conversations.message', 'bookmarks.create', 'bookmarks.delete', 'artifacts.create', 'artifacts.capture', 'artifacts.annotate', 'artifacts.delete'].includes(name);
    const tabs = ['tabs.new', 'tabs.activate', 'tabs.close', 'tabs.pin', 'tabs.duplicate', 'tabs.claim', 'tabs.release', 'page.navigate', 'page.back', 'page.forward', 'page.reload', 'page.stop', 'page.click', 'page.fill', 'page.find', 'page.zoom', 'downloads.cancel'].includes(name);
    const required = read ? 'read' : records ? 'records.write' : tabs ? 'tabs.control' : null;
    if (!required || !grant.scopes.includes(required)) throw denied(`Client scope does not permit ${name}`);
  }
}
