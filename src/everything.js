/**
 * The built-in Everything workspace (#99): a normal workspace in storage terms (own Chromium partition,
 * tabs, bookmarks, history, notes, captures, tasks) that cannot be deleted, renamed or archived. It holds
 * pages that belong to no project yet: new tabs opened with no workspace context, links and files other
 * applications ask Weft to open, and tabs rescued from a deleted workspace.
 *
 * It is not a global bucket for agents: agent tokens stay scoped by workspace, and an external link
 * opened by the operating system never grants any agent access.
 */
// A fixed, UUID-shaped id, so every surface that validates workspace ids (MCP resource URIs, typed error details) accepts it.
export const EVERYTHING_ID = 'ws_00000000-0000-4000-8000-000000000001';
export const EVERYTHING_NAME = 'Everything';
export const EXTERNAL_DESTINATIONS = Object.freeze(['everything', 'ask', 'last-used']);

export const isEverything = id => id === EVERYTHING_ID;

export function everythingRecord(timestamp = new Date().toISOString()) {
  return { id: EVERYTHING_ID, name: EVERYTHING_NAME, description: 'Pages and links that are not part of a project yet.', color: '#5E6B73', icon: '∗',
    archived: false, builtin: 'everything', createdAt: timestamp, updatedAt: timestamp, revision: 1 };
}

/** Add Everything to a store that predates it, first in the rail. Returns true when it was added or repaired. */
export function ensureEverything(data, timestamp) {
  const index = data.workspaces.findIndex(item => item.id === EVERYTHING_ID);
  if (index === -1) { data.workspaces.unshift(everythingRecord(timestamp)); return true; }
  const record = data.workspaces[index];
  let changed = false;
  // The built-in identity is restored if a store was edited by hand; its contents are left alone.
  if (record.builtin !== 'everything' || record.archived || record.name !== EVERYTHING_NAME) { Object.assign(record, { builtin: 'everything', archived: false, name: EVERYTHING_NAME }); changed = true; }
  if (index !== 0) { data.workspaces.splice(index, 1); data.workspaces.unshift(record); changed = true; }
  return changed;
}

/** A typed refusal for changes the built-in workspace does not allow. */
export function everythingRefusal(action) {
  const message = action === 'delete' ? 'Everything is built in and cannot be deleted'
    : action === 'archive' ? 'Everything is built in and cannot be archived'
      : action === 'rename' ? 'Everything is built in and cannot be renamed'
        : action === 'window' ? 'Everything is shown only in the main window; it cannot be moved to another window'
          : 'Everything is built in; this change is not allowed';
  return Object.assign(new Error(message), { code: 'invalid_arguments', details: { workspaceId: EVERYTHING_ID, builtin: 'everything' } });
}
