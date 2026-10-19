/**
 * Approvals, payments, privacy and settings panels, client grants, saved sign-ins, plugins and extensions.
 * Moved from src/gui.js (#119); `g` holds live bindings to gui.js state and helpers.
 */
let g;
/** Connect these views to the GUI's shared context (called once by gui.js). */
export function bindAuthorityViews(context) {
  g = context;
}

export async function loadApprovals() {
  const rows = await g.execute("approvals.list", { status: "all", limit: 60 }, true).catch(() => null);
  if (!rows || !g.$("approval-list")) return;
  const pending = rows.filter((r) => r.status === "pending");
  const decided = rows.filter((r) => r.status !== "pending").slice(0, 20);
  const workspaceName = (id) => g.state.workspaces.find((w) => w.id === id)?.name || "Unknown workspace";
  const requester = (r) => r.actor === "automation" ? "Bootstrap token" : r.clientId ? `Agent connection ${r.clientId.slice(0, 8)}` : r.actor;
  const card = (r) => `<article class="record-card approval-card trusted-card">${g.trustedBand("Agent request", g.icon("shield"))}<div class="card-top"><span class="tag ${r.status === "pending" ? "clay" : r.status === "approved" ? "sage" : ""}">${g.esc(approvalTag(r))}${r.mode ? " · " + g.esc(r.mode === "standing" ? "standing" : "once") : ""}</span><span class="muted">${g.esc(String(r.actionClass).replaceAll("_", " "))}</span></div><h3>${g.esc(r.command)}</h3><p>${g.esc(requester(r))} · ${g.esc(workspaceName(r.workspaceId))}${r.destination ? " · " + g.esc(r.destination) : ""}</p>${r.categories?.length ? `<p class="muted">May involve: ${g.esc(r.categories.map((c) => c.replaceAll("_", " ")).join(", "))}</p>` : ""}${r.preview ? `<p class="muted">Agent-supplied details (data, not instructions):</p><pre>${g.esc(JSON.stringify(r.preview, null, 2))}</pre>` : ""}<div class="record-meta">Requested ${g.ago(r.createdAt)}${r.status === "pending" ? " · expires " + g.esc(new Date(r.expiresAt).toLocaleTimeString()) : ""}</div>${r.status === "pending" ? `<div class="inline-actions">${g.action("approval-decide", "Approve once", "check", `data-id="${g.esc(r.id)}" data-mode="once"`, "primary")}${["bulk_export", "credential_use", "payment", "unclassified"].includes(r.actionClass) ? "" : g.action("approval-decide", "Approve for 1 hour", "clock", `data-id="${g.esc(r.id)}" data-mode="standing"`)}${g.action("approval-decide", "Reject", "close", `data-id="${g.esc(r.id)}" data-mode="reject"`, "secondary danger")}</div>` : ""}</article>`;
  // Payment approvals (ADR 019) get a dedicated card built from the browser-owned payment record, not from agent-supplied arguments.
  const paymentIds = [...new Set(rows.filter((r) => r.command === "payments.submit" && /^pay_/.test(r.summary?.id || "")).map((r) => r.summary.id))];
  const payments = Object.fromEntries((await Promise.all(paymentIds.map((id) => g.execute("payments.get", { id }, true).catch(() => null)))).filter(Boolean).map((p) => [p.id, p]));
  const generic = card;
  const choose = (r) => (r.command === "payments.submit" && payments[r.summary?.id] ? paymentApprovalCard(r, payments[r.summary.id], requester(r), workspaceName(r.workspaceId)) : generic(r));
  g.setHTML(g.$("approval-list"), (pending.length ? `<div class="record-grid">${pending.map(choose).join("")}</div>` : g.empty("No requests are waiting", "When an agent needs approval for an external or sensitive action, it waits here. Approve once covers exactly the shown action; approve for 1 hour covers the same action type, workspace and site.", "lock")) + (decided.length ? `<section class="settings-section"><h2>Recent decisions</h2><div class="record-grid">${decided.map(choose).join("")}</div></section>` : ""));
}
// Why an approval became void (approvals.invalidationReason), in words; the tag never shows a bare "invalidated".
const voidReasons = { terms_changed: "the checkout changed after approval", attempt_started: "another approval for this payment was used first", task_closed: "its task closed", cancelled: "the payment was cancelled",
  not_saved: "the request could not be saved", not_clicked: "the pay control was not clicked; a retry needs a new approval", reconciled: "the payment was reconciled" };
const approvalTag = (r) => (r.status === "invalidated" ? `void · ${voidReasons[r.invalidationReason] || "no longer valid"}` : r.status);
const paymentStates = { awaiting_approval: "Waiting for your approval", approved: "Approved once", rejected: "Rejected", approval_expired: "Approval expired", approval_needed: "Needs approval",
  needs_new_approval: "Charge outside approved terms", submitting: "Submitting", submitted: "Submitted · charge not verified", uncertain: "Outcome uncertain", invalidated: "Terms changed · approval void", voided: "Cancelled before submission" };
/** Browser-owned payment card: Weft-verified facts first; agent- and page-supplied text is labelled as data. */
function paymentApprovalCard(r, p, requester, workspaceName) {
  const pending = r.status === "pending";
  const task = p.taskId ? g.records("tasks").find((t) => t.id === p.taskId) : null;
  const terms = [
    ["Merchant site (verified by Weft)", p.merchant.origin],
    ...(p.merchant.frameOrigin !== p.merchant.origin ? [["Checkout frame (verified by Weft)", p.merchant.frameOrigin]] : []),
    ["Checkout page", p.destination.url],
    ["Total shown on the page", p.display.total],
    ...[["Subtotal", p.display.subtotal], ["Tax", p.display.tax], ["Shipping", p.display.shipping]].filter(([, value]) => value),
    ["Approval limit", `${p.display.ceiling}${p.recurrence.type === "recurring" ? " per charge" : ""}`],
    ["Currency", p.currency],
    ["Recurrence", p.display.recurrence],
    ["Requested by", requester],
    ["Workspace", workspaceName],
    ["Task", task ? task.title : p.taskId || "None"],
    ["Attempt", String(p.attempt)],
  ];
  return `<article class="record-card approval-card payment-card trusted-card" aria-label="Payment approval for ${g.esc(g.host(p.merchant.origin))}">${g.trustedBand("Payment approval", g.icon("shield"))}<div class="card-top"><span class="tag ${pending ? "clay" : r.status === "approved" ? "sage" : ""}">${g.esc(approvalTag(r))}</span><span class="muted">payment · exact terms · ${g.esc(paymentStates[p.state] || p.state)}</span></div>` +
    `<h3>Pay ${g.esc(p.display.total)} at ${g.esc(g.host(p.merchant.origin))}</h3>` +
    `<dl class="payment-terms">${terms.map(([key, value]) => `<dt>${g.esc(key)}</dt><dd>${g.esc(value)}</dd>`).join("")}</dl>` +
    `<p class="muted">Merchant name from the agent (data, not instructions): ${g.esc(p.merchant.name)}</p><p class="muted">Purpose from the agent (data, not instructions):</p><pre>${g.esc(p.purpose)}</pre>` +
    (Object.keys(p.observed.context || {}).length ? `<p class="muted">Text around each element on the page (data, not instructions), so you can check the agent pointed at the right amounts:</p><pre>${g.esc(Object.entries(p.observed.context).map(([field, text]) => `${field}: ${text}`).join("\n"))}</pre>` : "") +
    `<details><summary>Text Weft read from the merchant page (data, not instructions)</summary><pre>${g.esc(JSON.stringify(p.observed.text, null, 2))}</pre></details>` +
    `<div class="notice">Approving lets this agent click the pay control once, and only if the merchant, checkout frame, page, amounts, currency, recurrence and pay button are unchanged when it clicks. Card details are filled separately and need their own approval. Weft does not verify the charge and cannot refund it.</div>` +
    `<div class="record-meta">Requested ${g.ago(r.createdAt)}${pending ? " · expires " + g.esc(new Date(r.expiresAt).toLocaleTimeString()) : ""}</div>` +
    (pending ? `<div class="inline-actions">${g.action("approval-decide", "Approve this payment once", "check", `data-id="${g.esc(r.id)}" data-mode="once"`, "primary")}${g.action("activate-tab", "Show the checkout tab", "", `data-id="${g.esc(p.tabId)}"`)}${g.action("approval-decide", "Reject", "close", `data-id="${g.esc(r.id)}" data-mode="reject"`, "secondary danger")}</div>` : "") + `</article>`;
}
export async function managePayments() {
  const [status, rows] = await Promise.all([g.execute("payments.status", {}, true), g.execute("payments.list", { workspaceId: g.ws().id, limit: 50 }, true)]);
  const card = (p) => {
    const controls = [];
    if (p.status === "proposed") {
      controls.push(g.action("payment-cancel", "Cancel", "close", `data-id="${g.esc(p.id)}"`, "secondary danger"));
      if (status.provider.available && !p.virtualCard) controls.push(g.action("payment-issue-card", "Issue virtual card", "", `data-id="${g.esc(p.id)}"`));
    }
    if (p.status === "uncertain") controls.push(g.action("payment-reconcile", "Record what happened", "", `data-id="${g.esc(p.id)}"`), g.action("payment-retry", "Allow another attempt…", "", `data-id="${g.esc(p.id)}"`, "secondary danger"));
    if (p.virtualCard) controls.push(g.action("payment-check-charges", "Check card charges", "", `data-id="${g.esc(p.id)}"`), ...(p.virtualCard.state !== "CLOSED" ? [g.action("payment-close-card", "Close card", "", `data-id="${g.esc(p.id)}"`, "secondary danger")] : []));
    return `<article class="record-card"><div class="card-top"><span class="tag ${["uncertain", "invalidated", "needs_new_approval"].includes(p.state) ? "clay" : p.status === "submitted" ? "sage" : ""}">${g.esc(paymentStates[p.state] || p.state)}</span><span class="muted">${g.esc(p.display.recurrence)}</span></div>` +
      `<h3>${g.esc(p.display.total)} · ${g.esc(g.host(p.merchant.origin))}</h3><p>${g.esc(p.purpose)}</p><small>Limit ${g.esc(p.display.ceiling)} · attempt ${g.esc(p.attempt)} · ${g.esc(p.actor)}</small>` +
      (p.virtualCard ? `<small>Virtual card ending ${g.esc(p.virtualCard.last4)} · ${g.esc(p.virtualCard.state)}</small>` : "") +
      (p.attention ? `<div class="notice">${g.esc(p.attention.message)}</div>` : "") + (p.invalidation ? `<small>Changed after approval: ${g.esc(p.invalidation.changed.join(", "))}</small>` : "") +
      `<div class="inline-actions">${controls.join("")}</div></article>`;
  };
  g.openDialog(`Payments in ${g.ws().name}`,
    `<p>Agents propose purchases; you approve the exact merchant, amounts, currency and recurrence on a payment card in Agent requests. Weft re-reads the checkout before clicking and refuses anything that changed. Submitted payments are reported as submitted, never as confirmed or refunded.</p>` +
      (rows.length ? `<div class="record-grid">${rows.map(card).join("")}</div>` : g.empty("No payments yet", "When an agent proposes a purchase, it appears here and in Agent requests.", "lock")),
    g.action("close-dialog", "Close") + g.action("payment-provider", "Virtual cards"), true, "Payments");
}
export function privacyView() {
  const rules = (g.state.siteRules || []).filter(
    (r) => r.workspaceId === g.ws().id || r.scope === "global",
  );
  const today = new Date().toISOString().slice(0, 10);
  return (
    g.heading(
      "Privacy & site rules",
      "Your browsing boundaries, managed by you.",
      g.action(
        "new-record",
        "Add site rule",
        "plus",
        'data-kind="siteRules"',
        "primary",
      ),
    ) +
    `<div class="notice">Each workspace has its own site storage. Site rules cover browser-managed requests; they do not control independent network tools used by external agents. Weft never clicks consent banners; these controls apply whether or not a site asks.</div><section class="settings-section"><div class="section-heading"><h2>Site storage</h2>${g.action("storage-defaults", "Change defaults", "", "", "text-button")}</div><div id="storage-policy"><p>Loading storage policy…</p></div><div class="settings-row"><div><strong>Clear this site</strong><small>Remove cookies and stored data for a specific site in this workspace. Server-side account records are not deleted.</small></div>${g.action("clear-storage", "Choose a site", "trash")}</div></section><div class="settings-section"><div class="section-heading"><h2>Personal site rules</h2><div class="inline-actions">${g.action("manage-lists", "Community site lists", "", "", "text-button")}${g.action("explain-url", "Explain a web address", "search", "", "text-button")}</div></div><p>Personal preferences are not malware classifications. Navigation rules stop visits; connection rules also stop matching subresources.</p>${rules.length ? `<div class="record-grid">${rules.map((r) => `<article class="record-card"><span class="tag">${r.enabled === false ? "Inactive · " : ""}${g.esc(r.behavior)} · ${g.esc(r.mode)}${r.provenance?.kind === "community-list" ? " · community list" : ""}</span><h3>${g.esc(r.hostname)}</h3><p>${g.esc(r.reason)}${r.note ? "\n" + g.esc(r.note) : ""}</p><small>${r.includeSubdomains ? "Includes subdomains" : "Exact hostname"} · ${g.esc(r.scope)} · created by ${g.esc(r.createdBy || "unknown")} · revision ${g.esc(r.revision)}${r.provenance?.signed ? " · " + g.esc(r.provenance.claimKind) + " from community list " + g.esc(r.provenance.listName) + " (entry " + g.esc(r.provenance.entryId) + ")" : ""}</small>${r.evidence?.length ? `<small>Evidence: ${r.evidence.map((e) => g.esc(g.host(e))).join(", ")}</small>` : ""}${r.reviewBy ? `<small>${r.reviewBy < today ? "Review overdue" : "Review by"} ${g.esc(r.reviewBy)}${r.lastReviewedAt ? " · last reviewed " + g.esc(new Date(r.lastReviewedAt).toLocaleDateString()) : ""}</small>` : ""}<div class="inline-actions">${g.action("edit-record", "Edit rule", "", 'data-kind="siteRules" data-id="' + g.esc(r.id) + '"')}${g.action("review-rule", "Mark reviewed", "", 'data-id="' + g.esc(r.id) + '"')}${g.action("delete-record", "Remove", "", 'data-kind="siteRules" data-id="' + g.esc(r.id) + '"', "secondary danger")}</div></article>`).join("")}</div>` : g.empty("No personal site rules", "Add a domain when you want this browser to avoid it.", "shield")}</div><section class="settings-section"><div class="section-heading"><h2>Security intelligence</h2>${g.action("install-threats", "Install threat list", "upload", "", "text-button")}</div><p>Known malicious destinations come from lists or a provider you choose. Security findings are kept separate from your personal preferences.</p><div id="threat-status"><p>Loading…</p></div></section><section class="settings-section"><div class="section-heading"><h2>Download scanning</h2>${g.action("configure-scanner", "Configure scanner", "", "", "text-button")}</div><div id="scanner-status"><p>Loading…</p></div></section><div class="settings-section"><h2>Protection coverage</h2><p>Remote pages run sandboxed without Node.js access. Site permission requests are denied, and external application launches wait for your approval in Downloads. Popups need a click in their tab. Model chat proposes app actions for your review; each action needs your approval. Optional read-only tools require an explicit choice for each request.</p><div class="notice">Threat lists and scanners reduce exposure to known threats only; they cannot prevent browser exploits or detect new malware. Saved sign-ins and cards are filled only on their exact sites with your approval, and every payment needs your approval of its exact terms. This browser does not claim to isolate secrets from an agent with unrestricted access to your computer.</div></div>`
  );
}
export const storageModeLabel = { block: "Blocked", session: "This session only", remember: "Remembered", default: "Workspace default" };
export async function loadPrivacyPanels() {
  try {
    const policy = await g.execute("storage.policy", { workspaceId: g.ws().id }, true);
    if (g.$("storage-policy"))
      g.setHTML(g.$("storage-policy"), `<div class="settings-row"><div><strong>Workspace default</strong><small>${g.esc(storageModeLabel[policy.defaults.mode])} · cross-site cookies ${policy.defaults.crossSiteCookies === "block" ? "blocked" : "allowed"}</small><small>${g.esc(policy.sessionLifetime)}</small></div>${g.action("storage-coverage", "What is covered", "")}</div>` +
        (policy.exceptions.length
          ? policy.exceptions.map((e) => `<div class="settings-row"><div><strong>${g.esc(e.hostname)}</strong><small>${g.esc(storageModeLabel[e.mode])}${e.includeSubdomains ? " · includes subdomains" : ""} · set ${g.esc(new Date(e.updatedAt).toLocaleDateString())}</small></div>${g.action("storage-mode", "Revoke exception", "", `data-host="${g.esc(e.hostname)}" data-mode="default"`, "secondary danger")}</div>`).join("")
          : "<p>No site exceptions. Use the shield in the address bar to set one for the current site.</p>") +
        (policy.temporaryData.pendingEntries ? `<small>${policy.temporaryData.pendingEntries} temporary site origin(s) will be erased at exit.</small>` : ""));
  } catch (error) {
    if (g.$("storage-policy")) g.$("storage-policy").textContent = g.errorMessage(error);
  }
  try {
    const threats = await g.execute("threats.status", {}, true);
    if (g.$("threat-status"))
      g.setHTML(g.$("threat-status"), (threats.lists.length
          ? threats.lists.map((l) => `<div class="settings-row"><div><strong>${g.esc(l.publisher)}</strong><small>${g.esc(l.entryCount)} entries · generated ${g.esc(new Date(l.generatedAt).toLocaleString())} · ${l.freshness === "fresh" ? "current" : l.freshness === "stale" ? `stale (${g.esc(l.ageHours)} h old; newer threats are missed)` : "age unknown"}</small><small>SHA-256 ${g.esc(l.sha256.slice(0, 16))}… · ${g.esc(l.source)}</small></div>${g.action("remove-threats", "Remove", "", `data-id="${g.esc(l.id)}"`, "secondary danger")}</div>`).join("")
          : "<p>No threat list installed. Security findings are unavailable until you install one.</p>") +
        `<div class="settings-row"><div><strong>Reputation provider</strong><small>${threats.provider.enabled ? `On · ${g.esc(threats.provider.endpoint)} · ${g.esc(threats.provider.freshness)}${threats.provider.lastError ? " · last error: " + g.esc(threats.provider.lastError) : ""}` : "Off. Nothing is sent to any provider."}</small><small>${g.esc(threats.provider.egress)}</small></div><div class="inline-actions">${threats.provider.enabled ? g.action("update-threats", "Update now", "") : ""}${g.action("configure-provider", threats.provider.enabled ? "Change" : "Set up", "")}</div></div>`);
    const scanner = threats.downloadScanner?.scanner;
    if (g.$("scanner-status"))
      g.setHTML(g.$("scanner-status"), `<p>Files are saved to a separate Weft downloads folder, marked with their origin where the operating system supports it, and never opened or run by Weft.</p><div class="settings-row"><div><strong>${scanner ? "Scanner configured" : "No scanner"}</strong><small>${scanner ? g.esc(scanner.command + " " + scanner.args.join(" ")) : "Completed downloads are shown as not scanned."}</small></div></div>`);
  } catch (error) {
    if (g.$("threat-status")) g.$("threat-status").textContent = g.errorMessage(error);
  }
}
export function settingsView() {
  return (
    g.heading("Settings", "Make this space work for you.") +
    `<section class="settings-section"><h2>Appearance</h2><div class="settings-row"><div><strong>Color theme</strong><small>Warm surfaces, in light or dark.</small></div><select id="theme-select" aria-label="Color theme"><option value="system" ${g.state.settings.theme === "system" ? "selected" : ""}>System</option><option value="light" ${g.state.settings.theme === "light" ? "selected" : ""}>Light</option><option value="dark" ${g.state.settings.theme === "dark" ? "selected" : ""}>Dark</option></select></div></section><section class="settings-section"><div class="section-heading"><h2>Model connections</h2>${g.action("new-model", "Add connection", "plus", "", "text-button")}</div><p>Choose where your messages go. Content is sent for requests or background features you enable. Replies stream when the provider supports it. Images go only to connections you mark or probe as image-capable, or to a vision fallback you choose, after you review each request. Optional read-only tools can read an explicitly selected page or search this workspace; app actions require your approval of an exact proposal.</p>${g.models.map((m) => `<div class="settings-row"><div><strong>${g.esc(m.name)}</strong><small>${g.esc(m.model)} · ${g.esc(m.endpoint)}</small><small>${g.esc(m.hasApiKey ? "Key available" : m.locality === "on-device endpoint" ? "Local endpoint · no key configured" : "No key configured")} · ${g.esc(m.locality)} · ${m.capabilities?.images ? "text + images" : "text only"}${m.capabilities?.visionFallback ? ` · vision fallback: ${g.esc(m.capabilities.visionFallback.name || "unavailable")}` : ""}${m.pricing ? " · cost estimates on" : ""}</small></div>${g.action("edit-model", "Configure", "", 'data-id="' + g.esc(m.id) + '"')}</div>`).join("")}</section><section class="settings-section"><h2>Workspace data</h2><p>Project records are stored in a local database; captures and files are stored as verified local files. Exported projects exclude browser sessions and model credentials. Notes and captures may contain personal information.</p><div class="inline-actions">${g.action("export-workspace", "Export workspace", "download")}${g.action("import-workspace", "Import workspace", "upload")}${g.action("export-package", "Export large project", "download")}${g.action("import-package", "Import large project", "upload")}${g.action("workspace-menu", "Manage workspaces", "grid")}</div></section><section class="settings-section"><div class="section-heading"><h2>Semantic search</h2>${g.action("configure-embeddings", "Configure", "search", "", "text-button")}</div><p>Search always matches words locally. Optionally, Weft can also match meaning using an embedding model that is already available at one of your model connections; nothing is downloaded. Off until you turn it on for this workspace.</p><div id="embedding-status"><p>Loading…</p></div></section><section class="settings-section"><h2>Learning & memory</h2><p>Optionally learn from saved workspace content. Review, edit or erase workspace and shared memories.</p>${g.action("manage-learning", "Manage learning & memory", "spark")}</section><section class="settings-section"><h2>Backups</h2><p>Weft keeps verified local backups automatically each day and lets you make one at any time. Restoring keeps your current data in the profile recovery folder.${g.encryption?.enabled ? " Backups of encrypted data stay encrypted." : ""}</p><div class="inline-actions">${g.action("backup-now", "Back up now", "download")}${g.action("manage-backups", "Manage backups", "clock")}</div></section>${g.encryptionSection()}<section class="settings-section"><h2>Browsing</h2>${g.browserChrome.engineSetting()}<div class="inline-actions">${g.action("section", "History", "clock", 'data-section="history"')}${g.action("section", "Bookmarks", "bookmark", 'data-section="bookmarks"')}${g.action("import-browsing", "Import bookmarks and history", "upload")}</div></section><section class="settings-section"><h2>Display & resources</h2><div id="display-panel"><p>Loading…</p></div></section><section class="settings-section"><h2>Links from other apps</h2><div id="external-panel"><p>Loading…</p></div></section><section class="settings-section"><h2>Agent connections & automation</h2><p>The authenticated CLI, MCP, and REST API share the browser’s command catalog. Use the command desk to inspect available actions.</p><div class="inline-actions">${g.action("manage-clients", "Manage agent connections", "lock")}${g.action("automation-settings", "Agent input…", "settings")}${g.action("commands", "Open command desk", "terminal")}${g.action("emergency-stop", "Stop all agent activity", "stop", "", "secondary danger")}${g.action("section", "Workflows", "workflow", 'data-section="workflows"')}</div><div class="notice">Tasks with steps run only after you start them, as the identity you choose, and every step passes the same approvals. External agents connect through the authenticated API. Keep its token private.</div></section><section class="settings-section"><h2>Saved sign-ins</h2><p>Let an agent sign in without ever seeing a password. You enter each secret in a separate Weft window; agents see only a label, the exact sites and a masked account, and you approve every use.</p><div class="inline-actions">${g.action("manage-credentials", "Manage saved sign-ins", "lock")}</div></section><section class="settings-section"><h2>Payments</h2><p>Agents can propose a purchase but never complete one on their own: you approve its exact merchant, total, currency and recurrence, card details are filled separately with your approval, and Weft checks the checkout again right before paying. Virtual cards from a card issuer are optional and off until you set them up.${g.encryption?.enabled ? " Payment records are encrypted with your workspace data and stay unreadable while it is locked." : ""}</p><div class="inline-actions">${g.action("manage-payments", "Payments in this workspace", "lock")}${g.action("payment-provider", "Virtual cards")}</div></section><section class="settings-section"><h2>Community site lists</h2><p>Opt-in, signed lists of sites from publishers you choose, with a preview of every change, label/warn/block modes, exceptions and rollback.</p><div class="inline-actions">${g.action("manage-lists", "Manage community lists", "shield")}</div></section><section class="settings-section"><h2>Plugins & browser extensions</h2><p>Plugins add export formats, page extractors and reports through named hooks. Browser extensions run inside one workspace’s pages. Nothing third-party runs until you review its scope and enable it.</p><div class="inline-actions">${g.action("manage-plugins", "Manage plugins", "spark")}${g.action("manage-extensions", "Manage extensions for this workspace", "shield")}</div></section><section class="settings-section"><h2>Updates</h2><p>Weft looks for new stable releases only when you ask, unless you turn on daily checks. Downloads are verified first, and installing always waits for you.</p><div class="inline-actions">${g.action("section", "Open update center", "download", 'data-section="updates"')}</div></section>`
  );
}
const dataClassLabels = { workspace_records: "Workspace records", conversations: "Conversations", page_content: "Page text", page_capture: "Screenshots and PDFs", browsing_history: "History and downloads", activity: "Activity and requests", restricted_original: "Restricted capture originals (each read still needs your approval)" };
const defaultDataAccess = Object.keys(dataClassLabels).filter((key) => key !== "restricted_original");
export const levelLabels = { observe: "Observe only", assist: "Ask before any change", scoped: "Local changes; ask before external actions", autonomous: "Standing approval for external actions" };
function grantCard(grant) {
  const names = grant.workspaceIds.map((id) => g.state.workspaces.find((w) => w.id === id)?.name || id).join(", ");
  const status = grant.revoked ? "Revoked · " : Number(grant.expiresAt) <= Date.now() ? "Expired · " : "";
  const sites = grant.destinations && !grant.destinations.includes("*") ? grant.destinations.join(", ") : "Any site";
  return `<article class="record-card"><h3>${g.esc(grant.name)}</h3>${grant.purpose ? `<p>${g.esc(grant.purpose)}</p>` : ""}<p>${g.esc(grant.scopes.join(", "))}${grant.actionClasses?.length ? " · " + g.esc(grant.actionClasses.join(", ")) : ""}</p><small>Workspaces: ${g.esc(names)}${grant.crossWorkspace ? " (cross-workspace)" : ""}</small>${grant.autonomy ? `<small>Autonomy: ${g.esc(levelLabels[grant.autonomy] || grant.autonomy)} · Sites: ${g.esc(sites)}</small>` : ""}${grant.dataAccess ? `<small>Data: ${g.esc(grant.dataAccess.map((d) => dataClassLabels[d] || d).join(", "))}</small>` : ""}${grant.usage ? `<small>Used ${g.esc(String(grant.usage.count))}${grant.maxCommands ? " of " + g.esc(String(grant.maxCommands)) : ""} times${grant.taskId ? " · bound to a task" : ""}</small>` : ""}<small>${status}Expiry: ${g.esc(new Date(grant.expiresAt).toLocaleString())}</small>${!grant.revoked ? `<div class="inline-actions">${g.action("edit-client", "Change access", "", `data-id="${g.esc(grant.clientId)}"`)}${g.action("revoke-client", "Revoke token", "", `data-id="${g.esc(grant.clientId)}"`, "secondary danger")}</div>` : ""}</article>`;
}
export async function manageClients() {
  const [grants, autonomy] = await Promise.all([g.execute("clients.list", {}, true), g.execute("autonomy.get", { workspaceId: g.ws().id }, true)]);
  g.openDialog("Agent connections",
    `<p>Create a separate, expiring token for each agent. Scope each token to the workspace, sites, data and actions it needs. Changes and revocation apply to the agent’s next command.</p><div class="settings-row"><div><strong>Bootstrap token</strong><small>The token printed at startup.</small></div><select id="bootstrap-level" aria-label="Bootstrap token autonomy">${Object.entries(levelLabels).map(([v, l]) => `<option value="${v}" ${autonomy.bootstrapLevel === v ? "selected" : ""}>${g.esc(l)}</option>`).join("")}</select></div><div class="settings-row"><div><strong>Limit in this workspace</strong><small>Applies to every agent here.</small></div><select id="workspace-level" aria-label="Workspace autonomy limit"><option value="">No extra limit</option>${Object.entries(levelLabels).map(([v, l]) => `<option value="${v}" ${autonomy.workspaceCeiling === v ? "selected" : ""}>${g.esc(l)}</option>`).join("")}</select></div>${grants.length ? grants.map(grantCard).join("") : "<p>No scoped agent connections have been created.</p>"}`,
    g.action("close-dialog", "Close") + g.action("new-client", "Create connection", "plus", "", "primary"), true, "Agent access");
  g.$("bootstrap-level").onchange = (e) => void g.execute("autonomy.update", { bootstrapLevel: e.target.value }, true).then(() => g.toast("Bootstrap token autonomy updated.")).catch((error) => g.toast(g.errorMessage(error)));
  g.$("workspace-level").onchange = (e) => void g.execute("autonomy.update", { workspaceId: g.ws().id, level: e.target.value || null }, true).then(() => g.toast("Workspace autonomy limit updated.")).catch((error) => g.toast(g.errorMessage(error)));
}
function grantFields(grant = {}) {
  const others = g.state.workspaces.filter((w) => !w.archived && w.id !== g.ws().id);
  const checked = (list, value, fallback) => ((list ?? fallback).includes(value) ? "checked" : "");
  return `${g.field("Purpose", "purpose", grant.purpose || "")}<fieldset><legend>Allowed actions</legend><label><input type="checkbox" name="scope" value="read" ${checked(grant.scopes, "read", ["read"])}> Read workspace records and page evidence</label><label><input type="checkbox" name="scope" value="records.write" ${checked(grant.scopes, "records.write", [])}> Create, edit, and delete records</label><label><input type="checkbox" name="scope" value="tabs.control" ${checked(grant.scopes, "tabs.control", [])}> Control tabs, navigate, and interact with pages</label><label><input type="checkbox" name="actionClass" value="code_exec" ${checked(grant.actionClasses, "code_exec", [])}> Run page scripts (always an external action)</label><label><input type="checkbox" name="actionClass" value="cloud_spend" ${checked(grant.actionClasses, "cloud_spend", [])}> Send messages to model connections</label><label><input type="checkbox" name="actionClass" value="trusted_context" ${checked(grant.actionClasses, "trusted_context", [])}> Ask to promote findings into confirmed context (each promotion still needs your approval)</label></fieldset>${g.choice("Autonomy", "autonomy", Object.entries(levelLabels), grant.autonomy || "scoped")}<fieldset><legend>Data this agent may read</legend>${Object.entries(dataClassLabels).map(([v, l]) => `<label><input type="checkbox" name="dataAccess" value="${v}" ${checked(grant.dataAccess, v, defaultDataAccess)}> ${g.esc(l)}</label>`).join("")}</fieldset>${g.area("Allowed sites (one per line, e.g. https://docs.example.com or *.example.org; blank for any site)", "destinations", (grant.destinations || []).filter((d) => d !== "*").join("\n"))}${g.field("Command limit (blank for none)", "maxCommands", grant.maxCommands ?? "", "number")}${others.length ? `<fieldset><legend>Additional workspaces</legend>${others.map((w) => `<label><input type="checkbox" name="workspace" value="${g.esc(w.id)}" ${checked(grant.workspaceIds, w.id, [])}> ${g.esc(w.name)}</label>`).join("")}<label><input type="checkbox" name="crossWorkspace" value="yes" ${grant.crossWorkspace ? "checked" : ""}> I explicitly allow this agent to work across these workspaces</label></fieldset>` : ""}`;
}
function grantValues(form, current = g.ws().id) {
  const destinations = String(form.get("destinations") || "").split(/\n+/).map((v) => v.trim()).filter(Boolean);
  const workspaceIds = [current, ...form.getAll("workspace")];
  const scopes = form.getAll("scope");
  if (!scopes.length) throw new Error("Select at least one allowed action.");
  const limit = String(form.get("maxCommands") || "").trim();
  return { purpose: String(form.get("purpose") || "").trim(), scopes, actionClasses: form.getAll("actionClass"), autonomy: form.get("autonomy"), dataAccess: form.getAll("dataAccess"),
    destinations: destinations.length ? destinations : ["*"], maxCommands: limit ? Number(limit) : null,
    workspaceIds, crossWorkspace: workspaceIds.length > 1 && form.get("crossWorkspace") === "yes" };
}
const credentialStatus = { active: ["sage", "Active"], revoked: ["clay", "Revoked"], expired: ["clay", "Expired"], integrity_failed: ["clay", "Failed integrity check"] };
export async function manageCredentials() {
  const [status, rows] = await Promise.all([g.execute("credentials.status", {}, true), g.execute("credentials.list", { workspaceId: g.ws().id, includeInactive: true }, true)]);
  const protection = status.vault === "unprotected"
    ? `Operating-system protected storage is unavailable (${status.keyProtection.backend}). Weft will not store sign-ins without it.`
    : `Secrets are encrypted with a key protected by your operating system (${status.keyProtection.backend}) and handled by a separate broker process.`;
  const card = (c) => {
    const [tone, label] = credentialStatus[c.status] || ["", c.status];
    const controls = c.status === "active"
      ? g.action("fill-credential", c.kind === "payment_card" ? "Fill card on current tab" : "Sign in on current tab", "", `data-id="${g.esc(c.id)}"`) + g.action("grant-credential", "Allow a task", "", `data-id="${g.esc(c.id)}"`) + g.action("revoke-credential", "Revoke", "", `data-id="${g.esc(c.id)}"`, "secondary danger")
      : g.action("delete-credential", "Delete", "trash", `data-id="${g.esc(c.id)}"`, "secondary danger");
    return `<article class="record-card"><div class="card-top"><span class="tag ${tone}">${g.esc(label)}</span><span class="muted">${c.kind === "payment_card" ? "Payment card · " : ""}${c.provider === "onepassword" ? "1Password CLI" : "Weft vault"}</span></div><h3>${g.esc(c.label)}</h3><p>${g.esc(c.purpose)}</p><small>Account: ${g.esc(c.account || "not shown")}</small><small>Only for: ${g.esc(c.origins.join(", "))}${c.frameOrigins.length ? ` · embedded sign-in frames: ${g.esc(c.frameOrigins.join(", "))}` : ""}</small><small>${c.expiresAt ? `Expires ${g.esc(new Date(c.expiresAt).toLocaleString())}` : "No expiry"}${c.taskGrants?.length ? ` · ${c.taskGrants.length} task grant(s): ${c.taskGrants.map((g) => `${g.usesLeft} use(s) left`).join(", ")}` : ""}</small><div class="inline-actions">${controls}</div></article>`;
  };
  g.openDialog(`Saved sign-ins in ${g.ws().name}`,
    `<p>Agents never receive these secrets. Every use needs your one-time approval or a task grant, and Weft fills only the exact sites listed, never a different site or an embedded frame you did not allow. Weft does not verify whether sign-in succeeded.</p><div class="notice">${g.esc(protection)} This broker has not had an independent security review, and it cannot protect against malware running as your user.</div>` +
      (rows.length ? `<div class="record-grid">${rows.map(card).join("")}</div>` : g.empty("No saved sign-ins", "Add one to let an agent sign in on a specific site after you approve.", "lock")),
    g.action("close-dialog", "Close") + g.action("credential-provider", "1Password CLI") + (status.vault === "unprotected" ? "" : g.action("new-payment-card", "Add payment card", "plus") + g.action("new-credential", "Add sign-in", "plus", "", "primary")), true, "Protected sign-ins");
}
export function newPaymentCard() {
  g.formDialog("Add a payment card",
    `<p>You type the card number and security code in a separate Weft window. Agents see only the card brand and last four digits, can ask to fill it only on these merchant sites, and every fill needs your approval. Filling a card never pays: each purchase needs its own approval.</p>` +
      g.field("Name", "label", "", "text", true) + g.field("Purpose (shown to agents)", "purpose", "", "text", true) +
      g.area("Merchant sites (exact origins, one per line, e.g. https://shop.example.com)", "origins", "", true) +
      g.area("Payment-processor frames allowed (optional, exact origins)", "frameOrigins", "") + g.field("Expires (optional)", "expiresAt", "", "datetime-local"),
    async (v) => {
      const lines = (text) => String(text || "").split(/\n+/).map((line) => line.trim()).filter(Boolean);
      const created = await g.execute("credentials.create", { workspaceId: g.ws().id, kind: "payment_card", label: v.label, purpose: v.purpose, origins: lines(v.origins), frameOrigins: lines(v.frameOrigins),
        ...(v.expiresAt ? { expiresAt: new Date(v.expiresAt).toISOString() } : {}) });
      g.toast(`Saved ${created.label}. Agents see it as ${created.account}.`);
    }, { save: "Continue", wide: true, trusted: "Payment card" });
}
export function newCredential() {
  g.formDialog("Add a saved sign-in",
    g.field("Name", "label", "", "text", true) + g.field("Purpose (shown to agents)", "purpose", "", "text", true) +
      g.area("Sites it may be used on (exact origins, one per line, e.g. https://accounts.example.com)", "origins", "", true) +
      g.area("Embedded sign-in frames allowed (optional, exact origins)", "frameOrigins", "") + g.field("Expires (optional)", "expiresAt", "", "datetime-local") +
      g.choice("Where the secret is kept", "provider", [["local", "Weft vault (enter it next, in a separate window)"], ["onepassword", "1Password CLI reference"]], "local") +
      g.field("1Password password reference (op://vault/item/field)", "reference", "") + g.field("1Password username reference (optional)", "usernameReference", "") +
      g.field("Account shown to agents (optional; default is a masked username)", "accountLabel", ""),
    async (v) => {
      const lines = (text) => String(text || "").split(/\n+/).map((line) => line.trim()).filter(Boolean);
      const created = await g.execute("credentials.create", { workspaceId: g.ws().id, label: v.label, purpose: v.purpose, origins: lines(v.origins), frameOrigins: lines(v.frameOrigins),
        provider: v.provider, ...(v.expiresAt ? { expiresAt: new Date(v.expiresAt).toISOString() } : {}), ...(v.accountLabel ? { accountLabel: v.accountLabel } : {}),
        ...(v.provider === "onepassword" ? { reference: { password: v.reference.trim(), ...(v.usernameReference.trim() ? { username: v.usernameReference.trim() } : {}) } } : {}) });
      g.toast(`Saved ${created.label}. Agents see it as ${created.account || "an account without an identifier"}.`);
    }, { save: "Continue", wide: true, trusted: "Protected sign-in" });
}
export async function managePlugins() {
  const plugins = await g.execute("plugins.list", {}, true);
  g.openDialog("Plugins",
    `<p>Built-in plugins ship with Weft. Third-party plugins are read from the <code>plugins</code> folder of your Weft profile; listing them never runs their code. Enabling one binds your grant to the exact files shown, and changing those files disables it until you review it again.</p>${plugins.map(p => `<article class="record-card"><span class="tag">${p.builtin ? "Built-in" : "Third-party"} · ${g.esc(p.status)}${p.allowAutomation ? " · agents allowed" : ""}</span><h3>${g.esc(p.name)}${p.version ? " " + g.esc(p.version) : ""}</h3><p>${g.esc(p.description || "")}</p>${p.scope.length ? `<ul>${p.scope.map(line => `<li>${g.esc(line)}</li>`).join("")}</ul>` : ""}${(p.problems || []).length ? `<div class="notice">Refused: ${g.esc(p.problems.join("; "))}</div>` : ""}${p.builtin ? "" : p.codeSha256 ? `<small>Code sha256 ${g.esc(p.codeSha256)}</small>` : ""}<div class="inline-actions">${p.status === "enabled" ? g.action("disable-plugin", "Disable", "", `data-name="${g.esc(p.name)}"`, "secondary danger") : p.status !== "invalid" ? g.action("enable-plugin", "Enable", "", `data-name="${g.esc(p.name)}" data-manifest="${g.esc(p.manifestSha256 || "")}" data-code="${g.esc(p.codeSha256 || "")}"`) + (p.builtin ? "" : g.action("enable-plugin", "Enable and allow agents", "", `data-name="${g.esc(p.name)}" data-manifest="${g.esc(p.manifestSha256 || "")}" data-code="${g.esc(p.codeSha256 || "")}" data-automation="1"`, "secondary")) : ""}</div></article>`).join("")}`,
    g.action("close-dialog", "Close"), true);
}
export async function manageExtensions() {
  const rows = await g.execute("extensions.list", { workspaceId: g.ws().id }, true);
  g.openDialog(`Extensions in ${g.ws().name}`,
    `<p>Unpacked Manifest V3 extensions load only into this workspace’s browser session. Weft refuses native messaging, debugging, request interception, cookie access and hosts you have not granted. An enabled extension still runs code inside matching pages and can read what they show.</p>${rows.length ? rows.map(e => `<article class="record-card"><span class="tag">${e.enabled ? "Enabled" : "Disabled"}${e.loaded ? " · loaded" : ""}</span><h3>${g.esc(e.name)} ${g.esc(e.version)}</h3><p>Hosts: ${g.esc(e.hostGrants.join(", ") || "none")}<br>Permissions: ${g.esc(e.permissions.join(", ") || "none")}</p>${e.lastError ? `<div class="notice">${g.esc(e.lastError)}</div>` : ""}<small>sha256 ${g.esc(e.sha256)}</small><div class="inline-actions">${e.enabled ? g.action("disable-extension", "Disable", "", `data-id="${g.esc(e.id)}"`, "secondary danger") : g.action("enable-extension", "Enable", "", `data-id="${g.esc(e.id)}"`)}${g.action("remove-extension", "Remove", "", `data-id="${g.esc(e.id)}"`, "secondary danger")}</div></article>`).join("") : "<p>No extensions are installed in this workspace.</p>"}`,
    g.action("close-dialog", "Close") + g.action("install-extension", "Install unpacked extension", "plus", "", "primary"), true, "Extension permissions");
}
export function installExtension() {
  g.openDialog("Install unpacked extension",
    `<p>Enter the folder that contains <code>manifest.json</code>. Weft reviews it first; nothing is installed or run until you confirm.</p><form id="extension-form">${g.field("Extension folder (absolute path)", "path", "", "text", true)}<button class="primary" type="submit">Review extension</button></form><div id="extension-review" aria-live="polite"></div>`,
    g.action("close-dialog", "Cancel"), true, "Extension permissions");
  g.$("extension-form").onsubmit = async event => {
    event.preventDefault();
    const path = new FormData(event.currentTarget).get("path");
    try {
      const probe = await g.execute("extensions.audit", { path, workspaceId: g.ws().id }, true);
      const hosts = probe.scope?.requestedHostGrants || [];
      const report = hosts.length ? await g.execute("extensions.audit", { path, workspaceId: g.ws().id, hostGrants: hosts }, true) : probe;
      const blocking = report.refusals.filter(item => item.kind !== "ungranted");
      g.$("extension-review").innerHTML = `<h3>${g.esc(report.name || "Unnamed extension")} ${g.esc(report.version || "")}</h3>${blocking.length ? `<div class="notice">Weft will not install this extension:<ul>${blocking.map(item => `<li>${g.esc(item.key)} — ${g.esc(item.kind)}: ${g.esc(item.reason)}</li>`).join("")}</ul></div>` : `<form id="extension-grant"><fieldset><legend>Grant site access (all requested sites are required)</legend>${hosts.map(host => `<label><input type="checkbox" name="host" value="${g.esc(host)}"> ${g.esc(host)}${report.scope.hosts.find(item => item.pattern === host)?.broad ? " — every site or a whole domain" : ""}</label>`).join("") || "<p>No site access requested.</p>"}</fieldset><ul>${report.scope.permissions.map(item => `<li>${g.esc(item.name)}: ${g.esc(item.meaning)}</li>`).join("")}${report.ignored.map(item => `<li>Not available: ${g.esc(item.key)} — ${g.esc(item.reason)}</li>`).join("")}</ul><div class="notice">${report.scope.residualRisks.map(g.esc).join(" ")}</div><small>Package sha256 ${g.esc(report.sha256)} · ${Number(report.files)} files</small><button class="primary" type="submit">Install disabled</button></form>`}`;
      if (!g.$("extension-grant")) return;
      g.$("extension-grant").onsubmit = async grantEvent => {
        grantEvent.preventDefault();
        const granted = new FormData(grantEvent.currentTarget).getAll("host");
        try {
          if (granted.length !== hosts.length) throw new Error("Grant every requested site, or cancel the installation.");
          await g.execute("extensions.install", { path, workspaceId: g.ws().id, hostGrants: granted, sha256: report.sha256 }, true);
          await manageExtensions();
          g.toast("Extension installed disabled. Enable it when ready.");
        } catch (error) { g.$("form-error").textContent = g.errorMessage(error); }
      };
    } catch (error) { g.$("form-error").textContent = g.errorMessage(error); }
  };
}
export function createClient() {
  g.openDialog("Create agent connection",
    `<p>This token grants access to <strong>${g.esc(g.ws().name)}</strong> unless you explicitly add workspaces. Choose the least access this agent needs. External actions wait for your approval unless you grant standing approval.</p><form id="client-form">${g.field("Agent name", "name", "", "text", true)}${grantFields()}${g.choice("Expires after", "ttlSeconds", [["3600", "1 hour"], ["86400", "1 day"], ["604800", "7 days"], ["2592000", "30 days"]], "3600")}<button type="submit" hidden></button></form>`,
    g.action("close-dialog", "Cancel") + '<button type="submit" form="client-form" class="primary">Create token</button>', true, "Agent access");
  g.$("client-form").onsubmit = async event => {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const button = g.$("dialog-content").querySelector('button[form="client-form"]');
    button.disabled = true;
    try {
      // Quiet execution avoids retaining this one-time token in the command desk.
      const grant = await g.execute("clients.create", { name: form.get("name"), ...grantValues(form), ttlSeconds: Number(form.get("ttlSeconds")) }, true);
      g.openDialog("Save your agent token",
        `<p>Copy this token now. It will not be shown again after closing this dialog. If it is lost or exposed, revoke it and create a replacement.</p><p>Connection: ${g.esc(grant.name)}. Expires: ${g.esc(new Date(grant.expiresAt).toLocaleString())}.</p><label>Agent token<textarea id="new-client-token" readonly autocomplete="off" spellcheck="false"></textarea></label>`,
        g.action("close-dialog", "Done"), false, "Agent access");
      g.$("new-client-token").value = grant.token;
      g.$("new-client-token").focus();
      g.$("new-client-token").select();

    } catch (error) {
      if (g.$("form-error")) g.$("form-error").textContent = g.errorMessage(error);
    } finally { button.disabled = false; }
  };
}
export async function editClient(id) {
  const grant = (await g.execute("clients.list", {}, true)).find((g) => g.clientId === id);
  if (!grant) return g.toast("Agent connection not found.");
  const home = grant.workspaceIds.includes(g.ws().id) ? g.ws().id : grant.workspaceIds[0];
  g.formDialog(`Change access: ${grant.name}`, grantFields(grant), async () => {
    const changes = grantValues(new FormData(g.$("edit-form")), home);
    await g.execute("clients.update", { clientId: id, changes }, true);
    g.toast("Access updated. It applies to the agent’s next command.");
    setTimeout(() => void manageClients().catch(() => {}), 0);
  }, { save: "Save access", wide: true });
}
