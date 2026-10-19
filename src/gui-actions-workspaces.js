/**
 * Workspace, window, encryption, export/import and backup actions.
 * Moved from the act() switch in src/gui.js (#119). Each handler receives the clicked button and its
 * data-action, data-id and data-kind; `g` holds live bindings to gui.js state and helpers.
 */
let g;

const handlers = {
  "section": async (button, a, id, kind) => {
    if (g.$("dialog").open) g.closeDialog();
    g.navigateSection(button.dataset.section);
  },
  "new-workspace": async (button, a, id, kind) => {
    g.workspaceForm();
  },
  "workspace-menu": async (button, a, id, kind) => {
    await g.workspaceMenu();
  },
  "edit-workspace": async (button, a, id, kind) => {
    g.workspaceForm(g.state.workspaces.find((w) => w.id === id));
  },
  "switch-workspace": async (button, a, id, kind) => {
    // A workspace shown in another window is brought forward there (#100); a second window switches among its own.
    const owner = g.windowInfo.assignments?.[id] ?? 1;
    if (owner !== g.windowInfo.windowId) { await window.weft.windows({ action: "show", workspaceId: id }); return; }
    if (!g.windowInfo.main) { await window.weft.windows({ action: "showHere", workspaceId: id }); await g.refreshWindow(); }
    else await g.execute("workspaces.switch", { id });
    g.conversationId = null;
    g.panes.load(null);
    if (g.$("dialog").open) g.closeDialog();
    g.navigateSection("overview", false);
    await g.applyResume().catch(() => {});
    if (g.agentOpen) g.renderAgent();
  },
  "move-window": async (button, a, id, kind) => {
    await window.weft.windows({ action: "move", workspaceId: id });
    g.closeDialog();
    g.toast("Opened in its own window. Close that window to bring the workspace back here.");
  },
  "return-window": async (button, a, id, kind) => {
    await window.weft.windows({ action: "move", workspaceId: id, windowId: 1 });
    g.closeDialog();
  },
  "archive-workspace": async (button, a, id, kind) => {
    if (g.state.workspaces.find((w) => w.id === id)?.archived)
      await g.confirmDelete("workspaces", id);
    else {
      await g.execute("workspaces.archive", { id });
      await g.workspaceMenu();
    }
  },
  "restore-workspace": async (button, a, id, kind) => {
    await g.execute("workspaces.restore", { id });
    await g.workspaceMenu();
  },
  "duplicate-workspace": async (button, a, id, kind) => {
    await g.execute("workspaces.duplicate", { id: g.ws().id });
    await g.workspaceMenu();
  },
  "export-workspace": async (button, a, id, kind) => {
    g.exportWorkspace();
  },
  "encryption-enable": async (button, a, id, kind) => {
    await g.enableEncryptionDialog();
  },
  "encryption-lock": async (button, a, id, kind) => {
    await g.execute("encryption.lock", {}, true);
    g.closeDialog();
    void g.showLockScreen();
  },
  "encryption-configure": async (button, a, id, kind) => {
    g.configureEncryptionDialog();
  },
  "encryption-rotate": async (button, a, id, kind) => {
    g.rotateEncryptionDialog();
  },
  "encryption-check": async (button, a, id, kind) => {
    g.checkRecoveryKeyDialog();
  },
  "encryption-coverage": async (button, a, id, kind) => {
    g.encryptionCoverageDialog();
  },
  "encryption-disable": async (button, a, id, kind) => {
    g.disableEncryptionDialog();
  },
  "import-workspace": async (button, a, id, kind) => {
    g.importWorkspace();
  },
  "export-package": async (button, a, id, kind) => {
    g.exportPackage();
  },
  "import-package": async (button, a, id, kind) => {
    g.importPackage();
  },
  "backup-now": async (button, a, id, kind) => {
    const backup = await g.execute("backups.create", {}, true);
    g.toast(backup.status === "verified" ? "Backup created and verified." : "Backup failed verification.");
    if (g.$("dialog").open) await g.manageBackups();
  },
  "manage-backups": async (button, a, id, kind) => {
    await g.manageBackups();
  },
  "verify-backup": async (button, a, id, kind) => {
    const result = await g.execute("backups.verify", { id }, true);
    g.toast(result.status === "verified" ? "Backup verified: every file matches its checksum." : `Backup failed verification: ${result.problems.map((p) => p.problem).join(", ")}`);
  },
  "restore-backup": async (button, a, id, kind) => {
    await g.restoreBackupDialog(id);
  },
};

/** Bind the handlers to the GUI's shared context and return them by action name. */
export function workspacesActions(context) {
  g = context;
  return handlers;
}
