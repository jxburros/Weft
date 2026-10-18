'use strict';
/**
 * Weft credential broker (ADR-017). Runs as its own OS process, started by
 * src/credentials.js with an almost empty environment and Node's permission
 * model: filesystem access only to the credential directory, no workers, no
 * addons, and child processes only when a person enabled an external vault CLI.
 *
 * It owns the vault file, holds the unwrapped data key in memory, seals every
 * entry with AES-256-GCM (security-relevant metadata is authenticated as
 * associated data) and releases a secret only for an exact authorized origin.
 * It never logs; stdout carries only the JSON-lines reply protocol.
 *
 * Self-contained CommonJS with built-in modules only, so the permission model
 * does not have to allow reading other source files.
 */
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const VAULT_VERSION = 1;
const MAX_ENTRIES = 500;
const ID = /^cred_[0-9a-f-]{36}$/;
const OP_REFERENCE = /^op:\/\/[^\s"'`\\]{3,500}$/;
const REASONS = new Set(['not_found', 'revoked', 'expired', 'integrity_failed', 'workspace_mismatch', 'origin_mismatch', 'frame_origin_mismatch',
  'provider_unavailable', 'provider_failed', 'provider_disabled', 'invalid_entry', 'locked', 'vault_full', 'unsupported']);
const fail = reason => Object.assign(new Error(reason), { reason: REASONS.has(reason) ? reason : 'invalid_entry' });

const LOOPBACK = new Set(['localhost', '127.0.0.1', '[::1]']);
/** Exact origin (scheme, host, port). HTTPS everywhere; plain HTTP only for loopback hosts. No wildcards or paths. */
function normalizeOrigin(value) {
  let url;
  try { url = new URL(String(value)); } catch { throw fail('invalid_entry'); }
  if (url.username || url.password || url.search || url.hash || !['/', ''].includes(url.pathname)) throw fail('invalid_entry');
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && LOOPBACK.has(url.hostname))) throw fail('invalid_entry');
  if (/[*]/.test(url.hostname)) throw fail('invalid_entry');
  return url.origin;
}

/** Safe account identifier shown to agents: never the full username. */
function maskAccount(value) {
  const text = String(value || '').trim();
  if (!text) return null;
  const at = text.lastIndexOf('@');
  if (at > 0) {
    const local = text.slice(0, at);
    return `${local[0]}${'*'.repeat(3)}${local.length > 3 ? local.at(-1) : ''}@${text.slice(at + 1).slice(0, 120)}`;
  }
  return text.length < 4 ? '***' : `${text[0]}***${text.at(-1)}`;
}

const canonical = value => JSON.stringify(value, (_key, item) => item && typeof item === 'object' && !Array.isArray(item)
  ? Object.fromEntries(Object.keys(item).sort().map(name => [name, item[name]])) : item);
/**
 * Security-relevant metadata authenticated by the seal: editing the file invalidates the entry.
 * Payment-card entries (ADR 019) also bind their kind, brand and last four digits; login entries
 * keep the original associated data so existing vaults stay valid.
 */
function associatedData(entry) {
  return Buffer.from(canonical({ v: VAULT_VERSION, id: entry.id, workspaceId: entry.workspaceId, label: entry.label, purpose: entry.purpose,
    origins: entry.origins, frameOrigins: entry.frameOrigins, provider: entry.provider, account: entry.account, createdAt: entry.createdAt,
    expiresAt: entry.expiresAt, revokedAt: entry.revokedAt, revision: entry.revision,
    ...(entry.kind && entry.kind !== 'login' ? { kind: entry.kind, brand: entry.brand ?? null, last4: entry.last4 ?? null } : {}) }));
}

/** Luhn-valid 12-19 digit card number, a month and an unexpired year, a 3-4 digit security code. Values never leave this process except on release. */
function validateCard(secret, now) {
  if (!secret || typeof secret !== 'object') throw fail('invalid_entry');
  const number = String(secret.number ?? '').replace(/[\s-]/g, '');
  const month = Number(secret.expMonth);
  let year = Number(secret.expYear);
  const cvc = String(secret.cvc ?? '');
  const name = String(secret.name ?? '').slice(0, 100);
  if (!/^\d{12,19}$/.test(number) || !/^\d{3,4}$/.test(cvc) || !Number.isInteger(month) || month < 1 || month > 12 || !Number.isInteger(year)) throw fail('invalid_entry');
  if (year < 100) year += 2000;
  let sum = 0;
  for (let index = 0; index < number.length; index++) {
    let digit = Number(number[number.length - 1 - index]);
    if (index % 2 === 1) { digit *= 2; if (digit > 9) digit -= 9; }
    sum += digit;
  }
  const today = new Date(now);
  if (sum % 10 !== 0 || year > today.getUTCFullYear() + 30 || year * 12 + month < today.getUTCFullYear() * 12 + today.getUTCMonth() + 1) throw fail('invalid_entry');
  return { number, expMonth: month, expYear: year, cvc, name };
}
function cardBrand(number) {
  const prefix = Number(number.slice(0, 4));
  if (/^4/.test(number)) return 'Visa';
  if (/^5[1-5]/.test(number) || (prefix >= 2221 && prefix <= 2720)) return 'Mastercard';
  if (/^3[47]/.test(number)) return 'American Express';
  if (/^(6011|65|64[4-9])/.test(number)) return 'Discover';
  if (/^35(2[89]|[3-8])/.test(number)) return 'JCB';
  if (/^(36|38|30[0-5])/.test(number)) return 'Diners Club';
  if (/^62/.test(number)) return 'UnionPay';
  return 'Card';
}
function seal(key, entry, payload) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  cipher.setAAD(associatedData(entry));
  const data = Buffer.concat([cipher.update(Buffer.from(JSON.stringify(payload), 'utf8')), cipher.final()]);
  return { alg: 'A256GCM', iv: iv.toString('base64'), tag: cipher.getAuthTag().toString('base64'), data: data.toString('base64') };
}
function open(key, entry) {
  try {
    const decipher = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(entry.seal.iv, 'base64'));
    decipher.setAAD(associatedData(entry));
    decipher.setAuthTag(Buffer.from(entry.seal.tag, 'base64'));
    const plain = Buffer.concat([decipher.update(Buffer.from(entry.seal.data, 'base64')), decipher.final()]);
    const payload = JSON.parse(plain.toString('utf8'));
    plain.fill(0);
    return payload;
  } catch { throw fail('integrity_failed'); }
}

/** External vault adapters. Each resolves a sealed payload to {username, password} at release time only. */
class OnePasswordCli {
  constructor({ command, timeoutMs = 15000 }) { this.command = command; this.timeoutMs = timeoutMs; }
  static validate(reference) {
    if (!reference || !OP_REFERENCE.test(reference.password || '') || (reference.username != null && !OP_REFERENCE.test(reference.username))) throw fail('invalid_entry');
    return { password: reference.password, ...(reference.username ? { username: reference.username } : {}) };
  }
  read(reference) {
    // execFile without a shell: the reference is one argument; output and errors never leave this process.
    return new Promise((resolve, reject) => {
      let childProcess;
      try { childProcess = require('node:child_process'); } catch { reject(fail('provider_unavailable')); return; }
      try {
        childProcess.execFile(this.command, ['read', '--no-newline', reference], { env: process.env, timeout: this.timeoutMs, maxBuffer: 65536, windowsHide: true, shell: false },
          (error, stdout) => {
            if (error) { reject(fail(error.code === 'ENOENT' || error.code === 'ERR_ACCESS_DENIED' ? 'provider_unavailable' : 'provider_failed')); return; }
            const value = String(stdout);
            if (!value || value.length > 4096) { reject(fail('provider_failed')); return; }
            resolve(value);
          });
      } catch { reject(fail('provider_unavailable')); }
    });
  }
  async resolve(payload) {
    const password = await this.read(payload.reference.password);
    const username = payload.reference.username ? await this.read(payload.reference.username) : '';
    return { username, password };
  }
}

class Vault {
  constructor({ directory, key, providers = {}, clock = Date.now }) {
    if (!Buffer.isBuffer(key) || key.length !== 32) throw fail('locked');
    Object.assign(this, { directory, key, clock, providers });
    this.file = path.join(directory, 'vault.json');
    this.entries = [];
    try {
      const saved = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      if (saved.version !== VAULT_VERSION || !Array.isArray(saved.entries)) throw fail('integrity_failed');
      this.entries = saved.entries.filter(entry => entry && ID.test(entry.id));
    } catch (error) { if (error.code !== 'ENOENT') throw error.reason ? error : fail('integrity_failed'); }
  }
  save() {
    const temporary = `${this.file}.${crypto.randomUUID()}.tmp`;
    // Node's permission model disables fsync(); writeFile's flush option is used where the runtime allows it.
    const data = JSON.stringify({ version: VAULT_VERSION, entries: this.entries });
    try { fs.writeFileSync(temporary, data, { flag: 'wx', mode: 0o600, flush: true }); }
    catch (error) { if (error.code !== 'ERR_ACCESS_DENIED') throw error; fs.rmSync(temporary, { force: true }); fs.writeFileSync(temporary, data, { flag: 'wx', mode: 0o600 }); }
    if (fs.readFileSync(temporary, 'utf8') !== data) throw fail('integrity_failed');
    fs.renameSync(temporary, this.file);
  }
  status(entry) {
    let integrity = 'verified';
    try { const payload = open(this.key, entry); if (payload.password) payload.password = ''; }
    catch { integrity = 'failed'; }
    const expired = entry.expiresAt && Date.parse(entry.expiresAt) <= this.clock();
    return { integrity, state: integrity === 'failed' ? 'integrity_failed' : entry.revokedAt ? 'revoked' : expired ? 'expired' : 'active' };
  }
  describe(entry) {
    const { seal: _seal, ...metadata } = entry;
    return { ...metadata, ...this.status(entry) };
  }
  find(id) {
    const entry = this.entries.find(item => item.id === id);
    if (!entry) throw fail('not_found');
    return entry;
  }
  list() { return this.entries.map(entry => this.describe(entry)); }
  /** Secret material arrives only here, from the browser-owned entry dialog via the main process. */
  create(input, secret) {
    if (this.entries.length >= MAX_ENTRIES) throw fail('vault_full');
    const provider = input.provider === 'onepassword' ? 'onepassword' : 'local';
    const origins = [...new Set((input.origins || []).map(normalizeOrigin))];
    const frameOrigins = [...new Set((input.frameOrigins || []).map(normalizeOrigin))];
    if (!origins.length || origins.length > 10 || frameOrigins.length > 10) throw fail('invalid_entry');
    if (input.expiresAt != null && !(Date.parse(input.expiresAt) > this.clock())) throw fail('invalid_entry');
    let payload;
    let account = input.accountLabel ? String(input.accountLabel).slice(0, 120) : null;
    const card = input.kind === 'payment_card';
    let cardMeta = {};
    if (card) {
      // Payment cards are kept only in this vault (no external provider); the security code never leaves it except on release.
      if (provider !== 'local') throw fail('invalid_entry');
      const value = validateCard(secret, this.clock());
      payload = { kind: 'payment_card', ...value };
      cardMeta = { kind: 'payment_card', brand: cardBrand(value.number), last4: value.number.slice(-4) };
      account = account ?? `${cardMeta.brand} •••• ${cardMeta.last4}`;
    } else if (provider === 'local') {
      if (!secret || typeof secret.password !== 'string' || !secret.password || secret.password.length > 4096 || (secret.username != null && (typeof secret.username !== 'string' || secret.username.length > 512))) throw fail('invalid_entry');
      payload = { kind: 'local', username: secret.username || '', password: secret.password };
      account = account ?? maskAccount(secret.username);
    } else {
      if (!this.providers.onepassword) throw fail('provider_disabled');
      payload = { kind: 'onepassword', reference: OnePasswordCli.validate(input.reference) };
    }
    const now = new Date(this.clock()).toISOString();
    const entry = { id: `cred_${crypto.randomUUID()}`, workspaceId: String(input.workspaceId).slice(0, 200), label: String(input.label).slice(0, 120),
      purpose: String(input.purpose).slice(0, 300), origins, frameOrigins, provider, account, createdAt: now, updatedAt: now,
      expiresAt: input.expiresAt ? new Date(input.expiresAt).toISOString() : null, revokedAt: null, revision: 1, ...cardMeta };
    entry.seal = seal(this.key, entry, payload);
    if (payload.password) payload.password = '';
    if (card) { payload.number = ''; payload.cvc = ''; }
    this.entries.push(entry);
    this.save();
    return this.describe(entry);
  }
  /** Metadata changes re-seal the entry so the new authorization is authenticated. Revoked entries stay revoked. */
  update(id, changes) {
    const entry = this.find(id);
    const payload = open(this.key, entry);
    if (entry.revokedAt) throw fail('revoked');
    const next = { ...entry };
    if (changes.label != null) next.label = String(changes.label).slice(0, 120);
    if (changes.purpose != null) next.purpose = String(changes.purpose).slice(0, 300);
    if (changes.origins) { next.origins = [...new Set(changes.origins.map(normalizeOrigin))]; if (!next.origins.length || next.origins.length > 10) throw fail('invalid_entry'); }
    if (changes.frameOrigins) { next.frameOrigins = [...new Set(changes.frameOrigins.map(normalizeOrigin))]; if (next.frameOrigins.length > 10) throw fail('invalid_entry'); }
    if (changes.expiresAt !== undefined) {
      if (changes.expiresAt !== null && !(Date.parse(changes.expiresAt) > this.clock())) throw fail('invalid_entry');
      next.expiresAt = changes.expiresAt === null ? null : new Date(changes.expiresAt).toISOString();
    }
    return this.reseal(entry, next, payload);
  }
  reseal(entry, next, payload) {
    next.revision = entry.revision + 1;
    next.updatedAt = new Date(this.clock()).toISOString();
    next.seal = seal(this.key, next, payload);
    if (payload.password) payload.password = '';
    this.entries = this.entries.map(item => item.id === entry.id ? next : item);
    this.save();
    return this.describe(next);
  }
  revoke(id) {
    const entry = this.find(id);
    if (entry.revokedAt && this.status(entry).integrity === 'verified') return this.describe(entry);
    // The secret itself is discarded on revocation: a revoked reference can never be used again.
    // A tampered entry can still be revoked (its unverifiable contents are dropped).
    return this.reseal(entry, { ...entry, revokedAt: new Date(this.clock()).toISOString() }, { kind: entry.provider, revoked: true });
  }
  remove(id) {
    this.find(id);
    this.entries = this.entries.filter(item => item.id !== id);
    this.save();
    return { id, deleted: true };
  }
  /**
   * The only path that returns secret material. The main process supplies the
   * browser-verified top-level and target-frame origins; they must match the
   * authenticated metadata exactly at this moment.
   */
  async release(id, request) {
    const entry = this.find(id);
    const payload = open(this.key, entry);
    if (entry.workspaceId !== request.workspaceId) throw fail('workspace_mismatch');
    if (entry.revokedAt || payload.revoked) throw fail('revoked');
    if (entry.expiresAt && Date.parse(entry.expiresAt) <= this.clock()) throw fail('expired');
    let top;
    let frames;
    // A login fill names one target frame; a card fill names every frame that holds card fields.
    const requested = Array.isArray(request.frameOrigins) ? request.frameOrigins.slice(0, 10) : [request.frameOrigin];
    try { top = normalizeOrigin(request.topOrigin); frames = requested.map(normalizeOrigin); } catch { throw fail('origin_mismatch'); }
    if (!entry.origins.includes(top)) throw fail('origin_mismatch');
    if (!frames.length || frames.some(frame => frame !== top && !entry.frameOrigins.includes(frame))) throw fail('frame_origin_mismatch');
    if (payload.kind === 'payment_card') return { number: payload.number, expMonth: payload.expMonth, expYear: payload.expYear, cvc: payload.cvc, name: payload.name };
    if (payload.kind === 'local') return { username: payload.username, password: payload.password };
    const adapter = this.providers[payload.kind];
    if (!adapter) throw fail('provider_disabled');
    return adapter.resolve(payload);
  }
}

module.exports = { normalizeOrigin, maskAccount, associatedData, seal, open, Vault, OnePasswordCli, REASONS, validateCard, cardBrand };

if (require.main === module) {
  let vault = null;
  let buffered = '';
  const send = message => process.stdout.write(`${JSON.stringify(message)}\n`);
  const handle = async message => {
    if (message.type === 'init') {
      if (vault) throw fail('unsupported');
      const key = Buffer.from(String(message.key || ''), 'base64');
      const providers = {};
      if (message.providers?.onepassword?.command) providers.onepassword = new OnePasswordCli({ command: String(message.providers.onepassword.command) });
      vault = new Vault({ directory: String(message.directory), key, providers });
      return { ready: true, providers: Object.keys(providers) };
    }
    if (!vault) throw fail('locked');
    switch (message.type) {
      case 'list': return vault.list();
      case 'create': return vault.create(message.input || {}, message.secret || null);
      case 'update': return vault.update(message.id, message.changes || {});
      case 'revoke': return vault.revoke(message.id);
      case 'delete': return vault.remove(message.id);
      case 'release': return vault.release(message.id, message.request || {});
      default: throw fail('unsupported');
    }
  };
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', chunk => {
    buffered += chunk;
    if (buffered.length > 1024 * 1024) process.exit(2);
    let index;
    while ((index = buffered.indexOf('\n')) >= 0) {
      const line = buffered.slice(0, index);
      buffered = buffered.slice(index + 1);
      let message;
      try { message = JSON.parse(line); } catch { process.exit(2); }
      Promise.resolve().then(() => handle(message)).then(
        result => send({ seq: message.seq, ok: true, result }),
        error => send({ seq: message.seq, ok: false, reason: REASONS.has(error?.reason) ? error.reason : 'invalid_entry' }));
    }
  });
  process.stdin.on('end', () => process.exit(0));
}
