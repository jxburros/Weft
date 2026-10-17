import { createHash, randomUUID } from 'node:crypto';
import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync, openSync, fsyncSync, closeSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';
import { secretKey as exactSecretKey } from './export-safety.js';

/**
 * Append-only, hash-chained activity log (JSON lines). Tamper-evident for edits,
 * reordering and deletion inside the retained window; not tamper-proof against a
 * process or user that can rewrite the profile directory. See docs/decisions/004.
 */
export const ACTIVITY_TYPES = Object.freeze(['command', 'decision', 'approval', 'grant', 'policy', 'model', 'block', 'override', 'artifact', 'record', 'retention', 'integrity']);
export const ACTIVITY_OUTCOMES = Object.freeze(['attempted', 'completed', 'failed', 'denied', 'pending_approval', 'partial', 'externally_uncertain', 'cancelled', 'recorded']);
export const DEFAULT_RETENTION = Object.freeze({ maxAgeDays: 90, maxEntries: 20000 });
const GENESIS = '0'.repeat(64);
const idPattern = /^[A-Za-z][A-Za-z0-9]{0,15}[_-][A-Za-z0-9_-]{6,80}$/;
const secretKey = { test: name => exactSecretKey.test(name) || /token|secret|passw|credential|authorization|cookie|api.?key|private.?key|signature/i.test(name) };
const digest = value => createHash('sha256').update(value).digest('hex');
const short = (value, max = 300) => String(value ?? '').replace(/[\u0000-\u001f\u007f]/g, ' ').slice(0, max);

/** Strip credentials, query and fragment: keep origin and path only (personal-data minimization). */
export function minimizeUrl(value) {
  try {
    const url = new URL(value);
    if (url.href === 'about:blank') return 'about:blank';
    if (!['http:', 'https:'].includes(url.protocol)) return `${url.protocol}…`;
    return `${url.origin}${url.pathname.length > 200 ? `${url.pathname.slice(0, 200)}…` : url.pathname}`;
  } catch { return '[invalid url]'; }
}
/**
 * Generic, privacy-minimizing argument summary usable for any command: IDs, numbers,
 * booleans and short enum-like strings are kept; URLs lose query/fragment; free text
 * becomes a character count; secret-named fields are dropped entirely.
 */
export function summarizeArgs(args) {
  if (!args || typeof args !== 'object' || Array.isArray(args)) return {};
  const summary = {};
  for (const [key, value] of Object.entries(args).slice(0, 30)) {
    if (secretKey.test(key) || ['data', 'fileBase64', 'pngBase64'].includes(key)) continue;
    if (typeof value === 'boolean' || (typeof value === 'number' && Number.isFinite(value))) summary[key] = value;
    else if (typeof value === 'string') {
      if (/url|endpoint|href|source/i.test(key) || /^https?:\/\//i.test(value)) summary[key] = minimizeUrl(value);
      else if (idPattern.test(value) || /^[a-z][a-z0-9_.-]{0,39}$/i.test(value) && /(^id$|Id$|status|kind|category|role|mode|level|topic|provider|action|type|scope|behavior)/.test(key)) summary[key] = value.slice(0, 100);
      else summary[key] = { chars: value.length };
    } else if (Array.isArray(value)) summary[key] = { items: value.length };
    else if (value && typeof value === 'object') summary[key] = { fields: Object.keys(value).filter(name => !secretKey.test(name)).slice(0, 20) };
  }
  return summary;
}

const entryFields = ['type', 'command', 'actor', 'clientId', 'workspaceId', 'tabId', 'taskId', 'targetId', 'version', 'actionClass', 'decision', 'reason', 'outcome', 'irreversible', 'external', 'approvalId', 'summary', 'detail'];
function sanitizeEntry(input) {
  const entry = {};
  for (const key of entryFields) {
    let value = input[key];
    if (value === undefined || value === null) continue;
    if (key === 'type' && !ACTIVITY_TYPES.includes(value)) value = 'command';
    if (key === 'outcome' && !ACTIVITY_OUTCOMES.includes(value)) continue;
    if (['tabId', 'version'].includes(key)) { if (!Number.isSafeInteger(value) || value < 0) continue; }
    else if (['irreversible', 'external'].includes(key)) value = Boolean(value);
    else if (key === 'summary') { value = summarizeSafe(value); if (!Object.keys(value).length) continue; }
    else if (key === 'detail') value = short(value, 500);
    else value = short(value, 200);
    entry[key] = value;
  }
  return entry;
}
function summarizeSafe(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  const output = {};
  for (const [key, item] of Object.entries(value).slice(0, 30)) {
    if (secretKey.test(key)) continue;
    if (typeof item === 'string') output[key] = /^https?:\/\//i.test(item) ? minimizeUrl(item) : short(item, 200);
    else if (typeof item === 'number' || typeof item === 'boolean') output[key] = item;
    else if (item && typeof item === 'object') output[key] = JSON.parse(JSON.stringify(item, (name, nested) => (name && secretKey.test(name)) ? undefined : typeof nested === 'string' ? short(nested, 200) : nested).slice(0, 2000) || '{}');
  }
  return output;
}

const encodeCursor = seq => Buffer.from(`a${seq}`).toString('base64url');
function decodeCursor(cursor) {
  const raw = Buffer.from(cursor, 'base64url').toString();
  if (!/^a\d{1,15}$/.test(raw)) throw Object.assign(new Error('Invalid activity cursor; restart from the first page'), { code: 'invalid_arguments' });
  return Number(raw.slice(1));
}

const id = z.string().min(1).max(128);
export const activityCommandDefinitions = {
  'activity.list': ['List durable attributable activity, newest first, with cursor pagination and filters', {
    workspaceId: id.optional(), scope: z.enum(['workspace', 'all']).default('workspace'), limit: z.number().int().min(1).max(200).optional(), cursor: z.string().max(64).optional(),
    types: z.array(z.enum(ACTIVITY_TYPES)).max(ACTIVITY_TYPES.length).optional(), outcome: z.enum(ACTIVITY_OUTCOMES).optional(),
    actor: z.string().max(200).optional(), command: z.string().max(200).optional(), since: z.string().datetime().optional(),
  }],
  'activity.verify': ['Verify the activity hash chain over the retained window (tamper evidence, not proof)', {}],
  'activity.configure': ['Human sets activity retention by age and count; artifacts are unaffected', {
    maxAgeDays: z.number().int().min(1).max(3650).nullable().optional(), maxEntries: z.number().int().min(100).max(200000).nullable().optional(),
  }],
};

export class ActivityLog {
  constructor({ directory = null, clock = Date.now, onPrune = null } = {}) {
    this.directory = directory;
    this.clock = clock;
    this.onPrune = onPrune;
    this.entries = [];
    this.anchor = { seq: 0, hash: GENESIS };
    this.retention = { ...DEFAULT_RETENTION };
    this.loadIssues = [];
    this.appendsSincePrune = 0;
    if (!directory) return;
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    this.path = join(directory, 'activity-log.jsonl');
    this.headPath = join(directory, 'activity-head.json');
    this.configPath = join(directory, 'activity-config.json');
    try {
      const config = JSON.parse(readFileSync(this.configPath, 'utf8'));
      if (config.version === 1) this.retention = { maxAgeDays: config.maxAgeDays ?? null, maxEntries: config.maxEntries ?? null };
    } catch (error) { if (error.code !== 'ENOENT') this.loadIssues.push('Activity retention settings were unreadable; defaults apply'); }
    if (existsSync(this.path)) this.load();
    // Record a failed check inside the chain itself, so later retention cannot silently erase the evidence.
    const check = this.verify();
    if (check.status === 'broken') this.append({ type: 'integrity', outcome: 'recorded', reason: 'chain_broken_on_load', detail: `Activity integrity check failed (${check.reason}${check.brokenAt ? ` at entry ${check.brokenAt}` : ''}${check.issues ? `: ${check.issues.join('; ')}` : ''}).` });
    this.prune();
  }
  load() {
    const lines = readFileSync(this.path, 'utf8').split('\n');
    let torn = false;
    for (const [index, line] of lines.entries()) {
      if (!line.trim()) continue;
      let value;
      try { value = JSON.parse(line); } catch {
        // Only a final partial line is a recoverable torn write; anything else is reported by verify().
        if (index >= lines.length - 2) { torn = true; continue; }
        this.loadIssues.push(`Unparseable activity line ${index + 1}`);
        continue;
      }
      if (value.anchor === true && this.entries.length === 0) this.anchor = { seq: value.seq, hash: value.hash, prunedAt: value.prunedAt };
      else this.entries.push(value);
    }
    if (torn) {
      this.rewrite();
      this.append({ type: 'integrity', outcome: 'recorded', reason: 'torn_write_discarded', detail: 'An incomplete final activity line from an interrupted write was discarded.' });
    }
    if (this.loadIssues.length) this.append({ type: 'integrity', outcome: 'recorded', reason: 'unreadable_lines', detail: this.loadIssues.join('; ') });
    if (existsSync(this.headPath)) {
      try {
        const head = JSON.parse(readFileSync(this.headPath, 'utf8'));
        const last = this.entries.at(-1);
        if (last && head.seq > last.seq) this.headMismatch = `Recorded head seq ${head.seq} is newer than the log (${last.seq}); entries may have been truncated`;
      } catch { this.headMismatch = 'Activity head marker is unreadable'; }
    }
  }
  get lastHash() { return this.entries.at(-1)?.hash ?? this.anchor.hash; }
  get lastSeq() { return this.entries.at(-1)?.seq ?? this.anchor.seq; }
  append(input) {
    const body = { seq: this.lastSeq + 1, id: `event_${randomUUID()}`, at: new Date(this.clock()).toISOString(), ...sanitizeEntry(input), prevHash: this.lastHash };
    const entry = { ...body, hash: digest(`${body.prevHash}\n${JSON.stringify(body)}`) };
    if (this.path) {
      appendFileSync(this.path, `${JSON.stringify(entry)}\n`, { mode: 0o600 });
      this.writeHead(entry);
    }
    this.entries.push(entry);
    if (++this.appendsSincePrune >= 200) this.prune();
    return structuredClone(entry);
  }
  writeHead(entry) {
    const temporary = `${this.headPath}.${process.pid}.tmp`;
    writeFileSync(temporary, JSON.stringify({ version: 1, seq: entry.seq, hash: entry.hash }), { mode: 0o600 });
    renameSync(temporary, this.headPath);
  }
  rewrite() {
    if (!this.path) return;
    const temporary = `${this.path}.${randomUUID()}.tmp`;
    const lines = [JSON.stringify({ anchor: true, ...this.anchor }), ...this.entries.map(entry => JSON.stringify(entry))];
    writeFileSync(temporary, `${lines.join('\n')}\n`, { mode: 0o600 });
    const fd = openSync(temporary, 'r+');
    try { fsyncSync(fd); } finally { closeSync(fd); }
    renameSync(temporary, this.path);
    const last = this.entries.at(-1);
    if (last) this.writeHead(last);
  }
  /** Apply retention: remove entries older than maxAgeDays and beyond maxEntries, keeping a hash anchor for verification. */
  prune() {
    this.appendsSincePrune = 0;
    const { maxAgeDays, maxEntries } = this.retention;
    const cutoff = maxAgeDays ? this.clock() - maxAgeDays * 86400000 : -Infinity;
    let remove = 0;
    while (remove < this.entries.length && Date.parse(this.entries[remove].at) < cutoff) remove++;
    if (maxEntries && this.entries.length - remove > maxEntries) remove = this.entries.length - maxEntries;
    this.onPrune?.({ cutoff: Number.isFinite(cutoff) ? new Date(cutoff).toISOString() : null, maxEntries });
    if (!remove) return 0;
    const last = this.entries[remove - 1];
    this.anchor = { seq: last.seq, hash: last.hash, prunedAt: new Date(this.clock()).toISOString() };
    this.entries = this.entries.slice(remove);
    this.rewrite();
    this.append({ type: 'retention', outcome: 'recorded', reason: 'retention_applied', summary: { removed: remove, maxAgeDays: maxAgeDays ?? 0, maxEntries: maxEntries ?? 0 } });
    return remove;
  }
  configure({ maxAgeDays, maxEntries }) {
    if (maxAgeDays !== undefined) this.retention.maxAgeDays = maxAgeDays;
    if (maxEntries !== undefined) this.retention.maxEntries = maxEntries;
    if (this.configPath) {
      const temporary = `${this.configPath}.${randomUUID()}.tmp`;
      writeFileSync(temporary, JSON.stringify({ version: 1, ...this.retention }), { mode: 0o600 });
      renameSync(temporary, this.configPath);
    }
    this.append({ type: 'policy', command: 'activity.configure', actor: 'human', outcome: 'completed', summary: { maxAgeDays: this.retention.maxAgeDays ?? 0, maxEntries: this.retention.maxEntries ?? 0 } });
    const removed = this.prune();
    return { retention: { ...this.retention }, removed };
  }
  verify() {
    let previous = this.anchor.hash;
    let expectedSeq = this.anchor.seq + 1;
    for (const entry of this.entries) {
      const { hash, ...body } = entry;
      if (entry.seq !== expectedSeq) return { status: 'broken', entries: this.entries.length, brokenAt: entry.seq ?? null, reason: 'sequence_gap' };
      if (entry.prevHash !== previous || digest(`${body.prevHash}\n${JSON.stringify(body)}`) !== hash) return { status: 'broken', entries: this.entries.length, brokenAt: entry.seq, reason: 'hash_mismatch' };
      previous = hash; expectedSeq++;
    }
    const issues = [...this.loadIssues, ...(this.headMismatch ? [this.headMismatch] : [])];
    return { status: issues.length ? 'broken' : 'intact', entries: this.entries.length, firstSeq: this.entries[0]?.seq ?? null, lastSeq: this.lastSeq, headHash: this.lastHash,
      anchor: { seq: this.anchor.seq, prunedAt: this.anchor.prunedAt ?? null }, ...(issues.length && { reason: 'load_issues', issues }),
      scope: 'Tamper evidence for the retained window on this device. A process with write access to the profile can rewrite the whole log; this is not proof of external outcomes.' };
  }
  /** Newest first. `visible(entry)` enforces workspace scope for the caller. */
  list({ workspaceId, limit = 50, cursor, types, outcome, actor, command, since } = {}, visible = () => true) {
    const before = cursor ? decodeCursor(cursor) : Infinity;
    const sinceTime = since ? Date.parse(since) : -Infinity;
    const items = [];
    let index = this.entries.length - 1;
    for (; index >= 0 && items.length < limit; index--) {
      const entry = this.entries[index];
      if (entry.seq >= before) continue;
      if (Date.parse(entry.at) < sinceTime) { index = -1; break; }
      if (workspaceId && entry.workspaceId !== workspaceId) continue;
      if (types?.length && !types.includes(entry.type)) continue;
      if (outcome && entry.outcome !== outcome) continue;
      if (actor && entry.actor !== actor) continue;
      if (command && entry.command !== command) continue;
      if (!visible(entry)) continue;
      items.push(structuredClone(entry));
    }
    const more = items.length === limit && index >= 0 && this.entries.slice(0, index + 1).some(entry => Date.parse(entry.at) >= sinceTime);
    return { items, nextCursor: more ? encodeCursor(items.at(-1).seq) : null, retention: { ...this.retention }, oldestSeq: this.entries[0]?.seq ?? null };
  }
}
