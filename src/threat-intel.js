import { createHash } from 'node:crypto';
import { domainToASCII } from 'node:url';
import { z } from 'zod';
import { readJson, writeJsonDurable } from './atomic-json.js';
import { rejectSecretKeys } from './export-safety.js';

const listId = z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,99}$/);
const THREAT_TYPES = ['MALWARE', 'SOCIAL_ENGINEERING', 'UNWANTED_SOFTWARE', 'POTENTIALLY_HARMFUL_APPLICATION'];
export const threatCommandDefinitions = {
  'threats.status': ['Inspect installed malicious-destination intelligence, freshness and provider egress state without network access', {}],
  'threats.install': ['Human installs or replaces a hash-pinned offline threat list (security intelligence, separate from personal rules)', {
    id: listId, sha256: z.string().regex(/^[a-fA-F0-9]{64}$/), bytes: z.number().int().min(1).max(4000000),
    source: z.string().min(1).max(500), maxAgeHours: z.number().int().min(1).max(8760).default(72), data: z.string().min(1).max(4000000) }],
  'threats.remove': ['Human removes an installed threat list', { id: listId }],
  'threats.configureProvider': ['Human enables or disables the optional hash-prefix reputation provider (off by default; discloses egress)', {
    enabled: z.boolean(), endpoint: z.string().url().max(500).refine(value => { try { const url = new URL(value); return (url.protocol === 'https:' || ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)) && !url.username && !url.password && !url.search && !url.hash; } catch { return false; } }, 'Expected an HTTPS endpoint without credentials or query').optional(),
    apiKeyEnv: z.string().regex(/^[A-Z][A-Z0-9_]{0,99}$/).optional(), threatTypes: z.array(z.enum(THREAT_TYPES)).min(1).max(4).optional(),
    maxAgeHours: z.number().int().min(1).max(720).optional(), acknowledgeEgress: z.boolean().optional() }],
  'threats.update': ['Human fetches provider list updates now; sends list state only, never browsing URLs', {}],
};
const schemas = Object.fromEntries(Object.entries(threatCommandDefinitions).map(([name, [, shape]]) => [name, z.strictObject(shape)]));
const listSchema = z.strictObject({
  format: z.literal('weft-threat-list'), version: z.literal(1), publisher: z.string().min(1).max(200),
  generatedAt: z.string().datetime({ offset: true }), description: z.string().max(2000).default(''),
  entries: z.array(z.strictObject({
    type: z.enum(['host', 'url-prefix', 'sha256']), value: z.string().min(1).max(4096),
    category: z.enum(['malware', 'phishing', 'unwanted-software', 'harmful-download']).default('malware'),
    includeSubdomains: z.boolean().default(true), reference: z.string().url().max(2048).optional(),
  })).min(1).max(200000),
});
const sha256 = value => createHash('sha256').update(value).digest('hex');
const categories = { MALWARE: 'malware', SOCIAL_ENGINEERING: 'phishing', UNWANTED_SOFTWARE: 'unwanted-software', POTENTIALLY_HARMFUL_APPLICATION: 'harmful-download' };

function normalizeHost(value) {
  const host = domainToASCII(String(value).toLowerCase().replace(/\.$/, ''));
  if (!host || host.length > 253 || /[\s/@?#:\\]/.test(host)) throw new Error(`Invalid threat-list host: ${String(value).slice(0, 100)}`);
  return host;
}

/** Google Safe Browsing-style URL canonicalization (v4 "Hashing" guidance) on top of WHATWG parsing. */
export function canonicalize(input) {
  let text = String(input).trim().replace(/[\t\r\n]/g, '');
  const unescape = value => { let previous; let current = value; for (let i = 0; i < 16 && previous !== current; i++) { previous = current; current = current.replace(/%([0-9a-fA-F]{2})/g, (_, hex) => String.fromCharCode(parseInt(hex, 16))); } return current; };
  const escape = value => [...value].map(char => { const code = char.charCodeAt(0); return code <= 0x20 || code >= 0x7f || char === '#' || char === '%' ? `%${code.toString(16).toUpperCase().padStart(2, '0')}` : char; }).join('');
  if (!/^[a-z][a-z\d+.-]*:\/\//i.test(text)) text = `http://${text}`;
  const url = new URL(text);
  const host = url.hostname.replace(/^\.+|\.+$/g, '').replace(/\.{2,}/g, '.');
  let path = unescape(url.pathname).replace(/\/{2,}/g, '/');
  const segments = [];
  for (const segment of path.split('/').slice(1)) { if (segment === '..') segments.pop(); else if (segment !== '.') segments.push(segment); }
  path = `/${segments.join('/')}`;
  return { host, path: escape(path), query: url.search ? escape(unescape(url.search.slice(1))) : null, ip: /^[\d.]+$/.test(host) || host.startsWith('[') };
}

export function urlExpressions(input) {
  const { host, path, query, ip } = canonicalize(input);
  const hosts = [host];
  if (!ip) { const parts = host.split('.'); for (let i = Math.max(1, parts.length - 5); i < parts.length - 1; i++) hosts.push(parts.slice(i).join('.')); }
  const paths = [...(query !== null ? [`${path}?${query}`] : []), path, '/'];
  let current = '/';
  for (const part of path.split('/').slice(1, -1).slice(0, 3)) { current += `${part}/`; paths.push(current); }
  const expressions = [];
  for (const h of [...new Set(hosts)].slice(0, 5)) for (const p of [...new Set(paths)].slice(0, 6)) expressions.push(`${h}${p}`);
  return [...new Set(expressions)];
}

/** Offline, hash-pinned intelligence plus an optional, explicitly enabled hash-prefix provider. */
export class ThreatIntel {
  constructor({ path, fetchImpl = globalThis.fetch, env = process.env, now = () => Date.now() } = {}) {
    this.path = path; this.fetch = fetchImpl; this.env = env; this.now = now;
    this.state = path ? readJson(path, { version: 1, lists: [], provider: { enabled: false } }) : { version: 1, lists: [], provider: { enabled: false } };
    this.state.lists ??= []; this.state.provider ??= { enabled: false };
    this.cache = new Map();
    this.index();
  }

  save() { if (this.path) writeJsonDurable(this.path, this.state); this.index(); }
  index() {
    this.hosts = new Map(); this.prefixes = new Map(); this.hashes = new Map();
    for (const list of this.state.lists) for (const entry of list.entries) {
      const finding = { listId: list.id, category: entry.category, reference: entry.reference ?? null };
      if (entry.type === 'host') { const items = this.hosts.get(entry.value) ?? []; items.push({ ...finding, includeSubdomains: entry.includeSubdomains }); this.hosts.set(entry.value, items); }
      else if (entry.type === 'url-prefix') { const host = new URL(entry.value).host; this.prefixes.set(host, [...(this.prefixes.get(host) ?? []), { ...finding, prefix: entry.value }]); }
      else this.hashes.set(entry.value, [...(this.hashes.get(entry.value) ?? []), finding]);
    }
    this.providerPrefixes = new Map();
    for (const [threatType, list] of Object.entries(this.state.provider.lists ?? {})) for (const prefix of list.prefixes ?? []) {
      const types = this.providerPrefixes.get(prefix) ?? []; types.push(threatType); this.providerPrefixes.set(prefix, types);
    }
    this.prefixLengths = [...new Set([...this.providerPrefixes.keys()].map(prefix => prefix.length))];
  }

  freshness(list) {
    const generated = Date.parse(list.generatedAt);
    if (!Number.isFinite(generated) || generated > this.now() + 3600000) return { freshness: 'unknown', ageHours: null };
    const ageHours = Math.floor((this.now() - generated) / 3600000);
    return { freshness: ageHours > list.maxAgeHours ? 'stale' : 'fresh', ageHours };
  }
  providerFreshness() {
    const provider = this.state.provider;
    if (!provider.enabled) return 'disabled';
    if (!provider.lastUpdateAt) return 'never-updated';
    return this.now() - Date.parse(provider.lastUpdateAt) > (provider.maxAgeHours ?? 24) * 3600000 ? 'stale' : 'fresh';
  }
  finding(base, source) {
    const list = this.state.lists.find(item => item.id === base.listId);
    const freshness = list ? this.freshness(list).freshness : this.providerFreshness();
    return { kind: 'security', action: 'block', category: base.category, source, listId: base.listId ?? null,
      publisher: list?.publisher ?? (source === 'provider' ? this.state.provider.endpoint : null), reference: base.reference ?? null,
      freshness, stale: freshness !== 'fresh', listGeneratedAt: list?.generatedAt ?? this.state.provider.lastUpdateAt ?? null };
  }

  /** Synchronous local findings for a URL. Never contacts the network. */
  checkUrl(value) {
    let url; try { url = new URL(value); } catch { return []; }
    if (!['http:', 'https:', 'ws:', 'wss:'].includes(url.protocol)) return [];
    const host = url.hostname.toLowerCase().replace(/\.$/, '');
    const findings = [];
    const labels = host.split('.');
    for (let i = 0; i < labels.length; i++) {
      for (const item of this.hosts.get(labels.slice(i).join('.')) ?? []) if (i === 0 || item.includeSubdomains) findings.push(this.finding(item, 'list'));
    }
    const href = new URL(url.href); href.hash = ''; href.protocol = href.protocol.replace(/^ws/, 'http');
    for (const item of this.prefixes.get(href.host) ?? []) if (href.href.startsWith(item.prefix)) findings.push(this.finding(item, 'list'));
    return findings;
  }
  checkHash(hex) { return (this.hashes.get(String(hex).toLowerCase()) ?? []).map(item => this.finding(item, 'list')); }

  /** Local result, or a promise when a provider prefix hit needs full-hash confirmation. */
  assess(value, { remote = true } = {}) {
    const local = this.checkUrl(value);
    if (local.length || !remote || !this.state.provider.enabled || !this.prefixLengths.length) return local;
    let expressions; try { if (!/^https?:/i.test(value)) return local; expressions = urlExpressions(value); } catch { return local; }
    const full = expressions.map(expression => sha256(expression));
    const hits = new Set();
    for (const hash of full) for (const length of this.prefixLengths) if (this.providerPrefixes.has(hash.slice(0, length))) hits.add(hash.slice(0, length));
    if (!hits.size) return local;
    return this.confirm([...hits], full);
  }

  async confirm(prefixes, fullHashes) {
    const cached = []; const unknown = [];
    for (const prefix of prefixes) {
      const entry = this.cache.get(prefix);
      if (entry && entry.expires > this.now()) cached.push(...entry.matches); else unknown.push(prefix);
    }
    let matches = cached;
    if (unknown.length) {
      const provider = this.state.provider;
      const response = await this.request('/v4/fullHashes:find', { client: this.client(), clientStates: Object.values(provider.lists ?? {}).map(list => list.state).filter(Boolean),
        threatInfo: { threatTypes: provider.threatTypes, platformTypes: ['ANY_PLATFORM'], threatEntryTypes: ['URL'], threatEntries: unknown.map(prefix => ({ hash: Buffer.from(prefix, 'hex').toString('base64') })) } }, 'full-hash-lookup', unknown.length);
      const found = (response.matches ?? []).map(match => ({ threatType: match.threatType, hash: Buffer.from(match.threat?.hash ?? '', 'base64').toString('hex'), expires: this.now() + duration(match.cacheDuration, 300) * 1000 }));
      const negative = this.now() + duration(response.negativeCacheDuration, 300) * 1000;
      for (const prefix of unknown) this.cache.set(prefix, { expires: Math.max(negative, ...found.filter(item => item.hash.startsWith(prefix)).map(item => item.expires)), matches: found.filter(item => item.hash.startsWith(prefix)) });
      matches = [...matches, ...found];
    }
    const wanted = new Set(fullHashes);
    return matches.filter(match => wanted.has(match.hash)).map(match => this.finding({ category: categories[match.threatType] ?? 'malware' }, 'provider'));
  }

  client() { return { clientId: 'weft', clientVersion: '1.0.0' }; }
  apiKey() {
    const name = this.state.provider.apiKeyEnv;
    const key = name ? this.env[name] : '';
    if (!key) throw new Error(`Reputation provider key is unavailable; set the ${name || 'configured'} environment variable`);
    return key;
  }
  async request(path, body, kind, count = 0) {
    const provider = this.state.provider;
    const url = new URL(path, provider.endpoint);
    url.searchParams.set('key', this.apiKey());
    provider.egress = [...(provider.egress ?? []), { at: new Date(this.now()).toISOString(), kind, host: url.host, hashPrefixes: count }].slice(-50);
    const response = await this.fetch(url, { method: 'POST', redirect: 'error', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.timeout(15000) });
    if (!response.ok) throw new Error(`Reputation provider returned HTTP ${response.status}`);
    return response.json();
  }

  async update() {
    const provider = this.state.provider;
    if (!provider.enabled) throw new Error('The reputation provider is disabled');
    if (provider.nextUpdateAfter && Date.parse(provider.nextUpdateAfter) > this.now()) return { ...this.status().provider, notice: 'The provider asked Weft to wait before the next update.' };
    const lists = provider.lists ?? {};
    try {
      const response = await this.request('/v4/threatListUpdates:fetch', { client: this.client(), listUpdateRequests: provider.threatTypes.map(threatType => ({
        threatType, platformType: 'ANY_PLATFORM', threatEntryType: 'URL', state: lists[threatType]?.state ?? '', constraints: { supportedCompressions: ['RAW'] } })) }, 'list-update');
      const next = structuredClone(lists);
      for (const update of response.listUpdateResponses ?? []) {
        if (!provider.threatTypes.includes(update.threatType)) continue;
        let prefixes = update.responseType === 'FULL_UPDATE' ? [] : [...(next[update.threatType]?.prefixes ?? [])];
        const removals = (update.removals ?? []).flatMap(item => item.rawIndices?.indices ?? []).sort((a, b) => b - a);
        for (const index of removals) { if (!Number.isInteger(index) || index < 0 || index >= prefixes.length) throw new Error('Provider removal index is out of range'); prefixes.splice(index, 1); }
        for (const addition of update.additions ?? []) {
          if (addition.compressionType && addition.compressionType !== 'RAW') throw new Error('Provider sent an unsupported compression');
          const size = addition.rawHashes?.prefixSize; const raw = Buffer.from(addition.rawHashes?.rawHashes ?? '', 'base64');
          if (!Number.isInteger(size) || size < 4 || size > 32 || raw.length % size) throw new Error('Provider sent malformed hash prefixes');
          for (let offset = 0; offset < raw.length; offset += size) prefixes.push(raw.subarray(offset, offset + size).toString('hex'));
        }
        prefixes = [...new Set(prefixes)].sort();
        const checksum = createHash('sha256').update(Buffer.concat(prefixes.map(prefix => Buffer.from(prefix, 'hex')))).digest('base64');
        if (update.checksum?.sha256 && checksum !== update.checksum.sha256) { delete next[update.threatType]; throw new Error(`Checksum mismatch for ${update.threatType}; the list was discarded and will be fully refetched`); }
        next[update.threatType] = { state: update.newClientState ?? '', prefixes, updatedAt: new Date(this.now()).toISOString() };
      }
      provider.lists = next;
      provider.lastUpdateAt = new Date(this.now()).toISOString();
      provider.nextUpdateAfter = new Date(this.now() + duration(response.minimumWaitDuration, 0) * 1000).toISOString();
      provider.lastError = null;
      this.cache.clear();
      this.save();
      return this.status().provider;
    } catch (error) {
      provider.lastError = String(error.message).slice(0, 500);
      if (/Checksum mismatch/.test(error.message)) provider.lists = Object.fromEntries(Object.entries(lists).filter(([type]) => !error.message.includes(type)));
      this.save();
      throw error;
    }
  }

  status() {
    const provider = this.state.provider;
    return { kind: 'security',
      lists: this.state.lists.map(({ entries, ...list }) => ({ ...list, entryCount: entries.length, ...this.freshness(list) })),
      provider: { enabled: Boolean(provider.enabled), endpoint: provider.endpoint ?? null, apiKeyEnv: provider.apiKeyEnv ?? null, threatTypes: provider.threatTypes ?? [],
        freshness: this.providerFreshness(), lastUpdateAt: provider.lastUpdateAt ?? null, nextUpdateAfter: provider.nextUpdateAfter ?? null, lastError: provider.lastError ?? null,
        prefixCount: Object.values(provider.lists ?? {}).reduce((sum, list) => sum + (list.prefixes?.length ?? 0), 0), recentEgress: provider.egress ?? [],
        egress: 'When enabled: list updates send list names and opaque client state; a local hash-prefix match sends only 4-32 byte SHA-256 prefixes of URL expressions. Full URLs, page content and cookies are never sent. The provider sees your IP address and API key.' },
      coverage: this.state.lists.length ? (provider.enabled ? 'local-lists+provider' : 'local-lists') : provider.enabled ? 'provider' : 'none',
      limitations: ['Threat intelligence reduces exposure to known destinations; it cannot detect new or targeted threats or prevent browser exploits.',
        'Stale lists still block their entries but miss newer threats; provider lookup failures fail open and are reported.',
        'Security findings are separate from personal preference rules and community lists.'] };
  }

  execute(name, input) {
    const args = schemas[name].parse(input);
    if (name === 'threats.status') return this.status();
    if (name === 'threats.update') return this.update();
    if (name === 'threats.remove') {
      if (!this.state.lists.some(list => list.id === args.id)) throw new Error('Threat list not found');
      this.state.lists = this.state.lists.filter(list => list.id !== args.id); this.save(); return this.status();
    }
    if (name === 'threats.install') {
      if (Buffer.byteLength(args.data, 'utf8') !== args.bytes || sha256(args.data) !== args.sha256.toLowerCase()) throw new Error('LIST_INTEGRITY: supplied bytes do not match the pinned byte count and SHA-256');
      const parsed = JSON.parse(args.data);
      rejectSecretKeys(parsed);
      const source = listSchema.parse(parsed);
      const entries = source.entries.map(entry => {
        if (entry.type === 'host') return { ...entry, value: normalizeHost(entry.value) };
        if (entry.type === 'sha256') { if (!/^[a-fA-F0-9]{64}$/.test(entry.value)) throw new Error('Invalid SHA-256 threat entry'); return { ...entry, value: entry.value.toLowerCase() }; }
        const url = new URL(entry.value);
        if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw new Error('Invalid URL-prefix threat entry');
        url.hash = ''; return { ...entry, value: url.href };
      });
      const list = { id: args.id, publisher: source.publisher, description: source.description, source: args.source, sha256: args.sha256.toLowerCase(), bytes: args.bytes,
        generatedAt: source.generatedAt, maxAgeHours: args.maxAgeHours, installedAt: new Date(this.now()).toISOString(), entries };
      this.state.lists = [...this.state.lists.filter(item => item.id !== args.id), list];
      this.save();
      return { ...this.status(), installed: args.id };
    }
    const provider = this.state.provider;
    if (args.enabled && !args.acknowledgeEgress) throw new Error('Enabling the reputation provider requires acknowledgeEgress: true after reviewing the disclosed egress');
    if (args.enabled && !(args.endpoint ?? provider.endpoint)) throw new Error('A provider endpoint is required');
    this.state.provider = { ...provider, enabled: args.enabled, endpoint: args.endpoint ?? provider.endpoint ?? null, apiKeyEnv: args.apiKeyEnv ?? provider.apiKeyEnv ?? null,
      threatTypes: args.threatTypes ?? provider.threatTypes ?? ['MALWARE', 'SOCIAL_ENGINEERING', 'UNWANTED_SOFTWARE'], maxAgeHours: args.maxAgeHours ?? provider.maxAgeHours ?? 24,
      ...(args.enabled ? { acknowledgedAt: new Date(this.now()).toISOString() } : { lists: {}, lastUpdateAt: null, nextUpdateAfter: null }) };
    if (args.endpoint && args.endpoint !== provider.endpoint) Object.assign(this.state.provider, { lists: {}, lastUpdateAt: null, nextUpdateAfter: null });
    this.cache.clear();
    this.save();
    return this.status();
  }
}
function duration(value, fallback) { const seconds = Number.parseFloat(String(value ?? '').replace(/s$/, '')); return Number.isFinite(seconds) && seconds >= 0 ? Math.min(seconds, 86400) : fallback; }
