/**
 * Credentials, payments, plugins, extensions, client grants, approvals and activity actions.
 * Moved from the act() switch in src/gui.js (#119). Each handler receives the clicked button and its
 * data-action, data-id and data-kind; `g` holds live bindings to gui.js state and helpers.
 */
let g;

const handlers = {
  "manage-clients": async (button, a, id, kind) => {
    await g.manageClients();
  },
  "manage-credentials": async (button, a, id, kind) => {
    await g.manageCredentials();
  },
  "new-credential": async (button, a, id, kind) => {
    g.newCredential();
  },
  "new-payment-card": async (button, a, id, kind) => {
    g.newPaymentCard();
  },
  "manage-payments": async (button, a, id, kind) => {
    await g.managePayments();
  },
  "payment-provider": async (button, a, id, kind) => {
    const status = await g.execute("payments.status", {}, true);
    g.formDialog("Virtual cards",
      `<p>Optional. With a card-issuing account (an API in the style of Lithic or Privacy.com), Weft can create a card for one approved payment: single-use, or locked to the merchant and limited to the approved amount per period. The card goes straight into your saved cards; agents never see its number. This adapter has been tested only against a stand-in server, not a real issuer account.</p>` +
        g.choice("Status", "enabled", [["false", "Off"], ["true", "On"]], String(status.provider.enabled)) + g.field("Issuer API address", "baseUrl", status.provider.baseUrl || "") +
        g.field(status.provider.keyConfigured ? "API key (leave empty to keep the saved key)" : "API key", "apiKey", "", "password") + g.field("Currencies the issuer supports", "currencies", status.provider.currencies.join(", ")),
      async (v) => {
        const currencies = v.currencies.split(/[\s,]+/).map((code) => code.trim().toUpperCase()).filter(Boolean);
        await g.execute("payments.configureProvider", { provider: "issuer_api", enabled: v.enabled === "true", ...(v.baseUrl.trim() ? { baseUrl: v.baseUrl.trim() } : {}), ...(v.apiKey ? { apiKey: v.apiKey } : {}), ...(currencies.length ? { currencies } : {}) });
        g.toast(v.enabled === "true" ? "Virtual cards are on. Issue one from a proposed payment." : "Virtual cards are off.");
      });
  },
  "payment-cancel": async (button, a, id, kind) => {
    await g.execute("payments.cancel", { id, reason: "Cancelled in Weft" }, true);
    g.toast("Cancelled before submission. The approval is void.");
    await g.managePayments();
  },
  "payment-issue-card": async (button, a, id, kind) => {
    g.formDialog("Issue a virtual card",
      `<p>Creates a card limited to this payment's approved amount and stores it as a saved card for the merchant site. Add payment-processor frames if the checkout collects card details in an embedded frame.</p>${g.area("Payment-processor frames allowed (optional, exact origins)", "frameOrigins", "")}`,
      async (v) => {
        const frameOrigins = String(v.frameOrigins || "").split(/\n+/).map((line) => line.trim()).filter(Boolean);
        const issued = await g.execute("payments.issueCard", { id, ...(frameOrigins.length ? { frameOrigins } : {}) });
        g.toast(issued.notice);
      });
  },
  "payment-check-charges": async (button, a, id, kind) => {
    const result = await g.execute("payments.checkCharges", { id }, true);
    g.toast(result.outsideTerms ? `${result.outsideTerms} charge(s) are outside the approved terms. Close the card and approve a new payment for further charges.` : `${result.withinTerms} charge(s), all within the approved terms.`);
    await g.managePayments();
  },
  "payment-close-card": async (button, a, id, kind) => {
    await g.execute("payments.closeCard", { id }, true);
    g.toast("Card closed at the issuer and removed from saved cards.");
    await g.managePayments();
  },
  "payment-reconcile": async (button, a, id, kind) => {
    g.formDialog("Record what happened",
      `<p>Weft could not tell whether the merchant received this payment. Check the merchant account, confirmation email or card statement. With a virtual card, Weft can look up its transactions.</p>${g.choice("What happened", "determination", [["lookup", "Look up the virtual card's transactions"], ["completed", "The payment went through"], ["not_completed", "Nothing was charged"]], "lookup")}${g.area("Note (optional)", "note", "")}`,
      async (v) => {
        const result = await g.execute("payments.reconcile", { id, determination: v.determination, ...(v.note ? { note: v.note } : {}) });
        g.toast(result.determination.status === "unknown" ? `Still uncertain: ${result.determination.detail}` : `Recorded: ${result.determination.status.replace("_", " ")}.`);
      });
  },
  "payment-retry": async (button, a, id, kind) => {
    g.formDialog("Allow another attempt",
      `<div class="notice">The earlier attempt may already have charged. Allowing another attempt risks paying twice. The agent still needs your approval of the same terms before it can submit again.</div>${g.area("Why (optional)", "note", "")}`,
      async (v) => { const result = await g.execute("payments.retry", { id, confirmDuplicateRisk: true, ...(v.note ? { note: v.note } : {}) }); g.toast(result.notice); },
      { save: "I accept the risk of paying twice", trusted: "Payments" });
  },
  "fill-credential": async (button, a, id, kind) => {
    if (!g.active()) throw new Error("Open the sign-in page in a tab first.");
    const result = await g.execute("credentials.fill", { id, tabId: g.active().id, workspaceId: g.ws().id });
    g.toast(result.status === "filled" ? `Filled on ${result.origin}. Check the page and submit when ready.` : `Sign-in ${result.status}.`);
  },
  "grant-credential": async (button, a, id, kind) => {
    const open = g.records("tasks").filter((t) => !["completed", "failed", "cancelled"].includes(t.status));
    if (!open.length) throw new Error("Create the task first; grants are bound to one open task.");
    g.formDialog("Allow a task to use this sign-in",
      `<p>The agent working on this task may fill this sign-in without asking each time, only on its listed sites, until the uses run out, the time ends or the task closes.</p>${g.choice("Task", "taskId", open.map((t) => [t.id, t.title]), open[0].id)}${g.field("Number of uses", "uses", "1", "number", true)}${g.field("Minutes", "minutes", "60", "number", true)}`,
      async (v) => { await g.execute("credentials.grantTask", { id, taskId: v.taskId, uses: Number(v.uses), minutes: Number(v.minutes) }); g.toast("Task grant created."); }, { trusted: "Sign-in grant" });
  },
  "revoke-credential": async (button, a, id, kind) => {
    await g.execute("credentials.revoke", { id }, true);
    g.toast("Revoked. Its secret was discarded and it can never be used again.");
    await g.manageCredentials();
  },
  "delete-credential": async (button, a, id, kind) => {
    await g.execute("credentials.delete", { id }, true);
    await g.manageCredentials();
  },
  "credential-provider": async (button, a, id, kind) => {
    const status = await g.execute("credentials.status", {}, true);
    g.formDialog("1Password CLI",
      `<p>Optional. Weft's credential broker runs the 1Password command-line tool (<code>op read</code>) only when a saved sign-in that uses it is filled. Sign in to the CLI separately. This adapter has been tested only against a stand-in program, not a real 1Password account.</p>${g.choice("Status", "enabled", [["false", "Off"], ["true", "On"]], String(status.providers.onepassword.enabled))}${g.field("op program (path or name on PATH)", "command", status.providers.onepassword.command || "op")}`,
      async (v) => { await g.execute("credentials.configureProvider", { provider: "onepassword", enabled: v.enabled === "true", command: v.command.trim() || "op" }); });
  },
  "manage-plugins": async (button, a, id, kind) => {
    await g.managePlugins();
  },
  "enable-plugin": async (button, a, id, kind) => {
    await g.execute("plugins.enable", { name: button.dataset.name, ...(button.dataset.code ? { manifestSha256: button.dataset.manifest, codeSha256: button.dataset.code } : {}), ...(button.dataset.automation ? { allowAutomation: true } : {}) }, true);
    await g.managePlugins();
  },
  "disable-plugin": async (button, a, id, kind) => {
    await g.execute("plugins.disable", { name: button.dataset.name }, true);
    await g.managePlugins();
  },
  "manage-extensions": async (button, a, id, kind) => {
    await g.manageExtensions();
  },
  "install-extension": async (button, a, id, kind) => {
    g.installExtension();
  },
  "enable-extension": async (button, a, id, kind) => {
    await g.execute(`extensions.${a.split("-")[0]}`, { id }, true);
    await g.manageExtensions();
  },
  "new-client": async (button, a, id, kind) => {
    g.createClient();
  },
  "revoke-client": async (button, a, id, kind) => {
    await g.execute("clients.revoke", { clientId: id }, true);
    await g.manageClients();
  },
  "edit-client": async (button, a, id, kind) => {
    await g.editClient(id);
  },
  "approval-decide": async (button, a, id, kind) => {
    const mode = button.dataset.mode;
    if (mode === "reject") await g.execute("approvals.reject", { id }, true);
    else await g.execute("approvals.approve", { id, mode, standingMinutes: 60 }, true);
    g.toast(mode === "reject" ? "Request rejected. The agent will see the refusal." : mode === "once" ? "Approved once. The agent can now retry exactly this action." : "Approved for 1 hour for this action type, workspace and site.");
    await g.refresh(true);
    await g.loadApprovals();
  },
  "activity-more": async (button, a, id, kind) => {
    await g.loadActivity(true);
  },
  "activity-settings": async (button, a, id, kind) => {
    await g.activitySettings();
  },
};
handlers["disable-extension"] = handlers["enable-extension"];
handlers["remove-extension"] = handlers["enable-extension"];

/** Bind the handlers to the GUI's shared context and return them by action name. */
export function authorityActions(context) {
  g = context;
  return handlers;
}
