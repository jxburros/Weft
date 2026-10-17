import assert from 'node:assert/strict';
import test from 'node:test';
import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WorkspaceService } from '../src/workspace.js';
import { CommunityLists } from '../src/community-lists.js';
import { SiteStoragePolicy, STORAGE_SANDBOX, approximateSite } from '../src/site-storage.js';
import { ThreatIntel, canonicalize, urlExpressions } from '../src/threat-intel.js';
import { DownloadSafety, applyOriginMetadata, fileCategory } from '../src/download-safety.js';
import { executeOutcome, resultExitCode, commands } from '../src/commands.js';
import { actionClassForCommand } from '../src/autonomy.js';

const sha = value => createHash('sha256').update(value).digest('hex');
function fixture(t) {
  const directory = mkdtempSync(join(tmpdir(), 'weft-site-security-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  return directory;
}
function fakeSession() {
  const calls = { cleared: [], removed: [], flushed: 0 };
  const cookies = [];
  return { calls, cookieJar: cookies,
    clearStorageData: async options => { calls.cleared.push(options.origin); },
    clearData: async options => { calls.cleared.push(`cache:${options.origins?.[0]}`); },
    flushStorageData: () => { calls.flushed++; },
    cookies: { get: async () => cookies.slice(), remove: async (url, name) => { calls.removed.push(`${url}#${name}`); const index = cookies.findIndex(cookie => cookie.name === name); if (index >= 0) cookies.splice(index, 1); }, flushStore: async () => {}, on() {}, removeListener() {} } };
}

test('site-rule explanation lists every match with explicit precedence, provenance, review state and IDN details', async t => {
  const service = new WorkspaceService({ directory: fixture(t) });
  t.after(() => service.close());
  const warn = await service.execute('siteRules.create', { hostname: 'example.com', behavior: 'warn', reason: 'Watch', evidence: ['https://evidence.test/report'], reviewBy: '2001-01-01' });
  const navigation = await service.execute('siteRules.create', { hostname: 'news.example.com', mode: 'navigation' });
  const global = await service.execute('siteRules.create', { hostname: 'example.com', mode: 'connection', scope: 'global' });
  const disabled = await service.execute('siteRules.create', { hostname: 'example.com', path: '/a', mode: 'connection', enabled: false });
  const data = JSON.stringify({ format: 'weft-site-list', version: 1, rules: [{ hostname: 'example.com', reason: 'Community claim' }] });
  await new CommunityLists({ workspace: service }).execute('lists.install', { id: 'community', sourceRepo: 'example/lists', commit: 'a'.repeat(40), path: 'list.json', sha256: sha(data), bytes: Buffer.byteLength(data), data }, { actor: 'human' });

  const explained = service.explainSiteRules('https://news.example.com/a/b');
  assert.equal(explained.decision, 'block');
  assert.equal(explained.decidedBy, 'block-connection');
  assert.equal(explained.effectiveRuleId, global.id);
  assert.equal(service.matchSiteRule('https://news.example.com/a/b').id, global.id, 'enforcement and explanation agree');
  assert.deepEqual(explained.matches.map(match => match.id).slice(0, 3), [global.id, navigation.id, warn.id]);
  const community = explained.matches.find(match => match.source === 'community-list');
  assert.equal(community.applies, false, 'disabled community rules are listed but do not apply');
  assert.equal(community.provenance.sourceRepo, 'example/lists');
  assert.equal(explained.matches.find(match => match.id === disabled.id).precedence, 'disabled');
  assert.equal(explained.matches.find(match => match.id === warn.id).reviewStatus, 'due');
  assert.deepEqual(explained.matches.find(match => match.id === warn.id).evidence, ['https://evidence.test/report']);
  assert.equal(explained.matches.find(match => match.id === warn.id).createdBy, 'human');
  assert.ok(explained.conflicts);
  assert.equal(explained.precedence[0].id, 'security');

  const idn = service.explainSiteRules('https://xn--bcher-kva.example/');
  assert.equal(idn.hostname.unicode, 'bücher.example');
  assert.equal(idn.hostname.punycode, true);
  assert.equal(idn.decision, 'allow');
  const withException = service.explainSiteRules('https://example.com/', undefined, { exception: { kind: 'exact-visit', tabId: 1 } });
  assert.equal(withException.decision, 'allow-exception');
  const security = service.explainSiteRules('https://elsewhere.test/', undefined, { security: [{ kind: 'security', action: 'block', category: 'malware' }] });
  assert.equal(security.decidedBy, 'security');

  const updated = await service.execute('siteRules.update', { id: warn.id, changes: { reason: 'Changed' } });
  assert.deepEqual(updated.revisions.at(-1).changed, ['reason']);
  assert.equal(updated.revisions.at(-1).previous.reason, 'Watch');
  await assert.rejects(service.execute('siteRules.review', { id: warn.id }, { actor: 'agent' }), /PERMISSION_REQUIRED/);
  const reviewed = await service.execute('siteRules.review', { id: warn.id, reviewBy: '2999-01-01', note: 'Still relevant' });
  assert.equal(reviewed.reviewBy, '2999-01-01');
  assert.ok(reviewed.lastReviewedAt);
  assert.equal(reviewed.revisions.at(-1).summary, 'Reviewed: Still relevant');
  assert.equal(service.explainSiteRules('https://example.com/').matches.find(match => match.id === warn.id).reviewStatus, 'scheduled');
});

test('storage policy strips cookies, sandboxes blocked documents, blocks cross-site cookies and journals temporary sites before contact', async t => {
  const directory = fixture(t);
  const service = new WorkspaceService({ directory: join(directory, 'records') });
  t.after(() => service.close());
  const session = fakeSession();
  const journalPath = join(directory, 'journal.json');
  const policy = new SiteStoragePolicy({ workspaceService: service, journalPath, sessionFor: () => session });
  const workspaceId = service.activeWorkspaceId;
  await assert.rejects(policy.execute('storage.setSiteMode', { workspaceId, hostname: 'blocked.test', mode: 'block' }, { actor: 'agent' }), /PERMISSION_REQUIRED/);
  await policy.execute('storage.setSiteMode', { workspaceId, hostname: 'blocked.test', mode: 'block' }, { actor: 'human' });
  await policy.execute('storage.setSiteMode', { workspaceId, hostname: 'temp.test', mode: 'session' }, { actor: 'human' });
  await policy.execute('storage.setSiteMode', { workspaceId, hostname: 'keep.test', mode: 'remember' }, { actor: 'human' });

  const cookieRequest = (url, extra = {}) => ({ url, resourceType: 'xhr', webContentsId: 7, requestHeaders: { Cookie: 'a=1', Accept: '*/*' }, ...extra });
  assert.deepEqual(policy.beforeSendHeaders(cookieRequest('https://sub.blocked.test/x'), workspaceId).requestHeaders, { Accept: '*/*' });
  assert.deepEqual(policy.beforeSendHeaders(cookieRequest('https://blocked.test/sw.js', { requestHeaders: { 'Service-Worker': 'script' } }), workspaceId), { cancel: true });
  const document = policy.headersReceived({ url: 'https://blocked.test/', resourceType: 'mainFrame', webContentsId: 7, responseHeaders: { 'Set-Cookie': ['a=1'], 'Cache-Control': ['max-age=60'] } }, workspaceId);
  assert.equal(document.responseHeaders['Set-Cookie'], undefined);
  assert.deepEqual(document.responseHeaders['Content-Security-Policy'], [STORAGE_SANDBOX]);
  assert.doesNotMatch(STORAGE_SANDBOX, /allow-same-origin/);
  assert.deepEqual(document.responseHeaders['Cache-Control'], ['no-store']);

  const embedded = { resourceType: 'image', webContentsId: 7, webContents: { getURL: () => 'https://news.example/' } };
  assert.deepEqual(policy.beforeSendHeaders({ ...cookieRequest('https://tracker.test/pixel'), ...embedded }, workspaceId).requestHeaders, { Accept: '*/*' }, 'cross-site cookie headers are removed by default');
  assert.equal(policy.headersReceived({ url: 'https://tracker.test/pixel', ...embedded, responseHeaders: { 'set-cookie': ['t=1'] } }, workspaceId).responseHeaders['set-cookie'], undefined);
  assert.deepEqual(policy.beforeSendHeaders({ ...cookieRequest('https://cdn.news.example/a'), ...embedded }, workspaceId), {}, 'same-site subdomains keep cookies');
  assert.deepEqual(policy.beforeSendHeaders({ ...cookieRequest('https://keep.test/a'), ...embedded }, workspaceId), {}, 'an explicit exception allows cross-site cookies');
  assert.equal(approximateSite('a.b.example.co.uk'), 'example.co.uk');
  assert.equal(policy.activityFor(7).crossSiteCookiesBlocked, 2);

  assert.deepEqual(policy.beforeSendHeaders(cookieRequest('https://temp.test:8443/page'), workspaceId), {});
  assert.ok(JSON.parse(readFileSync(journalPath, 'utf8')).entries.some(entry => entry.origin === 'https://temp.test:8443'), 'journal is durable before the request continues');

  // A new instance models a crashed process: the journal drives cleanup on startup.
  const recovered = new SiteStoragePolicy({ workspaceService: service, journalPath, sessionFor: () => session });
  session.cookieJar.push({ name: 'temp', domain: 'temp.test', path: '/', secure: true }, { name: 'kept', domain: 'keep.test', path: '/', secure: true });
  const result = await recovered.cleanup('startup');
  assert.ok(result.cleared >= 2);
  assert.equal(result.remaining, 0);
  assert.ok(session.calls.cleared.includes('https://temp.test:8443'));
  assert.ok(session.calls.removed.some(value => value.includes('temp.test')));
  assert.equal(session.calls.removed.some(value => value.includes('keep.test')), false, 'remembered sites are kept');
  assert.equal(JSON.parse(readFileSync(journalPath, 'utf8')).entries.length, 0);
  assert.equal(recovered.policy(workspaceId).temporaryData.lastStartupRecovery.reason, 'startup');

  const revoked = await policy.execute('storage.setSiteMode', { workspaceId, hostname: 'blocked.test', mode: 'default' }, { actor: 'human' });
  assert.equal(revoked.exceptions.some(item => item.hostname === 'blocked.test'), false, 'exceptions are revocable');
  await policy.execute('storage.setDefaultMode', { workspaceId, mode: 'session', crossSiteCookies: 'allow' }, { actor: 'human' });
  assert.equal(policy.modeFor('anything.test', workspaceId).mode, 'session');
  assert.equal(policy.modeFor('keep.test', workspaceId).mode, 'remember');
  assert.deepEqual(policy.beforeSendHeaders({ ...cookieRequest('https://other.test/pixel'), ...embedded }, workspaceId), {});
  assert.equal(policy.policy(workspaceId).coverage.length > 8, true);
});

test('threat lists are pinned, distinguish security findings, report staleness and match hashes without network access', async t => {
  let fetched = 0;
  const now = Date.parse('2026-10-17T00:00:00Z');
  const intel = new ThreatIntel({ path: join(fixture(t), 'threats.json'), fetchImpl: async () => { fetched++; throw new Error('no network'); }, now: () => now });
  const body = 'malicious download fixture';
  const list = data => JSON.stringify({ format: 'weft-threat-list', version: 1, publisher: 'Fixture CERT', generatedAt: data.generatedAt, entries: [
    { type: 'host', value: 'Malware.TEST', category: 'malware' }, { type: 'url-prefix', value: 'https://files.test/bad/', category: 'harmful-download', includeSubdomains: false },
    { type: 'sha256', value: sha(body), category: 'harmful-download' }] });
  const fresh = list({ generatedAt: '2026-10-16T00:00:00Z' });
  assert.throws(() => intel.execute('threats.install', { id: 'cert', source: 'fixture', sha256: sha(fresh), bytes: 1, data: fresh }), /LIST_INTEGRITY/);
  intel.execute('threats.install', { id: 'cert', source: 'fixture', sha256: sha(fresh), bytes: Buffer.byteLength(fresh), data: fresh });
  assert.equal(intel.checkUrl('https://cdn.malware.test/x')[0].kind, 'security');
  assert.equal(intel.checkUrl('https://cdn.malware.test/x')[0].freshness, 'fresh');
  assert.equal(intel.checkUrl('https://files.test/bad/tool.exe')[0].category, 'harmful-download');
  assert.deepEqual(intel.checkUrl('https://files.test/good/'), []);
  assert.deepEqual(intel.checkUrl('https://notmalware.test/'), [], 'no substring matching');
  assert.equal(intel.checkHash(sha(body))[0].category, 'harmful-download');
  const stale = list({ generatedAt: '2026-10-01T00:00:00Z' });
  intel.execute('threats.install', { id: 'cert', source: 'fixture', sha256: sha(stale), bytes: Buffer.byteLength(stale), data: stale, maxAgeHours: 72 });
  const status = intel.execute('threats.status', {});
  assert.equal(status.lists[0].freshness, 'stale');
  assert.equal(status.kind, 'security');
  assert.equal(intel.checkUrl('https://malware.test/')[0].stale, true, 'stale intelligence still blocks and says so');
  assert.equal(status.provider.enabled, false, 'provider is off by default');
  assert.deepEqual(intel.assess('https://unlisted.test/'), []);
  assert.equal(fetched, 0, 'no egress unless explicitly enabled');
  assert.throws(() => intel.execute('threats.configureProvider', { enabled: true, endpoint: 'https://provider.test' }), /acknowledgeEgress/);
  const reloaded = new ThreatIntel({ path: intel.path, now: () => now });
  assert.equal(reloaded.checkUrl('https://malware.test/').length, 1, 'installed lists persist');
  intel.execute('threats.remove', { id: 'cert' });
  assert.deepEqual(intel.checkUrl('https://malware.test/'), []);
});

test('Safe Browsing-compatible canonicalization produces the documented lookup expressions', () => {
  assert.deepEqual(urlExpressions('http://a.b.c/1/2.html?param=1').sort(), ['a.b.c/1/2.html?param=1', 'a.b.c/1/2.html', 'a.b.c/', 'a.b.c/1/', 'b.c/1/2.html?param=1', 'b.c/1/2.html', 'b.c/', 'b.c/1/'].sort());
  assert.deepEqual(urlExpressions('http://a.b.c.d.e.f.g/1.html').sort(), ['a.b.c.d.e.f.g/1.html', 'a.b.c.d.e.f.g/', 'c.d.e.f.g/1.html', 'c.d.e.f.g/', 'd.e.f.g/1.html', 'd.e.f.g/', 'e.f.g/1.html', 'e.f.g/', 'f.g/1.html', 'f.g/'].sort());
  assert.deepEqual(urlExpressions('http://1.2.3.4/1/').sort(), ['1.2.3.4/', '1.2.3.4/1/'].sort());
  assert.equal(canonicalize('http://www.GOOgle.com/').host, 'www.google.com');
  assert.equal(canonicalize('http://host/%25%32%35').path, '/%25');
  assert.equal(canonicalize('http://www.google.com/blah/..').path, '/');
  assert.equal(canonicalize('http://www.google.com/foo\tbar\rbaz\n2').path, '/foobarbaz2');
  assert.equal(canonicalize('http://3279880203/blah').host, '195.127.0.11');
  assert.equal(canonicalize('www.google.com').path, '/');
});

test('optional reputation provider updates hash-prefix lists, verifies checksums and only discloses hash prefixes', async t => {
  const badUrl = 'https://phish.test/login/index.html';
  const badHash = createHash('sha256').update('phish.test/login/index.html').digest();
  const otherHash = createHash('sha256').update('unrelated.test/').digest();
  const prefixes = [badHash.subarray(0, 4), otherHash.subarray(0, 4)].sort(Buffer.compare);
  const checksum = list => createHash('sha256').update(Buffer.concat(list)).digest('base64');
  const requests = [];
  let corrupt = false;
  const server = createServer((request, response) => {
    let body = '';
    request.on('data', chunk => { body += chunk; });
    request.on('end', () => {
      requests.push({ url: request.url, body });
      const json = JSON.parse(body);
      response.setHeader('content-type', 'application/json');
      if (request.url.startsWith('/v4/threatListUpdates:fetch')) {
        const partial = json.listUpdateRequests[0].state === 'state-1';
        const list = partial ? [prefixes[0]] : prefixes;
        response.end(JSON.stringify({ minimumWaitDuration: '0s', listUpdateResponses: [{ threatType: 'SOCIAL_ENGINEERING', platformType: 'ANY_PLATFORM', threatEntryType: 'URL',
          responseType: partial ? 'PARTIAL_UPDATE' : 'FULL_UPDATE', newClientState: partial ? 'state-2' : 'state-1',
          additions: partial ? [] : [{ compressionType: 'RAW', rawHashes: { prefixSize: 4, rawHashes: Buffer.concat(prefixes).toString('base64') } }],
          removals: partial ? [{ compressionType: 'RAW', rawIndices: { indices: [prefixes.indexOf(prefixes.find(prefix => prefix.equals(otherHash.subarray(0, 4))))] } }] : [],
          checksum: { sha256: corrupt ? 'AAAA' : checksum(list) } }] }));
        return;
      }
      if (request.url.startsWith('/v4/fullHashes:find')) {
        response.end(JSON.stringify({ matches: [{ threatType: 'SOCIAL_ENGINEERING', platformType: 'ANY_PLATFORM', threatEntryType: 'URL', threat: { hash: badHash.toString('base64') }, cacheDuration: '300s' }], negativeCacheDuration: '300s' }));
        return;
      }
      response.statusCode = 404; response.end('{}');
    });
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => server.close());
  const intel = new ThreatIntel({ path: join(fixture(t), 'threats.json'), env: { WEFT_TEST_SB_KEY: 'fixture-key' } });
  intel.execute('threats.configureProvider', { enabled: true, acknowledgeEgress: true, endpoint: `http://127.0.0.1:${server.address().port}`, apiKeyEnv: 'WEFT_TEST_SB_KEY', threatTypes: ['SOCIAL_ENGINEERING'] });
  const first = await intel.execute('threats.update', {});
  assert.equal(first.prefixCount, 2);
  assert.equal(first.freshness, 'fresh');
  const second = await intel.update();
  assert.equal(second.prefixCount, 1, 'partial update removes by index');
  const findings = await intel.assess(badUrl);
  assert.equal(findings[0].category, 'phishing');
  assert.equal(findings[0].source, 'provider');
  assert.deepEqual(await intel.assess('https://phish.test/other'), [], 'no prefix hit means no lookup and no finding');
  const lookups = requests.filter(item => item.url.startsWith('/v4/fullHashes:find'));
  assert.equal(lookups.length, 1);
  for (const request of requests) {
    assert.doesNotMatch(request.body, /phish\.test|login|index\.html/, 'URLs never leave the browser');
    assert.match(request.url, /key=fixture-key/);
  }
  assert.equal(JSON.parse(lookups[0].body).threatInfo.threatEntries[0].hash, badHash.subarray(0, 4).toString('base64'));
  assert.ok(intel.status().provider.recentEgress.some(item => item.kind === 'full-hash-lookup' && item.hashPrefixes === 1));
  corrupt = true;
  intel.state.provider.lists = {}; intel.state.provider.nextUpdateAfter = null;
  await assert.rejects(intel.update(), /Checksum mismatch/);
  assert.equal(intel.status().provider.prefixCount, 0, 'a list failing verification is discarded');
  intel.execute('threats.configureProvider', { enabled: false });
  assert.equal(intel.status().provider.enabled, false);
});

test('download safety classifies risky files, records OS origin metadata and reports honest scan statuses', async t => {
  assert.deepEqual(fileCategory('setup.msi'), { category: 'installer', risky: true });
  assert.deepEqual(fileCategory('run.PS1'), { category: 'script', risky: true });
  assert.deepEqual(fileCategory('bundle.tar.gz'), { category: 'archive', risky: true });
  assert.equal(fileCategory('notes.pdf').risky, false);
  const writes = [];
  const windows = await applyOriginMetadata('C:\\Downloads\\a.exe', { url: 'https://user:pw@files.test/a.exe?token=secret#x', referrer: 'https://page.test/' }, { platform: 'win32', writeFileImpl: (path, value) => writes.push([path, value]) });
  assert.equal(windows.status, 'applied');
  assert.equal(writes[0][0], 'C:\\Downloads\\a.exe:Zone.Identifier');
  assert.match(writes[0][1], /ZoneId=3\r\nReferrerUrl=https:\/\/page\.test\/\r\nHostUrl=https:\/\/files\.test\/a\.exe\r\n/);
  assert.doesNotMatch(writes[0][1], /secret|pw/);
  const calls = [];
  const mac = await applyOriginMetadata('/tmp/a.dmg', { url: 'https://files.test/a.dmg' }, { platform: 'darwin', execFileImpl: (command, args, _options, done) => { calls.push([command, args]); done(null, '', ''); } });
  assert.equal(mac.status, 'applied');
  assert.equal(calls[0][0], '/usr/bin/xattr');
  assert.match(calls[0][1][2], /^0081;[0-9a-f]+;Weft;/);
  const linux = await applyOriginMetadata('/tmp/a', { url: 'https://files.test/a' }, { platform: 'linux', execFileImpl: (_c, _a, _o, done) => done(Object.assign(new Error('missing'), { code: 'ENOENT' })) });
  assert.equal(linux.status, 'unsupported');

  const directory = fixture(t);
  const scanner = new DownloadSafety({ path: join(directory, 'download-safety.json'), execFileImpl: (_command, args, _options, done) => {
    const file = args.at(-1);
    if (file.includes('hang')) return done(Object.assign(new Error('timeout'), { killed: true, code: null }));
    if (file.includes('bad')) return done(Object.assign(new Error('found'), { code: 1 }), 'FOUND', '');
    return done(null, 'OK', '');
  } });
  assert.equal((await scanner.scan('/tmp/clean')).scanStatus, 'unscanned', 'no scanner means unscanned, never clean');
  assert.throws(() => scanner.configure({ command: 'clamscan' }), /absolute/);
  scanner.configure({ command: process.execPath, args: ['--scan'] });
  assert.equal((await scanner.scan('/tmp/clean')).scanStatus, 'clean');
  assert.equal((await scanner.scan('/tmp/bad')).scanStatus, 'infected');
  const hang = await scanner.scan('/tmp/hang');
  assert.equal(hang.scanStatus, 'scan-failed');
  assert.match(hang.scanDetail, /timed out/);
  assert.ok(existsSync(join(directory, 'download-safety.json')));
  scanner.configure({ command: null });
  assert.equal(scanner.status().scanner, null);
});

test('blocked navigation returns a structured site_blocked outcome and new commands are classified', async () => {
  const error = Object.assign(new Error('Blocked by site rule: example.com'), { code: 'site_blocked', details: { url: 'https://example.com/', kind: 'preference', ruleId: 'rule_1', hostname: 'example.com', source: 'personal-workspace', mode: 'navigation', reason: 'x', unexpected: 'dropped', exception: 'human-only', explain: 'siteRules.explain' } });
  const outcome = await executeOutcome(() => { throw error; }, 'page.navigate', { url: 'https://example.com/' });
  assert.equal(outcome.error.code, 'site_blocked');
  assert.equal(outcome.error.httpStatus, 403);
  assert.equal(outcome.review, 'required');
  assert.equal(outcome.error.details.blocked.ruleId, 'rule_1');
  assert.equal(outcome.error.details.blocked.unexpected, undefined);
  assert.equal(resultExitCode(outcome), 5);
  for (const name of ['siteRules.explain', 'storage.policy', 'threats.status', 'launches.list']) assert.equal(actionClassForCommand(name), 'local_read', name);
  for (const name of ['storage.setSiteMode', 'storage.setDefaultMode', 'threats.install', 'threats.configureProvider', 'threats.update', 'downloads.configureScanner', 'launches.approve', 'siteRules.review']) {
    assert.equal(actionClassForCommand(name), 'administration', name);
    assert.equal(commands[name].humanOnly, true, name);
  }
});
