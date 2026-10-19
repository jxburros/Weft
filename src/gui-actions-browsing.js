/**
 * Browsing data, downloads, updates, bookmarks, search results and page actions.
 * Moved from the act() switch in src/gui.js (#119). Each handler receives the clicked button and its
 * data-action, data-id and data-kind; `g` holds live bindings to gui.js state and helpers.
 */
let g;

const handlers = {
  "clear-storage": async (button, a, id, kind) => {
    g.formDialog(
      "Clear site storage",
      g.field(
        "Site URL",
        "url",
        g.active()?.url !== "about:blank" ? g.active()?.url || "" : "",
        "url",
        true,
      ) +
        "<p>This signs you out of the site in this workspace. Server-side account records are not deleted.</p>",
      async (v) => {
        await g.execute("storage.clear", { url: v.url, workspaceId: g.ws().id });
      },
      { save: "Clear site data" },
    );
  },
  "approve-download": async (button, a, id, kind) => {
    await g.execute("downloads.approve", { downloadId: Number(id) });
    await g.loadDownloads();
  },
  "clear-history": async (button, a, id, kind) => {
    g.formDialog(
      "Clear browsing history?",
      "<p>This removes recorded visits in this workspace. Saved materials and captures remain.</p>",
      async () => {
        await g.execute("history.clear", { workspaceId: g.ws().id });
      },
      { save: "Clear history" },
    );
  },
  "bookmark-page": async (button, a, id, kind) => {
    if (!g.active() || g.active().url === "about:blank")
      throw new Error("Open a page before bookmarking it.");
    await g.execute("bookmarks.create", {
      workspaceId: g.ws().id,
      title: g.displayTitle(g.active()).slice(0, 240),
      url: g.active().url,
    });
    g.toast("Bookmark saved.");
  },
  "resume-automation": async (button, a, id, kind) => {
    await g.execute("browser.resumeAutomation", {});
    g.toast("Automation resumed. Tab control remains with you until released.");
  },
  "check-updates": async (button, a, id, kind) => {
    button.disabled = true;
    try {
      const result = await g.execute("update.check", {}, true);
      g.toast(result.message);
    } finally {
      await g.loadUpdates();
    }
  },
  "install-update": async (button, a, id, kind) => {
    const result = await g.execute("update.install", { version: button.dataset.version }, true);
    g.toast(result.message);
    await g.loadUpdates();
  },
  "rollback-update": async (button, a, id, kind) => {
    const result = await g.execute("update.rollback", {}, true);
    g.toast(result.message);
    await g.loadUpdates();
  },
  "emergency-stop": async (button, a, id, kind) => {
    await g.execute("browser.emergencyStop", {});
    g.toast(
      "Agent control revoked. Loading, downloads, and model requests stopped.",
    );
  },
  "cancel-download": async (button, a, id, kind) => {
    await g.execute("downloads.cancel", { downloadId: Number(id) });
    await g.loadDownloads();
  },
  "search-result": async (button, a, id, kind) => {
    if (kind === "memories") { await g.manageLearning(); return; }
    if (kind === "artifacts") await g.viewArtifact(id);
    else if (kind === "workspaces") {
      await g.execute("workspaces.switch", { id });
      g.navigateSection("overview");
    } else if (g.state[kind]) g.editRecord(kind, id);
  },
  "download-file": async (button, a, id, kind) => {
    const r = await g.execute("materials.get", { id }, true);
    if (!r.fileBase64)
      throw new Error("Stored file bytes were not returned.");
    const link = document.createElement("a");
    link.href = `data:${r.mimeType || "application/octet-stream"};base64,${r.fileBase64}`;
    link.download = r.filename || r.title;
    link.click();
  },
  "find-page": async (button, a, id, kind) => {
    g.browserChrome.actions({ dataset: { action: "open-find" } });
  },
  "zoom-page": async (button, a, id, kind) => {
    await g.execute("page.zoom", { factor: Number(button.dataset.factor) });
  },
  "duplicate-tab": async (button, a, id, kind) => {
    await g.execute("tabs.duplicate", { tabId: g.active().id });
    g.closeDialog();
    g.navigateSection("browse");
  },
  "save-pdf": async (button, a, id, kind) => {
    g.showResult(await g.execute("page.pdf"));
    g.openCommands();
  },
  "show-tabs": async (button, a, id, kind) => {
    g.closeDialog();
    g.navigateSection("tabs");
  },
  "move-tab": async (button, a, id, kind) => {
    g.formDialog(
      "Move tab to another workspace",
      g.choice(
        "Destination",
        "workspaceId",
        g.state.workspaces
          .filter((w) => !w.archived && w.id !== g.ws().id)
          .map((w) => [w.id, w.name]),
        "",
      ) +
        "<p>The page reloads in a separate storage container. Login state is not transferred.</p>",
      async (values) => {
        await g.execute("tabs.move", { tabId: g.active().id, ...values });
      },
      { save: "Move tab" },
    );
  },
};

/** Bind the handlers to the GUI's shared context and return them by action name. */
export function browsingActions(context) {
  g = context;
  return handlers;
}
