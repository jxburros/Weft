import { createHash, randomUUID } from 'node:crypto';
import { copyFileSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { basename, extname, join } from 'node:path';
import { z } from 'zod';
import { DatabaseSync } from './sqlite.js';
import { sanitizeUrl } from './workspace.js';

/**
 * Human-only browsing-data import for #24: bookmarks and history from Chromium-family profiles
 * (Bookmarks JSON, History SQLite), Firefox profiles (places.sqlite) and Netscape bookmark HTML.
 * Only the files named in READABLE are ever opened; SQLite databases are copied to a private
 * temporary folder first, so the source browser's files are never written or locked.
 * Passwords, cookies, sessions, autofill, payment data and extensions are never read.
 */
export const READABLE = Object.freeze({ chromium: ['Bookmarks', 'History', 'History-wal', '../Local State'], firefox: ['places.sqlite', 'places.sqlite-wal', 'containers.json'], 'netscape-html': ['<selected .html file>'] });
export const NEVER_IMPORTED = Object.freeze([
  'Passwords and login data (Login Data, logins.json, key4.db)',
  'Cookies and site storage (Cookies, cookies.sqlite, Local Storage, IndexedDB)',
  'Open tabs and sessions (Current Session, Sessions, sessionstore)',
  'Autofill, addresses and payment methods (Web Data, formhistory.sqlite)',
  'Extensions, permissions, certificates and sync credentials',
]);
const LIMITS = { bookmarks: 5000, history: 5000, htmlBytes: 20 * 1024 * 1024, jsonBytes: 50 * 1024 * 1024, sqliteBytes: 512 * 1024 * 1024, depth: 32 };
const BOOKMARK_KEYS = new Set(['type', 'name', 'url', 'children', 'date_added', 'id', 'guid']);
const HTML_ATTRIBUTES = new Set(['HREF', 'ADD_DATE']);
const CHROMIUM_BROWSERS = [
  ['Google Chrome', { linux: '.config/google-chrome', darwin: 'Library/Application Support/Google/Chrome', win32: ['LOCALAPPDATA', 'Google/Chrome/User Data'] }],
  ['Chromium', { linux: '.config/chromium', darwin: 'Library/Application Support/Chromium', win32: ['LOCALAPPDATA', 'Chromium/User Data'] }],
  ['Microsoft Edge', { linux: '.config/microsoft-edge', darwin: 'Library/Application Support/Microsoft Edge', win32: ['LOCALAPPDATA', 'Microsoft/Edge/User Data'] }],
  ['Brave', { linux: '.config/BraveSoftware/Brave-Browser', darwin: 'Library/Application Support/BraveSoftware/Brave-Browser', win32: ['LOCALAPPDATA', 'BraveSoftware/Brave-Browser/User Data'] }],
  ['Vivaldi', { linux: '.config/vivaldi', darwin: 'Library/Application Support/Vivaldi', win32: ['LOCALAPPDATA', 'Vivaldi/User Data'] }],
];
const FIREFOX_ROOTS = { linux: ['.mozilla/firefox', 'snap/firefox/common/.mozilla/firefox'], darwin: ['Library/Application Support/Firefox'], win32: [['APPDATA', 'Mozilla/Firefox']] };

const kind = z.enum(['chromium', 'firefox', 'netscape-html']).describe('chromium: a Chrome/Edge/Brave/Chromium/Vivaldi profile folder; firefox: a Firefox profile folder; netscape-html: an exported bookmarks .html file.');
const source = { kind, path: z.string().min(1).max(4096).refine(value => !value.includes('\0'), 'Invalid path').describe('Absolute path of the profile folder or bookmarks file (from browsingData.sources or chosen by the person).'),
  include: z.array(z.enum(['bookmarks', 'history'])).min(1).max(2).default(['bookmarks', 'history']).describe('Data to import.'), workspaceId: z.string().min(1).max(128).optional() };
export const browsingCommandDefinitions = {
  'browsingData.sources': ['Human lists browser profiles found on this computer and what Weft can import from them (never passwords, cookies, sessions or autofill)', {}],
  'browsingData.preview': ['Human previews a bookmarks/history import: counts, containers, duplicates, unsupported fields and excluded secret data', source],
  'browsingData.import': ['Human imports previewed bookmarks (as pinned website materials) and history into a workspace', { ...source,
    previewDigest: z.string().regex(/^[0-9a-f]{64}$/).describe('Digest from browsingData.preview; the import refuses data that changed since the preview.'),
    skipDuplicates: z.boolean().default(true).describe('Skip items already in the workspace or repeated in the source.') }],
};
const schemas = Object.fromEntries(Object.entries(browsingCommandDefinitions).map(([name, [, shape]]) => [name, z.strictObject(shape)]));
const fail = (code, message) => Object.assign(new Error(message), { code });
const digest = value => createHash('sha256').update(value).digest('hex');
const chromeTime = value => { try { const millis = typeof value === 'bigint' ? Number(value / 1000n) : Number(value) / 1000; return Number.isFinite(millis) && millis > 0 ? new Date(millis - 11644473600000).toISOString() : null; } catch { return null; } };
const unixMicros = value => { const micros = Number(value); return Number.isFinite(micros) && micros > 0 ? new Date(micros / 1000).toISOString() : null; };
const unixSeconds = value => { const seconds = Number(value); return Number.isFinite(seconds) && seconds > 0 ? new Date(seconds * 1000).toISOString() : null; };
const valid = iso => { try { return iso && !Number.isNaN(Date.parse(iso)) && Date.parse(iso) > 0 && Date.parse(iso) < Date.now() + 86400000 ? new Date(iso).toISOString() : null; } catch { return null; } };

function regularFile(path, limit) {
  const stat = lstatSync(path, { throwIfNoEntry: false });
  if (!stat) return null;
  if (stat.isSymbolicLink() || !stat.isFile()) throw fail('invalid_arguments', `${basename(path)} is not a regular file`);
  if (stat.size > limit) throw fail('request_too_large', `${basename(path)} exceeds the ${Math.round(limit / 1048576)} MiB import limit`);
  return stat;
}
function directory(path) {
  const stat = lstatSync(path, { throwIfNoEntry: false });
  if (!stat || stat.isSymbolicLink() || !stat.isDirectory()) throw fail('not_found', 'Profile folder not found (links are not followed)');
}

/** Find browser profiles under the home folder. Lists paths and available data only; opens nothing but profile indexes. */
export function discoverSources({ home = homedir(), platform = process.platform, env = process.env } = {}) {
  const resolve = spec => Array.isArray(spec) ? (env[spec[0]] ? join(env[spec[0]], spec[1]) : null) : spec ? join(home, spec) : null;
  const sources = [];
  for (const [browser, roots] of CHROMIUM_BROWSERS) {
    const root = resolve(roots[platform]);
    if (!root || !existsSync(root)) continue;
    let names = {};
    try { names = JSON.parse(readFileSync(join(root, 'Local State'), 'utf8'))?.profile?.info_cache ?? {}; } catch { /* names are optional */ }
    let entries = [];
    try { entries = readdirSync(root, { withFileTypes: true }).filter(entry => entry.isDirectory() && (entry.name === 'Default' || /^Profile \d+$/.test(entry.name))); } catch { continue; }
    for (const entry of entries) {
      const path = join(root, entry.name);
      const data = { bookmarks: existsSync(join(path, 'Bookmarks')), history: existsSync(join(path, 'History')) };
      if (!data.bookmarks && !data.history) continue;
      sources.push({ kind: 'chromium', browser, profile: String(names[entry.name]?.name || entry.name).slice(0, 100), path, data });
    }
  }
  for (const spec of FIREFOX_ROOTS[platform] ?? []) {
    const root = resolve(spec);
    if (!root || !existsSync(join(root, 'profiles.ini'))) continue;
    let ini = '';
    try { ini = readFileSync(join(root, 'profiles.ini'), 'utf8'); } catch { continue; }
    for (const block of ini.split(/^\[/m).filter(section => /^Profile\d+\]/.test(section))) {
      const value = key => block.match(new RegExp(`^${key}=(.*)$`, 'm'))?.[1]?.trim();
      const relative = value('IsRelative') !== '0';
      const path = relative ? join(root, ...String(value('Path') || '').split('/')) : value('Path');
      if (!path || !existsSync(join(path, 'places.sqlite'))) continue;
      sources.push({ kind: 'firefox', browser: 'Firefox', profile: String(value('Name') || basename(path)).slice(0, 100), path, data: { bookmarks: true, history: true, containers: existsSync(join(path, 'containers.json')) } });
    }
  }
  return { sources, readable: READABLE, neverImported: NEVER_IMPORTED, notice: 'Weft lists browser profiles it found. Nothing is read until you preview a source, and only bookmarks and history files are opened.' };
}

/** Folder inside the profile that holds short-lived copies of imported browser databases. */
export const IMPORT_SCRATCH = 'import-scratch';
/** Remove copies left behind by an import that was interrupted (crash, power loss); run at startup. */
export function cleanImportScratch(profileDirectory) {
  if (profileDirectory) rmSync(join(profileDirectory, IMPORT_SCRATCH), { recursive: true, force: true });
}
/**
 * Copy a SQLite database (and its WAL) into a private folder and open the copy. The folder lives in the
 * Weft profile (owner-only), not the OS temporary folder, so an interrupted import leaves no browsing
 * history in a shared location, and startup removes any leftover. The copy is opened with
 * trusted_schema=OFF so schema-defined functions in a hostile database cannot run.
 */
function withCopy(path, work, scratch = null) {
  regularFile(path, LIMITS.sqliteBytes);
  if (scratch) mkdirSync(scratch, { recursive: true, mode: 0o700 });
  const folder = mkdtempSync(join(scratch ?? tmpdir(), 'weft-import-'));
  try {
    const copy = join(folder, 'copy.sqlite');
    copyFileSync(path, copy);
    if (regularFile(`${path}-wal`, LIMITS.sqliteBytes)) copyFileSync(`${path}-wal`, `${copy}-wal`);
    const db = new DatabaseSync(copy);
    try { db.exec('PRAGMA trusted_schema = OFF'); return work(db); } finally { db.close(); }
  } finally { rmSync(folder, { recursive: true, force: true }); }
}

function chromiumBookmarks(path, report) {
  if (!regularFile(path, LIMITS.jsonBytes)) return [];
  let json;
  try { json = JSON.parse(readFileSync(path, 'utf8')); } catch { throw fail('invalid_arguments', 'Bookmarks file is not valid JSON'); }
  const items = [];
  const visit = (node, folder, depth) => {
    if (!node || typeof node !== 'object' || depth > LIMITS.depth) return;
    for (const key of Object.keys(node)) if (!BOOKMARK_KEYS.has(key)) report.unsupported(`bookmark.${key}`);
    if (node.type === 'url') items.push({ title: node.name, url: node.url, folder, addedAt: chromeTime(node.date_added) });
    else if (Array.isArray(node.children)) for (const child of node.children) visit(child, [...folder, String(node.name || '')].filter(Boolean), depth + 1);
  };
  const roots = json?.roots && typeof json.roots === 'object' ? json.roots : {};
  for (const [key, root] of Object.entries(roots)) {
    if (!root || typeof root !== 'object' || !Array.isArray(root.children)) { if (key !== 'sync_transaction_version') report.unsupported(`roots.${key}`); continue; }
    for (const child of root.children) visit(child, [String(root.name || key)], 1);
  }
  return items;
}
function chromiumHistory(path, report, scratch) {
  if (!existsSync(path)) return [];
  return withCopy(path, db => {
    // Chromium timestamps (microseconds since 1601) exceed 2^53: read them as BigInt.
    const statement = db.prepare('SELECT url, title, visit_count AS visits, last_visit_time AS last FROM urls WHERE hidden = 0 AND last_visit_time > 0 ORDER BY last_visit_time DESC LIMIT ?');
    statement.setReadBigInts(true);
    const rows = statement.all(LIMITS.history + 1);
    report.note('Chromium history imports each URL’s title, last visit time and visit count; individual visits, transitions, durations and referrers are not imported.');
    return rows.map(row => ({ url: row.url, title: row.title, visitedAt: chromeTime(row.last), visitCount: Number(row.visits) || 1 }));
  }, scratch);
}
function firefoxPlaces(path, include, report, scratch) {
  return withCopy(path, db => {
    const out = { bookmarks: [], history: [] };
    if (include.includes('bookmarks')) {
      const rows = db.prepare('SELECT b.id, b.type, b.parent, b.title, b.dateAdded AS added, b.guid, p.url FROM moz_bookmarks b LEFT JOIN moz_places p ON p.id = b.fk').all();
      const byId = new Map(rows.map(row => [row.id, row]));
      const tagsRoot = rows.find(row => row.guid === 'tags________')?.id;
      const path = row => { const names = []; let current = byId.get(row.parent); for (let i = 0; current && i < LIMITS.depth; i++) { if (current.parent && current.parent !== 0) names.unshift(String(current.title || '')); current = byId.get(current.parent); } return names.filter(Boolean); };
      const tagged = row => { let current = byId.get(row.parent); for (let i = 0; current && i < LIMITS.depth; i++) { if (current.id === tagsRoot) return true; current = byId.get(current.parent); } return false; };
      for (const row of rows) {
        if (row.type !== 1 || !row.url) continue;
        if (tagged(row)) { report.unsupported('firefox.tags'); continue; }
        out.bookmarks.push({ title: row.title, url: row.url, folder: path(row), addedAt: unixMicros(row.added) });
      }
      try { if (db.prepare('SELECT count(*) AS n FROM moz_keywords').get().n) report.unsupported('firefox.keywords', db.prepare('SELECT count(*) AS n FROM moz_keywords').get().n); } catch { /* older schema */ }
    }
    if (include.includes('history')) {
      out.history = db.prepare('SELECT url, title, visit_count AS visits, last_visit_date AS last FROM moz_places WHERE hidden = 0 AND last_visit_date IS NOT NULL ORDER BY last_visit_date DESC LIMIT ?').all(LIMITS.history + 1)
        .map(row => ({ url: row.url, title: row.title, visitedAt: unixMicros(row.last), visitCount: Number(row.visits) || 1 }));
      report.note('Firefox history imports each URL’s title, last visit time and visit count; individual visits and transition types are not imported.');
    }
    return out;
  }, scratch);
}
function firefoxContainers(path) {
  const file = join(path, 'containers.json');
  if (!regularFile(file, LIMITS.jsonBytes)) return [];
  try {
    const identities = JSON.parse(readFileSync(file, 'utf8'))?.identities;
    return (Array.isArray(identities) ? identities : []).filter(item => item && item.public !== false).map(item => ({ id: Number(item.userContextId) || null, name: String(item.name || item.l10nID || 'Container').slice(0, 100), color: String(item.color || '').slice(0, 30) }));
  } catch { return []; }
}
const entities = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", '#39': "'" };
const decode = value => String(value).replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (match, code) => code[0] === '#' ? String.fromCodePoint(code[1].toLowerCase() === 'x' ? parseInt(code.slice(2), 16) : Number(code.slice(1))) : entities[code.toLowerCase()] ?? match);
function netscapeBookmarks(path, report) {
  if (!['.html', '.htm'].includes(extname(path).toLowerCase())) throw fail('invalid_arguments', 'Choose an exported bookmarks .html file');
  if (!regularFile(path, LIMITS.htmlBytes)) throw fail('not_found', 'Bookmarks file not found');
  const html = readFileSync(path, 'utf8');
  if (!/<!DOCTYPE NETSCAPE-Bookmark-file-1>/i.test(html)) throw fail('invalid_arguments', 'Not a Netscape bookmarks export (missing NETSCAPE-Bookmark-file-1 doctype)');
  const items = [];
  const folders = [];
  let pending = null;
  for (const match of html.matchAll(/<DT><H3([^>]*)>([\s\S]*?)<\/H3>|<DL>|<\/DL>|<DT><A([^>]*)>([\s\S]*?)<\/A>/gi)) {
    if (match[2] !== undefined) { pending = decode(match[2].replace(/<[^>]*>/g, '')).trim(); continue; }
    if (/^<DL>$/i.test(match[0])) { folders.push(pending); pending = null; continue; }
    if (/^<\/DL>$/i.test(match[0])) { folders.pop(); continue; }
    const attributes = Object.fromEntries([...match[3].matchAll(/([A-Z_-]+)="([^"]*)"/gi)].map(([, name, value]) => [name.toUpperCase(), decode(value)]));
    for (const name of Object.keys(attributes)) if (!HTML_ATTRIBUTES.has(name)) report.unsupported(`html.${name.toLowerCase()}`);
    items.push({ title: decode(match[4].replace(/<[^>]*>/g, '')).trim(), url: attributes.HREF, folder: folders.filter(Boolean), addedAt: unixSeconds(attributes.ADD_DATE) });
    if (items.length > LIMITS.bookmarks * 2) break;
  }
  return items;
}

/** Read and normalize one source. Nothing outside READABLE is opened. */
export function readSource({ kind, path, include, scratch = null }) {
  const unsupported = new Map();
  const notes = [];
  const report = { unsupported: (field, count = 1) => unsupported.set(field, (unsupported.get(field) ?? 0) + count), note: text => { if (!notes.includes(text)) notes.push(text); } };
  let raw = { bookmarks: [], history: [] };
  let containers = [];
  let profile = basename(path);
  if (kind === 'chromium') {
    directory(path);
    if (include.includes('bookmarks')) raw.bookmarks = chromiumBookmarks(join(path, 'Bookmarks'), report);
    if (include.includes('history')) raw.history = chromiumHistory(join(path, 'History'), report, scratch);
    try { profile = JSON.parse(readFileSync(join(path, '..', 'Local State'), 'utf8'))?.profile?.info_cache?.[basename(path)]?.name || profile; } catch { /* optional */ }
  } else if (kind === 'firefox') {
    directory(path);
    if (!existsSync(join(path, 'places.sqlite'))) throw fail('not_found', 'places.sqlite not found in this Firefox profile');
    raw = firefoxPlaces(join(path, 'places.sqlite'), include, report, scratch);
    containers = firefoxContainers(path);
    if (containers.length) report.note('Firefox containers are listed for review. places.sqlite does not record which container a visit or bookmark came from, so items cannot be separated by container; container cookies and sessions are never imported.');
  } else {
    if (include.includes('history')) report.note('Bookmark HTML files contain no browsing history.');
    raw.bookmarks = include.includes('bookmarks') ? netscapeBookmarks(path, report) : [];
  }
  const skipped = new Map();
  const skip = reason => skipped.set(reason, (skipped.get(reason) ?? 0) + 1);
  const clean = item => {
    let parsed;
    try { parsed = new URL(String(item.url ?? '')); } catch { skip('invalid URL'); return null; }
    if (!['http:', 'https:'].includes(parsed.protocol)) { skip(`unsupported scheme ${parsed.protocol.slice(0, 20)}`); return null; }
    if (parsed.username || parsed.password) { skip('URL contains credentials (never imported)'); return null; }
    const url = sanitizeUrl(parsed.href);
    if (url !== parsed.href.replace(/#.*$/, '')) report.unsupported('url.sensitiveParametersRemoved');
    return { ...item, url, title: String(item.title || parsed.hostname).replace(/\s+/g, ' ').trim().slice(0, 240) || parsed.hostname };
  };
  const bookmarks = raw.bookmarks.map(clean).filter(Boolean).map(item => ({ title: item.title, url: item.url, folder: (item.folder ?? []).map(name => String(name).slice(0, 100)).slice(0, 10), addedAt: valid(item.addedAt) }));
  const history = raw.history.map(clean).filter(Boolean).map(item => ({ title: item.title, url: item.url, visitedAt: valid(item.visitedAt), visitCount: item.visitCount }));
  const truncated = { bookmarks: Math.max(0, bookmarks.length - LIMITS.bookmarks), history: Math.max(0, history.length - LIMITS.history) };
  return { profile: String(profile).slice(0, 100), containers, bookmarks: bookmarks.slice(0, LIMITS.bookmarks), history: history.filter(item => item.visitedAt).slice(0, LIMITS.history),
    unsupported: [...unsupported].map(([field, count]) => ({ field, count })), skipped: [...skipped].map(([reason, count]) => ({ reason, count })), truncated, notes };
}

/** Preview: what would be imported into the workspace, with duplicates and exclusions. */
export function planImport(sourceSpec, state, workspaceId) {
  const data = readSource(sourceSpec);
  const existingUrls = new Set(state.materials.filter(item => item.workspaceId === workspaceId && item.kind === 'website' && item.url).map(item => item.url));
  const existingVisits = new Set((state.history ?? []).filter(item => item.workspaceId === workspaceId).map(item => `${item.url}\u0000${item.visitedAt}`));
  const seen = new Set();
  const bookmarks = data.bookmarks.map(item => {
    const duplicate = existingUrls.has(item.url) ? 'already in workspace' : seen.has(item.url) ? 'repeated in source' : null;
    seen.add(item.url);
    return { ...item, duplicate };
  });
  const seenVisits = new Set();
  const history = data.history.map(item => {
    const key = `${item.url}\u0000${item.visitedAt}`;
    const duplicate = existingVisits.has(key) ? 'already in workspace' : seenVisits.has(key) ? 'repeated in source' : null;
    seenVisits.add(key);
    return { ...item, duplicate };
  });
  const retainedHistory = Math.min(1000, (state.history ?? []).filter(item => item.workspaceId === workspaceId).length + history.filter(item => !item.duplicate).length);
  const previewDigest = digest(JSON.stringify({ kind: sourceSpec.kind, path: sourceSpec.path, include: [...sourceSpec.include].sort(), workspaceId,
    bookmarks: bookmarks.map(item => [item.url, item.title, item.folder, item.addedAt]), history: history.map(item => [item.url, item.title, item.visitedAt]) }));
  return { data, bookmarks, history, retainedHistory, previewDigest };
}

function summary(sourceSpec, plan) {
  const count = (items, flag) => items.filter(item => Boolean(item.duplicate) === flag).length;
  return {
    source: { kind: sourceSpec.kind, path: sourceSpec.path, profile: plan.data.profile, include: sourceSpec.include, filesRead: READABLE[sourceSpec.kind] },
    containers: plan.data.containers,
    bookmarks: { found: plan.bookmarks.length, new: count(plan.bookmarks, false), duplicates: count(plan.bookmarks, true), sample: plan.bookmarks.slice(0, 25), folders: [...new Set(plan.bookmarks.map(item => item.folder.join(' / ')).filter(Boolean))].slice(0, 50) },
    history: { found: plan.history.length, new: count(plan.history, false), duplicates: count(plan.history, true), sample: plan.history.slice(0, 25),
      retainedAfterImport: plan.retainedHistory, retention: 'Each workspace keeps its latest 1,000 visits; older imported visits beyond that are not kept.' },
    unsupported: plan.data.unsupported, skipped: plan.data.skipped, truncated: plan.data.truncated, notes: plan.data.notes,
    neverImported: NEVER_IMPORTED,
    disclosure: 'Imported bookmarks become pinned website materials and history becomes workspace visits. Opening one loads the live page: sites may ask you to sign in again, and no cookies, passwords or sessions come with the import.',
    contentTrust: 'untrusted', previewDigest: plan.previewDigest,
  };
}

/** browsingData.* commands. Human administration only; the dispatcher and this check both enforce it. */
export async function executeBrowsingCommand(name, input, context, { workspace }) {
  if (!['human', 'admin'].includes(context.actor)) throw fail('human_required', 'Browsing-data import is available only from the trusted Weft window');
  const args = schemas[name].parse(input);
  if (name === 'browsingData.sources') return discoverSources();
  const workspaceId = args.workspaceId ?? workspace.activeWorkspaceId;
  workspace.workspace(workspaceId);
  const spec = { kind: args.kind, path: args.path, include: args.include, scratch: workspace.directory ? join(workspace.directory, IMPORT_SCRATCH) : null };
  if (name === 'browsingData.preview') return summary(spec, planImport(spec, workspace.data, workspaceId));
  const run = workspace.queue.then(() => {
    const plan = planImport(spec, workspace.data, workspaceId);
    if (plan.previewDigest !== args.previewDigest) throw fail('stale_state', 'The source changed since the preview (or the workspace gained duplicates); preview it again before importing.');
    const keep = item => !args.skipDuplicates || !item.duplicate;
    const label = spec.kind === 'netscape-html' ? 'bookmarks file' : `${spec.kind === 'firefox' ? 'Firefox' : 'Chromium'} profile ${plan.data.profile}`;
    return workspace.commitChange(() => {
      const now = new Date().toISOString();
      const bookmarks = plan.bookmarks.filter(keep).map(item => ({ id: `mate_${randomUUID()}`, workspaceId, title: item.title, localOnly: false, kind: 'website', content: '', url: item.url,
        note: [`Imported from ${label}`, item.folder.length ? `Folder: ${item.folder.join(' / ')}` : '', item.addedAt ? `Originally added ${item.addedAt}` : ''].filter(Boolean).join('\n'),
        tags: ['imported-bookmark'], pinned: true, createdAt: now, updatedAt: now, revision: 1, history: [{ revision: 1, content: '', actor: 'human', createdAt: now }] }));
      workspace.data.materials.push(...bookmarks);
      const visits = plan.history.filter(keep).map(item => ({ id: `visit_${randomUUID()}`, workspaceId, url: item.url, title: item.title, tabId: null, visitedAt: item.visitedAt, imported: true }));
      const others = workspace.data.history.filter(item => item.workspaceId !== workspaceId);
      const mine = [...workspace.data.history.filter(item => item.workspaceId === workspaceId), ...visits].sort((a, b) => String(a.visitedAt).localeCompare(String(b.visitedAt))).slice(-1000);
      workspace.data.history = [...others, ...mine];
      const kept = new Set(mine.map(item => item.id));
      workspace.log('browsingData.import', workspaceId, workspaceId, 'human', `Imported ${bookmarks.length} bookmarks and ${visits.filter(item => kept.has(item.id)).length} visits from a ${spec.kind} source; no passwords, cookies, sessions or autofill.`);
      return { imported: { bookmarks: bookmarks.length, history: visits.filter(item => kept.has(item.id)).length },
        skipped: { duplicateBookmarks: plan.bookmarks.length - bookmarks.length, duplicateVisits: plan.history.length - visits.length, beyondHistoryRetention: visits.filter(item => !kept.has(item.id)).length, invalid: plan.data.skipped },
        unsupported: plan.data.unsupported, neverImported: NEVER_IMPORTED, workspaceId,
        notice: 'Imported items are references to live pages. Opening them reloads the site, which may require signing in again.' };
    });
  });
  workspace.queue = run.catch(() => {});
  return run;
}
