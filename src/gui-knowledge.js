/**
 * Trusted-GUI views for shared context collections, linked sources and service
 * references, proposals and promotion, evidence conflicts and citation status
 * (#21, #22, #23, #66). Every change goes through the shared command catalog as
 * the human; record and source text is always rendered escaped, as data.
 */
const roleLabel = { owner: "Owner", write: "Can read and write", read: "Read only" };
const linkLabel = { available: "Available", changed: "Changed since verified", moved: "Moved", missing: "Missing", inaccessible: "Inaccessible", unlinked: "Needs relinking" };
const accessLabel = { none: "No credential", unknown: "Credential not yet used", authorized: "Authorized", unauthorized: "Access refused by service", revoked: "Access revoked" };
const citationLabel = { verified: "Verified", reanchored: "Found in a newer version", stale: "Source changed", unverified: "Unverified" };
const categoryLabel = { confirmed: "Confirmed information", decisions: "Decisions", instructions: "Instructions & preferences" };
const good = (value) => ["available", "authorized", "verified", "none"].includes(value);

export function knowledgeUI(ui) {
  const { esc, short, date, action, openDialog, formDialog, closeDialog, field, area, choice, execute, toast, errorMessage, refresh } = ui;
  const state = () => ui.state();
  const ws = () => ui.ws();
  const workspaceName = (id) => state().workspaces.find((w) => w.id === id)?.name || "Another workspace";
  const role = (c, workspaceId = ws().id) => c.workspaceId === workspaceId ? "owner" : (c.members || []).find((m) => m.workspaceId === workspaceId && !m.revokedAt)?.role || null;
  const collections = () => (state().sharedCollections || []).filter((c) => role(c));
  const memberships = (type, id) => (state().sharedCollections || []).filter((c) => c.workspaceId === ws().id && (c.items || []).some((i) => i.type === type && i.id === id));

  function originLabel(o) {
    if (!o) return "";
    if (o.kind === "human") return o.authoring === "pasted" ? "Pasted by you" : "Added by you";
    if (o.kind === "model") return `Model${o.model ? " " + o.model : ""}`;
    if (o.kind === "import") return `Imported${o.claimed?.kind ? ` (claimed: ${o.claimed.kind})` : ""}`;
    if (o.kind === "system") return "Weft source check";
    return `${o.actor?.startsWith("client:") ? "Agent connection" : o.actor === "automation" ? "Bootstrap token" : "Agent"}${o.model ? " · " + o.model : ""}${o.via ? " · from " + workspaceName(o.via.workspaceId) : ""}`;
  }
  function citationTag(r) {
    const list = r.citations || [];
    if (!list.length) return "";
    const stale = list.filter((c) => c.status === "stale").length;
    const unverified = list.filter((c) => c.status === "unverified").length;
    return `<span class="tag ${stale || unverified ? "clay" : "sage"}">${list.length} citation${list.length === 1 ? "" : "s"}${stale ? ` · ${stale} source changed` : ""}${unverified ? ` · ${unverified} unverified` : ""}</span>`;
  }
  function badges(kind, r) {
    const tags = [];
    if (r.link) tags.push(`<span class="tag ${good(r.link.status) ? "sage" : "clay"}">Linked ${esc(r.link.kind)} · ${esc(linkLabel[r.link.status] || r.link.status)}</span>`);
    if (r.service) tags.push(`<span class="tag ${good(r.service.access) ? "sage" : "clay"}">Service · ${esc(accessLabel[r.service.access] || r.service.access)}</span>`);
    if (r.copiedFrom) tags.push(`<span class="tag">Managed copy of ${esc(r.copiedFrom.name)}</span>`);
    if (r.proposal?.status === "proposed") tags.push(`<span class="tag clay">Proposed as ${esc(categoryLabel[r.proposal.proposedCategory] || r.proposal.proposedCategory)}</span>`);
    if (r.proposal?.status === "promoted") tags.push('<span class="tag sage">Promoted</span>');
    if (r.promotedFrom) tags.push('<span class="tag sage">Promoted from a finding</span>');
    if (r.superseded) tags.push('<span class="tag">Superseded</span>');
    tags.push(citationTag(r));
    if (memberships(kind, r.id).length) tags.push('<span class="tag">Shared</span>');
    const origin = r.origin && r.origin.kind !== "human" ? `<small>${esc(originLabel(r.origin))}</small>` : "";
    const html = tags.filter(Boolean).join("");
    return html || origin ? `<div class="inline-actions">${html}</div>${origin}` : "";
  }
  function cardActions(kind, r) {
    if (r.link) return action("source-check", "Check source", "reload", `data-id="${esc(r.id)}"`) + (r.link.status === "changed" ? action("source-refresh", "Accept new version", "check", `data-id="${esc(r.id)}"`) : "")
      + (["moved", "missing", "unlinked"].includes(r.link.status) ? action("source-relink", r.link.status === "moved" ? "Relink to found file" : "Choose new location", "folder", `data-id="${esc(r.id)}" data-kind="${esc(r.link.kind)}"`) : "")
      + action("source-view", "View", "file", `data-id="${esc(r.id)}"`);
    if (r.service) return action("service-refresh", "Refresh", "reload", `data-id="${esc(r.id)}"`) + action("service-view", "View cached", "file", `data-id="${esc(r.id)}"`)
      + action("service-credential", "Credential", "lock", `data-id="${esc(r.id)}"`);
    if (kind === "context" && r.proposal?.status === "proposed") return action("promote-proposal", "Promote", "check", `data-id="${esc(r.id)}"`);
    return "";
  }

  // ---- Context review panel ---------------------------------------------------------
  function contextToolbar() {
    return action("section", "Shared collections", "tabs", 'data-section="shared"', "text-button") + action("freshness-check", "Check sources", "reload", "", "text-button");
  }
  function contextPanel() {
    const proposals = ui.records("context").filter((r) => r.proposal?.status === "proposed");
    const conflicts = ui.records("conflicts").filter((c) => c.status === "open");
    if (!proposals.length && !conflicts.length) return "";
    const title = (id) => state().context.find((r) => r.id === id)?.title || state().materials.find((r) => r.id === id)?.title || "Removed record";
    return `<section class="settings-section" aria-label="Review"><h2>Needs your review</h2><p>Agents propose findings; only you (or an approval you give) can make them confirmed context. Conflicting evidence is kept until you resolve it.</p><div class="record-grid">${proposals
      .map((r) => `<article class="record-card"><div class="card-top"><span class="tag clay">Proposed as ${esc(categoryLabel[r.proposal.proposedCategory] || r.proposal.proposedCategory)}</span></div><h3>${esc(r.title)}</h3><p>${esc(short(r.content, 160))}</p>${r.proposal.rationale ? `<small>Why: ${esc(short(r.proposal.rationale, 160))}</small>` : ""}<small>${esc(originLabel(r.origin))} · ${date(r.createdAt)}</small>${citationTag(r) ? `<div class="inline-actions">${citationTag(r)}</div>` : ""}<div class="inline-actions">${action("promote-proposal", "Promote", "check", `data-id="${esc(r.id)}"`, "primary")}${action("dismiss-proposal", "Dismiss", "close", `data-id="${esc(r.id)}"`)}${action("edit-record", "Inspect", "", `data-kind="context" data-id="${esc(r.id)}"`)}</div></article>`)
      .join("")}${conflicts
      .map((c) => `<article class="record-card"><div class="card-top"><span class="tag clay">${c.kind === "source_changed" ? "Source changed" : c.kind === "edit" ? "Conflicting edit" : "Contradiction"}</span></div><h3>${esc(c.subjects.map((s) => title(s.id)).join(" · "))}</h3><p>${esc(short(c.note, 160))}</p><small>${esc(originLabel(c.origin))} · ${date(c.createdAt)}</small><div class="inline-actions">${action("inspect-conflict", "Inspect and resolve", "search", `data-id="${esc(c.id)}"`, "primary")}</div></article>`)
      .join("")}</div></section>`;
  }
  function recordDetails(kind, r) {
    if (!r || !["context", "materials"].includes(kind)) return "";
    const citations = (r.citations || []).map((c) => {
      const target = c.type === "capture" ? `Capture ${state().artifacts.find((a) => a.id === c.captureId)?.title || c.captureId || "unknown"}${c.version ? " v" + c.version : ""}` : c.type === "record" ? `${c.collection || "context"} record ${state()[c.collection || "context"]?.find((x) => x.id === c.recordId)?.title || c.recordId || "unknown"} revision ${c.revision ?? "?"}` : `Linked source ${state().materials.find((m) => m.id === c.recordId)?.title || c.recordId || "unknown"}`;
      return `<li><span class="tag ${["verified", "reanchored"].includes(c.status) ? "sage" : "clay"}">${esc(citationLabel[c.status] || c.status)}</span> ${esc(target)}${c.exact ? ` — “${esc(short(c.exact, 140))}”` : ""}${c.reason ? ` <small>(${esc(c.reason.replaceAll("_", " "))})</small>` : ""}</li>`;
    }).join("");
    const history = (r.history || []).slice(-8).reverse().map((h) => `<li>Revision ${esc(h.revision)} · ${esc(originLabel(h.origin) || h.actor)} · ${esc(new Date(h.createdAt).toLocaleString())}</li>`).join("");
    return `<details class="record-provenance"><summary>Provenance, citations and revisions</summary><p>${esc(originLabel(r.origin) || "Origin not recorded")}${r.origin?.toolCall ? " · tool call " + esc(r.origin.toolCall) : ""}${r.origin?.conversationId ? " · from a conversation" : ""}</p>${citations ? `<ul>${citations}</ul>` : "<p>No exact citations.</p>"}${history ? `<ul>${history}</ul>` : ""}</details>`;
  }

  // ---- Shared collections view ----------------------------------------------------------
  function sharedView() {
    const mine = collections().filter((c) => c.workspaceId === ws().id);
    const shared = collections().filter((c) => c.workspaceId !== ws().id);
    const owned = (c) => `<article class="record-card"><div class="card-top"><span class="tag">Owned by this workspace</span><span class="muted">${(c.items || []).length} items</span></div><h3>${esc(c.name)}</h3>${c.description ? `<p>${esc(c.description)}</p>` : ""}${(c.members || []).filter((m) => !m.revokedAt).map((m) => `<div class="settings-row"><div><strong>${esc(workspaceName(m.workspaceId))}</strong><small>${esc(roleLabel[m.role])} · granted ${date(m.grantedAt)}</small></div>${action("collection-revoke", "Revoke", "", `data-id="${esc(c.id)}" data-member="${esc(m.workspaceId)}"`, "secondary danger")}</div>`).join("") || "<p>Not shared with any workspace yet.</p>"}<div class="inline-actions">${action("collection-manage", "Manage", "settings", `data-id="${esc(c.id)}"`, "primary")}${action("collection-delete", "Delete collection", "trash", `data-id="${esc(c.id)}"`, "secondary danger")}</div></article>`;
    const incoming = (c) => `<article class="record-card"><div class="card-top"><span class="tag ${role(c) === "write" ? "sage" : ""}">${esc(roleLabel[role(c)])}</span><span class="muted">${(c.items || []).length} items</span></div><h3>${esc(c.name)}</h3><p>Shared by ${esc(workspaceName(c.workspaceId))}${c.description ? "\n" + esc(c.description) : ""}</p><div class="inline-actions">${action("collection-open", "Open", "folder", `data-id="${esc(c.id)}"`, "primary")}${role(c) === "write" ? action("collection-add-finding", "Add a finding", "plus", `data-id="${esc(c.id)}"`) : ""}</div></article>`;
    return `${ui.heading("Shared context", "Collections of project context shared between your workspaces, with explicit read or write access.", action("collection-create", "New collection", "plus", "", "primary"))}<div class="notice">Sharing context never shares browser sign-ins, cookies or site storage: every workspace keeps its own browser session. Revoking access applies to the next request from you, agents and models. Agent connections still need their own workspace grants.</div><section class="settings-section"><h2>Shared from this workspace</h2>${mine.length ? `<div class="record-grid">${mine.map(owned).join("")}</div>` : ui.empty("Nothing shared yet", "Create a collection, add context or materials to it, then choose which workspaces may read or write it.", "tabs")}</section><section class="settings-section"><h2>Shared with this workspace</h2>${shared.length ? `<div class="record-grid">${shared.map(incoming).join("")}</div>` : "<p>No other workspace shares a collection with this one.</p>"}</section>`;
  }
  // workspaceId pins the workspace a just-created collection belongs to, in case the active workspace changes meanwhile.
  async function manageCollection(id, workspaceId = ws().id) {
    const c = await execute("collections.get", { id, workspaceId }, true);
    const others = state().workspaces.filter((w) => !w.archived && w.id !== c.ownerWorkspaceId);
    const candidates = [...ui.records("context").map((r) => ["context", r]), ...ui.records("materials").map((r) => ["materials", r]), ...ui.records("artifacts").map((r) => ["artifacts", r])]
      .filter(([type, r]) => !(c.items || []).some((i) => i.type === type && i.id === r.id));
    openDialog(`Manage ${c.name}`,
      `<p>Records stay in this workspace. Participants see only the items listed here.</p><h3>Items</h3>${(c.items || []).map((i) => `<div class="settings-row"><div><strong>${esc(i.title || i.id)}</strong><small>${esc(i.type)}${i.missing ? " · removed" : ` · revision ${esc(i.revision)}`}</small></div>${action("collection-remove-item", "Remove", "", `data-id="${esc(c.id)}" data-type="${esc(i.type)}" data-item="${esc(i.id)}"`, "secondary danger")}</div>`).join("") || "<p>No items yet.</p>"}
      ${candidates.length ? `<form id="collection-add-form" class="inline-form">${choice("Add a record", "item", candidates.map(([type, r]) => [`${type}:${r.id}`, `${r.title} (${type})`]), "")}<button class="secondary" type="submit">Add</button></form>` : ""}
      <h3>Access</h3>${others.length ? `<form id="collection-grant-form" class="inline-form">${choice("Workspace", "workspaceId", others.map((w) => [w.id, w.name]), "")}${choice("Access", "role", [["read", "Read only"], ["write", "Read and write"]], "read")}<button class="secondary" type="submit">Grant access</button></form>` : "<p>Create another workspace to share this collection.</p>"}<details><summary>History</summary><ul>${(c.history || []).slice().reverse().map((h) => `<li>${esc(h.change)} · ${esc(h.actor === "human" ? "you" : h.actor)} · ${esc(new Date(h.at).toLocaleString())}</li>`).join("")}</ul></details>`,
      action("close-dialog", "Close"), true);
    const submit = (formId, run) => { const form = ui.$(formId); if (form) form.onsubmit = async (event) => { event.preventDefault(); try { await run(new FormData(form)); await refresh(true); await manageCollection(id); } catch (error) { ui.$("form-error").textContent = errorMessage(error); } }; };
    submit("collection-add-form", (form) => { const [type, itemId] = String(form.get("item")).split(":"); return execute("collections.addItem", { id, type, itemId }, true); });
    submit("collection-grant-form", (form) => execute("collections.grant", { id, memberWorkspaceId: form.get("workspaceId"), role: form.get("role") }, true));
  }
  async function openCollection(id) {
    const c = await execute("collections.get", { id, workspaceId: ws().id }, true);
    openDialog(c.name, `<p>Shared by ${esc(workspaceName(c.ownerWorkspaceId))} · ${esc(roleLabel[c.role])}. These records live in the owner workspace.</p>${(c.items || []).map((i) => `<div class="settings-row"><div><strong>${esc(i.title || i.id)}</strong><small>${esc(i.type)} · revision ${esc(i.revision ?? "?")}${i.origin ? " · " + esc(originLabel(i.origin)) : ""}</small></div>${i.missing ? "" : action("collection-read", "View", "", `data-id="${esc(c.id)}" data-item="${esc(i.id)}"`)}</div>`).join("") || "<p>No items.</p>"}<div id="collection-item" aria-live="polite"></div>`, action("close-dialog", "Close"), true);
  }

  // ---- Linked sources and services ------------------------------------------------------------
  function materialDialogExtras() {
    return action("link-source", "Link a file…", "file", 'data-kind="file"') + action("link-source", "Link a folder…", "folder", 'data-kind="folder"') + action("service-create", "Service reference…", "globe");
  }
  async function linkSource(kind, materialId) {
    const picked = window.weft.pickPath ? await window.weft.pickPath(kind) : null;
    formDialog(materialId ? "Choose the new location" : kind === "folder" ? "Link a folder" : "Link a file",
      `<p>Weft keeps a verified reference (size, modification time and SHA-256) and tells you when the ${kind} changes, moves or disappears. Agents can read it only through this link, never anything else on your computer.</p>${field(`${kind === "folder" ? "Folder" : "File"} location`, "path", picked || "", "text", true)}${materialId ? "" : field("Title (optional)", "title", "") + (kind === "file" ? choice("Keep as", "mode", [["link", "Linked reference (tracks the original)"], ["copy", "Managed copy (up to 10 MB, stored in Weft)"]], "link") : "")}`,
      async (values) => {
        if (materialId) await execute("sources.relink", { id: materialId, path: values.path });
        else await execute("sources.link", { workspaceId: ws().id, path: values.path, kind, ...(values.title ? { title: values.title } : {}), ...(values.mode ? { mode: values.mode } : {}) });
        toast(materialId ? "Source relinked and verified." : values.mode === "copy" ? "Managed copy stored." : "Linked and verified.");
      }, { save: materialId ? "Relink" : "Link" });
  }
  async function showSource(id) {
    const result = await execute("sources.read", { id, workspaceId: ws().id }, true);
    openDialog(`Linked ${result.link.kind}: ${result.title}`, `<span class="tag ${good(result.link.status) ? "sage" : "clay"}">${esc(linkLabel[result.link.status] || result.link.status)}</span><div class="notice">Live content from your computer, shown as untrusted data. Verified ${esc(result.link.verifiedAt ? new Date(result.link.verifiedAt).toLocaleString() : "never")}${result.matchesVerified === false ? " · the file differs from the verified version" : ""}.</div>${result.kind === "listing" ? `<ul>${result.entries.map((e) => `<li>${esc(e.path)} <small>${esc(e.type)}${e.type === "file" ? " · " + esc(Math.round(e.size / 1024)) + " KB" : ""}</small></li>`).join("")}</ul>${result.truncated ? "<p>Only the first entries are shown.</p>" : ""}` : `<pre class="artifact-text">${esc(result.encoding === "utf8" ? result.content : "Binary content is not displayed.")}</pre>${result.truncated ? "<p>Showing the first part of the file.</p>" : ""}`}`, action("close-dialog", "Close"), true);
  }
  function serviceForm() {
    formDialog("Add a service reference",
      `<p>A service reference keeps a cached copy of an HTTPS document or documented API. Nothing is fetched until you refresh it; redirects are never followed. Credentials are stored only in your operating system’s protected storage and never exported.</p>${field("Title", "title", "", "text", true)}${field("HTTPS URL", "url", "", "url", true)}<label><input type="checkbox" name="autoRefresh"> Allow scheduled source checks to refresh this reference</label>`,
      async (values) => { await execute("services.create", { workspaceId: ws().id, title: values.title, url: values.url, autoRefresh: values.autoRefresh === "on" }); toast("Service reference added. Refresh it when you want a copy."); }, { save: "Add reference" });
  }
  async function showService(id) {
    const result = await execute("services.read", { id, workspaceId: ws().id }, true);
    openDialog(`Service: ${result.title}`, `<span class="tag ${good(result.access) ? "sage" : "clay"}">${esc(accessLabel[result.access] || result.access)}</span><div class="notice">Cached copy, not the live service. ${result.version ? `Version ${esc(result.version.number)} fetched ${esc(new Date(result.version.fetchedAt).toLocaleString())} · SHA-256 ${esc(result.version.sha256.slice(0, 12))}…` : "Nothing fetched yet."}${result.lastError ? ` Last refresh: ${esc(result.lastError.outcome)}${result.lastError.detail ? " — " + esc(result.lastError.detail) : ""}.` : ""}</div><p>${esc(result.url)}</p>${result.content !== null && result.content !== undefined ? `<pre class="artifact-text">${esc(result.encoding === "utf8" ? result.content : "Binary content is not displayed.")}</pre>` : `<p>${esc(result.reason || "No cached content.")}</p>`}`, action("close-dialog", "Close"), true);
  }
  function credentialForm(id) {
    const r = state().materials.find((m) => m.id === id);
    formDialog("Service credential",
      `<p>Stored encrypted by your operating system and sent only to ${esc(r?.service?.url || "this reference")}. It is never shown again, written to project data or exported.</p>${choice("Header", "header", [["Authorization", "Authorization"], ["X-API-Key", "X-API-Key"]], r?.service?.credentialHeader || "Authorization")}<label>Credential value<input id="service-secret" name="secretValue" type="password" autocomplete="off" required></label>`,
      async (values) => { await execute("services.setCredential", { id, header: values.header, secretValue: values.secretValue }, true); toast("Credential stored. Refresh to use it."); },
      { save: "Store credential", extra: r?.service?.credentialState === "stored" ? action("service-revoke", "Revoke access", "lock", `data-id="${ui.esc(id)}"`, "secondary danger") : "" });
  }

  // ---- Conflicts and freshness ------------------------------------------------------------
  async function inspectConflict(id) {
    const c = await execute("conflicts.get", { id }, true);
    const subject = (s) => `<article class="record-card"><div class="card-top"><span class="tag">${esc(s.collection)}${s.current?.category ? " · " + esc(s.current.category) : ""}</span><span class="muted">${s.missing ? "removed" : "revision " + esc(s.current.revision)}</span></div>${s.missing ? "<p>This record no longer exists.</p>" : `<h3>${esc(s.current.title)}</h3><p>${esc(short(s.atRevision?.content ?? s.current.content, 600))}</p>${s.atRevision && s.atRevision.revision !== s.current.revision ? `<small>Shown at revision ${esc(s.atRevision.revision)}; current text: ${esc(short(s.current.content, 200))}</small>` : ""}<small>${esc(originLabel(s.current.origin))}</small>${s.current.superseded ? "<small>Superseded</small>" : ""}${c.status === "open" ? `<div class="inline-actions">${action("conflict-resolve", "Keep this one", "check", `data-id="${esc(c.id)}" data-decision="choose" data-chosen="${esc(s.id)}"`)}</div>` : ""}`}</article>`;
    const evidence = c.evidence ? `<div class="notice">Cited ${c.evidence.type === "capture" ? "capture version" : c.evidence.type === "source" ? "linked source version" : "record revision"}: ${esc(c.evidence.cited?.versionId || c.evidence.cited?.sha256?.slice(0, 12) || c.evidence.cited?.revision || "")}${c.evidence.exact ? ` · quote “${esc(short(c.evidence.exact, 200))}”` : ""} · ${esc(String(c.evidence.reason || "").replaceAll("_", " "))}. The original citation and its pinned version are kept.</div>` : "";
    const proposed = c.proposed ? `<article class="record-card"><div class="card-top"><span class="tag clay">Proposed change</span></div><p>${esc(short(c.proposed.changes.content ?? c.proposed.changes.title ?? "", 600))}</p><small>${esc(originLabel(c.origin))}</small>${c.status === "open" ? `<div class="inline-actions">${action("conflict-resolve", "Apply this change", "check", `data-id="${esc(c.id)}" data-decision="choose" data-chosen="proposed"`)}</div>` : ""}</article>` : "";
    openDialog("Evidence conflict",
      `<p>${esc(c.note || "")}</p>${evidence}<div class="record-grid">${c.subjects.map(subject).join("")}${proposed}</div>${c.status === "open" ? `<form id="conflict-merge-form"><details><summary>Merge into a new record</summary>${field("Merged title", "title", c.subjects[0]?.current?.title || "", "text", true)}${area("Merged content", "content", c.subjects.map((s) => s.current?.content || "").join("\n\n"), true)}<button class="secondary" type="submit">Create merged record</button></details></form>` : `<div class="notice">Resolved: ${esc(c.resolution.decision.replaceAll("_", " "))} · ${esc(originLabel(c.resolution.origin))} · ${esc(new Date(c.resolution.at).toLocaleString())}${c.resolution.note ? " · " + esc(c.resolution.note) : ""}</div>`}<p class="muted">Resolving never deletes or rewrites the originals: other records are marked superseded and keep their history.</p>`,
      (c.status === "open" ? action("conflict-resolve", "Keep both", "", `data-id="${esc(c.id)}" data-decision="keep_both"`) + action("conflict-resolve", "Dismiss", "", `data-id="${esc(c.id)}" data-decision="dismiss"`) : "") + action("close-dialog", "Close"), true);
    if (ui.$("conflict-merge-form")) ui.$("conflict-merge-form").onsubmit = async (event) => {
      event.preventDefault();
      const form = new FormData(event.currentTarget);
      try { await execute("conflicts.resolve", { id, decision: "merge", merged: { title: form.get("title"), content: form.get("content") } }, true); await refresh(true); await inspectConflict(id); toast("Merged record created; the originals are kept."); }
      catch (error) { ui.$("form-error").textContent = errorMessage(error); }
    };
  }
  async function freshness() {
    const report = await execute("freshness.check", { workspaceId: ws().id }, true);
    await refresh(true);
    const policy = (state().freshnessPolicies || []).find((p) => p.workspaceId === ws().id);
    const changes = report.citations.changes;
    openDialog("Source check",
      `<p>${esc(report.egress)}</p><h3>Linked sources</h3>${report.sources.length ? `<ul>${report.sources.map((s) => `<li><span class="tag ${good(s.status) ? "sage" : "clay"}">${esc(linkLabel[s.status] || s.status)}</span> ${esc(s.title)}${s.detail ? ` <small>${esc(s.detail)}</small>` : ""}</li>`).join("")}</ul>` : "<p>No linked files or folders.</p>"}<h3>Citations</h3><p>${esc(report.citations.checked)} checked${changes.length ? ` · ${changes.length} changed status` : " · no changes"}${report.citations.conflictsOpened.length ? ` · ${report.citations.conflictsOpened.length} conflict(s) opened for review` : ""}.</p>${changes.length ? `<ul>${changes.map((x) => `<li>${esc(state().context.find((r) => r.id === x.recordId)?.title || x.recordId)}: ${esc(citationLabel[x.from] || x.from)} → ${esc(citationLabel[x.to] || x.to)}${x.reason ? ` (${esc(x.reason.replaceAll("_", " "))})` : ""}</li>`).join("")}</ul>` : ""}${report.services.length ? `<h3>Service references</h3><ul>${report.services.map((s) => `<li>${esc(s.title)} · ${esc(accessLabel[s.access] || s.access)} · ${s.lastRefreshAt ? "refreshed " + esc(new Date(s.lastRefreshAt).toLocaleString()) : "never refreshed"}</li>`).join("")}</ul><p class="muted">Service references are refreshed only when you choose, or by scheduled checks where you allowed it.</p>` : ""}<form id="freshness-form"><label><input type="checkbox" name="scheduled" ${policy?.scheduled ? "checked" : ""}> Check this workspace on a schedule</label>${field("Every (hours)", "intervalHours", policy?.intervalHours ?? 24, "number")}<button class="secondary" type="submit">Save schedule</button></form>`,
      action("close-dialog", "Close"), true);
    ui.$("freshness-form").onsubmit = async (event) => {
      event.preventDefault();
      const form = new FormData(event.currentTarget);
      try { await execute("freshness.configure", { workspaceId: ws().id, scheduled: form.get("scheduled") === "on", intervalHours: Number(form.get("intervalHours")) || 24 }, true); toast("Schedule saved."); }
      catch (error) { ui.$("form-error").textContent = errorMessage(error); }
    };
  }
  function shareButton(type, id) {
    return (state().sharedCollections || []).some((c) => c.workspaceId === ws().id) ? action("share-record", "Share…", "tabs", `data-type="${esc(type)}" data-id="${esc(id)}"`) : "";
  }

  async function handle(name, button) {
    const id = button.dataset.id;
    switch (name) {
      case "collection-create":
        formDialog("New shared collection", `<p>Create a collection in ${esc(ws().name)}. Nothing is shared until you grant another workspace access.</p>${field("Name", "name", "", "text", true)}${area("What is it for?", "description", "")}`,
          async (values) => { const workspaceId = ws().id; const created = await execute("collections.create", { workspaceId, name: values.name, description: values.description }); setTimeout(() => void manageCollection(created.id, workspaceId).catch((e) => toast(errorMessage(e))), 0); }, { save: "Create collection" });
        return true;
      case "collection-manage": await manageCollection(id); return true;
      case "collection-open": await openCollection(id); return true;
      case "collection-read": {
        const r = await execute("collections.read", { id, workspaceId: ws().id, itemId: button.dataset.item }, true);
        const target = ui.$("collection-item");
        if (target) target.innerHTML = `<article class="record-card"><div class="card-top"><span class="tag">${esc(r.category || r.kind || "Shared record")}</span><span class="muted">revision ${esc(r.revision)}</span></div><h3>${esc(r.title)}</h3><pre class="artifact-text">${esc(r.content ?? r.latestVersion?.text ?? r.note ?? "")}</pre><small>${esc(originLabel(r.origin))}</small>${citationTag(r) ? `<div class="inline-actions">${citationTag(r)}</div>` : ""}</article>`;
        return true;
      }
      case "collection-add-finding":
        formDialog("Add a finding to the shared collection", `<p>The finding is stored in the owner workspace and attributed to you. Confirmed facts and decisions stay with the owner.</p>${field("Title", "title", "", "text", true)}${area("Content", "content", "", true)}`,
          async (values) => { await execute("collections.write", { id, workspaceId: ws().id, type: "context", fields: { title: values.title, content: values.content, category: "findings" } }); toast("Finding added to the shared collection."); }, { save: "Add finding" });
        return true;
      case "collection-revoke":
        await execute("collections.revoke", { id, memberWorkspaceId: button.dataset.member });
        toast("Access revoked. It applies to the next request.");
        return true;
      case "collection-remove-item":
        await execute("collections.removeItem", { id, type: button.dataset.type, itemId: button.dataset.item }, true);
        await refresh(true);
        await manageCollection(id);
        return true;
      case "collection-delete":
        formDialog("Delete this collection?", "<p>Other workspaces lose access. The records themselves stay in this workspace.</p>", async () => { await execute("collections.delete", { id }); }, { save: "Delete collection" });
        return true;
      case "share-record": {
        const owned = (state().sharedCollections || []).filter((c) => c.workspaceId === ws().id);
        formDialog("Share to a collection", choice("Collection", "collection", owned.map((c) => [c.id, c.name]), owned[0]?.id) + "<p>Participants of the collection can read this record; writers can also update it with revision checks.</p>",
          async (values) => { await execute("collections.addItem", { id: values.collection, type: button.dataset.type, itemId: id }); toast("Added to the collection."); }, { save: "Share" });
        return true;
      }
      case "link-source": await linkSource(button.dataset.kind || "file"); return true;
      case "source-check": {
        const r = await execute("sources.check", { id }, true);
        toast(`${linkLabel[r.status] || r.status}${r.detail ? ": " + r.detail : ""}`);
        await refresh(true);
        return true;
      }
      case "source-refresh": {
        const r = state().materials.find((m) => m.id === id);
        const result = await execute("sources.refresh", { id, expectedRevision: r?.revision }, true);
        toast(result.refreshed ? (result.newVersion ? "New source version recorded. Citations to the old version are flagged on the next check." : "Source unchanged.") : result.reason);
        await refresh(true);
        return true;
      }
      case "source-relink": {
        const r = state().materials.find((m) => m.id === id);
        if (r?.link?.status === "moved" && r.link.candidate) {
          formDialog("Relink to the found file", `<p>Weft found a ${esc(r.link.kind)} with the same ${r.link.candidate.matchedBy === "inode" ? "file identity" : "content"} at:</p><p><strong>${esc(r.link.candidate.path || r.link.candidate.name)}</strong></p>`, async () => { await execute("sources.relink", { id }); toast("Relinked."); }, { save: "Relink" });
        } else await linkSource(button.dataset.kind || "file", id);
        return true;
      }
      case "source-view": await showSource(id); return true;
      case "service-create": serviceForm(); return true;
      case "service-refresh": {
        const result = await execute("services.refresh", { id }, true);
        toast(result.outcome === "updated" ? `Fetched version ${result.version?.number}.` : result.outcome === "not_modified" ? "Unchanged since the last refresh." : `Refresh ${result.outcome.replaceAll("_", " ")}${result.detail ? ": " + result.detail : ""}`);
        await refresh(true);
        return true;
      }
      case "service-view": await showService(id); return true;
      case "service-credential": credentialForm(id); return true;
      case "service-revoke":
        formDialog("Revoke service access?", '<p>The stored credential is deleted. Agents and models can no longer read cached content from this service.</p><label><input type="checkbox" name="purgeCache"> Also delete cached copies</label>',
          async (values) => { await execute("services.revoke", { id, purgeCache: values.purgeCache === "on" }); toast("Access revoked."); }, { save: "Revoke access" });
        return true;
      case "promote-proposal": {
        const r = state().context.find((x) => x.id === id);
        formDialog("Promote to trusted context", `<p>${esc(r.title)}</p><p class="muted">${esc(short(r.content, 300))}</p>${choice("Promote as", "category", Object.entries(categoryLabel), r.proposal?.proposedCategory || "confirmed")}${area("Note (optional)", "note", "")}<p>A new trusted record is created; the finding and its evidence are kept.</p>`,
          async (values) => { await execute("context.promote", { id, expectedRevision: r.revision, category: values.category, ...(values.note ? { note: values.note } : {}) }); toast("Promoted. The original finding is kept as evidence."); }, { save: "Promote" });
        return true;
      }
      case "dismiss-proposal":
        formDialog("Dismiss this proposal?", area("Reason (optional)", "reason", "") + "<p>The finding and its evidence stay in Context.</p>", async (values) => { await execute("context.dismiss", { id, reason: values.reason || "" }); }, { save: "Dismiss" });
        return true;
      case "inspect-conflict": await inspectConflict(id); return true;
      case "conflict-resolve": {
        const c = await execute("conflicts.get", { id }, true);
        await execute("conflicts.resolve", { id, decision: button.dataset.decision, ...(button.dataset.chosen ? { chosenId: button.dataset.chosen } : {}), expectedRevision: c.revision }, true);
        toast("Conflict resolved. The originals are kept.");
        await refresh(true);
        await inspectConflict(id);
        return true;
      }
      case "freshness-check": await freshness(); return true;
    }
    return false;
  }
  return { badges, cardActions, contextToolbar, contextPanel, recordDetails, sharedView, materialDialogExtras, shareButton, handle, closeDialog };
}
