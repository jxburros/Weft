import { createCipheriv, createDecipheriv, randomBytes, randomInt, randomUUID } from 'node:crypto';
import { lstatSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';
import { z } from 'zod';
import { readJson, writeJsonDurable } from './atomic-json.js';
import { classify } from './autonomy.js';
import { topOrigin } from './site-permissions.js';

/**
 * The person's own saved passwords (#95, ADR-020). A separate vault from the agent credential broker
 * (ADR-017): entries are sealed with AES-256-GCM under a data key wrapped by OS-protected storage, and
 * every command is human-only. Agents cannot list, read, fill or reveal these entries, and nothing here
 * reaches model context, the activity log (origins and actions only), captures or workspace exports.
 * Saving is offered only after a person submits a sign-in form; filling happens only when a person
 * chooses an entry in Weft's own interface, and only into frames on the saved origin.
 */
export const PASSWORD_WORLD = 1361;
const OFFER_TTL_MS = 120_000;
const CANDIDATE_GESTURE_MS = 10_000;
const LIMITS = Object.freeze({ entries: 5000, importBytes: 5 * 1024 * 1024, field: 1000 });
const workspaceId = z.string().min(1).max(200).optional();
const id = z.string().regex(/^pw_[0-9a-f-]{36}$/).describe('Saved password entry id from passwords.list.');
const origin = z.string().max(2048).refine(value => topOrigin(value) === value, 'Expected an http(s) origin such as https://example.com');
const absolute = z.string().min(1).max(4096).refine(value => isAbsolute(value) && !value.includes('\0'), 'Expected an absolute file path chosen by the person');
export const passwordCommandDefinitions = {
  'passwords.list': ['Human lists the saved sign-ins of a workspace (sites and usernames, never passwords), sites never saved, and pending save offers', { workspaceId }],
  'passwords.respondOffer': ['Human answers a save-password offer after a sign-in: save (or update), never for this site, or not now', {
    offerId: z.string().regex(/^pwo_[0-9a-f-]{36}$/), action: z.enum(['save', 'never', 'dismiss']) }],
  'passwords.save': ['Human saves a sign-in by hand', { workspaceId, origin, username: z.string().max(LIMITS.field), password: z.string().min(1).max(LIMITS.field) }],
  'passwords.update': ['Human edits a saved sign-in or shares it with other workspaces', { id, changes: z.strictObject({ username: z.string().max(LIMITS.field).optional(),
    password: z.string().min(1).max(LIMITS.field).optional(), sharedWith: z.array(z.string().min(1).max(200)).max(50).optional().describe('Other workspaces that may use this sign-in.') }) }],
  'passwords.delete': ['Human deletes a saved sign-in', { id }],
  'passwords.reveal': ['Human shows one saved password after confirming in a browser-owned dialog', { id }],
  'passwords.fill': ['Human fills a saved sign-in into a tab whose page is on the saved site (never another site or frame)', { id, tabId: z.number().int().positive() }],
  'passwords.generate': ['Human fills a generated strong password into the new-password fields of the current page', { tabId: z.number().int().positive(), length: z.number().int().min(12).max(64).default(20) }],
  'passwords.forgetNever': ['Human lets Weft offer to save passwords on a site again', { workspaceId, origin }],
  'passwords.import': ['Human imports sign-ins from a Chrome, Edge, Firefox or Safari CSV export chosen in a file dialog', { workspaceId, path: absolute,
    deleteSource: z.boolean().default(false).describe('Delete the plaintext export after a successful import.') }],
  'passwords.export': ['Human exports this workspace\'s sign-ins as a plaintext CSV file (acknowledgement required)', { workspaceId, path: absolute, acknowledgePlaintext: z.literal(true) }],
};
export const PASSWORD_COMMANDS = Object.freeze(Object.keys(passwordCommandDefinitions));
// Every command is human-only; listing is a read so the person's own browsing is not logged as administration.
classify('administration', PASSWORD_COMMANDS.filter(name => name !== 'passwords.list'));
classify('local_read', 'passwords.list');
const schemas = Object.fromEntries(Object.entries(passwordCommandDefinitions).map(([name, [, shape]]) => [name, z.strictObject(shape)]));
const failure = (code, message, details) => Object.assign(new Error(message), { code, ...(details && { details }) });

/** Installed in the top frame's own isolated world: remembers the sign-in a person submits, until Weft takes it. */
export const CAPTURE_SCRIPT = `(() => {
  if (globalThis.__weftPasswordCapture) return true;
  const state = globalThis.__weftPasswordCapture = { candidate: null };
  const text = el => el && el.localName === 'input' && ['text', 'email', 'tel', ''].includes(el.type) && el.value;
  const read = root => {
    const scope = root || document;
    const passwords = [...scope.querySelectorAll('input[type=password]')].filter(el => el.value);
    if (!passwords.length || passwords.length > 3) return null;
    const fields = [...scope.querySelectorAll('input')];
    const before = fields.slice(0, fields.indexOf(passwords[0])).reverse();
    const username = before.find(el => /user|mail|login|account/i.test((el.autocomplete || '') + ' ' + el.name + ' ' + el.id) && text(el)) || before.find(text);
    // A sign-up or change form has a new password last (confirm fields repeat it).
    return { username: String(username?.value || '').slice(0, ${LIMITS.field}), password: passwords[passwords.length - 1].value.slice(0, ${LIMITS.field}),
      origin: location.origin, change: passwords.length > 1, at: Date.now() };
  };
  const capture = form => { const found = read(form); if (found) state.candidate = found; };
  // Read when a person presses the mouse or Enter, before any navigation can start.
  state.snapshot = () => { const form = document.activeElement?.form || null; return read(form) || read(null); };
  document.addEventListener('submit', event => { if (event.isTrusted || event.submitter) capture(event.target); }, true);
  document.addEventListener('click', event => {
    if (!event.isTrusted) return;
    const control = event.target?.closest?.('button, input[type=submit], input[type=button], [role=button]');
    if (control) capture(control.form || control.closest('form'));
  }, true);
  document.addEventListener('keydown', event => { if (event.isTrusted && event.key === 'Enter' && event.target?.localName === 'input') capture(event.target.form); }, true);
  return true;
})()`;
const SNAPSHOT_SCRIPT = '(() => globalThis.__weftPasswordCapture?.snapshot?.() ?? null)()';
const TAKE_SCRIPT = '(() => { const state = globalThis.__weftPasswordCapture; const found = state?.candidate ?? null; if (state) state.candidate = null; return found; })()';
const GENERATE_SCRIPT = value => `(() => {
  const visible = el => el.isConnected && el.getClientRects().length > 0 && !el.disabled && !el.readOnly;
  const all = [...document.querySelectorAll('input[type=password]')].filter(visible);
  const marked = all.filter(el => /new-password/i.test(el.autocomplete || ''));
  const targets = (marked.length ? marked : all.filter(el => !el.value)).slice(0, 2);
  const view = document.defaultView;
  for (const el of targets) {
    Object.getOwnPropertyDescriptor(view.HTMLInputElement.prototype, 'value').set.call(el, ${JSON.stringify(value)});
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
    el.setAttribute('data-weft-credential', 'secret');
  }
  return { filled: targets.length };
})()`;
const GENERATOR_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789-_.!@#%';
export function generatePassword(length = 20) {
  let value = '';
  // Guarantee each class so common site rules accept it.
  const classes = ['ABCDEFGHJKLMNPQRSTUVWXYZ', 'abcdefghijkmnopqrstuvwxyz', '23456789', '-_.!@#%'];
  do { value = Array.from({ length }, () => GENERATOR_ALPHABET[randomInt(GENERATOR_ALPHABET.length)]).join(''); }
  while (!classes.every(set => [...value].some(ch => set.includes(ch))));
  return value;
}

/** RFC 4180 CSV rows (quoted fields, doubled quotes, CRLF or LF). */
export function parseCsv(text) {
  const rows = [];
  let row = [], field = '', quoted = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quoted) {
      if (ch === '"' && text[i + 1] === '"') { field += '"'; i++; }
      else if (ch === '"') quoted = false;
      else field += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === ',') { row.push(field); field = ''; }
    else if (ch === '\n' || ch === '\r') { if (ch === '\r' && text[i + 1] === '\n') i++; row.push(field); rows.push(row); row = []; field = ''; }
    else field += ch;
  }
  if (field || row.length) { row.push(field); rows.push(row); }
  return rows.filter(item => item.some(value => value !== ''));
}
const csvField = value => /[",\r\n]/.test(value) ? `"${String(value).replaceAll('"', '""')}"` : String(value);

/** Sign-ins from a browser export: Chrome/Edge (name,url,username,password,note), Firefox (url,username,password,…) and Safari (Title,URL,Username,Password,…). */
export function importRows(text) {
  const [header, ...rows] = parseCsv(text.replace(/^﻿/, ''));
  if (!header) return { entries: [], skipped: 0 };
  const column = name => header.findIndex(item => item.trim().toLowerCase() === name);
  const url = column('url'), username = column('username'), password = column('password');
  if (url < 0 || password < 0) throw failure('invalid_arguments', 'The file is not a password export: it needs url and password columns');
  const entries = [];
  let skipped = 0;
  for (const row of rows) {
    const site = topOrigin(row[url] ?? '');
    const secret = String(row[password] ?? '');
    if (!site || !secret || secret.length > LIMITS.field) { skipped++; continue; }
    entries.push({ origin: site, username: String(row[username] ?? '').slice(0, LIMITS.field), password: secret });
  }
  return { entries, skipped };
}

export class PasswordService {
  constructor({ directory, protector, browser = null, workspace = null, confirmReveal = async () => false, audit = () => {}, now = () => Date.now() }) {
    Object.assign(this, { directory, protector, browser, workspace, confirmReveal, audit, now });
    this.path = join(directory, 'vault.json');
    const saved = readJson(this.path, { version: 1, wrappedKey: null, entries: [], never: [] });
    if (saved.version !== 1 || !Array.isArray(saved.entries) || !Array.isArray(saved.never)) throw new Error('Invalid password vault');
    this.vault = saved;
    this.key = null;
    this.offers = new Map();
    this.queue = Promise.resolve();
    if (browser) browser.passwords = this;
  }

  protection() { try { return this.protector?.status?.() ?? { protected: false }; } catch { return { protected: false }; } }

  dataKey() {
    if (this.key) return this.key;
    if (!this.protection().protected) throw failure('unavailable', 'OS-protected storage is unavailable (or Linux is using the basic_text backend); Weft does not save passwords without it', { credential: 'unprotected_storage' });
    if (this.vault.wrappedKey) this.key = Buffer.from(this.protector.unwrap(Buffer.from(this.vault.wrappedKey, 'base64')), 'base64');
    else {
      this.key = randomBytes(32);
      this.vault.wrappedKey = Buffer.from(this.protector.wrap(this.key.toString('base64'))).toString('base64');
    }
    return this.key;
  }

  seal(entry, secret) {
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', this.dataKey(), iv);
    cipher.setAAD(Buffer.from(`${entry.id}|${entry.workspaceId}|${entry.origin}`));
    const body = Buffer.concat([cipher.update(JSON.stringify(secret), 'utf8'), cipher.final()]);
    return Buffer.concat([iv, cipher.getAuthTag(), body]).toString('base64');
  }

  open(entry) {
    const bytes = Buffer.from(entry.sealed, 'base64');
    const decipher = createDecipheriv('aes-256-gcm', this.dataKey(), bytes.subarray(0, 12));
    decipher.setAAD(Buffer.from(`${entry.id}|${entry.workspaceId}|${entry.origin}`));
    decipher.setAuthTag(bytes.subarray(12, 28));
    return JSON.parse(Buffer.concat([decipher.update(bytes.subarray(28)), decipher.final()]).toString('utf8'));
  }

  save() { mkdirSync(this.directory, { recursive: true, mode: 0o700 }); writeJsonDurable(this.path, this.vault); }
  visible(workspace) { return this.vault.entries.filter(item => item.workspaceId === workspace || item.sharedWith?.includes(workspace)); }
  entry(entryId) { const found = this.vault.entries.find(item => item.id === entryId); if (!found) throw failure('not_found', 'Saved sign-in not found'); return found; }

  upsert(workspace, site, username, password) {
    const existing = this.visible(workspace).find(item => item.origin === site && this.open(item).username === username);
    if (existing) { existing.sealed = this.seal(existing, { username, password }); existing.updatedAt = new Date(this.now()).toISOString(); return { entry: existing, updated: true }; }
    if (this.vault.entries.length >= LIMITS.entries) throw failure('invalid_arguments', `At most ${LIMITS.entries} sign-ins can be saved`);
    const entry = { id: `pw_${randomUUID()}`, workspaceId: workspace, origin: site, sharedWith: [], createdAt: new Date(this.now()).toISOString(), updatedAt: new Date(this.now()).toISOString() };
    entry.sealed = this.seal(entry, { username, password });
    this.vault.entries.push(entry);
    return { entry, updated: false };
  }

  summary(entry, workspace) {
    let username = '';
    try { username = this.open(entry).username; } catch { username = '(cannot be opened)'; }
    return { id: entry.id, workspaceId: entry.workspaceId, origin: entry.origin, username, shared: entry.workspaceId !== workspace, sharedWith: entry.sharedWith ?? [], createdAt: entry.createdAt, updatedAt: entry.updatedAt };
  }

  // ---- Capture after a person submits a sign-in form ------------------------------------------
  /** Wire one page: install the capture script after each load and take a candidate after human submission. */
  watch(tab, contents) {
    if (typeof contents.executeJavaScriptInIsolatedWorld !== 'function') return;
    const install = () => { void contents.executeJavaScriptInIsolatedWorld(PASSWORD_WORLD, [{ code: CAPTURE_SCRIPT }]).catch(() => {}); };
    contents.on('dom-ready', install);
    // Electron defers page scripts while a main-frame navigation loads, so a form post cannot be read once it
    // starts: the filled form is read when the person presses the mouse or Enter, and offered if a navigation follows.
    let pressed = null;
    const navigated = () => {
      const candidate = pressed && this.now() - pressed.at < CANDIDATE_GESTURE_MS ? pressed.candidate : null;
      pressed = null;
      if (candidate && this.browser?.recentHumanInput?.(tab, CANDIDATE_GESTURE_MS)) void this.offer(tab, candidate).catch(() => {});
    };
    contents.on('will-navigate', navigated);
    contents.on('did-start-navigation', details => { if (details?.isMainFrame && !details.isSameDocument) navigated(); });
    const input = (_event, data) => {
      const enter = data?.key === 'Enter';
      if (data?.type === 'mouseDown' || (['keyDown', 'rawKeyDown'].includes(data?.type) && enter)) {
        if (contents.isLoadingMainFrame?.()) return;
        void contents.executeJavaScriptInIsolatedWorld(PASSWORD_WORLD, [{ code: SNAPSHOT_SCRIPT }])
          .then(candidate => { pressed = candidate?.password ? { candidate, at: this.now() } : null; }, () => {});
      }
      // Script sign-ins (fetch) do not navigate: take the submitted form shortly after the click or Enter.
      if (data?.type === 'mouseUp' || (data?.type === 'keyUp' && enter)) setTimeout(() => this.take(tab, contents), 800).unref?.();
    };
    contents.on('before-input-event', input);
    contents.on('before-mouse-event', input);
  }

  async take(tab, contents) {
    if (!this.browser?.recentHumanInput?.(tab, CANDIDATE_GESTURE_MS) || contents.isDestroyed?.() || contents.isLoadingMainFrame?.()) return;
    let candidate = null;
    try { candidate = await contents.executeJavaScriptInIsolatedWorld(PASSWORD_WORLD, [{ code: TAKE_SCRIPT }]); } catch { return; }
    if (!candidate || typeof candidate.password !== 'string' || !candidate.password) return;
    void this.offer(tab, candidate).catch(() => {});
  }

  async offer(tab, candidate) {
    const site = topOrigin(candidate.origin);
    if (!site || site !== topOrigin(tab.url || '') && site !== topOrigin(tab.view?.webContents?.getURL?.() || '')) return null;
    if (this.vault.never.some(item => item.workspaceId === tab.workspaceId && item.origin === site)) return null;
    if (!this.protection().protected) return null;
    const username = String(candidate.username || '').slice(0, LIMITS.field);
    const match = this.visible(tab.workspaceId).filter(item => item.origin === site).map(item => ({ item, secret: this.open(item) }));
    const same = match.find(({ secret }) => secret.username === username);
    if (same && same.secret.password === candidate.password) return null;
    for (const existing of [...this.offers.values()]) if (existing.tabId === tab.id) this.offers.delete(existing.id);
    const offer = { id: `pwo_${randomUUID()}`, tabId: tab.id, workspaceId: tab.workspaceId, origin: site, username, kind: same ? 'update' : 'save',
      expiresAt: new Date(this.now() + OFFER_TTL_MS).toISOString(), secret: candidate.password };
    this.offers.set(offer.id, offer);
    setTimeout(() => { if (this.offers.get(offer.id) === offer) { offer.secret = ''; this.offers.delete(offer.id); } }, OFFER_TTL_MS).unref?.();
    this.browser?.onSitePrompt?.({ kind: 'password', tabId: tab.id });
    return offer;
  }

  /** Save-offer state for the trusted interface: site, username and kind only. */
  offerFor(tabId) {
    const offer = [...this.offers.values()].find(item => item.tabId === tabId);
    return offer ? { id: offer.id, origin: offer.origin, username: offer.username, kind: offer.kind, expiresAt: offer.expiresAt } : null;
  }

  /** Saved sign-ins available on a tab's page, for the address-bar key menu (no passwords). */
  available(tab) {
    const site = topOrigin(tab?.view?.webContents?.getURL?.() || tab?.url || '');
    if (!site || !this.vault.entries.length) return [];
    try { return this.visible(tab.workspaceId).filter(item => item.origin === site).map(item => ({ id: item.id, username: this.summary(item, tab.workspaceId).username })); }
    catch { return []; }
  }

  // ---- Commands ----------------------------------------------------------------------------------
  execute(name, input, context = {}) {
    // Defense in depth: the dispatcher already refuses these for every non-human caller.
    if (!['human', 'admin'].includes(context.actor)) return Promise.reject(failure('permission_required', 'Saved passwords are available only to the person, in Weft\'s own interface'));
    const run = this.queue.then(() => this.dispatch(name, schemas[name]?.parse(input) ?? input, context));
    this.queue = run.catch(() => {});
    return run;
  }

  async dispatch(name, args) {
    if (!schemas[name]) throw failure('unknown_command', `Unknown password command ${name}`);
    const workspace = args.workspaceId ?? this.workspace?.activeWorkspaceId ?? this.browser?.workspaceId ?? 'general';
    const log = (reason, summary) => this.audit({ type: 'decision', reason, outcome: 'recorded', workspaceId: workspace, summary });
    if (name === 'passwords.list') {
      return { workspaceId: workspace, protection: this.protection(), entries: this.vault.entries.length && this.protection().protected ? this.visible(workspace).map(item => this.summary(item, workspace)) : [],
        never: this.vault.never.filter(item => item.workspaceId === workspace).map(item => item.origin),
        offers: [...this.offers.values()].filter(item => item.workspaceId === workspace).map(item => this.offerFor(item.tabId)),
        notice: 'Your saved passwords are separate from agent sign-ins. Agents cannot list, read, fill or reveal them.' };
    }
    if (name === 'passwords.respondOffer') {
      const offer = this.offers.get(args.offerId);
      if (!offer) throw failure('not_found', 'The save offer expired or was answered');
      this.offers.delete(offer.id);
      const secret = offer.secret;
      offer.secret = '';
      if (args.action === 'dismiss') return { action: 'dismiss' };
      if (args.action === 'never') {
        if (!this.vault.never.some(item => item.workspaceId === offer.workspaceId && item.origin === offer.origin)) this.vault.never.push({ workspaceId: offer.workspaceId, origin: offer.origin });
        this.save();
        log('password_never_save', { origin: offer.origin });
        return { action: 'never', origin: offer.origin };
      }
      const { entry, updated } = this.upsert(offer.workspaceId, offer.origin, offer.username, secret);
      this.save();
      log(updated ? 'password_updated' : 'password_saved', { origin: offer.origin });
      return { action: 'save', updated, entry: this.summary(entry, offer.workspaceId) };
    }
    if (name === 'passwords.save') {
      this.workspace?.workspace?.(workspace);
      const { entry, updated } = this.upsert(workspace, args.origin, args.username, args.password);
      this.save();
      log(updated ? 'password_updated' : 'password_saved', { origin: args.origin });
      return { updated, entry: this.summary(entry, workspace) };
    }
    if (name === 'passwords.update') {
      const entry = this.entry(args.id);
      const secret = this.open(entry);
      if (args.changes.sharedWith) {
        for (const target of args.changes.sharedWith) this.workspace?.workspace?.(target);
        entry.sharedWith = [...new Set(args.changes.sharedWith.filter(item => item !== entry.workspaceId))];
      }
      if (args.changes.username != null || args.changes.password != null) entry.sealed = this.seal(entry, { username: args.changes.username ?? secret.username, password: args.changes.password ?? secret.password });
      entry.updatedAt = new Date(this.now()).toISOString();
      this.save();
      log('password_updated', { origin: entry.origin, shared: entry.sharedWith.length });
      return this.summary(entry, entry.workspaceId);
    }
    if (name === 'passwords.delete') {
      const entry = this.entry(args.id);
      this.vault.entries = this.vault.entries.filter(item => item !== entry);
      this.save();
      log('password_deleted', { origin: entry.origin });
      return { deleted: entry.id };
    }
    if (name === 'passwords.reveal') {
      const entry = this.entry(args.id);
      const secret = this.open(entry);
      if (!(await this.confirmReveal({ origin: entry.origin, username: secret.username }))) throw failure('cancelled', 'The password was not shown');
      log('password_revealed', { origin: entry.origin });
      return { id: entry.id, origin: entry.origin, username: secret.username, password: secret.password };
    }
    if (name === 'passwords.forgetNever') {
      this.vault.never = this.vault.never.filter(item => !(item.workspaceId === workspace && item.origin === args.origin));
      this.save();
      return { origin: args.origin };
    }
    if (name === 'passwords.import') {
      let stat;
      try { stat = lstatSync(args.path); } catch { throw failure('not_found', 'File not found'); }
      if (!stat.isFile()) throw failure('invalid_arguments', 'Choose a regular file (not a folder or link)');
      if (stat.size > LIMITS.importBytes) throw failure('request_too_large', 'Password exports are limited to 5 MiB');
      this.workspace?.workspace?.(workspace);
      const { entries, skipped } = importRows(readFileSync(args.path, 'utf8'));
      let imported = 0, updated = 0;
      for (const item of entries) { const result = this.upsert(workspace, item.origin, item.username, item.password); if (result.updated) updated++; else imported++; item.password = ''; }
      this.save();
      if (args.deleteSource) rmSync(args.path, { force: true });
      log('password_import', { imported, updated, skipped });
      return { imported, updated, skipped, sourceDeleted: args.deleteSource,
        notice: args.deleteSource ? 'Imported. The plaintext export was deleted.' : 'Imported. The export file still holds your passwords in plain text; delete it when you no longer need it.' };
    }
    if (name === 'passwords.export') {
      const rows = this.visible(workspace).filter(item => item.workspaceId === workspace).map(item => { const secret = this.open(item); return ['', item.origin, secret.username, secret.password, ''].map(csvField).join(','); });
      writeFileSync(args.path, `name,url,username,password,note\n${rows.join('\n')}\n`, { flag: 'wx', mode: 0o600 });
      log('password_export', { entries: rows.length });
      return { exported: rows.length, path: args.path, notice: 'This file holds passwords in plain text. Keep it safe and delete it after use.' };
    }
    if (name === 'passwords.fill') return this.fill(args, workspace);
    if (name === 'passwords.generate') return this.generate(args);
    throw failure('unknown_command', `Unknown password command ${name}`);
  }

  /** Fill only frames whose origin is the saved origin, and only when the page's top-level site is that origin. */
  async fill(args) {
    const browser = this.browser;
    const tab = browser.tab(args.tabId);
    const entry = this.entry(args.id);
    if (!(entry.workspaceId === tab.workspaceId || entry.sharedWith?.includes(tab.workspaceId))) throw failure('target_mismatch', 'This sign-in is not saved for this workspace');
    const contents = tab.view.webContents;
    const site = topOrigin(contents.getURL());
    if (site !== entry.origin) throw failure('target_mismatch', 'This page is not on the site the sign-in was saved for; nothing was filled', { credential: 'origin_mismatch' });
    if (browser.protectedReason?.(tab)) throw failure('permission_required', 'An agent sign-in is in progress on this tab; try again in a moment');
    const main = contents.mainFrame;
    const frames = [main, ...(main.framesInSubtree ?? []).filter(item => item !== main)].filter(frame => !frame.isDestroyed?.() && frame.origin === entry.origin);
    let target = null;
    for (const frame of frames) {
      let probe = null;
      try { probe = await browser.credentialFrameScript(contents, frame, 'probe', { origin: entry.origin }); } catch { continue; }
      if (probe?.ok) { target = frame; break; }
    }
    if (!target) throw failure('not_found', 'No sign-in form with one password field was found on this page');
    const secret = this.open(entry);
    try {
      // From here a password may be in the page: the same residue protections as a brokered fill apply.
      tab.credentialFill = { document: tab.documentSerial ?? 0, at: Date.now(), top: target === main, kind: 'human_password' };
      const result = await browser.credentialFrameScript(contents, target, 'fill', { origin: entry.origin, username: secret.username, password: secret.password, submit: false });
      if (!result?.ok) throw failure('stale_state', 'The sign-in form changed; nothing was filled', { reason: 'element_changed' });
      this.audit({ type: 'decision', reason: 'password_filled', outcome: 'recorded', workspaceId: tab.workspaceId, tabId: tab.id, summary: { origin: entry.origin } });
      return { filled: result.filled, frame: target === main ? 'top' : 'subframe', notice: 'Filled. Weft does not submit the form or check whether sign-in worked.' };
    } finally { secret.password = ''; }
  }

  async generate(args) {
    const tab = this.browser.tab(args.tabId);
    const contents = tab.view.webContents;
    if (!topOrigin(contents.getURL())) throw failure('invalid_arguments', 'Passwords can be generated only on http(s) pages');
    let value = generatePassword(args.length);
    try {
      tab.credentialFill = { document: tab.documentSerial ?? 0, at: Date.now(), top: true, kind: 'human_password' };
      const result = await contents.executeJavaScriptInIsolatedWorld(PASSWORD_WORLD, [{ code: GENERATE_SCRIPT(value) }], true);
      if (!result?.filled) throw failure('not_found', 'No empty new-password field was found on this page');
      return { filled: result.filled, notice: 'A strong password was filled in. Weft offers to save it when you submit the form.' };
    } finally { value = ''; }
  }

  close() { for (const offer of this.offers.values()) offer.secret = ''; this.offers.clear(); this.key?.fill(0); this.key = null; }
}
