import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import electron from "electron";
import { installChecks } from "./a11y-checks.js";
import { electronEnv } from "../scripts/electron-env.js";

/**
 * Accessibility audit of the real GUI renderer in real Electron (#31): axe-core over every main
 * view, browser-owned page state and dialog in light and dark themes, plus checks axe cannot make
 * on its own — rendered state contrast, focus indicators, target size, keyboard reachability and
 * focus restoration, the native-page focus boundary, live-region noise, 200% zoom and text at the
 * minimum window, and reduced motion. Real screen readers are not exercised here (docs/ACCESSIBILITY.md).
 */
const TOKEN = "a11y-fixture-token";
const AXE_TAGS = ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa", "best-practice"];

if (process.argv.includes("--a11y-child")) {
  const { app, BrowserWindow } = electron;
  app.setPath("userData", process.env.WEFT_TEST_PROFILE);
  const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  let fixture;
  (async () => {
    fixture = createServer((request, response) => {
      response.setHeader("content-type", "text/html");
      if (request.url === "/checkout") return response.end('<!doctype html><title>Checkout</title><main><p>Tax <span id="tax">$4.00</span></p><p>Total <span id="total">$49.99</span></p><button id="pay">Pay $49.99</button></main>');
      response.end('<!doctype html><title>Reference page</title><main><h1>A useful reference</h1><p>Evidence saved for the project.</p><a href="/next">Next page</a> <button id="page-button">Page button</button></main>');
    });
    await new Promise((resolve) => fixture.listen(0, "127.0.0.1", resolve));
    const origin = `http://127.0.0.1:${fixture.address().port}`;
    // Seed realistic records before the app opens the store.
    const { WorkspaceService } = await import("../src/workspace.js");
    const seed = new WorkspaceService({ directory: join(process.env.WEFT_TEST_PROFILE, "workspace-data") });
    const home = seed.activeWorkspaceId;
    await seed.execute("workspaces.create", { name: "Second project", description: "Another workspace" });
    await seed.execute("workspaces.switch", { id: home });
    await seed.execute("materials.create", { workspaceId: home, kind: "note", title: "Interview notes", content: "Keep exact sources and record open questions.", pinned: true });
    await seed.execute("materials.create", { workspaceId: home, kind: "website", title: "Reference site", url: `${origin}/`, pinned: true });
    await seed.execute("context.create", { workspaceId: home, category: "questions", title: "Which supplier?", content: "Compare delivery times." });
    await seed.execute("tasks.create", { workspaceId: home, title: "Draft the summary", objective: "Summarize the findings", status: "waiting_on_human", blocker: "Needs your review" });
    await seed.execute("tasks.create", { workspaceId: home, title: "Check the order", plan: [{ id: "s1", kind: "review", title: "Confirm the order number" }] });
    await seed.execute("conversations.create", { workspaceId: home, title: "Planning chat" });
    await seed.execute("workflows.create", { workspaceId: home, title: "Weekly check", steps: [{ title: "Step 1", instruction: "Open the dashboard" }] });
    await seed.execute("siteRules.create", { workspaceId: home, hostname: "127.0.0.1", path: "/blocked", behavior: "block", reason: "Personal preference" });
    seed.close();
    await import("../src/main.js");
    await app.whenReady();
    let window;
    for (let i = 0; i < 300; i++) {
      window = BrowserWindow.getAllWindows()[0];
      if (window && !window.webContents.isLoading()) break;
      await pause(20);
    }
    window.webContents.on("console-message", (event) => { if (process.env.WEFT_A11Y_DEBUG) console.log("RENDERER", event.message ?? event); });
    const run = async (expression) => {
      try { return await window.webContents.executeJavaScript(expression); }
      catch (error) { throw new Error(`${expression.slice(0, 200)} : ${error.message}`); }
    };
    const until = async (expression, label = expression) => {
      // Generous under a parallel full-suite run.
      for (let i = 0; i < 600; i++) { if (await run(expression)) return; await pause(30); }
      throw new Error(`GUI timed out: ${label}; status: ${await run('document.getElementById("status").textContent')}`);
    };
    const execute = (name, args = {}) => run(`window.weft.execute(${JSON.stringify(name)}, ${JSON.stringify(args)})`);
    const api = async (command, args = {}) => (await fetch(`http://127.0.0.1:${process.env.WEFT_PORT}/v1/execute`, { method: "POST", headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" }, body: JSON.stringify({ command, args }) })).json();
    /** Trigger a GUI action exactly as its button would (the document-level click handler). */
    const act = (action, data = {}) => run(`(() => { const b = document.createElement("button"); b.hidden = true; b.dataset.action = ${JSON.stringify(action)}; Object.assign(b.dataset, ${JSON.stringify(data)}); document.body.append(b); b.click(); b.remove(); })()`);
    const press = async (keyCode, modifiers = []) => {
      window.webContents.sendInputEvent({ type: "keyDown", keyCode, modifiers });
      // Enter activates buttons on its character event, as a real keyboard does.
      if (keyCode === "Enter") window.webContents.sendInputEvent({ type: "char", keyCode: "\r", modifiers });
      window.webContents.sendInputEvent({ type: "keyUp", keyCode, modifiers });
      await pause(25);
    };
    const settle = async () => { await pause(250); await run("document.fonts.ready.then(() => true)"); };
    await until('document.getElementById("content")?.textContent.includes("Pick up where you left off")', "overview");
    window.focus();
    window.webContents.focus();
    // Other windows on a shared test display can take OS focus; emulate a focused page so
    // :focus-visible and focus behaviour match a person using this window.
    await window.webContents.debugger.attach("1.3");
    await window.webContents.debugger.sendCommand("Emulation.setFocusEmulationEnabled", { enabled: true });
    await run(readFileSync(createRequire(import.meta.url).resolve("axe-core/axe.min.js"), "utf8"));
    await run(`(${installChecks.toString()})()`);
    const report = { views: [], keyboard: [], restoration: [], zoom: [], motion: null, liveRegions: null, boundary: null, ownership: null, split: null };
    const failures = [];
    const audit = async (label, theme) => {
      await settle();
      // Measure the settled view: jump entrance animations (view fade-in, dialog rise-in) to their end
      // state. A fixed pause loses that race on a slow runner, and an unpainted window can freeze an
      // animation's timeline outright. Infinite loops (loading line) are left running.
      await run("document.getAnimations().filter((a) => a.effect?.getComputedTiming().iterations !== Infinity).forEach((a) => a.finish())");
      const axe = await run(`axe.run(${'document.getElementById("lock-screen") || (document.getElementById("dialog").open ? document.getElementById("dialog") : document)'}, { runOnly: { type: "tag", values: ${JSON.stringify(AXE_TAGS)} }, resultTypes: ["violations"] }).then((r) => r.violations.map((v) => ({ id: v.id, impact: v.impact, help: v.help, nodes: v.nodes.slice(0, 6).map((n) => ({ target: n.target.join(" "), summary: n.failureSummary.split("\\n").slice(0, 3).join(" ") })) })))`);
      const contrast = await run("window.__a11y.contrast()");
      const targets = await run("window.__a11y.targets()");
      const font = await run("window.__a11y.minFont()");
      const entry = { view: label, theme, axe, contrast: contrast.failures, states: contrast.states, targets: targets.failures, minFont: font };
      report.views.push(entry);
      if (axe.length) failures.push(`${theme} ${label}: axe ${axe.map((v) => `${v.id} (${v.nodes.map((n) => n.target).join(", ")})`).join("; ")}`);
      if (contrast.failures.length) failures.push(`${theme} ${label}: contrast ${JSON.stringify(contrast.failures.slice(0, 5))}`);
      if (targets.failures.length) failures.push(`${theme} ${label}: targets ${JSON.stringify(targets.failures.slice(0, 5))}`);
      if (font.min < 11) failures.push(`${theme} ${label}: text below 11px (${font.min}px at ${font.where})`);
      return entry;
    };
    const auditFocus = async (label) => {
      const result = await run("window.__a11y.focusIndicators()");
      if (result.failures.length) failures.push(`${label}: focus indicators ${JSON.stringify(result.failures.slice(0, 6))}`);
      return result;
    };
    const section = async (name) => { await act("section", { section: name }); await until(`!document.getElementById("dialog").open && document.getElementById("breadcrumb-section").textContent.length > 0`); };
    const closeDialog = async () => { if (await run('document.getElementById("dialog").open')) { await press("Escape"); await until('!document.getElementById("dialog").open'); } };
    const dialog = async (open, title) => { await open(); await until(`document.getElementById("dialog").open && document.getElementById("dialog-title")?.textContent.includes(${JSON.stringify(title)})`, `dialog ${title}`); };

    // ---- Richer state through the real command surfaces --------------------------------------
    const live = await execute("tabs.new", { url: `${origin}/` });
    await until(`(async () => (await window.weft.execute("tabs.list", {})).some((t) => t.id === ${live.id} && !t.loading && t.title === "Reference page"))()`, "fixture page");
    const capture = await execute("artifacts.capture", { workspaceId: home, tabId: live.id, kind: "bundle", title: "Reference capture" });
    await execute("artifacts.capture", { workspaceId: home, tabId: live.id, kind: "bundle", title: "Reference capture", artifactId: capture.id });
    await execute("tabGroups.create", { workspaceId: home, name: "Research", color: "sage", tabIds: [live.id] });
    const checkout = await api("tabs.new", { url: `${origin}/checkout`, workspaceId: home });
    let proposed;
    for (let i = 0; i < 100 && !proposed?.result; i++) {
      proposed = await api("payments.propose", { workspaceId: home, tabId: checkout.result.id, merchantName: "Fixture shop", purpose: "Buy printer paper", amountCeiling: "50.00", currency: "USD", checkout: { total: { selector: "#total" }, tax: { selector: "#tax" }, submit: { selector: "#pay" } } });
      if (!proposed.result) await pause(50);
    }
    assert.equal(proposed.error, null, JSON.stringify(proposed.error));
    await execute("tabs.activate", { tabId: live.id });
    await api("handoffs.create", { workspaceId: home, objective: "Finish the comparison", nextStep: "Review the second supplier", tabIds: [live.id] });
    await execute("autonomy.update", { bootstrapLevel: "assist" });
    const requested = await api("materials.create", { workspaceId: home, title: "Agent proposed note" });
    assert.equal(requested.error?.code, "approval_required");

    const mainViews = ["overview", "materials", "context", "tasks", "conversations", "workflows", "artifacts", "activity", "approvals", "shared", "settings", "updates", "privacy", "lists", "downloads", "history", "bookmarks", "tabs"];
    const dialogs = [
      ["palette", () => run('document.getElementById("search-button").click()'), "Find anything"],
      ["command desk", () => run('document.getElementById("command-button").click()'), "Command desk"],
      ["tab search", () => act("search-tabs"), "Search tabs"],
      ["workspace menu", () => act("workspace-menu"), "Your workspaces"],
      ["new workspace", () => run('document.getElementById("add-workspace").click()'), "Create a workspace"],
      ["new material", () => act("new-material"), "New material"],
      ["new task", () => act("new-task"), "New task"],
      ["task review", async () => act("task-detail", { id: (await execute("workspace.snapshot")).tasks.find((t) => t.plan?.length).id }), "Check the order"],
      ["artifact viewer", () => act("view-artifact", { id: capture.id }), "Reference capture"],
      ["compare versions", async () => act("compare-versions", { id: capture.id, version: (await execute("artifacts.get", { id: capture.id })).versions.at(-1).id }), "Compare capture versions"],
      ["redaction editor", async () => act("redact-version", { id: capture.id, version: (await execute("artifacts.get", { id: capture.id })).versions.at(-1).id }), "Review and redact"],
      ["agent connections", () => act("manage-clients"), "Agent connections"],
      ["create connection", () => act("new-client"), "Create agent connection"],
      ["saved sign-ins", () => act("manage-credentials"), "Saved sign-ins"],
      ["payments", () => act("manage-payments"), "Payments in"],
      ["plugins", () => act("manage-plugins"), "Plugins"],
      ["extensions", () => act("manage-extensions"), "Extensions in"],
      ["backups", () => act("manage-backups"), "Backups"],
      ["resource limits", () => act("manage-resources"), "Resource limits"],
      ["export", () => act("export-workspace"), "Review workspace export"],
      ["encryption", () => act("encryption-enable"), "Turn on encryption"],
      ["retention", () => act("activity-settings"), "Retention & integrity"],
      ["model connection", () => act("new-model"), "Add model connection"],
      ["semantic search", () => act("configure-embeddings"), "Semantic search in"],
      ["explain address", () => act("explain-url", { url: `${origin}/blocked` }), "Why this outcome"],
      ["storage coverage", () => act("storage-coverage"), "Storage coverage"],
      ["subscribe to list", () => act("lists-subscribe"), "Subscribe to a community list"],
      ["agent input", () => act("automation-settings"), "Agent input"],
      ["page tools", () => run('document.getElementById("page-more").click()'), "Page tools"],
    ];
    for (const theme of process.env.WEFT_A11Y_SKIP_VIEWS === "1" ? [] : ["light", "dark"]) {
      await execute("settings.update", { theme });
      await until(`document.documentElement.dataset.theme === ${JSON.stringify(theme)}`);
      for (const name of mainViews) { await section(name); await audit(name, theme); }
      // The live page itself is the website's; the chrome around it is Weft's.
      await act("activate-tab", { id: String(live.id) });
      await until('document.getElementById("breadcrumb-section").textContent === "Live page"');
      await audit("live page chrome", theme);
      await act("activate-tab", { id: String(checkout.result.id) });
      await run(`window.weft.execute("page.navigate", { url: ${JSON.stringify(`${origin}/blocked`)} }).catch(() => {})`);
      await until('document.getElementById("content").textContent.includes("restricted")', "stop page");
      await audit("stop page", theme);
      await act("activate-tab", { id: String(live.id) });
      await section("overview");
      await run('document.getElementById("agent-toggle").click()');
      await until('document.getElementById("chat-form") !== null');
      await audit("agent panel", theme);
      await act("close-agent");
      for (const [label, open, title] of dialogs) {
        try { await dialog(open, title); } catch (error) { failures.push(`${theme} dialog ${label}: ${error.message}`); await closeDialog(); continue; }
        await audit(`dialog: ${label}`, theme);
        if (theme === "light") await auditFocus(`dialog: ${label}`);
        await closeDialog();
      }
      if (theme === "light") for (const name of ["overview", "settings", "privacy", "approvals"]) { await section(name); await auditFocus(name); }
    }
    await execute("settings.update", { theme: "light" });

    // ---- Keyboard reachability: every control in a view or dialog is reached with Tab, and Tab is not trapped outside modals.
    const tabThrough = async (label, { modal = false } = {}) => {
      // Let the view's own loaders and one poll settle so the controls are stable while tabbing.
      await pause(1600);
      await settle();
      const expected = await run("window.__a11y.tabbable()");
      const seen = new Set();
      await run('document.activeElement?.blur(); document.getElementById("dialog").open ? document.getElementById("dialog").focus() : document.body.focus()');
      let wrapped = false, first = null;
      const order = [];
      for (let i = 0; i < expected.length + 40; i++) {
        await press("Tab");
        const id = await run("window.__a11y.focusedId()");
        order.push(await run("document.activeElement ? window.__a11y.describe(document.activeElement) : 'none'"));
        if (!id) continue;
        if (first === null) first = id;
        else if (id === first) { wrapped = true; break; }
        seen.add(id);
        if (modal && !(await run('document.getElementById("dialog").contains(document.activeElement)'))) { failures.push(`${label}: Tab left the modal dialog`); break; }
      }
      seen.add(first);
      const missed = expected.filter((e) => !seen.has(e.id)).map((e) => e.element);
      report.keyboard.push({ view: label, controls: expected.length, missed, wrapped });
      if (missed.length) failures.push(`${label}: not reachable with Tab: ${missed.slice(0, 8).join("; ")}`);
      if (!wrapped && !modal) failures.push(`${label}: Tab did not cycle back to the first control (possible trap); last stops: ${order.slice(-12).join(" | ")}`);
    };
    for (const name of ["overview", "tasks", "approvals", "settings", "privacy", "lists"]) { await section(name); await tabThrough(`view: ${name}`); }
    for (const [label, open, title] of dialogs.filter(([label]) => ["palette", "new material", "agent connections", "artifact viewer", "redaction editor", "subscribe to list", "agent input"].includes(label))) {
      await dialog(open, title);
      await tabThrough(`dialog: ${label}`, { modal: true });
      await closeDialog();
    }

    // ---- Focus restoration: opened from the keyboard, closed with Escape, focus returns to the invoking control.
    const restoration = async (label, focusInvoker, title, invoker) => {
      await focusInvoker();
      await press("Enter");
      try { await until(`document.getElementById("dialog").open && document.getElementById("dialog-title")?.textContent.includes(${JSON.stringify(title)})`, `${label} opens`); }
      catch (error) { failures.push(`${label}: ${error.message}`); return; }
      const inside = await run('document.getElementById("dialog").contains(document.activeElement)');
      await press("Escape");
      await until('!document.getElementById("dialog").open');
      await pause(60);
      const back = await run(`document.activeElement?.matches(${JSON.stringify(invoker)})`);
      report.restoration.push({ dialog: label, focusMovedIn: inside, restored: back });
      if (!inside) failures.push(`${label}: focus did not move into the dialog`);
      if (!back) failures.push(`${label}: focus did not return to ${invoker} (now ${await run("window.__a11y.describe(document.activeElement)")})`);
    };
    await section("overview");
    await restoration("Find anything", () => run('document.getElementById("search-button").focus()'), "Find anything", "#search-button");
    await restoration("Command desk", () => run('document.getElementById("command-button").focus()'), "Command desk", "#command-button");
    await restoration("Workspace menu", () => run('document.getElementById("workspace-heading").focus()'), "Your workspaces", "#workspace-heading");
    await restoration("Create workspace", () => run('document.getElementById("add-workspace").focus()'), "Create a workspace", "#add-workspace");
    await restoration("Workspace options", () => run('document.querySelector("[data-action=workspace-menu]").focus()'), "Your workspaces", "[data-action=workspace-menu]");
    await restoration("Save a thought", () => run('document.querySelector(".quick-card[data-action=new-material]").focus()'), "New material", ".quick-card[data-action=new-material]");
    await section("settings");
    await restoration("Agent connections", () => run('document.querySelector("[data-action=manage-clients]").focus()'), "Agent connections", "[data-action=manage-clients]");
    await restoration("Agent input", () => run('document.querySelector("[data-action=automation-settings]").focus()'), "Agent input", "[data-action=automation-settings]");
    await section("tasks");
    await restoration("Task editor", () => run('document.querySelector("#record-cards [data-action=edit-record]").focus()'), "Edit task", "#record-cards [data-action=edit-record]");
    await section("lists");
    await restoration("Subscribe", () => run('document.querySelector("[data-action=lists-subscribe]").focus()'), "Subscribe to a community list", "[data-action=lists-subscribe]");
    // The agent panel is not modal: Escape inside it closes it and returns to its toggle.
    await run('document.getElementById("agent-toggle").focus()');
    await press("Enter");
    await until('document.activeElement?.id === "chat-input"', "agent panel takes focus");
    await press("Escape");
    await until('document.getElementById("agent-panel").hidden && document.activeElement?.id === "agent-toggle"', "agent panel returns focus");
    report.restoration.push({ dialog: "Agent panel (non-modal)", focusMovedIn: true, restored: true });

    // ---- Native page boundary: F6 enters the page, F6 / Ctrl+L inside the page return to Weft; the page never sees them.
    const pageView = () => window.contentView.children.find((view) => view.webContents && view.webContents !== window.webContents && view.webContents.getURL().startsWith(origin));
    await act("activate-tab", { id: String(live.id) });
    await until('document.getElementById("breadcrumb-section").textContent === "Live page" && !document.getElementById("focus-page").hidden', "live page shown");
    await until('document.activeElement?.id === "focus-page"', "view change offers the way into the page");
    await run('document.getElementById("address").focus()');
    await press("F6");
    for (let i = 0; i < 50 && !pageView()?.webContents.isFocused(); i++) await pause(30);
    const entered = Boolean(pageView()?.webContents.isFocused());
    const page = pageView().webContents;
    await page.executeJavaScript('window.__keys = []; addEventListener("keydown", (e) => window.__keys.push(e.key), true); true');
    await page.executeJavaScript('document.getElementById("page-button").focus(); true');
    page.sendInputEvent({ type: "keyDown", keyCode: "F6" });
    page.sendInputEvent({ type: "keyUp", keyCode: "F6" });
    await pause(200);
    const leftWithF6 = !page.isFocused() && (await run('Boolean(document.activeElement && document.activeElement !== document.body)'));
    await run('document.getElementById("focus-page").click()');
    for (let i = 0; i < 50 && !page.isFocused(); i++) await pause(30);
    const enteredWithButton = page.isFocused();
    page.sendInputEvent({ type: "keyDown", keyCode: "L", modifiers: ["control"] });
    page.sendInputEvent({ type: "keyUp", keyCode: "L", modifiers: ["control"] });
    await until('document.activeElement?.id === "address"', "Ctrl+L from the page focuses the address bar");
    const pageSaw = await page.executeJavaScript("window.__keys");
    const controller = (await execute("tabs.list")).find((t) => t.id === live.id).controller;
    report.boundary = { enteredWithF6: entered, leftWithF6, enteredWithButton, ctrlLReturned: true, keysSeenByPage: pageSaw, controllerAfter: controller };
    if (!entered) failures.push("boundary: F6 from the address bar did not focus the page");
    if (!leftWithF6) failures.push("boundary: F6 inside the page did not return focus to Weft");
    if (!enteredWithButton) failures.push("boundary: the Move focus into the page control did not focus the page");
    if (pageSaw.some((key) => ["F6", "l", "L"].includes(key))) failures.push(`boundary: the page received browser-owned keys ${pageSaw.join(",")}`);

    // ---- Ownership, handoff transition and split view (#36): stated in text, framed, and focusable per pane.
    await execute("tabs.setControlMode", { tabId: live.id, mode: "agent-drives", agent: "research-agent" });
    await until('document.getElementById("page-owner").textContent.includes("Agent drives") && document.querySelector(".pane-frame.agent") !== null', "agent ownership shown");
    const handoff = await run('document.querySelector(".pane-frame")?.classList.contains("handoff")');
    await until('document.getElementById("announcer").textContent.includes("Agent drives")', "ownership change announced");
    await execute("tabs.takeover", { tabId: live.id });
    await until('document.getElementById("page-owner").textContent.includes("You drive") && document.querySelector(".pane-frame.agent") === null', "takeover shown");
    report.ownership = { handoffTransition: handoff, chip: await run('document.getElementById("page-owner").textContent'), statusBar: await run('document.getElementById("ownership").textContent') };
    if (!handoff) failures.push("ownership: the page frame did not show the handoff transition");
    const second = await execute("tabs.new", { url: `${origin}/second` });
    await until(`(async () => (await window.weft.execute("tabs.list", {})).some((t) => t.id === ${second.id} && !t.loading))()`, "second page");
    // The GUI learns about the new tab on its next poll; split view needs it in the tab list.
    await until(`document.querySelector('#tabs [data-action="activate-tab"][data-id="${second.id}"]') !== null`, "second tab listed");
    await act("activate-tab", { id: String(live.id) });
    await until(`document.getElementById("breadcrumb-section").textContent === "Live page" && document.querySelector('#tabs .tab.active [data-action="activate-tab"][data-id="${live.id}"]') !== null`, "first page active");
    await run('document.getElementById("split-view").click()');
    await until('document.querySelectorAll(".pane-header").length === 2', "split view panes");
    await audit("split view", "light");
    const panes = await run('[...document.querySelectorAll(".pane-header")].map((h) => ({ focused: h.classList.contains("focused"), text: h.textContent }))');
    await run('document.querySelector(\'.pane-header [data-pane="secondary"]\').focus()');
    await press("Enter");
    await until('document.querySelector(".pane-header.focused")?.dataset.pane === "secondary" && document.querySelector(".pane-frame.focused")?.dataset.pane === "secondary"', "secondary pane focused");
    const secondary = window.contentView.children.filter((view) => view.webContents && view.webContents !== window.webContents).sort((a, b) => a.getBounds().x - b.getBounds().x).at(-1);
    for (let i = 0; i < 50 && !secondary.webContents.isFocused(); i++) await pause(30);
    report.split = { panes, secondaryReceivedFocus: secondary.webContents.isFocused(), statusBar: await run('document.getElementById("ownership").textContent') };
    if (!report.split.secondaryReceivedFocus) failures.push("split view: choosing the right pane did not move keyboard focus into it");
    if (!panes.some((p) => p.focused && p.text.includes("Focused"))) failures.push("split view: the focused pane is not stated in text");
    await run('document.getElementById("split-view").click()');
    await until('document.querySelectorAll(".pane-header").length === 0', "split view closed");
    // Hand keyboard focus back to Weft and let the last announcement finish before measuring idle silence.
    window.webContents.focus();
    await pause(500);

    // ---- Live regions: one status region and one alert region announce meaningful changes; polling is silent.
    const regions = await run('[...document.querySelectorAll("[aria-live]:not([aria-live=off]), [role=status], [role=alert], [role=log]:not([aria-live=off])")].map((el) => el.id || el.className)');
    report.liveRegions = { regions };
    for (const region of regions) if (!["toast", "announcer", "alert-announcer", "form-error"].includes(region)) failures.push(`live regions: unexpected live region ${region}`);
    await section("overview");
    const quiet = await run(`new Promise((resolve) => { const seen = [], rerenders = []; const o = new MutationObserver(() => seen.push(document.getElementById("announcer").textContent)); o.observe(document.getElementById("announcer"), { childList: true, characterData: true, subtree: true }); const r = new MutationObserver((list) => rerenders.push(...list.map((m) => m.target.id || m.target.className))); for (const id of ["sections", "tabs", "content", "safety-notices"]) r.observe(document.getElementById(id), { childList: true }); setTimeout(() => { o.disconnect(); r.disconnect(); resolve({ seen, rerenders }); }, 4000); })`);
    if (quiet.rerenders.length) failures.push(`idle polling replaced controls: ${quiet.rerenders.join(", ")}`);
    if (quiet.seen.length) failures.push(`live regions: idle polling announced ${JSON.stringify(quiet.seen)}`);
    const requestedAgain = await api("materials.create", { workspaceId: home, title: "Second agent note" });
    assert.equal(requestedAgain.error?.code, "approval_required");
    await until('document.getElementById("announcer").textContent.includes("need your decision")', "new agent request is announced");
    report.liveRegions.idleAnnouncements = quiet.seen.length;
    report.liveRegions.idleRerenders = quiet.rerenders.length;
    report.liveRegions.approvalAnnouncement = await run('document.getElementById("announcer").textContent');

    // ---- 200% zoom and 200% text at the minimum window size: nothing essential is clipped or overlapping.
    window.setContentSize(1000, 640);
    const scaled = async (mode) => {
      for (const name of ["overview", "tasks", "settings", "privacy", "lists", "approvals"]) {
        await section(name);
        await settle();
        const problems = await run("window.__a11y.layout()");
        report.zoom.push({ mode, view: name, problems });
        if (problems.length) failures.push(`${mode} ${name}: ${problems.slice(0, 6).join("; ")}`);
      }
      for (const [label, open, title] of dialogs.filter(([label]) => ["palette", "new material", "agent connections", "subscribe to list"].includes(label))) {
        await dialog(open, title);
        await settle();
        const problems = await run("window.__a11y.layout()");
        report.zoom.push({ mode, view: `dialog: ${label}`, problems });
        if (problems.length) failures.push(`${mode} dialog ${label}: ${problems.slice(0, 6).join("; ")}`);
        await closeDialog();
      }
    };
    window.webContents.setZoomFactor(2);
    await pause(300);
    await scaled("200% zoom");
    window.webContents.setZoomFactor(1);
    await run('document.documentElement.style.fontSize = "32px"');
    await scaled("200% text");
    await run('document.documentElement.style.fontSize = ""');
    window.setContentSize(1480, 960);

    // ---- Reduced motion: no animation or transition runs, and state stays in text.
    await window.webContents.debugger.sendCommand("Emulation.setEmulatedMedia", { features: [{ name: "prefers-reduced-motion", value: "reduce" }] });
    await section("tabs");
    await settle();
    const moving = await run("window.__a11y.motion()");
    report.motion = { reducedMotionRunning: moving, handoffDuration: await run('getComputedStyle(document.documentElement).getPropertyValue("--motion-handoff").trim()') };
    if (moving.length) failures.push(`reduced motion: still animating ${moving.join("; ")}`);
    await window.webContents.debugger.sendCommand("Emulation.setEmulatedMedia", { features: [] });

    // ---- Lock screen: the only operable surface, audited in both themes, and focus returns after unlock.
    await execute("encryption.enable", { acknowledgeKeyLoss: true, unlockMode: "manual", passphrase: "a11y lock passphrase" });
    for (const theme of ["light", "dark"]) {
      await execute("settings.update", { theme });
      await until(`document.documentElement.dataset.theme === ${JSON.stringify(theme)}`);
      await run('document.getElementById("search-button").focus()');
      const locked = await run(`window.weft.executeOutcome("encryption.lock", {})`);
      if (locked.error) throw new Error(`lock failed: ${JSON.stringify(locked.error)}`);
      await until('document.getElementById("lock-screen") !== null', "lock screen");
      await audit("lock screen", theme);
      if (theme === "light") {
        await auditFocus("lock screen");
        for (let i = 0; i < 8; i++) {
          await press("Tab");
          if (!(await run('document.getElementById("lock-screen").contains(document.activeElement)'))) { failures.push("lock screen: Tab reached content behind the lock screen"); break; }
        }
      }
      await run('(() => { const form = document.getElementById("unlock-form"); form.querySelector("[name=secret]").value = "a11y lock passphrase"; form.requestSubmit(); })()');
      await until('document.getElementById("lock-screen") === null', "unlocked");
      await pause(200);
      if (!(await run('document.activeElement?.id === "search-button"'))) failures.push(`lock screen (${theme}): focus did not return after unlock`);
    }
    writeFileSync(process.env.WEFT_A11Y_REPORT || join(process.env.WEFT_TEST_PROFILE, "a11y-report.json"), JSON.stringify({ report, failures }, null, 2));
    for (const f of failures) console.log("A11Y", f);
    console.log(`WEFT_A11Y_DONE ${failures.length}`);
    fixture.close();
    app.quit();
  })().catch((error) => { console.error(error); fixture?.close(); app.exit(1); });
} else {
  test("accessibility audit of every GUI view and dialog in real Electron", {
    timeout: 420000,
    skip: process.platform === "linux" && !process.env.DISPLAY ? "Requires DISPLAY or xvfb-run" : false,
  }, async () => {
    const profile = mkdtempSync(join(tmpdir(), "weft-a11y-"));
    const reservation = createServer();
    await new Promise((r) => reservation.listen(0, "127.0.0.1", r));
    const port = reservation.address().port;
    await new Promise((r) => reservation.close(r));
    const child = spawn(electron, ["--no-sandbox", "--disable-gpu", fileURLToPath(import.meta.url), "--a11y-child"], {
      env: electronEnv({ WEFT_TEST_PROFILE: profile, WEFT_PORT: String(port), WEFT_TOKEN: TOKEN, LANG: "en_US.UTF-8" }),
      stdio: ["ignore", "pipe", "pipe"],
    });
    let output = "";
    child.stdout.on("data", (x) => (output += x));
    child.stderr.on("data", (x) => (output += x));
    const timer = setTimeout(() => child.kill("SIGKILL"), 410000);
    try {
      const code = await new Promise((resolve, reject) => { child.on("exit", resolve); child.on("error", reject); });
      assert.equal(code, 0, output);
      assert.match(output, /WEFT_A11Y_DONE 0/, output.split("\n").filter((line) => line.startsWith("A11Y")).join("\n") || output.slice(-4000));
    } finally {
      clearTimeout(timer);
      rmSync(profile, { recursive: true, force: true });
    }
  });
}
