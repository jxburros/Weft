/**
 * Browser-owned site surfaces in the trusted GUI (#90, #94, #95, #97, #98): permission prompts and the
 * screen-share source picker, the "popup blocked" and "in use" indicators, saved-password offers, the
 * address-bar key and extensions menus, and the private-window entry. Every decision goes through the
 * shared human-only commands; page-supplied text (origins, titles, usernames) is always escaped.
 */
import { icon } from "./icons.js";
import { announce } from "./gui-a11y.js";

const permissionNames = {
  camera: "camera", microphone: "microphone", geolocation: "location", notifications: "notifications", "clipboard-read": "clipboard",
  "display-capture": "screen sharing", midi: "MIDI devices", sensors: "motion sensors", popups: "pop-ups",
};
const listNames = (items) => (items || []).map((item) => permissionNames[item] || item).join(" and ");
const decisionText = { allow: "Allowed", block: "Blocked" };

export function siteUI(ui) {
  const { $, esc, action, openDialog, closeDialog, execute, toast, errorMessage, ws, active, refresh } = ui;
  let shownPrompt = null;
  let shownOffer = null;

  /** Small buttons in the address field: popups blocked, permissions in use, saved sign-ins, extensions. */
  function mountIndicators() {
    if ($("site-indicators")) return;
    const holder = document.createElement("span");
    holder.id = "site-indicators";
    holder.className = "site-indicators";
    $("address").after(holder);
  }

  function indicators(tab, extensions = []) {
    mountIndicators();
    const p = tab?.protection || {};
    const buttons = [];
    const blocked = (p.blockedPopups || []).length;
    if (blocked) buttons.push(`<button type="button" class="indicator" data-action="popups-blocked" aria-label="${blocked} pop-up${blocked === 1 ? "" : "s"} blocked on this page" title="Pop-up blocked">${icon("blocked")}<span>${blocked}</span></button>`);
    const using = [...new Set([...(p.permissionUses || []), ...(p.sharing ? ["display-capture"] : [])])];
    if (using.length) buttons.push(`<button type="button" class="indicator in-use" data-action="permissions-in-use" aria-label="This page is using your ${esc(listNames(using))}" title="In use: ${esc(listNames(using))}">${icon("you")}<span>${p.sharing ? "Sharing" : "In use"}</span></button>`);
    if (p.savedLogins) buttons.push(`<button type="button" class="indicator" data-action="passwords-menu" aria-label="Saved sign-ins for this site" title="Saved sign-ins">${icon("lock")}</button>`);
    if (extensions.length) buttons.push(`<button type="button" class="indicator" data-action="extensions-menu" aria-label="Extensions (${extensions.length})" title="Extensions">${icon("grid")}</button>`);
    const html = buttons.join("");
    if ($("site-indicators").innerHTML !== html) $("site-indicators").innerHTML = html;
  }

  /** Open the browser-owned prompt or save offer for the page the person is looking at. */
  function afterRefresh(tab) {
    const p = tab?.protection || {};
    if ($("dialog").open) return;
    if (p.permissionPrompt && p.permissionPrompt.id !== shownPrompt) return permissionPrompt(tab, p.permissionPrompt);
    if (p.passwordOffer && p.passwordOffer.id !== shownOffer) return passwordOffer(p.passwordOffer);
  }

  function permissionPrompt(tab, prompt) {
    shownPrompt = prompt.id;
    const what = listNames(prompt.permissions);
    const sources = prompt.display
      ? `<fieldset class="share-sources"><legend>Choose what to share</legend>${(prompt.sources || []).map((s, i) => `<label class="share-source"><input type="radio" name="share-source" value="${esc(s.id)}" ${i === 0 ? "checked" : ""}>${s.thumbnail?.startsWith("data:image/") ? `<img src="${esc(s.thumbnail)}" alt="">` : ""}<span>${esc(s.kind === "screen" ? "Entire screen" : "Window")}: ${esc(s.name)}</span></label>`).join("")}</fieldset>`
      : "";
    const choices = prompt.display
      ? action("perm-respond", "Share", "check", `data-id="${esc(prompt.id)}" data-decision="allow-once"`, "primary") + action("perm-respond", "Don't share", "", `data-id="${esc(prompt.id)}" data-decision="dismiss"`)
        + action("perm-respond", "Block for this site", "", `data-id="${esc(prompt.id)}" data-decision="block-always"`, "secondary danger")
      : action("perm-respond", "Allow on this visit", "", `data-id="${esc(prompt.id)}" data-decision="allow-once"`)
        + action("perm-respond", "Allow while the site is open", "", `data-id="${esc(prompt.id)}" data-decision="allow-while-open"`)
        + action("perm-respond", "Always allow", "check", `data-id="${esc(prompt.id)}" data-decision="allow-always"`, "primary")
        + action("perm-respond", "Block", "", `data-id="${esc(prompt.id)}" data-decision="block"`)
        + action("perm-respond", "Always block", "", `data-id="${esc(prompt.id)}" data-decision="block-always"`, "secondary danger");
    openDialog(
      prompt.display ? "Share your screen?" : `Allow ${what}?`,
      `<p><strong>${esc(prompt.origin)}</strong> wants to ${esc(prompt.display ? "see your screen or a window" : `use your ${what}`)}.</p>${sources}<p class="muted">Decided for this site in the workspace “${esc(ws()?.name || "")}” only. Agents cannot answer this. Closing this dialog denies the request.</p>`,
      `<div class="inline-actions">${choices}</div>`,
      false,
      "Site permission",
    );
    announce(`${prompt.origin} asks to use your ${what}`, { assertive: true });
    $("dialog").addEventListener("close", () => {
      if (shownPrompt === prompt.id && !prompt.answered) void execute("permissions.respond", { promptId: prompt.id, decision: "dismiss" }, true).catch(() => {});
    }, { once: true });
    permissionPrompt.current = prompt;
  }

  function passwordOffer(offer) {
    shownOffer = offer.id;
    openDialog(
      offer.kind === "update" ? "Update saved password?" : "Save password?",
      `<p>${offer.kind === "update" ? "Update the saved password for" : "Save the password for"} <strong>${esc(offer.username || "this account")}</strong> on <strong>${esc(offer.origin)}</strong> in this workspace?</p><p class="muted">Saved passwords are encrypted with your system key store and only you can use them. Agents cannot see, list or fill them.</p>`,
      `<div class="inline-actions">${action("pw-offer", offer.kind === "update" ? "Update" : "Save", "check", `data-id="${esc(offer.id)}" data-mode="save"`, "primary")}${action("pw-offer", "Never for this site", "", `data-id="${esc(offer.id)}" data-mode="never"`)}${action("pw-offer", "Not now", "", `data-id="${esc(offer.id)}" data-mode="dismiss"`)}</div>`,
      false,
      "Saved passwords",
    );
  }

  async function popupsDialog(tab) {
    const p = tab.protection || {};
    openDialog(
      "Pop-ups blocked",
      `<p>This page tried to open ${(p.blockedPopups || []).length} pop-up window(s) without a click or key press from you.</p>${(p.blockedPopups || []).slice().reverse().map((b) => `<div class="settings-row"><div><strong>${esc(b.url)}</strong><small>${esc(new Date(b.at).toLocaleTimeString())}</small></div><div class="inline-actions">${b.id ? action("popup-allow", "Open once", "external", `data-id="${esc(b.id)}" data-tab="${tab.id}"`) + action("popup-allow", "Always allow pop-ups from this site", "", `data-id="${esc(b.id)}" data-tab="${tab.id}" data-mode="always"`) : ""}</div></div>`).join("")}<p class="muted">A pop-up opened from this list cannot message the page that tried to open it. Allowing pop-ups for the site lets later ones open normally; revoke it in Site controls.</p>`,
      action("close-dialog", "Close"),
      false,
      "Pop-ups",
    );
  }

  async function passwordsMenu(tab) {
    const listed = await execute("passwords.list", { workspaceId: ws().id }, true);
    let site = "";
    try { site = new URL(tab.url).origin; } catch { /* about:blank */ }
    const here = listed.entries.filter((e) => e.origin === site);
    openDialog(
      "Saved sign-ins",
      `${here.length ? here.map((e) => `<div class="settings-row"><div><strong>${esc(e.username || "(no username)")}</strong><small>${esc(e.origin)}${e.shared ? " · shared from another workspace" : ""}</small></div>${action("pw-fill", "Fill", "lock", `data-id="${esc(e.id)}" data-tab="${tab.id}"`, "primary")}</div>`).join("") : "<p>No saved sign-ins for this site.</p>"}<div class="inline-actions">${action("pw-generate", "Suggest a strong password", "spark", `data-tab="${tab.id}"`)}${action("pw-manage", "Manage passwords…", "settings")}</div><p class="muted">Weft fills only this site's own sign-in form, never a frame from another site, and never submits it.</p>`,
      action("close-dialog", "Close"),
      false,
      "Saved passwords",
    );
  }

  async function passwordsManager() {
    const listed = await execute("passwords.list", { workspaceId: ws().id }, true);
    const unprotected = !listed.protection?.protected;
    openDialog(
      "Saved passwords",
      `${unprotected ? '<div class="notice" role="alert">Your system key store is unavailable (or Linux is using its plain-text fallback), so Weft cannot save passwords.</div>' : ""}${listed.entries.length ? listed.entries.map((e) => `<div class="settings-row"><div><strong>${esc(e.origin)}</strong><small>${esc(e.username || "(no username)")}${e.shared ? " · shared from another workspace" : e.sharedWith.length ? ` · shared with ${e.sharedWith.length} workspace(s)` : ""}</small><span id="pw-shown-${esc(e.id)}" class="secret-reveal"></span></div><div class="inline-actions">${action("pw-reveal", "Show", "", `data-id="${esc(e.id)}"`)}${e.shared ? "" : action("pw-delete", "Delete", "trash", `data-id="${esc(e.id)}"`, "secondary danger")}</div></div>`).join("") : "<p>No saved passwords in this workspace.</p>"}${listed.never.length ? `<h3>Never saved</h3>${listed.never.map((o) => `<div class="settings-row"><div><strong>${esc(o)}</strong></div>${action("pw-forget-never", "Offer again", "", `data-host="${esc(o)}"`)}</div>`).join("")}` : ""}<div class="inline-actions">${action("pw-import", "Import from a CSV export…", "upload")}${action("pw-export", "Export to CSV…", "download")}</div><p class="muted">${esc(listed.notice)}</p>`,
      action("close-dialog", "Close"),
      true,
      "Saved passwords",
    );
  }

  async function extensionsMenu() {
    const items = await execute("extensions.actions", { workspaceId: ws().id }, true);
    openDialog(
      "Extensions",
      `${items.map((x) => `<div class="settings-row"><div class="extension-row">${x.icon?.startsWith("data:image/") ? `<img src="${esc(x.icon)}" alt="" width="20" height="20">` : icon("grid")}<strong>${esc(x.title)}</strong><small>${esc(x.name)}</small></div><div class="inline-actions">${x.popup ? action("ext-open", "Open", "external", `data-id="${esc(x.id)}" data-mode="popup"`, "primary") : ""}${x.options ? action("ext-open", "Options", "settings", `data-id="${esc(x.id)}" data-mode="options"`) : ""}</div></div>`).join("") || "<p>No enabled extension in this workspace has a toolbar button.</p>"}<p class="muted">Extension pages open in their own window with only the permissions you granted. Badges and other toolbar features are not supported.</p>`,
      action("close-dialog", "Close"),
      false,
      "Extensions",
    );
  }

  /** Per-site section of the Site controls dialog: remembered decisions, never-ask and the full list. */
  function controlsSection() {
    return '<section class="settings-section" aria-labelledby="site-permissions-heading"><h3 id="site-permissions-heading">Permissions for this site</h3><div id="site-permissions-panel"><p>Loading…</p></div></section>';
  }

  async function loadControls(tab) {
    const panel = $("site-permissions-panel");
    if (!panel) return;
    let site = null;
    try { site = new URL(tab.url).origin; } catch { /* not a web page */ }
    const listed = await execute("permissions.list", { workspaceId: ws().id }, true).catch(() => null);
    if (!listed || !$("site-permissions-panel")) return;
    const here = listed.decisions.filter((d) => d.origin === site);
    const p = tab.protection || {};
    const userDenied = Object.values(p.permissionUserDenials || {}).reduce((a, b) => a + b, 0);
    panel.innerHTML = `${here.length ? here.map((d) => `<div class="settings-row"><div><strong>${esc(permissionNames[d.permission] || d.permission)}: ${esc(decisionText[d.decision] || d.decision)}</strong><small>${esc(d.scope === "always" ? "Remembered" : d.scope === "while-open" ? "While the site is open" : "Until the site is closed")}</small></div>${action("perm-revoke", "Reset", "", `data-host="${esc(d.origin)}" data-kind="${esc(d.permission)}"`)}</div>`).join("") : "<p>No decisions for this site. It will ask before using your camera, microphone, location, notifications, clipboard, screen, MIDI devices or sensors.</p>"}`
      + `<p class="muted">On this page: ${userDenied} request(s) you denied; requests from background tabs, pages only an agent is driving and unsupported features (USB, serial, HID, Bluetooth and similar) are denied without asking.</p>`
      + `${p.permissionUses?.length || p.sharing ? action("perm-stop", "Stop camera, microphone and screen sharing (reloads the page)", "stop", `data-tab="${tab.id}"`, "secondary danger") : ""}`
      + `<label class="toggle-row"><input type="checkbox" data-action-change="perm-never-ask" ${listed.neverAsk ? "checked" : ""}> Never ask: deny every site's requests without a prompt</label>`
      + `${listed.decisions.length > here.length ? action("perm-all", `All site decisions in this workspace (${listed.decisions.length})`, "shield", "", "text-button") : ""}`;
    panel.querySelector('[data-action-change="perm-never-ask"]')?.addEventListener("change", (e) => {
      void execute("permissions.configure", { neverAsk: e.target.checked }, true).then(() => toast(e.target.checked ? "Sites can no longer ask" : "Sites can ask again")).catch((err) => toast(errorMessage(err)));
    });
  }

  async function allDecisions() {
    const listed = await execute("permissions.list", { workspaceId: ws().id }, true);
    openDialog(
      "Site decisions in this workspace",
      listed.decisions.length ? listed.decisions.map((d) => `<div class="settings-row"><div><strong>${esc(d.origin)}</strong><small>${esc(permissionNames[d.permission] || d.permission)}: ${esc(decisionText[d.decision] || d.decision)} · ${esc(d.scope === "always" ? "remembered" : "temporary")}</small></div>${action("perm-revoke", "Reset", "", `data-host="${esc(d.origin)}" data-kind="${esc(d.permission)}"`)}</div>`).join("") : "<p>No decisions.</p>",
      action("close-dialog", "Close"),
      true,
      "Site permissions",
    );
  }

  async function handle(a, button) {
    const d = button.dataset || {};
    switch (a) {
      case "perm-respond": {
        const prompt = permissionPrompt.current;
        if (prompt?.id === d.id) prompt.answered = true;
        const sourceId = $("dialog-content").querySelector('input[name="share-source"]:checked')?.value;
        closeDialog();
        await execute("permissions.respond", { promptId: d.id, decision: d.decision, ...(prompt?.display && d.decision === "allow-once" ? { sourceId } : {}) }, true);
        toast(d.decision.startsWith("allow") ? "Allowed" : "Denied");
        await refresh(true);
        return true;
      }
      case "perm-revoke":
        await execute("permissions.set", { workspaceId: ws().id, origin: d.host, permission: d.kind, decision: "ask" }, true);
        toast("Reset. The site will ask again.");
        if ($("site-permissions-panel")) await loadControls(active()); else await allDecisions();
        return true;
      case "perm-all": await allDecisions(); return true;
      case "perm-stop":
        await execute("permissions.stop", { tabId: Number(d.tab) }, true);
        closeDialog();
        toast("Stopped. The page reloaded.");
        return true;
      case "popups-blocked": if (active()) await popupsDialog(active()); return true;
      case "popup-allow": {
        await execute("popups.allow", { tabId: Number(d.tab), popupId: d.id, always: d.mode === "always" }, true);
        closeDialog();
        await refresh(true);
        return true;
      }
      case "permissions-in-use": if (active()) { await ui.siteControls(); } return true;
      case "pw-offer":
        shownOffer = d.id;
        closeDialog();
        await execute("passwords.respondOffer", { offerId: d.id, action: d.mode }, true);
        if (d.mode === "save") toast("Password saved");
        return true;
      case "passwords-menu": if (active()) await passwordsMenu(active()); return true;
      case "pw-fill":
        closeDialog();
        await execute("passwords.fill", { id: d.id, tabId: Number(d.tab) }, true);
        toast("Filled");
        return true;
      case "pw-generate": {
        const result = await execute("passwords.generate", { tabId: Number(d.tab) }, true);
        closeDialog();
        toast(result.notice);
        return true;
      }
      case "pw-manage": await passwordsManager(); return true;
      case "pw-reveal": {
        const shown = await execute("passwords.reveal", { id: d.id }, true);
        const target = document.getElementById(`pw-shown-${d.id}`);
        if (target) { target.textContent = shown.password; setTimeout(() => { target.textContent = ""; }, 30000); }
        return true;
      }
      case "pw-delete":
        await execute("passwords.delete", { id: d.id }, true);
        await passwordsManager();
        return true;
      case "pw-forget-never":
        await execute("passwords.forgetNever", { workspaceId: ws().id, origin: d.host }, true);
        await passwordsManager();
        return true;
      case "pw-import": {
        const path = await window.weft.pickPath("import");
        if (!path) return true;
        const deleteSource = window.confirm("Delete the export file after importing? It holds your passwords in plain text.");
        const result = await execute("passwords.import", { workspaceId: ws().id, path, deleteSource }, true);
        toast(`Imported ${result.imported}, updated ${result.updated}, skipped ${result.skipped}`);
        await passwordsManager();
        return true;
      }
      case "pw-export": {
        if (!window.confirm("The exported file will contain your passwords in plain text. Continue?")) return true;
        const path = await window.weft.pickPath("save");
        if (!path) return true;
        const result = await execute("passwords.export", { workspaceId: ws().id, path, acknowledgePlaintext: true }, true);
        toast(`Exported ${result.exported} sign-in(s)`);
        return true;
      }
      case "extensions-menu": await extensionsMenu(); return true;
      case "ext-open":
        closeDialog();
        await execute("extensions.openPage", { id: d.id, page: d.mode }, true);
        return true;
      case "private-window":
        closeDialog();
        await window.weft.openPrivateWindow?.();
        return true;
      default: return false;
    }
  }

  /** Extra Page tools entries. */
  const pageTools = () => action("private-window", "New private window", "lock", 'aria-keyshortcuts="Control+Shift+N"') + action("pw-manage", "Saved passwords", "lock") + action("extensions-menu", "Extensions", "grid");

  return { indicators, afterRefresh, handle, controlsSection, loadControls, pageTools, passwordsManager };
}
