/**
 * Community site lists (#28, ADR-004): the human management screen for signed,
 * opt-in subscriptions. Every change goes through the shared lists.* commands as
 * the human (they are human-only administration), and nothing is applied before
 * the person has seen the publisher key fingerprint and the exact previewed
 * release (its payload digest is what lists.subscribe/lists.update confirm).
 * List and claim text from publishers is untrusted data and is always escaped.
 */
import { icon } from "./icons.js";
import { announce, trustedBand } from "./gui-a11y.js";

const modeText = {
  label: ["Label only", "Show the list's claim on matching pages. Never warns or blocks."],
  warn: ["Warn", "Show a warning on matching pages; you can continue."],
  block: ["Block", "Stop matching pages. You can still allow one visit, or add an exception."],
};
const groupText = { "private-group": "Private group", public: "Public list" };
const checkText = { "update-available": "Update available (not applied)", unchanged: "No new release", rejected: "Release rejected", error: "Could not reach the source" };

export function listsUI(ui) {
  const { esc, action, heading, empty, openDialog, formDialog, closeDialog, field, area, choice, execute, toast, errorMessage, ws } = ui;
  const when = (value) => (value ? new Date(value).toLocaleString() : "never");
  const lines = (value) => String(value || "").split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  const readFile = async (input) => (input?.files?.[0] ? await input.files[0].text() : "");

  function view() {
    return heading("Community site lists", "Opt-in lists from publishers you choose. Every release is signature-checked, shown to you first, and applied only when you confirm.", action("lists-subscribe", "Subscribe to a list…", "plus", "", "primary"))
      + `<div class="notice">Subscribing never uploads your history or private site rules. Labels are claims by the list's reviewers, not Weft findings: opinions are marked as opinions. A single report never blocks a site on its own; the list's reviewer threshold and your mode decide. Your personal rules and exceptions are always shown alongside.</div>`
      + '<h2 class="visually-hidden">Subscriptions</h2><div id="lists-panel"><p>Loading…</p></div>'
      + `<section class="settings-section"><h2>Which lists match an address</h2><p>See every list entry and site rule that applies to a web address, in the order the browser resolves them.</p><form id="lists-match-form" class="inline-form">${field("Web address", "url", "", "url", true)}<button class="secondary" type="submit">Show matches</button></form><div id="lists-matches"></div></section>`;
  }

  function subscriptionCard(s) {
    const attrs = `data-id="${esc(s.id)}"`;
    if (s.kind !== "signed") {
      return `<article class="record-card"><div class="card-top"><span class="tag">Pinned file · ${s.enabled ? "enabled" : "disabled until reviewed"}</span><span class="muted">${esc(s.integrity)}</span></div><h3>${esc(s.id)}</h3><p>${esc(s.description || "")}</p><small>Source: ${esc(s.sourceRepo)} @ ${esc(String(s.commit).slice(0, 12))} · ${esc(s.path)}</small><small>${Number(s.enabledRuleCount)} of ${Number(s.ruleCount)} rules enabled · SHA-256 ${esc(String(s.sha256).slice(0, 16))}…</small><div class="inline-actions">${s.rollbackAvailable ? action("lists-rollback", "Roll back…", "back", attrs, "secondary danger") : ""}</div></article>`;
    }
    const [modeName, modeHelp] = modeText[s.mode] || [s.mode, ""];
    const counts = s.counts || {};
    const exceptions = (s.exceptions || []).map((e) => `<li><span>${esc(e.hostname)}${e.reason ? ` — ${esc(e.reason)}` : ""} <small>since ${esc(new Date(e.createdAt).toLocaleDateString())}</small></span>${action("lists-exception-remove", "Remove", "", `${attrs} data-host="${esc(e.hostname)}" aria-label="Remove exception for ${esc(e.hostname)}"`, "text-button")}</li>`).join("");
    return `<article class="record-card list-card" aria-labelledby="list-${esc(s.id)}"><div class="card-top"><span class="tag ${s.integrity === "verified" ? "sage" : "clay"}">${s.integrity === "verified" ? "Signature verified" : "Integrity problem"}</span><span class="muted">${esc(groupText[s.groupType] || s.groupType)}</span></div>`
      + `<h3 id="list-${esc(s.id)}">${esc(s.name)}</h3>${s.description ? `<p>${esc(s.description)}</p>` : ""}`
      + `<dl class="payment-terms"><dt>Mode</dt><dd><strong>${esc(modeName)}</strong> · ${esc(modeHelp)}</dd><dt>Publisher key</dt><dd><code class="fingerprint">${esc(s.publisher.fingerprint)}</code>${s.publisher.rotations?.length ? ` · rotated ${s.publisher.rotations.length} time(s)` : ""}</dd>`
      + `<dt>Release</dt><dd>Sequence ${Number(s.current.sequence)}${s.current.rolledBack ? " (rolled back)" : ""} · issued ${esc(when(s.current.issuedAt))} · applied ${esc(when(s.current.appliedAt))}${s.highWater > s.current.sequence ? ` · newest accepted ${Number(s.highWater)}` : ""}</dd>`
      + `<dt>Entries</dt><dd>${Number(counts.entries ?? 0)} (${Number(counts.accepted ?? 0)} accepted, ${Number(counts.disputed ?? 0)} disputed, ${Number(counts.stale ?? 0)} need review) · ${Number(s.enabledRuleCount)} enforced rules · reviewer threshold ${Number(s.reviewerThreshold ?? s.minReviewers)}</dd>`
      + `<dt>Updates</dt><dd>${s.sourceUrl ? `${esc(s.sourceUrl)} · ${s.scheduledCheck?.enabled ? `checked every ${Number(s.scheduledCheck.intervalHours)} h (never applied automatically)` : "checked only when you ask"}` : "Supplied by you as files"}${s.lastCheck ? ` · last check ${esc(when(s.lastCheck.at))}: ${esc(checkText[s.lastCheck.outcome] || s.lastCheck.outcome)}` : ""}</dd></dl>`
      + (s.pendingUpdate ? `<div class="notice"><strong>A verified update is waiting for your review:</strong> sequence ${Number(s.pendingUpdate.sequence)}, fetched ${esc(when(s.pendingUpdate.fetchedAt))}. Nothing changes until you apply it.</div>` : "")
      + `<h4>Exceptions</h4>${exceptions ? `<ul class="exception-list">${exceptions}</ul>` : "<p class=\"muted\">No exceptions. Add one to stop this list affecting a site.</p>"}`
      + `<div class="inline-actions">${s.sourceUrl ? action("lists-check", "Check for update", "reload", attrs) : ""}${action("lists-update", s.pendingUpdate ? "Review update…" : "Update from a file…", "download", attrs, s.pendingUpdate ? "primary" : "secondary")}${action("lists-configure", "Change mode…", "settings", attrs)}${action("lists-exception-add", "Add exception…", "plus", attrs)}${s.rollbackAvailable ? action("lists-rollback", `Roll back to sequence ${Number(s.previous.sequence)}…`, "back", attrs) : ""}${action("lists-unsubscribe", "Unsubscribe…", "trash", attrs, "secondary danger")}</div></article>`;
  }

  async function load() {
    const panel = document.getElementById("lists-panel");
    if (!panel) return;
    try {
      const rows = await execute("lists.status", { workspaceId: ws().id }, true);
      if (!document.getElementById("lists-panel")) return;
      panel.innerHTML = rows.length ? `<div class="record-grid wide-cards">${rows.map(subscriptionCard).join("")}</div>` : empty("No community lists", "Subscribe to a signed list from a publisher you trust. You will see the publisher's key fingerprint and every change before anything applies.", "shield");
    } catch (error) {
      panel.innerHTML = `<div class="notice" role="alert">${esc(errorMessage(error))}</div>`;
    }
    const form = document.getElementById("lists-match-form");
    if (form) form.onsubmit = async (event) => {
      event.preventDefault();
      const url = new FormData(form).get("url");
      try { showMatches(await execute("lists.matches", { url, workspaceId: ws().id }, true)); }
      catch (error) { document.getElementById("lists-matches").innerHTML = `<div class="notice" role="alert">${esc(errorMessage(error))}</div>`; }
    };
  }

  function showMatches(r) {
    const rules = r.rules.map((rule) => `<li><strong>${Number(rule.precedence)}. ${esc(rule.behavior)} · ${esc(rule.mode)}${rule.winner ? " · decides" : rule.enabled ? "" : " · disabled"}</strong> ${esc(rule.hostname)}${rule.path !== "/" ? esc(rule.path) : ""} <small>${rule.source === "community-list" ? `community list ${esc(rule.provenance?.listName || "")}, entry ${esc(rule.provenance?.entryId || "")}` : "your personal rule"} · ${esc(rule.reason)}</small></li>`).join("");
    const entries = r.communityMatches.map((m) => `<li><strong>${esc(m.listName)}</strong> · ${esc(m.claimKind)} · ${esc(m.status)} · ${m.active ? `enforced as ${esc(m.effectiveBehavior)}` : "not enforced"}<br>${esc(m.claim)}<br><small>${esc(m.reasons.join("; "))}${m.provenance.sources?.length ? ` · sources: ${m.provenance.sources.map((s) => esc(s.url || s.title)).join(", ")}` : ""} · ${Number(m.provenance.approvals)} of ${Number(m.provenance.approvalsNeeded)} reviewer approvals</small></li>`).join("");
    document.getElementById("lists-matches").innerHTML = `<div class="notice"><strong>${r.winner ? `Decided by rule ${Number(r.winner.precedence)} (${esc(r.winner.behavior)})` : "No enabled rule applies"}</strong> for ${esc(r.hostname)}</div><h3>Site rules in order</h3>${rules ? `<ol class="plain-list">${rules}</ol>` : "<p>No site rule matches.</p>"}<h3>Community list entries</h3>${entries ? `<ul class="plain-list">${entries}</ul>` : "<p>No list entry matches.</p>"}<details><summary>Precedence order</summary><ol>${r.precedence.map((p) => `<li>${esc(p)}</li>`).join("")}</ol></details>`;
    announce(`${r.rules.length} site rules and ${r.communityMatches.length} list entries match.`);
  }

  /** The preview a person reads before anything is applied: fingerprint first, then every change. */
  function previewHtml(p) {
    const entry = (e) => `<li><strong>${esc(e.subject)}</strong> · ${e.claimType === "opinion" ? "Opinion" : "Factual claim"} · ${esc(e.status)} · ${esc(e.behavior)}<br>${esc(e.claim)}</li>`;
    const domains = (list) => list.map((d) => `<li>${esc(d.hostname)}${d.includeSubdomains ? " and subdomains" : ""}${d.path && d.path !== "/" ? esc(d.path) : ""} <small>${d.claimType === "opinion" ? "opinion" : "factual claim"}: ${esc(d.claim)}</small></li>`).join("");
    const section = (title, items) => (items ? `<h3>${title}</h3><ul class="plain-list">${items}</ul>` : "");
    return `<div class="fingerprint-box"><span>Publisher key fingerprint</span><code class="fingerprint">${esc(p.publisher.fingerprint)}</code><small>${p.publisher.pinned ? "This is the key you pinned when you subscribed." : "Compare it, character by character, with the fingerprint the publisher gave you through a channel you trust. Weft pins this key: later releases must be signed by it or by an announced rotation."}</small></div>`
      + (p.warnings?.length ? `<div class="notice" role="alert">${p.warnings.map(esc).join("<br>")}</div>` : "")
      + `<dl class="payment-terms"><dt>List</dt><dd>${esc(p.name)} (${esc(p.listId)})</dd><dt>Release</dt><dd>${p.from ? `Sequence ${Number(p.from.sequence)} → ` : ""}${Number(p.to.sequence)} · issued ${esc(when(p.to.issuedAt))}${p.to.expiresAt ? ` · expires ${esc(when(p.to.expiresAt))}` : ""}</dd><dt>Release digest</dt><dd><code>${esc(p.to.payloadSha256)}</code> · ${Number(p.to.bytes)} bytes</dd><dt>Summary</dt><dd>${p.added.length} added · ${p.removed.length} removed · ${p.changed.length} changed · ${p.newlyBlocked.length} newly blocked · ${p.noLongerBlocked.length} no longer blocked · ${p.counts?.labelOnly ?? 0} label only</dd></dl>`
      + (p.unchanged ? "<p>This release is already applied. Nothing would change.</p>" : "")
      + section("Newly blocked", domains(p.newlyBlocked)) + section("Newly warned", domains(p.newlyWarned || [])) + section("No longer blocked", domains(p.noLongerBlocked))
      + section("Added entries", p.added.slice(0, 50).map(entry).join("")) + section("Changed entries", p.changed.slice(0, 50).map((c) => `<li><strong>${esc(c.after.subject)}</strong> · changed ${esc(c.fields.join(", "))}${c.correctionNote ? ` · correction: ${esc(c.correctionNote)}` : ""}<br>${esc(c.after.claim)}</li>`).join(""))
      + section("Removed entries", p.removed.slice(0, 50).map(entry).join("")) + section("Governance changes", (p.governanceChanges || []).map((g) => `<li>${esc(g)}</li>`).join(""));
  }

  function subscribeDialog() {
    formDialog("Subscribe to a community list",
      `<p>Paste the publisher's public key and choose the signed list file they published. Nothing is saved until you have reviewed the preview.</p>`
        + field("Name for this subscription (letters, digits, - and _)", "id", "", "text", true)
        + choice("Kind of list", "groupType", [["private-group", "Private group: people you know review entries"], ["public", "Public list: anyone may publish (stricter default reviewer threshold)"]], "private-group")
        + area("Publisher public key (base64)", "publicKey", "", true)
        + `<label>Signed list file<input id="list-file" type="file" accept="application/json,.json"></label>` + area("Or paste the signed list", "data", "")
        + choice("What the list may do", "mode", Object.entries(modeText).map(([value, [name, help]]) => [value, `${name}: ${help}`]), "label")
        + field("Reviewer approvals needed (optional, 1–10)", "minReviewers", "", "number")
        + field("Update source (optional https address, fetched only when you check)", "sourceUrl", "", "url")
        + `<label class="check-row"><input type="checkbox" name="scheduled"> Check the source once a day and keep verified updates for my review (never applied automatically)</label>`,
      async (v) => {
        const data = (await readFile(document.getElementById("list-file"))) || v.data;
        if (!data.trim()) throw new Error("Choose the signed list file or paste it.");
        const args = { id: v.id.trim(), workspaceId: ws().id, publicKey: v.publicKey.replace(/\s+/g, ""), data, mode: v.mode, ...(v.minReviewers ? { minReviewers: Number(v.minReviewers) } : {}) };
        const preview = await execute("lists.preview", args, true);
        const subscribe = { id: args.id, workspaceId: args.workspaceId, groupType: v.groupType, publicKey: args.publicKey, mode: v.mode, data, payloadSha256: preview.to.payloadSha256,
          ...(args.minReviewers ? { minReviewers: args.minReviewers } : {}), ...(v.sourceUrl ? { sourceUrl: v.sourceUrl.trim() } : {}), ...(v.scheduled === "on" ? { scheduledCheck: { enabled: true, intervalHours: 24 } } : {}) };
        setTimeout(() => confirmDialog("Review before subscribing", preview, "I compared the fingerprint with the one the publisher gave me", "Subscribe", async () => {
          await execute("lists.subscribe", subscribe, true);
          toast(`Subscribed to ${preview.name} in ${modeText[v.mode][0].toLowerCase()} mode.`);
        }), 0);
      }, { save: "Preview", wide: true, trusted: "Community site lists" });
  }

  function confirmDialog(title, preview, acknowledgement, save, onConfirm) {
    formDialog(title, previewHtml(preview) + `<label class="check-row"><input type="checkbox" name="acknowledge" required> ${esc(acknowledgement)}</label>`,
      async () => { await onConfirm(); setTimeout(() => void load(), 0); }, { save, wide: true, trusted: "Community site lists" });
  }

  async function updateDialog(id) {
    const [current] = await execute("lists.status", { id, workspaceId: ws().id }, true);
    if (current.pendingUpdate) {
      const preview = await execute("lists.preview", { id, workspaceId: ws().id }, true);
      return confirmDialog("Review the update", preview, "I reviewed these changes", "Apply update", async () => {
        await execute("lists.update", { id, workspaceId: ws().id, payloadSha256: preview.to.payloadSha256 }, true);
        toast(`Updated to sequence ${preview.to.sequence}.`);
      });
    }
    formDialog("Update from a file",
      `<p>Choose a newer signed release of ${esc(current.name)}. It must be signed by the pinned key; you will see every change first.</p><label>Signed list file<input id="list-file" type="file" accept="application/json,.json"></label>${area("Or paste the signed list", "data", "")}<label class="check-row"><input type="checkbox" name="allowOlder"> Allow an older release than the newest one I accepted (use only to undo a bad release)</label>`,
      async (v) => {
        const data = (await readFile(document.getElementById("list-file"))) || v.data;
        if (!data.trim()) throw new Error("Choose the signed list file or paste it.");
        const allowOlder = v.allowOlder === "on";
        const preview = await execute("lists.preview", { id, workspaceId: ws().id, data, allowOlder }, true);
        setTimeout(() => confirmDialog("Review the update", preview, "I reviewed these changes", "Apply update", async () => {
          await execute("lists.update", { id, workspaceId: ws().id, data, allowOlder, payloadSha256: preview.to.payloadSha256 }, true);
          toast(`Updated to sequence ${preview.to.sequence}.`);
        }), 0);
      }, { save: "Preview", wide: true, trusted: "Community site lists" });
  }

  async function configureDialog(id) {
    const [s] = await execute("lists.status", { id, workspaceId: ws().id }, true);
    formDialog(`Change ${s.name}`,
      choice("What the list may do", "mode", Object.entries(modeText).map(([value, [name, help]]) => [value, `${name}: ${help}`]), s.mode)
        + field("Reviewer approvals needed (1–10)", "minReviewers", String(s.minReviewers), "number", true)
        + field("Update source (https; leave empty to supply files yourself)", "sourceUrl", s.sourceUrl || "", "url")
        + `<label class="check-row"><input type="checkbox" name="scheduled" ${s.scheduledCheck?.enabled ? "checked" : ""}> Check the source on a schedule and keep verified updates for my review</label>`
        + field("Check every (hours, 1–720)", "intervalHours", String(s.scheduledCheck?.intervalHours || 24), "number"),
      async (v) => {
        const sourceUrl = v.sourceUrl.trim() || null;
        await execute("lists.configure", { id, workspaceId: ws().id, mode: v.mode, minReviewers: Number(v.minReviewers), sourceUrl, scheduledCheck: { enabled: v.scheduled === "on", intervalHours: Number(v.intervalHours) || 24 } }, true);
        toast(`${s.name}: ${modeText[v.mode][0].toLowerCase()} mode.`);
        setTimeout(() => void load(), 0);
      }, { save: "Save", trusted: "Community site lists" });
  }

  function exceptionDialog(id) {
    formDialog("Add an exception", `<p>This list will no longer label, warn about or block the site you enter. Your personal site rules still apply.</p>${field("Site (for example shop.example.com)", "hostname", "", "text", true)}${field("Why (optional)", "reason", "")}`,
      async (v) => {
        await execute("lists.exception", { id, workspaceId: ws().id, action: "add", hostname: v.hostname.trim(), reason: v.reason }, true);
        toast(`Exception added for ${v.hostname.trim()}.`);
        setTimeout(() => void load(), 0);
      }, { save: "Add exception", trusted: "Community site lists" });
  }

  function confirmSimple(title, body, save, run) {
    formDialog(title, body, async () => { await run(); setTimeout(() => void load(), 0); }, { save, trusted: "Community site lists" });
  }

  /** Handles lists-* actions; returns true when it handled one. */
  async function handle(name, button) {
    const id = button.dataset?.id;
    switch (name) {
      case "lists-subscribe": subscribeDialog(); return true;
      case "lists-update": await updateDialog(id); return true;
      case "lists-configure": await configureDialog(id); return true;
      case "lists-exception-add": exceptionDialog(id); return true;
      case "lists-exception-remove":
        await execute("lists.exception", { id, workspaceId: ws().id, action: "remove", hostname: button.dataset.host }, true);
        toast(`Exception removed for ${button.dataset.host}.`);
        await load();
        return true;
      case "lists-check": {
        const result = await execute("lists.check", { id, workspaceId: ws().id }, true);
        toast(`${checkText[result.checked] || result.checked}${result.lastCheck?.detail ? `: ${result.lastCheck.detail}` : ""}.`);
        await load();
        return true;
      }
      case "lists-rollback":
        confirmSimple("Roll back this list?", "<p>The previous verified release is restored and its rules apply again. The newest release stays recorded, so the same or a newer release can be applied later.</p>", "Roll back", async () => {
          const result = await execute("lists.rollback", { id, workspaceId: ws().id }, true);
          toast(`Rolled back${result.current ? ` to sequence ${result.current.sequence}` : ""}.`);
        });
        return true;
      case "lists-unsubscribe":
        confirmSimple("Unsubscribe from this list?", "<p>Every rule and label from this list is removed from this workspace. Nothing is sent to the publisher.</p>", "Unsubscribe", async () => {
          const result = await execute("lists.unsubscribe", { id, workspaceId: ws().id }, true);
          toast(`Unsubscribed; ${result.removedRules} rules removed.`);
        });
        return true;
      default:
        return false;
    }
  }

  return { view, load, handle, trusted: (kind) => trustedBand(esc(kind), icon("shield")) };
}
