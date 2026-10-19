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

// The trusted GUI's browser-owned site surfaces (#90, #94, #97): permission prompt, pop-up indicator, private window entry.
if (process.argv.includes("--gui-site")) {
  const { app, BrowserWindow, webContents } = electron;
  app.setPath("userData", process.env.WEFT_TEST_PROFILE);
  (async () => {
    const fixture = createServer((request, response) => {
      response.setHeader("content-type", "text/html");
      if (request.url === "/notify") return response.end('<!doctype html><title>notify</title><button id="b" style="position:fixed;left:0;top:0;width:400px;height:300px" onclick="Notification.requestPermission().then(r => document.title = \'notify:\' + r)">go</button>');
      if (request.url === "/spam") return response.end('<!doctype html><title>spam</title><script>setTimeout(() => window.open("/x"), 100)</script>');
      response.end("<!doctype html><title>x</title>");
    });
    await new Promise((resolve) => fixture.listen(0, "127.0.0.1", resolve));
    const origin = `http://127.0.0.1:${fixture.address().port}`;
    await import("../src/main.js");
    await app.whenReady();
    let window;
    for (let i = 0; i < 300 && !(window && !window.webContents.isLoading()); i++) { window = BrowserWindow.getAllWindows()[0]; await new Promise((r) => setTimeout(r, 20)); }
    const run = (expression) => window.webContents.executeJavaScript(expression);
    const until = async (expression, label = expression) => {
      for (let i = 0; i < 300; i++) { if (await run(expression)) return; await new Promise((r) => setTimeout(r, 30)); }
      const state = await run('window.weft.execute("permissions.list", {}).then(r => JSON.stringify({ pending: r.pending, title: document.getElementById("dialog-title")?.textContent, open: document.getElementById("dialog").open, section: document.querySelector(".section-link.active")?.dataset.section }))').catch((e) => e.message);
      throw new Error(`GUI timed out: ${label} ${state} page=${webContents.getAllWebContents().map((c) => c.getURL() + '|' + c.getTitle()).join(',')}`);
    };
    const page = (path) => webContents.getAllWebContents().find((contents) => contents.getURL() === `${origin}${path}`);
    try {
      await until('document.getElementById("content") !== null');
      const open = (path) => run(`document.getElementById("address").value = ${JSON.stringify(`${origin}`)} + ${JSON.stringify(path)}; document.getElementById("navigation").requestSubmit()`);
      await open("/notify");
      let view;
      for (let i = 0; i < 200 && !(view = page("/notify")); i++) await new Promise((r) => setTimeout(r, 25));
      await new Promise((r) => setTimeout(r, 400));
      view.focus();
      view.sendInputEvent({ type: "mouseDown", x: 50, y: 50, button: "left", clickCount: 1 });
      view.sendInputEvent({ type: "mouseUp", x: 50, y: 50, button: "left", clickCount: 1 });
      // The browser-owned prompt opens in the trusted GUI with the site's origin, and the person answers it there.
      await until('document.getElementById("dialog").open && document.getElementById("dialog-title").textContent === "Allow notifications?"', "permission prompt dialog");
      assert.match(await run('document.getElementById("dialog-content").textContent'), /127\.0\.0\.1/);
      assert.ok(await run('Boolean(document.querySelector("#dialog .trusted-band"))'), "trusted-surface band");
      await run('document.querySelector(\'[data-action="perm-respond"][data-decision="allow-always"]\').click()');
      for (let i = 0; i < 200 && view.getTitle() !== "notify:granted"; i++) await new Promise((r) => setTimeout(r, 25));
      assert.equal(view.getTitle(), "notify:granted");
      // Site controls list the remembered decision with a reset button.
      await run('document.getElementById("site-controls").click()');
      await until('document.getElementById("site-permissions-panel")?.textContent.includes("notifications: Allowed")', "site controls decision");
      await run('document.querySelector(\'[data-action="perm-revoke"]\').click()');
      await until('document.getElementById("site-permissions-panel")?.textContent.includes("No decisions for this site")', "decision reset");
      await run('document.querySelector(\'[data-action="close-dialog"]\').click()');
      // A blocked pop-up shows a quiet indicator in the address field.
      await open("/spam");
      await until('document.querySelector(\'#site-indicators [data-action="popups-blocked"]\') !== null', "pop-up indicator");
      await run('document.querySelector(\'#site-indicators [data-action="popups-blocked"]\').click()');
      await until('document.getElementById("dialog-title").textContent === "Pop-ups blocked"');
      await run('document.querySelector(\'[data-action="popup-allow"]\').click()');
      await until('!document.getElementById("dialog").open');
      for (let i = 0; i < 200 && !page("/x"); i++) await new Promise((r) => setTimeout(r, 25));
      assert.ok(page("/x"), "Open once opened the blocked pop-up as a tab");
      // Page tools opens a private window.
      await run('document.getElementById("page-more").click()');
      await run('document.querySelector(\'[data-action="private-window"]\').click()');
      for (let i = 0; i < 200 && !BrowserWindow.getAllWindows().some((w) => /Private window/.test(w.getTitle())); i++) await new Promise((r) => setTimeout(r, 25));
      assert.ok(BrowserWindow.getAllWindows().some((w) => /Private window/.test(w.getTitle())), "private window opened");
      console.log("WEFT_GUI_SITE_OK");
    } finally {
      fixture.closeAllConnections();
      fixture.close();
      app.quit();
    }
  })().catch((error) => { console.error(error); app.exit(1); });
} else {
  test("trusted GUI: permission prompt, site decisions, pop-up indicator and private window entry", { timeout: 90000, skip: process.platform === "linux" && !process.env.DISPLAY ? "Requires DISPLAY or xvfb-run" : false }, async () => {
    const profile = mkdtempSync(join(tmpdir(), "weft-gui-site-"));
    const reservation = createServer();
    await new Promise((r) => reservation.listen(0, "127.0.0.1", r));
    const port = reservation.address().port;
    await new Promise((r) => reservation.close(r));
    const child = spawn(electron, ["--no-sandbox", "--disable-gpu", fileURLToPath(import.meta.url), "--gui-site"], { env: electronEnv({ WEFT_TEST_PROFILE: profile, WEFT_PORT: String(port), WEFT_TOKEN: "gui-site-fixture-token", WEFT_DISABLE_UPDATES: "1" }), stdio: ["ignore", "pipe", "pipe"] });
    let output = "";
    child.stdout.on("data", (x) => (output += x));
    child.stderr.on("data", (x) => (output += x));
    const timeout = setTimeout(() => child.kill("SIGKILL"), 80000);
    try {
      const code = await new Promise((resolve, reject) => { child.on("exit", resolve); child.on("error", reject); });
      assert.equal(code, 0, output);
      assert.match(output, /WEFT_GUI_SITE_OK/);
    } finally {
      clearTimeout(timeout);
      rmSync(profile, { recursive: true, force: true });
    }
  });
}
