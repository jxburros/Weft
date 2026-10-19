/**
 * Site safety actions: stop pages, exceptions, storage modes, threat lists, scanners and app launches.
 * Moved from the act() switch in src/gui.js (#119). Each handler receives the clicked button and its
 * data-action, data-id and data-kind; `g` holds live bindings to gui.js state and helpers.
 */
let g;

const handlers = {
  "blocked-back": async (button, a, id, kind) => {
    await g.execute("page.back");
  },
  "allow-once": async (button, a, id, kind) => {
    if (g.active()?.blocked?.kind === "security") {
      g.formDialog(
        "Proceed to a known harmful destination?",
        `<p>${g.esc(g.active().blocked.url)} is listed as ${g.esc(g.active().blocked.category)} by your security intelligence. Continuing allows only this address in this tab, for this visit.</p><label><input type="checkbox" name="acknowledge" required> I understand the risk and want to continue</label>`,
        async () => { await g.execute("page.allowOnce", { tabId: g.active().id, acknowledgeSecurityRisk: true }); },
        { save: "Proceed for this visit", trusted: "Security stop" },
      );
    } else await g.execute("page.allowOnce", { tabId: g.active().id });
  },
  "explain-url": async (button, a, id, kind) => {
    if (button.dataset.url) await g.explainUrl(button.dataset.url);
    else g.formDialog("Explain a web address", g.field("Web address", "url", g.active()?.url !== "about:blank" ? g.active()?.url || "" : "", "url", true), async (v) => { setTimeout(() => void g.explainUrl(v.url).catch((e) => g.toast(g.errorMessage(e))), 0); });
  },
  "storage-mode": async (button, a, id, kind) => {
    await g.execute("storage.setSiteMode", { workspaceId: g.ws().id, hostname: button.dataset.host, mode: button.dataset.mode });
    g.toast(button.dataset.mode === "block" ? "Site storage blocked and existing data erased. Reload open pages." : button.dataset.mode === "session" ? "This site's data will be erased when Weft exits." : button.dataset.mode === "remember" ? "This site's data will be kept." : "Exception revoked; the workspace default applies.");
    if (g.$("dialog").open) g.closeDialog();
    if (g.section === "privacy") await g.loadPrivacyPanels();
  },
  "storage-defaults": async (button, a, id, kind) => {
    const policy = await g.execute("storage.policy", { workspaceId: g.ws().id }, true);
    g.formDialog(
      "Site storage defaults",
      g.choice("Sites without an exception", "mode", [["remember", "Remember site data"], ["session", "Keep data for this session only"], ["block", "Block site storage"]], policy.defaults.mode) +
        g.choice("Cross-site cookies", "crossSiteCookies", [["block", "Block (recommended)"], ["allow", "Allow"]], policy.defaults.crossSiteCookies) +
        "<p>Blocking storage can break sign-in and site features. Session-only data is erased at exit, or at the next start after a crash.</p>",
      async (v) => { await g.execute("storage.setDefaultMode", { workspaceId: g.ws().id, mode: v.mode, crossSiteCookies: v.crossSiteCookies }); },
    );
  },
  "storage-coverage": async (button, a, id, kind) => {
    const policy = await g.execute("storage.policy", { workspaceId: g.ws().id }, true);
    g.openDialog("Storage coverage", `<p>${g.esc(policy.sessionLifetime)}</p><table class="coverage-table"><thead><tr><th>Path</th><th>Block</th><th>This session</th><th>Remember</th></tr></thead><tbody>${policy.coverage.map((row) => `<tr><th>${g.esc(row.path)}</th><td>${g.esc(row.block)}</td><td>${g.esc(row.session)}</td><td>${g.esc(row.remember)}</td></tr>`).join("")}</tbody></table><ul>${policy.limitations.map((l) => `<li>${g.esc(l)}</li>`).join("")}</ul>`, g.action("close-dialog", "Close"), true);
  },
  "review-rule": async (button, a, id, kind) => {
    g.formDialog("Mark rule reviewed", g.field("Next review (optional)", "reviewBy", "", "date") + g.area("Review note (optional)", "note", ""), async (v) => {
      await g.execute("siteRules.review", { id, ...(v.reviewBy ? { reviewBy: v.reviewBy } : {}), ...(v.note ? { note: v.note } : {}) });
    });
  },
  "install-threats": async (button, a, id, kind) => {
    g.formDialog(
      "Install a threat list",
      '<p>Use a list from a publisher you trust. Paste the SHA-256 published by that source; the file must match it exactly. Lists never update in the background.</p><label>Threat list file (weft-threat-list JSON)<input id="threat-file" type="file" accept="application/json,.json" required></label>' + g.field("List name", "id", "", "text", true) + g.field("Published SHA-256", "sha256", "", "text", true) + g.field("Source (publisher URL or description)", "source", "", "text", true) + g.field("Stale after (hours)", "maxAgeHours", "72", "number"),
      async (v) => {
        const f = g.$("threat-file").files[0];
        if (!f || f.size > 4000000) throw new Error("Choose a list under 4 MB.");
        const data = await f.text();
        if ((await g.sha256Hex(data)) !== v.sha256.trim().toLowerCase()) throw new Error("The file does not match the published SHA-256.");
        await g.execute("threats.install", { id: v.id, sha256: v.sha256.trim(), bytes: new TextEncoder().encode(data).length, source: v.source, maxAgeHours: Number(v.maxAgeHours) || 72, data });
        g.toast("Threat list installed.");
      },
      { save: "Verify and install" },
    );
  },
  "remove-threats": async (button, a, id, kind) => {
    await g.execute("threats.remove", { id });
    await g.loadPrivacyPanels();
  },
  "update-threats": async (button, a, id, kind) => {
    await g.execute("threats.update", {});
    await g.loadPrivacyPanels();
  },
  "configure-provider": async (button, a, id, kind) => {
    const status = await g.execute("threats.status", {}, true);
    g.formDialog(
      "Reputation provider",
      `<p>Optional. When on, Weft downloads hash-prefix lists and, only when a page matches a prefix locally, sends that short hash prefix to the provider to confirm. Full addresses are never sent, but the provider sees your IP address. Check the provider's terms (some free services are non-commercial only).</p>${g.choice("Status", "enabled", [["false", "Off"], ["true", "On"]], String(status.provider.enabled))}${g.field("Endpoint (Safe Browsing v4 Update API compatible)", "endpoint", status.provider.endpoint || "https://safebrowsing.googleapis.com", "url")}${g.field("Environment variable holding the API key", "apiKeyEnv", status.provider.apiKeyEnv || "WEFT_SAFE_BROWSING_KEY")}<label><input type="checkbox" name="acknowledgeEgress"> I understand what is sent to this provider</label>`,
      async (v) => {
        await g.execute("threats.configureProvider", v.enabled === "true" ? { enabled: true, endpoint: v.endpoint, apiKeyEnv: v.apiKeyEnv, acknowledgeEgress: v.acknowledgeEgress === "on" } : { enabled: false });
      },
    );
  },
  "configure-embeddings": async (button, a, id, kind) => {
    const [models, status] = await Promise.all([g.execute("models.list", {}, true), g.execute("search.status", { workspaceId: g.ws().id }, true)]);
    const usable = models.filter((m) => ["ollama", "openai"].includes(m.provider));
    g.formDialog(
      `Semantic search in ${g.ws().name}`,
      `<p>Record text in this workspace is sent to the chosen endpoint to compute embeddings. Local-only records are sent only to an endpoint on this device. Weft never downloads or installs models.</p>${g.choice("Status", "enabled", [["false", "Off"], ["true", "On"]], String(status.vector.enabled))}${g.choice("Connection", "modelId", usable.map((m) => [m.id, `${m.name} · ${m.locality}`]), status.vector.modelId || usable[0]?.id || "")}${g.field("Embedding model already available there (for example nomic-embed-text)", "embeddingModel", status.vector.model || "")}<label><input type="checkbox" name="acknowledgeEgress"> The endpoint is not on this device; I understand record text is sent there</label>`,
      async (v) => {
        await g.execute("search.configureEmbeddings", v.enabled === "true" ? { workspaceId: g.ws().id, enabled: true, modelId: v.modelId, ...(v.embeddingModel.trim() ? { embeddingModel: v.embeddingModel.trim() } : {}), ...(v.acknowledgeEgress === "on" ? { acknowledgeEgress: true } : {}) } : { workspaceId: g.ws().id, enabled: false });
        g.toast(v.enabled === "true" ? "Semantic search is on; records are being embedded." : "Semantic search is off; stored vectors were removed.");
      },
    );
  },
  "configure-scanner": async (button, a, id, kind) => {
    g.formDialog(
      "Download scanner",
      "<p>Optional. Weft runs this local program with the downloaded file path as the last argument after each completed download. Without a scanner, downloads are shown as not scanned. A clean result is not a guarantee.</p>" + g.field("Scanner program (absolute path; leave empty to remove)", "command", "", "text") + g.field("Arguments (space separated)", "args", "") + g.field("Exit code meaning clean", "clean", "0", "number") + g.field("Exit code meaning infected", "infected", "1", "number"),
      async (v) => {
        await g.execute("downloads.configureScanner", v.command.trim() ? { command: v.command.trim(), args: v.args.split(" ").filter(Boolean), cleanExitCodes: [Number(v.clean)], infectedExitCodes: [Number(v.infected)] } : { command: null });
        g.toast(v.command.trim() ? "Scanner configured." : "Scanner removed. Downloads will show as not scanned.");
      },
    );
  },
  "approve-launch": async (button, a, id, kind) => {
    await g.execute("launches.approve", { launchId: Number(id) });
    await g.loadDownloads();
  },
  "deny-launch": async (button, a, id, kind) => {
    await g.execute("launches.deny", { launchId: Number(id) });
    await g.loadDownloads();
  },
};

/** Bind the handlers to the GUI's shared context and return them by action name. */
export function siteActions(context) {
  g = context;
  return handlers;
}
