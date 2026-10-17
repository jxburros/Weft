// In-memory only (the registry's per-plugin store): counts reset when Weft
// restarts and are never persisted or sent anywhere.

export default {
  manifest: {
    name: 'session-stats', version: '1.0.0', apiVersion: 1,
    description: 'Count command outcomes per workspace during this browser run (observes after-command metadata only)',
    permissions: { workspaceRead: true },
    hooks: { 'after-command': ['count'] },
    commands: {
      summary: { description: 'Summarize command outcomes observed for a workspace since Weft started', actionClass: 'local_read', input: {} },
    },
  },
  implementation: {
    hooks: {
      'after-command': {
        count(event, { store }) {
          if (!event.workspaceId) return;
          const counts = store.counts ??= new Map();
          const workspace = counts.get(event.workspaceId) ?? new Map();
          const key = `${event.command}\u0000${event.status}`;
          workspace.set(key, (workspace.get(key) ?? 0) + 1);
          counts.set(event.workspaceId, workspace);
        },
      },
    },
    commands: {
      summary(_args, weft) {
        const rows = [...(weft.store.counts?.get(weft.workspaceId) ?? new Map())].map(([key, count]) => {
          const [command, status] = key.split('\u0000');
          return { command, status, count };
        }).sort((a, b) => b.count - a.count || a.command.localeCompare(b.command));
        return { workspaceId: weft.workspaceId, scope: 'This browser run only; counts are not persisted.', total: rows.reduce((sum, row) => sum + row.count, 0), commands: rows };
      },
    },
  },
};
