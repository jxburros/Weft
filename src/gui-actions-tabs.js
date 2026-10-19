/**
 * Tab, tab group, pane, display, capture-queue and handoff actions.
 * Moved from the act() switch in src/gui.js (#119). Each handler receives the clicked button and its
 * data-action, data-id and data-kind; `g` holds live bindings to gui.js state and helpers.
 */
let g;

const handlers = {
  "new-tab": async (button, a, id, kind) => {
    await g.execute("tabs.new", {});
    g.navigateSection("browse");
    g.$("address").focus();
  },
  "activate-tab": async (button, a, id, kind) => {
    await g.execute("tabs.activate", { tabId: Number(id) });
    g.saveResume({ activeTabId: Number(id) });
    g.navigateSection("browse");
  },
  "open-tab-result": async (button, a, id, kind) => {
    const target = Number(id);
    if (button.dataset.ws && button.dataset.ws !== g.ws().id) {
      if ((g.windowInfo.assignments?.[button.dataset.ws] ?? 1) !== g.windowInfo.windowId) { await window.weft.windows({ action: "show", workspaceId: button.dataset.ws }); return; }
      if (g.windowInfo.main) await g.execute("workspaces.switch", { id: button.dataset.ws });
      else await window.weft.windows({ action: "showHere", workspaceId: button.dataset.ws });
      g.panes.load(null);
    }
    await g.execute("tabs.activate", { tabId: target });
    g.saveResume({ activeTabId: target });
    g.navigateSection("browse");
  },
  "search-tabs": async (button, a, id, kind) => {
    g.tabSearch();
  },
  "new-group": async (button, a, id, kind) => {
    g.groupDialog();
  },
  "edit-group": async (button, a, id, kind) => {
    g.groupDialog(g.records("tabGroups").find((g) => g.id === id));
  },
  "toggle-group": async (button, a, id, kind) => {
    const group = g.records("tabGroups").find((g) => g.id === id);
    if (group) await g.execute("tabGroups.update", { id, changes: { collapsed: !group.collapsed } }, true);
    await g.refresh(true);
    g.$(`group-${id}`)?.focus();
  },
  "delete-group": async (button, a, id, kind) => {
    await g.execute("tabGroups.delete", { id }, true);
    g.closeDialog();
    await g.refresh(true);
    g.toast("Group deleted. Its tabs stay open.");
  },
  "suspend-tab": async (button, a, id, kind) => {
    const result = await g.execute("tabs.suspend", { tabId: Number(id) }, true);
    g.toast(result.suspended ? "Tab suspended. It reloads when you open it." : `This tab was not suspended: ${result.blockedBy.join(", ").replaceAll("_", " ")}.`);
    await g.refresh(true);
  },
  "pin-resource": async (button, a, id, kind) => {
    await g.togglePin(kind, id);
  },
  "dismiss-restore": async (button, a, id, kind) => {
    g.restoreNotices = [];
    g.renderSafetyNotices(null);
  },
  "focus-pane-to": async (button, a, id, kind) => {
    const item = g.panes.focus(Math.max(0, g.PANE_NAMES.indexOf(button.dataset.pane)));
    // The focused tab pane is the active tab: address bar, find, zoom and print act on it.
    if (item?.type === "tab" && item.id !== g.active()?.id) await g.execute("tabs.activate", { tabId: item.id }, true);
    g.savePanes();
    await g.refresh(true);
    g.renderShell();
    g.renderContent();
    await g.focusPage();
  },
  "close-pane": async (button, a, id, kind) => {
    g.panes.close(Number(button.dataset.index));
    if (!g.panes.items.some((item) => item?.type === "preview") && g.previewing) await g.closePreview(true);
    g.savePanes();
    g.renderShell();
    g.renderContent();
    g.announce(`${g.panes.items.length} pane${g.panes.items.length === 1 ? "" : "s"} shown.`);
  },
  "pane-layout": async (button, a, id, kind) => {
    g.paneLayoutDialog();
  },
  "pane-choose": async (button, a, id, kind) => {
    g.paneChooser(Number(button.dataset.index), kind);
  },
  "open-in-pane": async (button, a, id, kind) => {
    const item = { type: kind, id: kind === "tab" ? Number(id) : id, ...(button.dataset.version ? { versionId: button.dataset.version } : {}) };
    if (Number.isInteger(Number(button.dataset.index))) { g.panes.focus(Number(button.dataset.index)); g.panes.open(item, g.visibleTabs(), g.active()); }
    else g.panes.open(item, g.visibleTabs(), g.active());
    if (item.type === "tab") await g.execute("tabs.activate", { tabId: item.id }, true);
    g.savePanes();
    g.closeDialog();
    g.navigateSection("browse");
  },
  "move-record": async (button, a, id, kind) => {
    g.moveRecordDialog(kind, id);
  },
  "manage-lists": async (button, a, id, kind) => {
    if (g.$("dialog").open) g.closeDialog();
    g.navigateSection("lists");
  },
  "automation-settings": async (button, a, id, kind) => {
    g.automationSettings();
  },
  "focus-pane": async (button, a, id, kind) => {
    const next = (g.panes.focused + 1) % Math.max(1, g.panes.items.length);
    const item = g.panes.focus(next);
    if (item?.type === "tab") await g.execute("tabs.activate", { tabId: item.id }, true);
    g.savePanes();
    g.closeDialog();
    await g.refresh(true);
    g.renderShell();
    g.renderContent();
    g.layout();
    g.toast(`Focused pane: ${g.panes.label(next)}.`);
  },
  "display-hide": async (button, a, id, kind) => {
    g.openDialog("Run Weft in the background?",
      "<p>The window hides and Weft keeps running with this profile, its policies and the agent API. Open pages reload so they can render without a window: unsent form input and in-page state in them are lost.</p><p>Show the window again with <code>weft attach</code> or by launching Weft. Agent requests that need your decision wait until then.</p>",
      g.action("close-dialog", "Cancel") + g.action("confirm-display-hide", "Hide window", "", "", "primary"));
  },
  "confirm-display-hide": async (button, a, id, kind) => {
    g.closeDialog();
    await g.execute("display.hide", { confirmReload: true }, true);
  },
  "quit-weft": async (button, a, id, kind) => {
    await g.execute("browser.close", {}, true);
  },
  "manage-resources": async (button, a, id, kind) => {
    await g.manageResources();
  },
  "cancel-capture": async (button, a, id, kind) => {
    const result = await g.execute("captures.cancel", { jobId: id }, true);
    g.toast(result.notice || (result.cancelled ? "Capture cancelled." : "Capture could not be cancelled."));
    g.closeDialog();
    await g.manageResources();
  },
  "import-browsing": async (button, a, id, kind) => {
    await g.importBrowsingData();
  },
  "close-tab": async (button, a, id, kind) => {
    await g.execute("tabs.close", { tabId: Number(id) });
    if (!g.visibleTabs().length) g.navigateSection("overview");
  },
  "pin-tab": async (button, a, id, kind) => {
    await g.execute("tabs.pin", {
      tabId: Number(id),
      pinned: !g.tabs.find((t) => t.id === Number(id))?.pinned,
    });
  },
  "takeover": async (button, a, id, kind) => {
    await g.execute("tabs.takeover", { tabId: Number(id) });
  },
  "control-mode": async (button, a, id, kind) => {
    await g.execute("tabs.setControlMode", { tabId: Number(id), mode: button.dataset.mode });
  },
  "handoff-accept": async (button, a, id, kind) => {
    await g.execute("handoffs.accept", { id });
  },
  "handoff-complete": async (button, a, id, kind) => {
    await g.execute("handoffs.complete", { id, status: button.dataset.state });
  },
};

/** Bind the handlers to the GUI's shared context and return them by action name. */
export function tabsActions(context) {
  g = context;
  return handlers;
}
