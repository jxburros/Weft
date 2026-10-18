/**
 * Pure audit of an unpacked Chromium extension manifest against Weft's
 * extension policy. Permissions are allowed only after a fixture verified them
 * in a workspace session (test/extensions.test.js); everything else is refused
 * as denied, unsupported or unknown rather than loaded with surprising gaps.
 */
export const ALLOWED_PERMISSIONS = Object.freeze({
  storage: 'Extension-private storage inside this workspace profile',
  scripting: 'Inject scripts or CSS into pages that match granted hosts',
  tabs: 'Read URLs and titles of tabs in this workspace only (other workspaces are separate sessions)',
});
const DENIED_PERMISSIONS = Object.freeze({
  nativeMessaging: 'native applications run outside the browser sandbox',
  debugger: 'DevTools protocol access can read and drive any page and bypass Weft policy',
  proxy: 'could route workspace traffic around site rules',
  webRequest: 'request observation can expose credentials and headers',
  webRequestBlocking: 'blocking request interception could rewrite or bypass Weft site-rule enforcement',
  webRequestAuthProvider: 'supplies credentials for authentication challenges',
  declarativeNetRequest: 'request rewriting could redirect around site rules',
  declarativeNetRequestWithHostAccess: 'request rewriting could redirect around site rules',
  declarativeNetRequestFeedback: 'exposes matched request details',
  cookies: 'direct cookie access is credential access',
  management: 'controls other extensions',
  privacy: 'changes browser-wide privacy settings',
  contentSettings: 'changes browser-wide site permissions',
  downloads: 'downloads require per-download human approval in Weft',
  'downloads.open': 'opens downloaded files with external applications',
  'downloads.ui': 'downloads require per-download human approval in Weft',
  history: 'browser-wide data outside the workspace command contract',
  topSites: 'browser-wide data outside the workspace command contract',
  sessions: 'browser-wide data outside the workspace command contract',
  bookmarks: 'browser-wide data outside the workspace command contract',
  readingList: 'browser-wide data outside the workspace command contract',
  browsingData: 'can erase evidence and storage outside human administration',
  clipboardRead: 'reads the system clipboard',
  desktopCapture: 'screen capture outside Weft provenance',
  tabCapture: 'tab media capture outside Weft provenance',
  pageCapture: 'page capture outside Weft provenance',
  identity: 'account credential flows',
  geolocation: 'device location',
  userScripts: 'arbitrary user-script injection',
  background: 'keeps code running outside any workspace interaction',
  platformKeys: 'client certificate keys', certificateProvider: 'client certificate keys', vpnProvider: 'network routing',
  fileSystemProvider: 'filesystem access', webAuthenticationProxy: 'credential flows', enterprise: 'device policy',
});
const UNSUPPORTED_PERMISSIONS = Object.freeze(['alarms', 'notifications', 'contextMenus', 'activeTab', 'idle', 'power', 'tts', 'ttsEngine', 'fontSettings', 'search', 'favicon', 'tabGroups', 'sidePanel',
  'offscreen', 'webNavigation', 'unlimitedStorage', 'clipboardWrite', 'dns', 'documentScan', 'printerProvider', 'printing', 'wallpaper', 'loginState', 'processes', 'gcm', 'system.cpu', 'system.memory',
  'system.display', 'system.storage', 'storage.managed', 'webview', 'accessibilityFeatures.read', 'accessibilityFeatures.modify', 'audio']);
const ALLOWED_KEYS = new Set(['manifest_version', 'name', 'version', 'description', 'short_name', 'version_name', 'author', 'homepage_url', 'icons', 'default_locale', 'key', 'minimum_chrome_version',
  'permissions', 'host_permissions', 'background', 'content_scripts', 'web_accessible_resources', 'content_security_policy', 'offline_enabled', 'incognito']);
const IGNORED_KEYS = Object.freeze({
  action: 'Weft has no extension toolbar; popups are not shown', options_page: 'Weft has no extension options UI', options_ui: 'Weft has no extension options UI',
  devtools_page: 'Weft does not expose DevTools', commands: 'extension keyboard shortcuts are not registered', omnibox: 'Weft has no omnibox integration',
  side_panel: 'Weft has no extension side panel', chrome_url_overrides: 'Weft pages are not overridable', update_url: 'Weft never updates extensions automatically; reinstall to update',
  browser_specific_settings: 'other browsers only', requirements: 'not evaluated', storage: 'managed storage policies are not provided',
});
const DENIED_KEYS = Object.freeze({
  externally_connectable: 'lets websites or other extensions message the extension, a cross-origin data channel',
  oauth2: 'account credential flows', declarative_net_request: 'request rewriting could redirect around site rules', chrome_settings_overrides: 'changes browser search/home settings',
  nacl_modules: 'native code', file_browser_handlers: 'filesystem integration', file_system_provider_capabilities: 'filesystem integration', input_components: 'system input methods',
  automation: 'accessibility automation of any page', sandbox: 'sandboxed pages with relaxed CSP are unsupported', export: 'shared modules are unsupported', import: 'shared modules are unsupported',
  optional_permissions: 'Weft has no runtime permission prompt; request permissions up front', optional_host_permissions: 'Weft has no runtime permission prompt; request hosts up front',
  tts_engine: 'unsupported', chrome_url_overrides_newtab: 'unsupported',
});
export const RESIDUAL_RISKS = Object.freeze([
  'An enabled extension runs its code inside matching pages of this workspace and can read or change anything those pages show, including form fields and non-HttpOnly cookies.',
  'Content scripts act with the page origin: their requests are governed by site rules like the page itself, not by the extension host grant.',
  'Extension service-worker requests are limited to granted hosts and site rules; requests through pages it controls are not.',
  'Weft audits the manifest and pins file hashes; it does not review or sandbox the extension code beyond Chromium\'s extension process model.',
]);

const MATCH = /^(\*|https?):\/\/(\*|\*\.[^/*:]+|[^/*:]+)(:(\*|\d{1,5}))?(\/.*)$/;
export function isBroadPattern(pattern) {
  if (pattern === '<all_urls>') return true;
  const host = MATCH.exec(pattern)?.[2];
  return host === '*' || (host?.startsWith('*.') && !host.slice(2).includes('.'));
}
function patternProblem(pattern) {
  if (typeof pattern !== 'string' || pattern.length > 2048) return 'host pattern must be a string of at most 2048 characters';
  if (pattern === '<all_urls>') return null;
  if (/^(file|ftp|chrome|chrome-extension|about|data|javascript|ws|wss|urn):/i.test(pattern)) return 'only http and https hosts can be granted';
  return MATCH.test(pattern) ? null : 'invalid match pattern';
}

/** Chrome match-pattern test for an http(s) URL. */
export function matchesPattern(pattern, value) {
  let url;
  try { url = new URL(value); } catch { return false; }
  if (!['http:', 'https:'].includes(url.protocol)) return false;
  if (pattern === '<all_urls>') return true;
  const parts = MATCH.exec(pattern);
  if (!parts) return false;
  const [, scheme, host, , port, path] = parts;
  if (scheme !== '*' && `${scheme}:` !== url.protocol) return false;
  if (host !== '*') {
    if (host.startsWith('*.')) { const base = host.slice(2).toLowerCase(); if (url.hostname !== base && !url.hostname.endsWith(`.${base}`)) return false; }
    else if (url.hostname !== host.toLowerCase()) return false;
  }
  if (port && port !== '*' && url.port !== port && !(url.port === '' && ((url.protocol === 'http:' && port === '80') || (url.protocol === 'https:' && port === '443')))) return false;
  const expression = new RegExp(`^${path.split('*').map(part => part.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('.*')}$`);
  return expression.test(url.pathname + url.search);
}

const relativeFile = value => typeof value === 'string' && value.length <= 1000 && !value.startsWith('/') && !/^[a-z]+:/i.test(value) && !value.includes('\\') && !value.split('/').some(part => !part || part === '..');

/**
 * @param manifest parsed manifest.json
 * @param options.hostGrants exact host patterns a person granted
 * @param options.files set of package-relative file paths, to check referenced scripts exist
 * @param options.chromiumVersion running Chromium version
 */
export function auditExtensionManifest(manifest, { hostGrants = [], files = null, chromiumVersion = '0' } = {}) {
  const refusals = [];
  const ignored = [];
  const refuse = (key, kind, reason) => refusals.push({ key, kind, reason });
  if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest)) return { ok: false, refusals: [{ key: 'manifest.json', kind: 'invalid', reason: 'manifest.json must be a JSON object' }], ignored, scope: null };
  if (manifest.manifest_version !== 3) refuse('manifest_version', 'unsupported', 'only Manifest V3 extensions are supported');
  if (typeof manifest.name !== 'string' || !manifest.name.trim() || manifest.name.length > 200) refuse('name', 'invalid', 'a name of at most 200 characters is required');
  if (typeof manifest.version !== 'string' || !/^\d{1,9}(\.\d{1,9}){0,3}$/.test(manifest.version)) refuse('version', 'invalid', 'version must be 1-4 dot-separated integers');
  if (manifest.minimum_chrome_version != null && Number.parseInt(manifest.minimum_chrome_version, 10) > Number.parseInt(chromiumVersion, 10)) refuse('minimum_chrome_version', 'unsupported', `requires Chromium ${manifest.minimum_chrome_version}; running ${chromiumVersion}`);
  for (const key of Object.keys(manifest)) {
    if (Object.hasOwn(DENIED_KEYS, key)) refuse(key, key.startsWith('optional_') || ['sandbox', 'export', 'import', 'tts_engine'].includes(key) ? 'unsupported' : 'denied', DENIED_KEYS[key]);
    else if (Object.hasOwn(IGNORED_KEYS, key)) ignored.push({ key, reason: IGNORED_KEYS[key] });
    else if (!ALLOWED_KEYS.has(key)) refuse(key, 'unknown', 'unknown manifest key; Weft fails closed on keys it has not evaluated');
  }
  const permissions = [];
  if (manifest.permissions != null && !Array.isArray(manifest.permissions)) refuse('permissions', 'invalid', 'permissions must be an array');
  for (const permission of Array.isArray(manifest.permissions) ? manifest.permissions : []) {
    const name = String(permission).slice(0, 100);
    if (Object.hasOwn(ALLOWED_PERMISSIONS, name)) permissions.push({ name, meaning: ALLOWED_PERMISSIONS[name] });
    else if (Object.hasOwn(DENIED_PERMISSIONS, name) || Object.hasOwn(DENIED_PERMISSIONS, name.split('.')[0])) refuse(`permissions.${name}`, 'denied', DENIED_PERMISSIONS[name] ?? DENIED_PERMISSIONS[name.split('.')[0]]);
    else if (UNSUPPORTED_PERMISSIONS.includes(name) || name.startsWith('system.')) refuse(`permissions.${name}`, 'unsupported', 'not available or not verified in Weft workspace sessions; the API would be missing at run time');
    else if (/^(\*|https?|file|ftp|<all_urls>)/.test(name)) refuse(`permissions.${name}`, 'invalid', 'Manifest V3 host patterns belong in host_permissions');
    else refuse(`permissions.${name}`, 'unknown', 'unknown permission; Weft fails closed on permissions it has not evaluated');
  }
  const requested = new Map();
  const request = (pattern, source) => { if (!requested.has(pattern)) requested.set(pattern, new Set()); requested.get(pattern).add(source); };
  if (manifest.host_permissions != null && !Array.isArray(manifest.host_permissions)) refuse('host_permissions', 'invalid', 'host_permissions must be an array');
  for (const pattern of Array.isArray(manifest.host_permissions) ? manifest.host_permissions : []) request(pattern, 'host_permissions');
  const contentScripts = manifest.content_scripts ?? [];
  if (!Array.isArray(contentScripts) || contentScripts.length > 50) refuse('content_scripts', 'invalid', 'content_scripts must be an array of at most 50 entries');
  for (const [index, script] of (Array.isArray(contentScripts) ? contentScripts : []).entries()) {
    if (!script || typeof script !== 'object' || !Array.isArray(script.matches) || !script.matches.length) { refuse(`content_scripts.${index}`, 'invalid', 'each content script needs matches'); continue; }
    for (const pattern of script.matches) request(pattern, 'content_scripts');
    for (const file of [...(script.js ?? []), ...(script.css ?? [])]) {
      if (!relativeFile(file)) refuse(`content_scripts.${index}`, 'invalid', `file path ${String(file).slice(0, 200)} must stay inside the package`);
      else if (files && !files.has(file)) refuse(`content_scripts.${index}`, 'invalid', `missing file ${file}`);
    }
    if (script.world != null && !['ISOLATED', 'MAIN'].includes(script.world)) refuse(`content_scripts.${index}.world`, 'invalid', 'world must be ISOLATED or MAIN');
  }
  const war = manifest.web_accessible_resources ?? [];
  if (!Array.isArray(war)) refuse('web_accessible_resources', 'invalid', 'must be an array');
  for (const [index, entry] of (Array.isArray(war) ? war : []).entries()) {
    if (entry?.extension_ids?.length) refuse(`web_accessible_resources.${index}.extension_ids`, 'denied', 'cross-extension resource sharing is unsupported');
    for (const pattern of entry?.matches ?? []) request(pattern, 'web_accessible_resources');
  }
  const background = manifest.background;
  if (background != null) {
    if (typeof background !== 'object' || Array.isArray(background) || Object.keys(background).some(key => !['service_worker', 'type'].includes(key))) refuse('background', 'unsupported', 'only background.service_worker (and type) is supported; MV2 background pages/scripts are not');
    else if (!relativeFile(background.service_worker)) refuse('background.service_worker', 'invalid', 'service worker path must stay inside the package');
    else if (files && !files.has(background.service_worker)) refuse('background.service_worker', 'invalid', `missing file ${background.service_worker}`);
    if (background?.type != null && background.type !== 'module') refuse('background.type', 'invalid', 'type must be module when present');
  }
  const csp = manifest.content_security_policy;
  if (csp != null && (typeof csp !== 'object' || /unsafe-eval|unsafe-inline|https?:|\*/.test(JSON.stringify(csp)))) refuse('content_security_policy', 'denied', 'extension CSP may not relax script sources');
  const grants = new Set(hostGrants);
  const hosts = [...requested].map(([pattern, sources]) => ({ pattern: String(pattern).slice(0, 2048), sources: [...sources], broad: isBroadPattern(pattern), granted: grants.has(pattern) }));
  for (const host of hosts) {
    const problem = patternProblem(host.pattern);
    if (problem) refuse(`hosts.${host.pattern}`, 'denied', problem);
    else if (!host.granted) refuse(`hosts.${host.pattern}`, 'ungranted', host.broad ? 'broad host access (every site or a whole top-level domain) must be granted explicitly' : 'host access must be granted explicitly');
  }
  for (const pattern of grants) if (!requested.has(pattern)) refuse(`hostGrants.${String(pattern).slice(0, 200)}`, 'invalid', 'grant only hosts the extension requests');
  return { ok: refusals.length === 0, name: typeof manifest.name === 'string' ? manifest.name.slice(0, 200) : null, version: typeof manifest.version === 'string' ? manifest.version.slice(0, 50) : null,
    refusals, ignored, scope: { hosts, permissions, contentScripts: Array.isArray(contentScripts) ? contentScripts.length : 0, serviceWorker: Boolean(background?.service_worker),
      requestedHostGrants: [...requested.keys()].map(String), residualRisks: [...RESIDUAL_RISKS] } };
}
