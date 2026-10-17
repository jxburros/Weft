import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import electron from "electron";

if (process.argv.includes("--gui-workflows")) {
  const { app, BrowserWindow } = electron;
  app.setPath("userData", process.env.WEFT_TEST_PROFILE);
  let fixture;
  const modelRequests = [];
  (async () => {
    fixture = createServer(async (request, response) => {
      if (request.url === "/v1/chat/completions") {
        let body = "";
        for await (const chunk of request) body += chunk;
        modelRequests.push(JSON.parse(body));
        // Stream like a real OpenAI-compatible server so the GUI renders deltas before the reply is saved.
        response.writeHead(200, { "content-type": "text/event-stream" });
        const frame = (value) => response.write(`data: ${JSON.stringify(value)}\n\n`);
        frame({ choices: [{ index: 0, delta: { content: "A real fixture " } }] });
        await new Promise((resolve) => setTimeout(resolve, 400));
        frame({ choices: [{ index: 0, delta: { content: "response from your selected endpoint." } }] });
        frame({ choices: [{ index: 0, delta: {}, finish_reason: "stop" }] });
        frame({ choices: [], usage: { prompt_tokens: 15, completion_tokens: 10 } });
        response.end("data: [DONE]\n\n");
        return;
      }
      response.setHeader("content-type", "text/html");
      response.end(
        "<!doctype html><title>Reference fixture</title><main><h1>A useful reference</h1><p>Evidence saved for the project.</p><pre>&lt;script&gt;window.evil=true&lt;/script&gt;</pre></main>",
      );
    });
    await new Promise((resolve) => fixture.listen(0, "127.0.0.1", resolve));
    const origin = `http://127.0.0.1:${fixture.address().port}`;
    await import("../src/main.js");
    await app.whenReady();
    let window;
    for (let i = 0; i < 200; i++) {
      window = BrowserWindow.getAllWindows()[0];
      if (window && !window.webContents.isLoading()) break;
      await new Promise((r) => setTimeout(r, 20));
    }
    const run = async (expression) => {
      try {
        return await window.webContents.executeJavaScript(expression);
      } catch (e) {
        throw new Error(expression + " : " + e.message);
      }
    };
    window.webContents.on("console-message", (_e, _l, message) =>
      console.log("RENDERER", message),
    );
    const until = async (expression) => {
      for (let i = 0; i < 160; i++) {
        if (await run(expression)) return;
        await new Promise((r) => setTimeout(r, 30));
      }
      throw new Error(
        "GUI timed out: " +
          expression +
          " STATUS: " +
          (await run('document.getElementById("status").textContent')),
      );
    };
    const click = (selector) =>
      run(`document.querySelector(${JSON.stringify(selector)}).click()`);
    const fill = (name, value) =>
      run(
        `document.querySelector('#edit-form [name="${name}"]').value=${JSON.stringify(value)}`,
      );
    const submit = () =>
      run('document.getElementById("edit-form").requestSubmit()');
    await until(
      'document.getElementById("content")?.textContent.includes("Make room")',
    );
    assert.equal(
      await run('document.querySelector(".workspace-dot").textContent'),
      "W",
    );
    if (process.env.WEFT_SAVE_SCREENSHOTS)
      writeFileSync(
        "artifacts/weft-overview.png",
        (await window.webContents.capturePage()).toPNG(),
      );
    await click("#new-tab");
    await until(
      '(async()=> (await window.weft.execute("tabs.list")).length===2)()',
    );
    await until(
      'document.getElementById("content").textContent.includes("Where would you")',
    );
    await click("#home");
    await until('document.querySelector("[data-action=new-task]")!==null');
    await click('[data-action="new-material"]');
    assert.equal(await run('document.getElementById("dialog").open'), true);
    await fill("title", "Research notes");
    await fill("content", "Keep this useful source and its assumptions.");
    await submit();
    await until('!document.getElementById("dialog").open');
    assert.equal(
      (await run('window.weft.execute("materials.list")'))[0].title,
      "Research notes",
    );
    await click('[data-action="new-task"]');
    await fill("title", "Review the saved reference");
    await fill("objective", "Compare the evidence.");
    await submit();
    await until('!document.getElementById("dialog").open');
    await click('[data-section="tasks"]');
    await click('[data-action="task-state"]');
    await until(
      '(async()=> (await window.weft.execute("tasks.list"))[0].status==="completed")()',
    );
    await click('[data-section="context"]');
    await click('[data-action="new-record"]');
    await fill("title", "Working principle");
    await fill("content", "Preserve exact sources.");
    await fill("category", "confirmed");
    await submit();
    await until('!document.getElementById("dialog").open');
    await run(
      `document.getElementById('address').value=${JSON.stringify(origin)};document.getElementById('navigation').requestSubmit()`,
    );
    await until(
      '(async()=> (await window.weft.execute("tabs.list")).find(t=>t.active).title==="Reference fixture")()',
    );
    await click("#save-page");
    await until('document.getElementById("dialog").open && document.getElementById("dialog-title").textContent === "Save page to workspace"');
    await fill("title", "Saved source");
    await fill("note", "Fixture evidence for the capture test.");
    await submit();
    await until(
      '(async()=> (await window.weft.execute("artifacts.list")).length===1)()',
    );
    await until(
      'document.getElementById("content").textContent.includes("Saved source")',
    );
    const saved = await run(
      '(async()=>{const [a]=await window.weft.execute("artifacts.list");return window.weft.execute("artifacts.get",{id:a.id})})()',
    );
    assert.match(saved.versions[0].text, /Evidence saved/);
    assert.ok(
      saved.versions[0].pngBase64,
      "capture contains a real screenshot after modal closes",
    );
    await click('[data-action="view-artifact"]');
    await until('document.querySelector(".artifact-text") !== null');
    await until('document.querySelector(".artifact-image")?.naturalWidth > 0');
    assert.match(
      await run('document.querySelector(".artifact-text").textContent'),
      /<script>/,
    );
    assert.equal(
      await run("globalThis.evil"),
      undefined,
      "artifact text does not execute",
    );
    assert.equal(
      await run('document.querySelector(".artifact-image").naturalWidth > 0'),
      true,
    );
    await click('[data-action="close-dialog"]');
    await click("#settings-button");
    await click('[data-action="new-model"]');
    await fill("name", "Local fixture");
    await fill("endpoint", `${origin}/v1`);
    await fill("model", "fixture-model");
    await submit();
    await until('!document.getElementById("dialog").open');
    await click("#agent-toggle");
    const model = (await run('window.weft.execute("models.list")')).find(
      (m) => m.name === "Local fixture",
    );
    await run(
      `document.getElementById('chat-model').value=${JSON.stringify(model.id)};document.getElementById('chat-model').dispatchEvent(new Event('change'));document.getElementById('chat-input').value='Help organize this project.';document.getElementById('chat-form').requestSubmit()`,
    );
    await until('document.getElementById("chat-live")?.textContent.includes("A real fixture")');
    assert.equal(
      await run('document.getElementById("chat-messages").textContent.includes("selected endpoint")'),
      false,
      "the streamed delta is visible before the reply completes",
    );
    await until(
      'document.getElementById("chat-messages").textContent.includes("A real fixture response")',
    );
    await until('document.getElementById("chat-live") === null');
    assert.match(
      await run('document.getElementById("model-destination").textContent'),
      /127.0.0.1.*on-device endpoint.*Text only/,
    );
    await until('document.querySelector(".message-usage")?.textContent.includes("15 in / 10 out tokens (reported by provider)")');
    assert.equal(modelRequests[0].stream, true);
    // Attach a stored note and an exact capture version; the text-only model cannot take the image.
    await click('[data-action="attach-chat"]');
    await until('document.getElementById("attach-selected") !== null');
    await run('for (const box of document.querySelectorAll(\'#dialog-content input[name="attach"]\')) if (/Research notes|Saved source/.test(box.parentElement.textContent)) box.checked = true;');
    await click("#attach-selected");
    await until('document.querySelectorAll("#chat-attachments .tag").length === 2');
    await run(
      `document.getElementById('chat-input').value='Use the attachments.';document.getElementById('chat-form').requestSubmit()`,
    );
    await until('document.getElementById("acknowledge-disclosure") !== null');
    assert.equal(await run('document.getElementById("acknowledge-disclosure").disabled'), true, "image items for a text-only model block sending");
    assert.match(await run('document.getElementById("dialog-content").textContent'), /does not accept image input/);
    await run('for (const box of document.querySelectorAll("#dialog-content .disclosure-item")) if (box.value.endsWith(":image")) box.checked = false;');
    await click("#update-disclosure");
    await until('document.getElementById("acknowledge-disclosure")?.disabled === false');
    assert.match(await run('document.getElementById("dialog-content").textContent'), /excluded by you/);
    await click("#acknowledge-disclosure");
    await until(`document.querySelectorAll("#chat-messages .chat-message.assistant").length === 2`);
    const attached = JSON.stringify(modelRequests.at(-1));
    assert.match(attached, /Keep this useful source/);
    assert.match(attached, /Evidence saved for the project/);
    assert.doesNotMatch(attached, /image_url/);
    await click("#add-workspace");
    await fill("name", "Second workspace");
    await submit();
    await until(
      'document.getElementById("workspace-name").textContent==="Second workspace"',
    );
    assert.deepEqual(await run('window.weft.execute("materials.list")'), []);
    const first = (await run('window.weft.execute("workspaces.list")')).find(
      (w) => w.name === "My workspace",
    );
    await click(`[data-action="switch-workspace"][data-id="${first.id}"]`);
    await until(
      'document.getElementById("workspace-name").textContent==="My workspace"',
    );
    assert.equal(
      (await run('window.weft.execute("artifacts.list")')).length,
      1,
    );
    await click("#theme-toggle");
    await until('document.documentElement.dataset.theme==="dark"');
    assert.ok(
      await run(
        'document.querySelector(".wordmark img").complete && document.querySelector(".wordmark img").naturalWidth>0',
      ),
    );
    await new Promise((resolve) => setTimeout(resolve, 180));
    if (process.env.WEFT_SAVE_SCREENSHOTS)
      writeFileSync(
        "artifacts/weft-dark.png",
        (await window.webContents.capturePage()).toPNG(),
      );
    await click("#theme-toggle");
    await click('[data-action="close-agent"]');
    await click("#search-button");
    await run(
      'document.getElementById("palette-query").value="Research notes";document.getElementById("palette-query").dispatchEvent(new Event("input"))',
    );
    await until(
      'document.getElementById("palette-results").textContent.includes("Research notes")',
    );
    await click('[data-action="close-dialog"]');
    window.setSize(1000, 700);
    await click("#agent-toggle");
    await new Promise((resolve) => setTimeout(resolve, 180));
    assert.equal(
      await run("document.documentElement.scrollWidth <= innerWidth"),
      true,
      "minimum width has no app overflow",
    );
    if (process.env.WEFT_SAVE_SCREENSHOTS)
      writeFileSync(
        "artifacts/weft-agent.png",
        (await window.webContents.capturePage()).toPNG(),
      );
    console.log("WEFT_GUI_WORKFLOWS_OK");
    fixture.close();
    app.quit();
  })().catch((error) => {
    console.error(error);
    fixture?.close();
    app.exit(1);
  });
} else {
  test(
    "GUI workflows persist records, capture offline evidence, switch workspaces, and chat with an explicit model",
    {
      timeout: 60000,
      skip:
        process.platform === "linux" && !process.env.DISPLAY
          ? "Requires DISPLAY or xvfb-run"
          : false,
    },
    async () => {
      const profile = mkdtempSync(join(tmpdir(), "weft-gui-"));
      const reservation = createServer();
      await new Promise((r) => reservation.listen(0, "127.0.0.1", r));
      const port = reservation.address().port;
      await new Promise((r) => reservation.close(r));
      const child = spawn(
        electron,
        [
          "--no-sandbox",
          "--disable-gpu",
          fileURLToPath(import.meta.url),
          "--gui-workflows",
        ],
        {
          env: {
            ...process.env,
            ELECTRON_RUN_AS_NODE: "",
            WEFT_TEST_PROFILE: profile,
            WEFT_PORT: String(port),
            WEFT_TOKEN: "gui-fixture-token",
          },
          stdio: ["ignore", "pipe", "pipe"],
        },
      );
      let output = "";
      child.stdout.on("data", (x) => (output += x));
      child.stderr.on("data", (x) => (output += x));
      const timeout = setTimeout(() => child.kill("SIGKILL"), 50000);
      try {
        const code = await new Promise((resolve, reject) => {
          child.on("exit", resolve);
          child.on("error", reject);
        });
        assert.equal(code, 0, output);
        assert.match(output, /WEFT_GUI_WORKFLOWS_OK/);
      } finally {
        clearTimeout(timeout);
        rmSync(profile, { recursive: true, force: true });
      }
    },
  );
}
