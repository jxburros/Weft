/**
 * Capture, archive preview, comparison, redaction and version actions.
 * Moved from the act() switch in src/gui.js (#119). Each handler receives the clicked button and its
 * data-action, data-id and data-kind; `g` holds live bindings to gui.js state and helpers.
 */
let g;

const handlers = {
  "open-url": async (button, a, id, kind) => {
    if (g.$("dialog").open) g.closeDialog();
    await g.execute("tabs.new", { url: button.dataset.url });
    g.navigateSection("browse");
  },
  "capture": async (button, a, id, kind) => {
    await g.capture();
  },
  "recapture": async (button, a, id, kind) => {
    await g.capture(id);
  },
  "view-artifact": async (button, a, id, kind) => {
    await g.viewArtifact(id);
  },
  "preview-archive": async (button, a, id, kind) => {
    await g.openPreview(id, button.dataset.version);
  },
  "close-preview": async (button, a, id, kind) => {
    await g.closePreview();
  },
  "compare-versions": async (button, a, id, kind) => {
    await g.compareDialog(id, button.dataset.version);
  },
  "redact-version": async (button, a, id, kind) => {
    await g.redactionEditor(id, button.dataset.version);
  },
  "restrict-version": async (button, a, id, kind) => {
    await g.execute("artifacts.setAccess", { id, versionId: button.dataset.version, access: a === "restrict-version" ? "restricted" : "standard" }, true);
    g.toast(a === "restrict-version" ? "Original restricted: agents get a withheld stub; it is removed from search and default exports." : "Agents can read this version again.");
    await g.viewArtifact(id, button.dataset.version);
  },
  "verify-artifact": async (button, a, id, kind) => {
    const report = await g.execute("artifacts.verify", { id }, true);
    g.toast(report.status === "verified" ? "Every stored component matches its SHA-256." : `${report.problems} stored components are damaged or missing; restore from a backup.`);
  },
  "purge-version": async (button, a, id, kind) => {
    const versionId = button.dataset.version;
    g.formDialog("Purge this version’s content?",
      "<p>This permanently deletes the stored text, screenshot and archived resources of this version from this profile. Its metadata and hashes stay, and sanitized versions are kept. Existing backups and exports still contain the content; delete them separately if needed. Weft cannot guarantee physical erasure from the storage device.</p>",
      async () => {
        const purged = await g.execute("artifacts.purgeContent", { id, versionId }, true);
        g.toast(`Content purged: ${purged.componentsDeleted} stored files deleted${purged.componentsKept ? `, ${purged.componentsKept} still used elsewhere` : ""}.`);
      }, { save: "Purge content" });
  },
};
handlers["allow-version"] = handlers["restrict-version"];

/** Bind the handlers to the GUI's shared context and return them by action name. */
export function capturesActions(context) {
  g = context;
  return handlers;
}
