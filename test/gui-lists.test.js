import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import electron from "electron";
import { electronEnv } from "../scripts/electron-env.js";

/**
 * The human screens for community site lists (#28) and agent input serialization (#9), driven in the
 * real GUI: the publisher fingerprint and every previewed change are shown before anything applies,
 * the confirmed digest is what gets applied, and exceptions, rollback, mode changes and unsubscribe
 * change real subscriber behaviour.
 */
if (process.argv.includes("--gui-lists")) {
  const { app, BrowserWindow } = electron;
  app.setPath("userData", process.env.WEFT_TEST_PROFILE);
  const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  (async () => {
    const { acceptEntry, factualDomain, newGroup, release } = await import("./fixtures/community-authoring.mjs");
    const now = new Date();
    const group = newGroup({ now });
    const first = acceptEntry(group.state, factualDomain("bad.example"), now);
    const v1 = release(group, first.state, now);
    const second = acceptEntry(v1.state, factualDomain("worse.example"), new Date(now.getTime() + 1000));
    const v2 = release(group, second.state, new Date(now.getTime() + 2000));
    const fingerprint = group.keys.keyId.match(/.{4}/g).slice(0, 8).join(" ");
    await import("../src/main.js");
    await app.whenReady();
    let window;
    for (let i = 0; i < 300; i++) {
      window = BrowserWindow.getAllWindows()[0];
      if (window && !window.webContents.isLoading()) break;
      await pause(20);
    }
    const run = (expression) => window.webContents.executeJavaScript(expression);
    const until = async (expression) => {
      for (let i = 0; i < 300; i++) { if (await run(expression)) return; await pause(30); }
      throw new Error(`GUI timed out: ${expression} ${await run('document.getElementById("form-error")?.textContent || ""')}`);
    };
    const click = (selector) => run(`document.querySelector(${JSON.stringify(selector)}).click()`);
    const fill = (name, value) => run(`(() => { const field = document.querySelector('#edit-form [name="${name}"]'); field.value = ${JSON.stringify(value)}; field.dispatchEvent(new Event("input", { bubbles: true })); })()`);
    const check = (name) => run(`document.querySelector('#edit-form [name="${name}"]').checked = true`);
    const submit = () => run('document.getElementById("edit-form").requestSubmit()');
    const status = async () => (await run('window.weft.execute("lists.status", {})'));
    await until('document.getElementById("content")?.textContent.includes("Make room")');

    // Settings leads to the management screen; nothing is subscribed yet.
    await click("#settings-button");
    await click('[data-action="manage-lists"]');
    await until('document.getElementById("lists-panel")?.textContent.includes("No community lists")');
    await click('[data-action="lists-subscribe"]');
    await until('document.getElementById("dialog-title")?.textContent === "Subscribe to a community list"');
    assert.equal(await run('document.getElementById("dialog").classList.contains("trusted")'), true, "list decisions use the trusted browser surface");
    await fill("id", "safety");
    await fill("publicKey", group.keys.publicKey);
    await fill("data", v1.data);
    await fill("mode", "block");
    await submit();
    // The preview names the key fingerprint and every newly blocked domain; nothing is stored yet.
    await until('document.getElementById("dialog-title")?.textContent === "Review before subscribing"');
    const preview = await run('document.getElementById("dialog-content").textContent');
    assert.match(preview, new RegExp(fingerprint));
    assert.match(preview, /Newly blocked\s*bad\.example/);
    assert.match(preview, /Factual claim/);
    assert.deepEqual(await status(), [], "previewing never subscribes");
    await submit();
    assert.equal(await run('document.getElementById("dialog").open'), true, "the fingerprint comparison must be acknowledged");
    await check("acknowledge");
    await submit();
    await until('document.getElementById("lists-panel")?.textContent.includes("Signature verified")');
    let [subscription] = await status();
    assert.equal(subscription.mode, "block");
    assert.equal(subscription.current.sequence, 1);
    assert.equal(subscription.publisher.fingerprint, fingerprint);
    assert.equal((await run('window.weft.execute("siteRules.explain", { url: "https://bad.example/" })')).decision, "block");

    // A newer release is reviewed (diff, newly blocked) and applied by its confirmed digest.
    await click('[data-action="lists-update"]');
    await until('document.getElementById("dialog-title")?.textContent === "Update from a file"');
    await fill("data", v2.data);
    await submit();
    await until('document.getElementById("dialog-title")?.textContent === "Review the update"');
    const update = await run('document.getElementById("dialog-content").textContent');
    assert.match(update, /Sequence 1 → 2/);
    assert.match(update, /Newly blocked\s*worse\.example/);
    assert.equal((await status())[0].current.sequence, 1, "previewing an update applies nothing");
    await check("acknowledge");
    await submit();
    await until('document.querySelector(".list-card")?.textContent.includes("Sequence 2")');

    // A visible exception stops the list for one site; the matches tool shows why.
    await click('[data-action="lists-exception-add"]');
    await until('document.getElementById("dialog-title")?.textContent === "Add an exception"');
    await fill("hostname", "bad.example");
    await fill("reason", "My own test site");
    await submit();
    await until('document.querySelector(".exception-list")?.textContent.includes("bad.example")');
    assert.notEqual((await run('window.weft.execute("siteRules.explain", { url: "https://bad.example/" })')).decision, "block");
    await run('(() => { const form = document.getElementById("lists-match-form"); form.querySelector("[name=url]").value = "https://bad.example/"; form.requestSubmit(); })()');
    await until('document.getElementById("lists-matches")?.textContent.includes("per-site exception")');
    await click('[data-action="lists-exception-remove"]');
    await until('!document.querySelector(".exception-list")');

    // Rollback restores the previous verified release; mode changes re-materialise rules.
    await click('[data-action="lists-rollback"]');
    await until('document.getElementById("dialog-title")?.textContent === "Roll back this list?"');
    await submit();
    await until('document.querySelector(".list-card")?.textContent.includes("(rolled back)")');
    [subscription] = await status();
    assert.equal(subscription.current.sequence, 1);
    assert.equal(subscription.highWater, 2);
    await click('[data-action="lists-configure"]');
    await until('document.getElementById("dialog-title")?.textContent.startsWith("Change")');
    await fill("mode", "label");
    await submit();
    await until('document.querySelector(".list-card")?.textContent.includes("Label only")');
    assert.equal((await run('window.weft.execute("siteRules.explain", { url: "https://bad.example/" })')).decision, "allow");

    await click('[data-action="lists-unsubscribe"]');
    await until('document.getElementById("dialog-title")?.textContent === "Unsubscribe from this list?"');
    await submit();
    await until('document.getElementById("lists-panel")?.textContent.includes("No community lists")');
    assert.deepEqual(await status(), []);

    // Agent input serialization settings (#9).
    await click("#settings-button");
    await click('[data-action="automation-settings"]');
    await until('document.getElementById("dialog-title")?.textContent === "Agent input"');
    await fill("inputConcurrency", "exclusive");
    await fill("queueLimit", "25");
    await submit();
    await pause(200);
    assert.equal(await run('document.getElementById("dialog").open && !document.querySelector("#edit-form [name=queueLimit]").validity.valid'), true, "out-of-range values are refused before saving");
    await fill("queueLimit", "3");
    await fill("queueSeconds", "2.5");
    await submit();
    await until('!document.getElementById("dialog").open');
    assert.deepEqual((await run('window.weft.execute("settings.get", {})')).automation, { inputConcurrency: "exclusive", queueLimit: 3, queueTimeoutMs: 2500 });
    await click('[data-action="automation-settings"]');
    await until('document.getElementById("dialog-title")?.textContent === "Agent input"');
    assert.equal(await run('document.querySelector("#edit-form [name=inputConcurrency]").value'), "exclusive", "the dialog shows the saved setting");
    console.log("WEFT_GUI_LISTS_OK");
    app.quit();
  })().catch((error) => { console.error(error); app.exit(1); });
} else {
  test("community list and agent input screens drive the shared commands as the human", {
    timeout: 90000,
    skip: process.platform === "linux" && !process.env.DISPLAY ? "Requires DISPLAY or xvfb-run" : false,
  }, async () => {
    const profile = mkdtempSync(join(tmpdir(), "weft-gui-lists-"));
    const reservation = createServer();
    await new Promise((r) => reservation.listen(0, "127.0.0.1", r));
    const port = reservation.address().port;
    await new Promise((r) => reservation.close(r));
    const child = spawn(electron, ["--no-sandbox", "--disable-gpu", fileURLToPath(import.meta.url), "--gui-lists"], {
      env: electronEnv({ WEFT_TEST_PROFILE: profile, WEFT_PORT: String(port), WEFT_TOKEN: "gui-lists-token-0123456789abcdef" }),
      stdio: ["ignore", "pipe", "pipe"],
    });
    let output = "";
    child.stdout.on("data", (x) => (output += x));
    child.stderr.on("data", (x) => (output += x));
    const timer = setTimeout(() => child.kill("SIGKILL"), 85000);
    try {
      const code = await new Promise((resolve, reject) => { child.on("exit", resolve); child.on("error", reject); });
      assert.equal(code, 0, output.slice(-4000));
      assert.match(output, /WEFT_GUI_LISTS_OK/);
    } finally {
      clearTimeout(timer);
      rmSync(profile, { recursive: true, force: true });
    }
  });
}
