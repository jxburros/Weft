/** Pure policy. Approval-required actions remain blocked until an approval broker exists. */
export const ACTION_CLASSES = Object.freeze(['local_read', 'external_read', 'local_write', 'external_write', 'code_exec', 'cloud_spend', 'administration', 'restricted']);
const classifications = new Map();
function add(actionClass, names) { for (const name of names.split(/\s+/).filter(Boolean)) classifications.set(name, actionClass); }
add('local_read', `guide.get browser.info tabs.list page.inspect storage.info downloads.list history.list bookmarks.list workspace.snapshot workspaces.list workspaces.get workspaces.export settings.get activity.list search.query artifacts.list artifacts.get models.list`);
add('external_read', `page.readable page.title page.content page.screenshot page.pdf`);
add('local_write', `tabs.activate tabs.close tabs.pin tabs.claim tabs.release page.find page.zoom page.stop downloads.cancel bookmarks.create bookmarks.delete workspaces.create workspaces.update workspaces.switch workspaces.archive workspaces.restore workspaces.duplicate workspaces.import conversations.message tasks.transition artifacts.capture artifacts.create artifacts.annotate artifacts.delete chat.cancel`);
add('external_write', `tabs.new tabs.duplicate tabs.move page.navigate page.back page.forward page.reload page.click page.fill`);
add('code_exec', 'page.evaluate');
add('cloud_spend', 'chat.send');
add('local_read', 'chat.preview');
add('administration', 'clients.create clients.list clients.revoke');
add('administration', `browser.emergencyStop browser.resumeAutomation browser.close downloads.approve tabs.takeover page.allowOnce cookies.list cookies.set cookies.clear storage.clear history.clear settings.update workspaces.delete models.save models.delete`);
for (const collection of ['materials', 'context', 'tasks', 'conversations', 'workflows', 'siteRules']) {
  for (const operation of ['list', 'get']) classifications.set(`${collection}.${operation}`, 'local_read');
  for (const operation of ['create', 'update', 'delete']) classifications.set(`${collection}.${operation}`, ['siteRules', 'workflows'].includes(collection) ? 'administration' : 'local_write');
}
export function actionClassForCommand(name) { return classifications.get(name) ?? 'restricted'; }
export function evaluateAutonomy({ actor, actionClass, level = 'scoped', approved = false } = {}) {
  if (['human', 'admin'].includes(actor)) return { decision: 'auto', reason: 'trusted_human' };
  if (!ACTION_CLASSES.includes(actionClass) || ['administration', 'restricted'].includes(actionClass)) return { decision: 'deny', reason: 'hard_floor' };
  if (!['observe', 'assist', 'scoped'].includes(level)) return { decision: 'deny', reason: 'unknown_autonomy_level' };
  if (['local_read', 'external_read'].includes(actionClass)) return { decision: 'auto', reason: 'read' };
  if (level === 'observe') return { decision: 'deny', reason: 'observe_only' };
  if (actionClass === 'local_write' && level === 'scoped') return { decision: 'auto', reason: 'local_write' };
  // Approval is evidence supplied by a future trusted broker, never a command argument.
  return approved ? { decision: 'auto_preapproved', reason: 'approved' } : { decision: 'approval', reason: 'approval_required' };
}
