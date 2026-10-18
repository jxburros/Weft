/**
 * Pure authority policy: action classes, data classes, autonomy levels and the
 * autonomy gate. No I/O. The dispatcher (src/authority.js) supplies identity,
 * grants and approval evidence; nothing here trusts command arguments.
 */
export const ACTION_CLASSES = Object.freeze(['local_read', 'external_read', 'local_write', 'external_write', 'code_exec', 'cloud_spend',
  'bulk_export', 'credential_use', 'payment', 'trusted_context', 'administration', 'unclassified']);
/** Classes that are never automatic and never covered by a standing approval: every use needs an exact one-time approval. */
export const ONCE_ONLY_CLASSES = Object.freeze(['bulk_export', 'credential_use', 'payment', 'unclassified']);
/** Classes that act outside Weft; success is acceptance by the browser or provider, not proof of an external result. */
export const EXTERNAL_CLASSES = Object.freeze(['external_write', 'code_exec', 'cloud_spend', 'credential_use', 'payment']);
/** Classes a human may add to a client grant beyond its read/write scopes. */
export const GRANTABLE_CLASSES = Object.freeze(['code_exec', 'cloud_spend', 'bulk_export', 'credential_use', 'payment', 'trusted_context']);
export const AUTONOMY_LEVELS = Object.freeze(['observe', 'assist', 'scoped', 'autonomous']);
export const DATA_CLASSES = Object.freeze(['workspace_records', 'conversations', 'page_content', 'page_capture', 'browsing_history', 'activity', 'restricted_original']);
/** Data classes a new client grant receives unless a human selects otherwise. Restricted originals are never granted by default. */
export const DEFAULT_DATA_ACCESS = Object.freeze(DATA_CLASSES.filter(item => item !== 'restricted_original'));
/** Data classes whose every non-human read needs an exact one-time human approval (never standing approvals or autonomy). */
export const APPROVAL_DATA_CLASSES = Object.freeze(['restricted_original']);
/** Sensitive outbound categories (spec 14.2) and the approval class each maps to. */
export const SENSITIVE_CATEGORIES = Object.freeze({
  form_submission: 'external_write', message: 'external_write', account_change: 'external_write',
  bulk_export: 'bulk_export', sensitive_outbound_data: 'cloud_spend', credential_use: 'credential_use', payment: 'payment',
});

const classifications = new Map();
/** Register command classes. Other modules may call this for new commands; unregistered commands are 'unclassified'. */
export function classify(actionClass, names) {
  if (!ACTION_CLASSES.includes(actionClass)) throw new Error(`Unknown action class ${actionClass}`);
  for (const name of (Array.isArray(names) ? names : names.split(/\s+/)).filter(Boolean)) classifications.set(name, actionClass);
}
const add = classify;
add('administration', 'learning.configure learning.erase memories.create memories.update memories.delete');
add('local_read', 'learning.status memories.list memories.get');
add('local_read', `guide.get browser.info tabs.list page.inspect storage.info downloads.list history.list bookmarks.list workspace.snapshot workspaces.list workspaces.get settings.get activity.list activity.verify search.query artifacts.list artifacts.get models.list chat.preview approvals.list autonomy.get`);
add('external_read', `page.message page.readable page.snapshot page.title page.content page.screenshot page.pdf`);
add('local_write', `tabs.activate tabs.close tabs.pin tabs.claim tabs.release page.find page.zoom page.stop downloads.cancel bookmarks.create bookmarks.delete workspaces.create workspaces.update workspaces.archive workspaces.restore workspaces.duplicate conversations.message tasks.transition artifacts.capture artifacts.create artifacts.annotate artifacts.delete chat.cancel browser.close`);
add('external_write', `tabs.new tabs.duplicate tabs.move page.navigate page.back page.forward page.reload page.click page.fill page.clickAt page.press`);
// Observation, raw input, control modes and handoffs (#9, #15, #41).
add('local_read', 'handoffs.list handoffs.get');
add('local_write', 'handoffs.create handoffs.accept handoffs.complete');
add('administration', 'tabs.setControlMode');
add('code_exec', 'page.evaluate');
add('local_read', 'handoffs.list handoffs.get');
add('local_write', 'handoffs.create handoffs.accept handoffs.complete');
add('administration', 'tabs.setControlMode');
add('cloud_spend', 'chat.send');
add('administration', `clients.create clients.list clients.update clients.revoke lists.install lists.status lists.rollback lists.subscribe lists.preview lists.update lists.configure lists.exception lists.unsubscribe lists.check lists.matches approvals.approve approvals.reject autonomy.update activity.configure
  browser.emergencyStop browser.resumeAutomation downloads.approve tabs.takeover page.allowOnce cookies.list cookies.set cookies.clear storage.clear history.clear
  settings.update workspaces.delete workspaces.import workspaces.export workspaces.switch models.save models.delete models.probe models.discover`);
// Site storage modes, rule explanations, threat intelligence, downloads and external launches (#18, #19, #20).
add('local_read', 'siteRules.explain storage.policy threats.status launches.list');
add('administration', 'siteRules.review storage.setSiteMode storage.setDefaultMode threats.install threats.remove threats.configureProvider threats.update downloads.configureScanner launches.approve launches.deny');
// Verified stable-only updates (#33, #54, #60): status is a read; network checks, install, rollback and settings are human-only.
add('local_read', 'update.status');
add('administration', 'update.check update.install update.rollback update.configure');
// Transactional record batches (#39) and local backups/large-project transfer (#27).
add('local_write', 'batch.execute');
// Shared context collections, linked sources, service references, proposals, freshness and conflicts (#21, #22, #23, #66).
add('local_read', 'collections.list collections.get collections.read sources.read services.read conflicts.list conflicts.get');
add('local_write', 'collections.write sources.check sources.refresh context.propose context.dismiss citations.check freshness.check conflicts.create conflicts.resolve');
add('administration', `collections.create collections.update collections.delete collections.grant collections.revoke collections.addItem collections.removeItem
  sources.link sources.relink services.create services.update services.setCredential services.revoke services.refresh freshness.configure`);
// Promotion into confirmed facts, decisions or instructions: an agent needs a human approval every time or a
// standing (optionally task-bound) approval; autonomy levels never grant it and page/record text cannot.
add('trusted_context', 'context.promote');
add('administration', 'backups.create backups.list backups.verify backups.restore backups.delete workspaces.exportPackage workspaces.importPackage');
// Durable task runtime and workflows (#8, #58, #10): steering one's own task is local work; every step is gated separately as
// the task identity. Rebinding identity, review decisions, outcome determinations, duplicate-risk retries and recording are human-only.
add('local_write', 'tasks.start tasks.pause tasks.continue tasks.cancel tasks.redirect workflows.run');
add('local_read', 'workflows.validate');
add('administration', 'tasks.reassign tasks.review tasks.reconcile tasks.retryStep workflows.recordStart workflows.recordStop');
// Credential references and protected login (#6): metadata reads, once-only credential use, human-only administration.
add('local_read', 'credentials.status credentials.list credentials.get');
add('credential_use', 'credentials.fill');
add('administration', 'credentials.create credentials.update credentials.revoke credentials.delete credentials.grantTask credentials.revokeGrant credentials.configureProvider');
// Resource archives, comparison and redaction derivatives (#16, #17). Access, retention and the offline preview are human decisions.
add('local_read', 'artifacts.compare artifacts.verify artifacts.review artifacts.readOriginal');
add('local_write', 'artifacts.redact');
add('administration', 'artifacts.setAccess artifacts.purgeContent artifacts.preview artifacts.closePreview');
// Integration contracts (#14) and optional hybrid retrieval (#67): discovery, replay and chunked transfer.
add('local_read', 'weft.capabilities events.list search.status transfers.read transfers.list conversations.messages artifacts.versions');
add('local_write', 'search.reindex transfers.begin transfers.append transfers.commit transfers.abort');
add('administration', 'search.configureEmbeddings search.indexing');
// Workspace encryption (#26, ADR 014): status is a metadata read that works while locked; the lifecycle is human-only.
add('local_read', 'encryption.status');
add('administration', 'encryption.enable encryption.lock encryption.unlock encryption.configure encryption.rotate encryption.checkRecoveryKey encryption.disable');
// Resume state, tab groups and search (#24); scheduling, suspension and capture queue (#30); display handoff (#11).
add('local_read', 'resume.get tabGroups.list tabs.search resources.status captures.list display.status');
add('local_write', 'resume.save tabGroups.create tabGroups.update tabGroups.delete tabs.group tabs.suspend captures.cancel display.show');
add('administration', 'display.hide browsingData.sources browsingData.preview browsingData.import');
// Payment authorization (#7, ADR 019): proposing records terms and queues an approval (local work); submitting is the once-only
// payment class; reading a virtual card's transactions is an external read; reconciliation, retries and card issuance are human-only.
add('local_read', 'payments.status payments.list payments.get');
add('local_write', 'payments.propose payments.cancel');
add('external_read', 'payments.checkCharges');
add('payment', 'payments.submit');
add('administration', 'payments.reconcile payments.retry payments.issueCard payments.closeCard payments.configureProvider');
for (const collection of ['materials', 'context', 'tasks', 'conversations', 'workflows', 'siteRules']) {
  for (const operation of ['list', 'get']) classifications.set(`${collection}.${operation}`, 'local_read');
  for (const operation of ['create', 'update', 'delete']) classifications.set(`${collection}.${operation}`, collection === 'siteRules' ? 'administration' : 'local_write');
}
// Plugin and browser-extension surfaces. Hook commands read only through nested gated dispatch;
// plugin and extension administration and export are human-only administration.
add('local_read', 'plugins.list plugins.invoke artifacts.render activity.report');
add('external_read', 'page.extract');
add('administration', 'workspaces.exportAs plugins.enable plugins.disable extensions.list extensions.audit extensions.install extensions.enable extensions.disable extensions.remove');
const pluginCommand = /^plugin\.[a-z][a-z0-9-]{1,39}\.[a-z][a-zA-Z0-9]{0,39}$/;
/**
 * Built-in plugin commands are classified from validated manifests by the plugin registry, never by name guessing.
 * The class is already raised to what the manifest permissions imply; data classes follow the permissions too.
 */
export function registerPluginActionClass(name, actionClass, dataClasses = null) {
  if (!pluginCommand.test(name) || !ACTION_CLASSES.includes(actionClass)) throw new Error(`Invalid plugin command classification: ${name}`);
  if (classifications.has(name) && classifications.get(name) !== actionClass) throw new Error(`Conflicting classification for ${name}`);
  classifications.set(name, actionClass);
  if (dataClasses) {
    if (dataClasses.some(item => !DATA_CLASSES.includes(item))) throw new Error(`Invalid plugin data classes: ${name}`);
    pluginDataClasses.set(name, [...new Set(dataClasses)]);
  }
}
const pluginDataClasses = new Map();
/** The more restrictive of two action classes (unknown values are unclassified). Used to raise a command to a plugin's effective class. */
const CLASS_ORDER = ['local_read', 'external_read', 'local_write', 'external_write', 'code_exec', 'cloud_spend', 'bulk_export', 'credential_use', 'payment', 'trusted_context', 'administration', 'unclassified'];
export function raiseActionClass(current, raised) {
  const rank = value => { const index = CLASS_ORDER.indexOf(value); return index < 0 ? CLASS_ORDER.length - 1 : index; };
  return CLASS_ORDER[Math.max(rank(current), rank(raised))];
}
export function actionClassForCommand(name) { return classifications.get(name) ?? 'unclassified'; }

/** Sensitive outbound categories that a command may produce. Unknown external effects are treated as all three external-change categories. */
const categories = {
  'page.click': ['form_submission', 'message', 'account_change'], 'page.fill': ['form_submission', 'account_change'],
  'page.clickAt': ['form_submission', 'message', 'account_change'], 'page.press': ['form_submission', 'message', 'account_change'],
  'page.evaluate': ['form_submission', 'message', 'account_change', 'sensitive_outbound_data'], 'chat.send': ['sensitive_outbound_data'],
  'workspaces.export': ['bulk_export'],
};
export function sensitiveCategoriesForCommand(name) {
  if (categories[name]) return [...categories[name]];
  const actionClass = actionClassForCommand(name);
  return Object.entries(SENSITIVE_CATEGORIES).filter(([, value]) => value === actionClass && actionClass !== 'external_write').map(([key]) => key);
}

/** Resource a command writes: decides which client write scope applies. Derived from namespace so new commands are covered. */
export function resourceForCommand(name) {
  const namespace = name.split('.')[0];
  if (['tabs', 'page', 'downloads', 'captures'].includes(namespace) || ['credentials.fill', 'payments.submit'].includes(name)) return 'tabs';
  if (['chat', 'models'].includes(namespace)) return 'models';
  if (['browser', 'cookies', 'storage', 'clients', 'lists', 'approvals', 'autonomy', 'settings', 'plugins', 'extensions', 'display', 'browsingData'].includes(namespace)) return 'browser';
  return 'records';
}

/** Data classes a command can disclose. Metadata-only commands return []. Unknown reads default to workspace records. */
const dataOverrides = {
  'guide.get': [], 'browser.info': [], 'plugins.list': [], 'page.extract': ['page_content'], 'activity.report': ['activity', 'workspace_records'], 'storage.info': [], 'models.list': [], 'tabs.list': [], 'autonomy.get': [], 'settings.get': [],
  'page.message': ['page_content'], 'page.readable': ['page_content'], 'page.title': ['page_content'], 'page.content': ['page_content'], 'page.inspect': ['page_content'], 'page.find': ['page_content'],
  'page.screenshot': ['page_capture'], 'page.pdf': ['page_capture'], 'artifacts.capture': ['page_capture'],
  'history.list': ['browsing_history'], 'downloads.list': ['browsing_history'],
  'activity.list': ['activity'], 'activity.verify': ['activity'], 'approvals.list': ['activity'],
  'conversations.list': ['conversations'], 'conversations.get': ['conversations'], 'chat.preview': ['conversations', 'workspace_records'],
  'chat.send': ['conversations', 'workspace_records'], 'conversations.message': ['conversations'],
  'workspace.snapshot': ['workspace_records', 'conversations', 'browsing_history', 'activity'],
  'search.query': ['workspace_records', 'conversations'],
  'artifacts.readOriginal': ['workspace_records', 'restricted_original'],
  'weft.capabilities': [], 'search.status': [], 'events.list': ['activity'], 'transfers.list': [], 'conversations.messages': ['conversations'],
  'transfers.read': ['workspace_records', 'page_capture'],
  'encryption.status': [],
  'tabs.search': ['workspace_records'], 'display.status': [], 'resources.status': [], 'captures.list': [],
  'payments.propose': ['page_content'], 'payments.status': [], 'payments.checkCharges': ['workspace_records'],
};
export function dataClassesForCommand(name) {
  if (dataOverrides[name]) return [...dataOverrides[name]];
  if (pluginDataClasses.has(name)) return [...pluginDataClasses.get(name)];
  const actionClass = actionClassForCommand(name);
  if (!['local_read', 'external_read'].includes(actionClass)) return [];
  return [name.startsWith('page.') ? 'page_content' : 'workspace_records'];
}

/** Effect labels drive activity outcomes: reads, reversible local writes, irreversible local deletion, or external effects. */
export function effectForCommand(name) {
  const actionClass = actionClassForCommand(name);
  if (['local_read', 'external_read'].includes(actionClass)) return 'none';
  if (EXTERNAL_CLASSES.includes(actionClass) || actionClass === 'unclassified') return 'external';
  if (/\.(delete|clear|close|revoke|remove)$/.test(name) || ['workspaces.import', 'workspaces.importPackage', 'artifacts.purgeContent'].includes(name)) return 'irreversible';
  return 'local';
}

export function levelRank(level) { return AUTONOMY_LEVELS.indexOf(level); }
/** The effective level is the most restrictive of the identity level and any workspace ceiling. */
export function effectiveLevel(...levels) {
  const known = levels.filter(level => level != null);
  if (known.some(level => levelRank(level) < 0)) return null;
  return known.reduce((lowest, level) => levelRank(level) < levelRank(lowest) ? level : lowest, 'autonomous');
}

/**
 * Pure autonomy gate. Returns auto, auto_preapproved, approval or deny.
 * Floors no override crosses: human-only commands deny; observe denies writes;
 * once-only classes require an exact one-time approval and ignore standing approvals and autonomy.
 * `approvedOnce`/`standing` are evidence from the trusted approval queue, never command arguments.
 */
export function evaluateAutonomy({ actor, actionClass, level = 'scoped', humanOnly = false, approvedOnce = false, standing = false, restrictedData = false } = {}) {
  if (['human', 'admin'].includes(actor)) return { decision: 'auto', reason: 'trusted_human' };
  if (humanOnly) return { decision: 'deny', reason: 'human_only' };
  const effective = ACTION_CLASSES.includes(actionClass) ? actionClass : 'unclassified';
  if (effective === 'administration') return { decision: 'deny', reason: 'human_only' };
  if (levelRank(level) < 0) return { decision: 'deny', reason: 'unknown_autonomy_level' };
  // Restricted originals: observe-level identities (including model readers) never read them; everyone else needs an exact one-time approval per read.
  if (restrictedData) {
    if (level === 'observe') return { decision: 'deny', reason: 'observe_only' };
    return approvedOnce ? { decision: 'auto_preapproved', reason: 'approved_once' } : { decision: 'approval', reason: 'restricted_original_access' };
  }
  if (['local_read', 'external_read'].includes(effective)) return { decision: 'auto', reason: 'read' };
  if (level === 'observe') return { decision: 'deny', reason: 'observe_only' };
  if (ONCE_ONLY_CLASSES.includes(effective)) return approvedOnce ? { decision: 'auto_preapproved', reason: 'approved_once' } : { decision: 'approval', reason: 'exact_approval_required' };
  // Trusted context is a human decision: only explicit approval evidence admits it, never an autonomy level.
  if (effective === 'trusted_context') return approvedOnce ? { decision: 'auto_preapproved', reason: 'approved_once' } : standing ? { decision: 'auto_preapproved', reason: 'standing_approval' } : { decision: 'approval', reason: 'trusted_context_approval_required' };
  if (effective === 'local_write' && levelRank(level) >= levelRank('scoped')) return { decision: 'auto', reason: 'local_write' };
  if (effective !== 'local_write' && level === 'autonomous') return { decision: 'auto_preapproved', reason: 'standing_autonomy_grant' };
  if (approvedOnce) return { decision: 'auto_preapproved', reason: 'approved_once' };
  if (standing) return { decision: 'auto_preapproved', reason: 'standing_approval' };
  return { decision: 'approval', reason: 'approval_required' };
}
/** Standing approvals are refused for once-only classes. */
export function standingAllowed(actionClass) { return !ONCE_ONLY_CLASSES.includes(ACTION_CLASSES.includes(actionClass) ? actionClass : 'unclassified'); }

/** Destination grants: '*', 'https://example.com', 'https://*.example.com', '*.example.com', with optional port. */
export function validDestinationPattern(pattern) {
  if (pattern === '*') return true;
  return /^(?:(https?):\/\/)?(\*\.)?[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)*(:\d{1,5})?$/i.test(pattern);
}
export function matchDestination(patterns, value) {
  if (!Array.isArray(patterns) || patterns.includes('*')) return true;
  let url;
  try { url = new URL(value); } catch { return false; }
  if (url.href === 'about:blank') return true;
  if (!['http:', 'https:'].includes(url.protocol)) return false;
  const host = url.hostname.toLowerCase().replace(/\.$/, '');
  const port = url.port || (url.protocol === 'https:' ? '443' : '80');
  return patterns.some(pattern => {
    const match = /^(?:(https?):\/\/)?(\*\.)?([^:]+)(?::(\d+))?$/i.exec(pattern);
    if (!match) return false;
    const [, scheme, wildcard, hostname, patternPort] = match;
    if (scheme && `${scheme.toLowerCase()}:` !== url.protocol) return false;
    if (patternPort && patternPort !== port) return false;
    const base = hostname.toLowerCase();
    return wildcard ? host.endsWith(`.${base}`) : host === base;
  });
}
