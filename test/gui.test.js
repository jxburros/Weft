import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import electron from "electron";
import { netscapeFile } from "./fixtures/browsing-data.mjs";
import { electronEnv } from "../scripts/electron-env.js";

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
      if (request.url === "/checkout")
        return response.end('<!doctype html><title>Checkout</title><main><p>Tax <span id="tax">$4.00</span></p><p>Total <span id="total">$49.99</span></p><button id="pay">Pay $49.99</button></main>');
      response.end(
        "<!doctype html><title>Reference fixture</title><main><h1>A useful reference</h1><p>Evidence saved for the project.</p><pre>&lt;script&gt;window.evil=true&lt;/script&gt;</pre></main>",
      );
    });
    await new Promise((resolve) => fixture.listen(0, "127.0.0.1", resolve));
    const origin = `http://127.0.0.1:${fixture.address().port}`;
    // A previous run was killed while a runtime task's external click was in flight (#8, #58).
    const { WorkspaceService } = await import("../src/workspace.js");
    const seed = new WorkspaceService({ directory: join(process.env.WEFT_TEST_PROFILE, "workspace-data") });
    const home = seed.activeWorkspaceId;
    const recovery = await seed.execute("workspaces.create", { name: "Recovery" });
    await seed.execute("workspaces.switch", { id: home });
    const seeded = await seed.execute("tasks.create", { workspaceId: recovery.id, title: "Submit supplier order", plan: [
      { id: "s1", kind: "command", title: "Click place order", command: "page.click", args: { selector: "#place-order" } },
      { id: "s2", kind: "review", title: "Confirm the order number" }] });
    await seed.mutateTask(seeded.id, (record, service) => {
      record.executor = { type: "runner", autonomy: "scoped" };
      record.run = { cursor: 0, steps: { s1: { phase: "running", attempts: 1 } }, startedAt: new Date().toISOString() };
      record.operations = [{ id: "op_00000000-0000-4000-8000-000000000001", stepId: "s1", kind: "command", command: "page.click", external: true, status: "attempted", attemptedAt: new Date().toISOString() }];
      service.transitionTask(record, "running", { actor: "human", reason: "started" });
    });
    seed.close();
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
    // Workspace editing stays open across background polls and persists the new fields.
    await click('[data-action="workspace-menu"]');
    await until('document.querySelector(\'[data-action="edit-workspace"]\') !== null');
    await click('[data-action="edit-workspace"]');
    await fill('memory', 'Remember this across polls');
    await fill('instructions', 'Use concise prose');
    await new Promise(resolve => setTimeout(resolve, 3400));
    assert.equal(await run('document.getElementById("dialog").open'), true);
    assert.equal(await run('document.querySelector(\'[name="memory"]\').value'), 'Remember this across polls');
    await submit();
    await until('!document.getElementById("dialog").open');
    assert.equal(await run('(async()=> (await window.weft.execute("workspaces.list", {}))[0].memory)()'), 'Remember this across polls');
    // Startup marked the interrupted external click uncertain; a person records what happened before anything resumes.
    await until('document.getElementById("safety-notices").textContent.includes("unknown outcome")');
    assert.equal((await run(`window.weft.execute("tasks.get", {id: ${JSON.stringify(seeded.id)}})`)).status, "uncertain");
    await click('#safety-notices [data-action="task-detail"]');
    await until('document.getElementById("dialog-content")?.textContent.includes("Work with an unknown outcome")');
    await click('[data-action="task-retry"]');
    await until('document.getElementById("dialog-title")?.textContent === "Retry work with an unknown outcome"');
    await click('[data-action="close-dialog"]');
    await click('#safety-notices [data-action="task-detail"]');
    await until('document.querySelector(\'[data-action="task-reconcile"][data-determination="completed"]\') !== null');
    await click('[data-action="task-reconcile"][data-determination="completed"]');
    await until('document.querySelector("[data-action=task-continue]") !== null');
    await click("[data-action=task-continue]");
    await until('document.querySelector(\'[data-action="task-review"][data-decision="approve"]\') !== null');
    await click('[data-action="task-review"][data-decision="approve"]');
    await until(`(async () => (await window.weft.execute("tasks.get", {id: ${JSON.stringify(seeded.id)}})).status === "completed")()`);
    const reconciled = await run(`window.weft.execute("tasks.get", {id: ${JSON.stringify(seeded.id)}})`);
    assert.equal(reconciled.operations[0].determination.source, "human");
    assert.ok(reconciled.timeline.some((entry) => entry.reason === "server_restart_uncertain"));
    await click('[data-action="close-dialog"]');
    await until('!document.getElementById("safety-notices").textContent.includes("unknown outcome")');
    // A parameterized workflow is authored, run with typed parameters and executed as a runtime task.
    await click('[data-section="tasks"]');
    await click('.section-toolbar [data-section="workflows"]');
    await until('document.querySelector("[data-action=new-record][data-kind=workflows]") !== null');
    await click('[data-action="new-record"][data-kind="workflows"]');
    await fill("title", "Note a topic");
    await fill("parameters", "topic:string");
    await fill("steps", JSON.stringify([{ title: "Note {{topic}}", kind: "command", command: "context.create", args: { title: "About {{topic}}", category: "findings" }, reviewRequired: false }]));
    await submit();
    await until('!document.getElementById("dialog").open');
    await until('document.querySelector("[data-action=run-workflow]") !== null');
    await click('[data-action="run-workflow"]');
    await until('document.querySelector(\'#edit-form [name="param:topic"]\') !== null');
    await fill("param:topic", "tides");
    await submit();
    await until('document.querySelector(".task-detail") !== null');
    await until('(async()=> (await window.weft.execute("context.list")).some(c => c.title === "About tides"))()');
    await until('(async()=> (await window.weft.execute("tasks.list")).some(t => t.workflowRun && t.status === "completed"))()');
    await click('[data-action="close-dialog"]');
    await run('(async()=>{ for (const t of await window.weft.execute("tasks.list")) if (t.workflowRun) await window.weft.execute("tasks.delete", {id: t.id}); for (const c of await window.weft.execute("context.list")) await window.weft.execute("context.delete", {id: c.id}); for (const w of await window.weft.execute("workflows.list")) await window.weft.execute("workflows.delete", {id: w.id}); })()');
    await click("#home");
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
    // Structured handoffs are listed with the tasks and can be accepted from the GUI.
    await run(
      'window.weft.execute("handoffs.create", {objective: "Check the saved reference", nextStep: "Review the evidence", to: "human"})',
    );
    await until(
      'document.querySelector("#handoffs")?.textContent.includes("Check the saved reference")',
    );
    await click('#handoffs [data-action="handoff-accept"]');
    await until(
      '(async()=> (await window.weft.execute("handoffs.list"))[0].status==="accepted")()',
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
    // Tab control is framed as an explicit mode in the toolbar.
    await until('document.getElementById("ownership").textContent.startsWith("Available to agents")');
    await run(
      '(async()=> { const tab = (await window.weft.execute("tabs.list")).find(t=>t.active); await window.weft.execute("tabs.setControlMode", {tabId: tab.id, mode: "assist"}); })()',
    );
    await until('document.getElementById("ownership").textContent.startsWith("Assist")');
    await run(
      '(async()=> { const tab = (await window.weft.execute("tabs.list")).find(t=>t.active); await window.weft.execute("tabs.release", {tabId: tab.id}); })()',
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
    // Tab groups (#24): created, assigned and collapsed through accessible controls with text labels.
    await click("#page-more");
    await click('[data-action="show-tabs"]');
    await click('[data-action="new-group"]');
    await fill("name", "Research");
    await run(`document.querySelector('#edit-form [name="color"]').value = "sage"`);
    await submit();
    await until('!document.getElementById("dialog").open');
    await until('document.querySelector(".tab-group")?.textContent.includes("Research") && document.querySelector(".tab-group").textContent.includes("Sage")');
    assert.equal(await run('document.querySelector(".tab-group").getAttribute("role")'), "group");
    await until('(async()=> (await window.weft.execute("tabs.list")).some(t=>t.groupId))()');
    const groupHeader = '.tab-group-header button[data-action="toggle-group"]';
    assert.equal(await run(`document.querySelector('${groupHeader}').getAttribute("aria-expanded")`), "true");
    await click(groupHeader);
    await until(`document.querySelector('${groupHeader}').getAttribute("aria-expanded") === "false" && !document.querySelector(".tab-group .tab")`);
    await click(groupHeader);
    await until('document.querySelector(".tab-group .tab") !== null');
    // Tab search: titles and URLs with ownership, group and task indicators as text.
    await click('[data-action="search-tabs"]');
    await run(`document.getElementById("tab-search-query").value = "reference"; document.getElementById("tab-search-query").dispatchEvent(new Event("input"))`);
    await until('document.querySelector("#tab-search-results .tab-result")?.textContent.includes("Group: Research (Sage)")');
    assert.match(await run('document.querySelector("#tab-search-results .tab-result").textContent'), /Reference fixture.*Available to agents/s);
    await run('document.getElementById("tab-search-query").dispatchEvent(new KeyboardEvent("keydown", {key: "ArrowDown", bubbles: true}))');
    assert.equal(await run('document.activeElement.classList.contains("tab-result")'), true);
    await run("document.activeElement.click()");
    await until('!document.getElementById("dialog").open && document.getElementById("breadcrumb-section").textContent === "Live page"');
    // Resume (#24): pinned resources and the last section are saved for this workspace.
    await click('[data-section="materials"]');
    await click('[data-action="pin-resource"][data-kind="material"]');
    await until('(async()=> (await window.weft.execute("resume.get", {})).pinned.length === 1)()');
    await until('(async()=> (await window.weft.execute("resume.get", {})).view.section === "materials")()');
    await click("#home");
    await until('document.getElementById("resume-panel")?.hidden === false && document.getElementById("resume-panel").textContent.includes("Research notes")');
    // Browsing-data import (#24): preview first, never passwords or sessions, then import.
    const bookmarkFile = netscapeFile(process.env.WEFT_TEST_PROFILE);
    await click("#settings-button");
    await until('document.getElementById("display-panel")?.textContent.includes("Window shown")');
    await click('[data-action="import-browsing"]');
    await until('document.getElementById("dialog-title")?.textContent === "Import bookmarks and history"');
    assert.match(await run('document.getElementById("dialog-content").textContent'), /Never imported: Passwords/);
    await run(`document.querySelector('#dialog-content input[name="source"][value="file"]').checked = true; document.querySelector('#dialog-content input[name="path"]').value = ${JSON.stringify(bookmarkFile)}; document.querySelector('#dialog-content select[name="kind"]').value = "netscape-html"`);
    await click('[data-action="preview-browsing"]');
    await until('document.getElementById("browsing-preview")?.textContent.includes("Bookmarks: 3 found")');
    await click("#confirm-browsing-import");
    await until('!document.getElementById("dialog").open');
    await until('(async()=> (await window.weft.execute("bookmarks.list")).some(b => b.url === "https://plain.example.com/"))()');
    // Resource limits (#30) are human settings edited in the same window.
    await click('[data-action="manage-resources"]');
    await until('document.getElementById("dialog-title")?.textContent === "Resource limits"');
    await fill("idleSuspendMinutes", "45");
    await submit();
    await until('(async()=> (await window.weft.execute("settings.get")).resources?.idleSuspendMinutes === 45)()');
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
    // The reply must be durable: the transient streaming bubble also carries the assistant class.
    await until(`document.getElementById("chat-live") === null && document.querySelectorAll("#chat-messages .chat-message.assistant:not(#chat-live)").length === 2`);
    assert.equal(modelRequests.length, 2, "the reviewed message was sent exactly once");
    const attached = JSON.stringify(modelRequests.at(-1));
    assert.match(attached, /Keep this useful source/);
    assert.match(attached, /Evidence saved for the project/);
    assert.doesNotMatch(attached, /image_url/);
    // App proposals require a visible exact approval; accepting changes appearance and records a receipt.
    const currentConversation = (await run('window.weft.execute("conversations.list", {})')).at(-1);
    const currentWorkspace = (await run('window.weft.execute("workspace.snapshot", {})')).activeWorkspaceId;
    await run(`window.weft.execute("conversations.message", {id: ${JSON.stringify(currentConversation.id)}, role: "tool", content: ${JSON.stringify(JSON.stringify({tool: 'propose_action', workspaceId: currentWorkspace, proposal: {title: 'Use dark mode', command: 'settings.update', args: {theme: 'dark'}}}))}})`);
    await until('document.querySelector(\'[data-action="review-action"]\') !== null');
    assert.equal(await run('document.documentElement.dataset.theme'), 'light');
    await click('[data-action="review-action"]');
    await until('document.getElementById("dialog-title").textContent === "Review Ask Weft action"');
    await submit();
    await until('!document.getElementById("dialog").open && document.documentElement.dataset.theme === "dark"');
    assert.ok((await run(`window.weft.execute("conversations.get", {id: ${JSON.stringify(currentConversation.id)}})`)).messages.some(m => m.content.includes('action_receipt')));
    await click('[data-action="close-agent"]');
    await run(`document.getElementById("address").value=${JSON.stringify(origin)};document.getElementById("navigation").requestSubmit()`);
    await until('(async()=> (await window.weft.execute("tabs.list")).find(t=>t.active).title==="Reference fixture")()');
    // Selected-text capture travels through the real page command and requires preview approval.
    await run(`window.weft.execute("page.evaluate", {expression: 'const range = document.createRange(); range.selectNodeContents(document.querySelector("main p")); getSelection().removeAllRanges(); getSelection().addRange(range); true;'})`);
    await until('!document.getElementById("send-to-weft").hidden');
    const beforeInbox = (await run('window.weft.execute("materials.list")')).length;
    await click('#send-to-weft');
    await until('document.getElementById("dialog-title").textContent === "Send to Weft"');
    assert.equal((await run('window.weft.execute("materials.list")')).length, beforeInbox);
    await fill('title', 'Captured selection fixture');
    await submit();
    await until('!document.getElementById("dialog").open');
    const capturedMail = (await run('window.weft.execute("materials.list")')).find(m => m.title === 'Captured selection fixture');
    assert.equal(capturedMail.localOnly, true);
    assert.ok(capturedMail.tags.includes('mailbox'));
    assert.match(capturedMail.content, /Evidence saved for the project/);
    assert.ok(capturedMail.url.startsWith(origin));
    await click('[data-section="mailbox"]');
    await click('[data-action="import-email"]');
    await fill('raw', 'Subject: Forwarded fixture\nFrom: sender@example.com\n\n<script>window.__mailRan = true</script>');
    await submit();
    await until('document.getElementById("content").textContent.includes("Forwarded fixture")');
    await run(`Array.from(document.querySelectorAll('.record-card')).find(el => el.textContent.includes('Forwarded fixture')).querySelector('[data-action="read-email"]').click()`);
    await until('document.getElementById("dialog").open');
    assert.equal(await run('window.__mailRan'), undefined);
    assert.match(await run('document.getElementById("dialog-content").textContent'), /<script>/);
    await click('[data-action="close-dialog"]');
    // Inbox processing creates a draft, with the selected material and retrieval enabled.
    await click('[data-action="read-email"]');
    await click('[data-action="process-inbox"][data-intent="task"]');
    await until('document.getElementById("chat-input")?.value.includes("Propose a task")');
    assert.equal(await run('document.getElementById("retrieve-context").checked'), true);
    assert.match(await run('document.getElementById("chat-attachments").textContent'), /Captured selection fixture/);
    await click('[data-action="close-agent"]');
    await click('#settings-button');
    await click('[data-action="manage-learning"]');
    await until('document.getElementById("dialog-title").textContent === "Learning & memory"');
    await click('[data-action="add-memory"]');
    await until('document.getElementById("dialog-title").textContent === "Add memory"');
    await fill('title', 'Shared preference'); await fill('content', 'Prefer short summaries'); await fill('scope', 'global');
    await submit(); await until('!document.getElementById("dialog").open');
    const savedMemory = (await run('window.weft.execute("memories.list")'))[0];
    assert.equal(savedMemory.scope, 'global');
    await click('[data-action="manage-learning"]');
    await until('document.getElementById("dialog-title").textContent === "Learning & memory"');
    await click('[data-action="edit-memory"]');
    await until('document.getElementById("dialog-title").textContent === "Edit memory"');
    await fill('content', 'Prefer detailed summaries'); await submit(); await until('!document.getElementById("dialog").open');
    assert.equal((await run('window.weft.execute("memories.list")'))[0].content, 'Prefer detailed summaries');
    await click('[data-action="manage-learning"]');
    await until('document.getElementById("dialog-title").textContent === "Learning & memory"');
    await click('[data-action="erase-memory"][data-scope="all"]');
    await submit(); await until('!document.getElementById("dialog").open');
    assert.equal((await run('window.weft.execute("memories.list")')).length, 0);
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
    // #17: review and redact a capture in the GUI: preview first, draw an image region, save a derivative, restrict the original.
    await click("#nav-artifacts, [data-section=artifacts]");
    await until('document.querySelector(\'[data-action="view-artifact"]\') !== null');
    await click('[data-action="view-artifact"]');
    await until('document.querySelector(\'[data-action="redact-version"]\') !== null');
    await click('[data-action="redact-version"]');
    await until('document.getElementById("redact-form") !== null && document.getElementById("redact-image")?.naturalWidth > 0');
    await run('document.querySelector(\'#redact-form [name="literals"]\').value = "Evidence saved"');
    await click("#redact-show");
    await until('document.getElementById("redact-preview").textContent.includes("[REDACTED]")');
    assert.equal(await run('document.querySelector("#redact-preview pre").textContent.includes("Evidence saved")'), false);
    await run('document.getElementById("redact-image").scrollIntoView({ block: "center" })');
    await new Promise((r) => setTimeout(r, 100));
    const box = await run('(() => { const r = document.getElementById("redact-image").getBoundingClientRect(); return { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) }; })()');
    for (const [type, dx, dy] of [["mouseDown", 6, 6], ["mouseMove", 30, 20], ["mouseMove", 60, 40], ["mouseUp", 60, 40]]) {
      window.webContents.sendInputEvent({ type, x: box.x + dx, y: box.y + dy, button: "left", clickCount: 1 });
      await new Promise((r) => setTimeout(r, 30));
    }
    await until('document.getElementById("redact-regions").textContent.includes("px at")');
    await click("#redact-save");
    await until('(async()=>{const [a]=await window.weft.execute("artifacts.list");return a.versions.length===2 && a.versions[0].access==="restricted"})()');
    const redacted = await run('(async()=>{const [a]=await window.weft.execute("artifacts.list");return window.weft.execute("artifacts.get",{id:a.id,versionId:a.versions[1].id})})()');
    assert.equal(redacted.text.includes("Evidence saved"), false);
    assert.deepEqual(redacted.redactions.map((item) => item.type), ["text", "region"]);
    await until('document.querySelector(".artifact-text")?.textContent.includes("[REDACTED]")');
    await click('[data-action="compare-versions"]');
    await until('document.getElementById("compare-form") !== null');
    await run('document.getElementById("compare-form").requestSubmit()');
    await until('document.getElementById("compare-result").textContent.includes("Differences found")');
    await click('[data-action="close-dialog"]');
    // Plugins and browser extensions are managed only through reviewed-scope dialogs.
    await click("#settings-button");
    await until('document.querySelector("[data-action=manage-plugins]")!==null');
    await click('[data-action="manage-plugins"]');
    await until('document.getElementById("dialog-content").textContent.includes("Hook export-format: markdown")');
    await click('[data-action="close-dialog"]');
    const probeSource = join(process.env.WEFT_TEST_PROFILE, "probe-source");
    mkdirSync(probeSource, { recursive: true });
    const probeFiles = JSON.parse(readFileSync(new URL("./fixtures/extensions.json", import.meta.url), "utf8")).extensions.probe;
    for (const [file, contents] of Object.entries(probeFiles)) writeFileSync(join(probeSource, file), contents);
    await click('[data-action="manage-extensions"]');
    await until('document.querySelector("[data-action=install-extension]")!==null');
    await click('[data-action="install-extension"]');
    await run(`document.querySelector('#extension-form [name="path"]').value=${JSON.stringify(probeSource)};document.getElementById("extension-form").requestSubmit()`);
    await until('document.getElementById("extension-grant")!==null');
    await run('document.getElementById("extension-grant").requestSubmit()');
    await until('document.getElementById("form-error").textContent.includes("Grant every requested site")');
    await run('document.querySelector("#extension-grant [name=host]").checked=true;document.getElementById("extension-grant").requestSubmit()');
    await until('document.querySelector("[data-action=enable-extension]")!==null');
    await click('[data-action="enable-extension"]');
    await until('document.querySelector("[data-action=disable-extension]")!==null');
    const [installedExtension] = await run('window.weft.execute("extensions.list")');
    assert.equal(installedExtension.loaded, true);
    assert.deepEqual(installedExtension.hostGrants, ["http://127.0.0.1/*"]);
    await click('[data-action="remove-extension"]');
    await until('document.getElementById("dialog-content").textContent.includes("No extensions are installed")');
    await click('[data-action="close-dialog"]');
    await click("#theme-toggle");
    await until('document.documentElement.dataset.theme==="dark"');
    // The dark wordmark is a different image; wait for it to load rather than sampling once.
    await until(
      'document.querySelector(".wordmark img").complete && document.querySelector(".wordmark img").naturalWidth>0',
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
    await click("#settings-button");
    // Semantic search is off until a person configures it; the dialog offers only existing connections.
    await until('document.getElementById("embedding-status")?.textContent.includes("documents searchable by words")');
    await click('[data-action="configure-embeddings"]');
    await until('document.querySelector("#edit-form [name=modelId]") !== null && document.querySelector("#edit-form [name=acknowledgeEgress]") !== null');
    await click('[data-action="close-dialog"]');
    await until('document.querySelector("[data-action=backup-now]")!==null');
    await click('[data-action="backup-now"]');
    await until('document.getElementById("toast").textContent.includes("Backup created and verified")');
    await click('[data-action="manage-backups"]');
    await until('document.getElementById("dialog-content").textContent.includes("Manual backup")');
    await click('[data-action="close-dialog"]');
    // Saved sign-ins: the GUI bridge never accepts a secret argument, and without OS-protected storage
    // (Xvfb has no keyring, so safeStorage reports basic_text) the dialog says so and offers no way to add one.
    await click("#settings-button");
    await click('[data-action="manage-credentials"]');
    await until('document.getElementById("dialog-content")?.textContent.includes("Saved sign-ins")');
    if ((await run('window.weft.execute("credentials.status", {})')).vault === "unprotected") {
      assert.match(await run('document.getElementById("dialog-content").textContent'), /will not store sign-ins/);
      assert.equal(await run('document.querySelector("[data-action=new-credential]")'), null);
    }
    const smuggled = await run('window.weft.executeOutcome("credentials.create", {label: "x", purpose: "y", origins: ["https://example.com"], password: "hunter2"})');
    assert.equal(smuggled.error.code, "invalid_arguments");
    assert.ok(!JSON.stringify(smuggled).includes("hunter2"));
    await click('[data-action="close-dialog"]');
    // Payments (ADR 019): an agent proposes a purchase and the person reviews a dedicated card of Weft-verified terms.
    const api = async (command, args) => (await fetch(`http://127.0.0.1:${process.env.WEFT_PORT}/v1/execute`, { method: "POST", headers: { authorization: "Bearer gui-fixture-token-0123456789abcdef", "content-type": "application/json" }, body: JSON.stringify({ command, args }) })).json();
    const checkoutTab = await api("tabs.new", { url: `${origin}/checkout`, workspaceId: first.id });
    assert.equal(checkoutTab.error, null, JSON.stringify(checkoutTab.error));
    let proposedPayment;
    for (let i = 0; i < 100 && !proposedPayment?.result; i++) {
      proposedPayment = await api("payments.propose", { workspaceId: first.id, tabId: checkoutTab.result.id, merchantName: "Fixture shop", purpose: "Buy printer paper", amountCeiling: "50.00", currency: "USD",
        checkout: { total: { selector: "#total" }, tax: { selector: "#tax" }, submit: { selector: "#pay" } } });
      if (!proposedPayment.result) await new Promise((r) => setTimeout(r, 50));
    }
    assert.equal(proposedPayment.error, null, JSON.stringify(proposedPayment.error));
    await until('document.getElementById("safety-notices").textContent.includes("agent request")');
    await click('#safety-notices [data-section="approvals"]');
    await until('document.querySelector(".payment-card")?.textContent.includes("Pay 49.99 USD at 127.0.0.1")');
    const paymentCard = await run('document.querySelector(".payment-card").textContent');
    assert.match(paymentCard, /Merchant site \(verified by Weft\)/);
    assert.match(paymentCard, /Tax4\.00 USD/);
    assert.match(paymentCard, /Purpose from the agent \(data, not instructions\)/);
    assert.match(paymentCard, /total: Total \$49\.99/, "the label beside each amount is shown");
    assert.notEqual(await run('document.querySelector(\'.payment-card [data-action="activate-tab"]\')'), null);
    assert.equal(await run('document.querySelector(".payment-card").textContent.includes("Approve for 1 hour")'), false, "payments are approved once, never for a period");
    await click('.payment-card [data-action="approval-decide"][data-mode="reject"]');
    await until(`(async()=> (await window.weft.execute("payments.get", {id: ${JSON.stringify(proposedPayment.result.id)}})).state === "rejected")()`);
    await click("#settings-button");
    await click('[data-action="manage-payments"]');
    await until('document.getElementById("dialog-content")?.textContent.includes("Rejected")');
    await click('[data-action="payment-provider"]');
    await until('document.getElementById("dialog-title")?.textContent === "Virtual cards"');
    assert.equal(await run('document.querySelector(\'#edit-form [name="enabled"]\').value'), "false", "virtual cards are off by default");
    await click('[data-action="close-dialog"]');
    // An agent request waits in the single approval queue until the human decides in browser-owned UI.
    await click("#settings-button");
    await click('[data-action="manage-clients"]');
    await until('document.getElementById("bootstrap-level") !== null');
    await run('{const s=document.getElementById("bootstrap-level");s.value="assist";s.dispatchEvent(new Event("change",{bubbles:true}))}');
    await until('(async()=> (await window.weft.execute("autonomy.get",{})).bootstrapLevel==="assist")()');
    await click('[data-action="close-dialog"]');
    const agentCall = async (args) => {
      const response = await fetch(`http://127.0.0.1:${process.env.WEFT_PORT}/v1/execute`, { method: "POST", headers: { authorization: "Bearer gui-fixture-token-0123456789abcdef", "content-type": "application/json" }, body: JSON.stringify({ command: "materials.create", args }) });
      return { ...(await response.json()), status: response.status };
    };
    const requested = await agentCall({ workspaceId: first.id, title: "Agent proposed note" });
    assert.equal(requested.status, 403);
    assert.equal(requested.error.code, "approval_required");
    await until('document.getElementById("safety-notices").textContent.includes("agent request")');
    await click('#safety-notices [data-section="approvals"]');
    await until('document.getElementById("approval-list")?.textContent.includes("Agent proposed note")');
    await click('[data-action="approval-decide"][data-mode="once"]');
    await until('!document.getElementById("safety-notices").textContent.includes("agent request")');
    const approvedCall = await agentCall({ workspaceId: first.id, title: "Agent proposed note" });
    assert.equal(approvedCall.error, null, JSON.stringify(approvedCall.error));
    await click('[data-section="activity"]');
    await until('document.getElementById("activity-entries")?.textContent.includes("materials.create")');
    await run('{const s=document.getElementById("activity-type");s.value="approval";s.dispatchEvent(new Event("change",{bubbles:true}))}');
    await until('document.getElementById("activity-entries").textContent.includes("Waiting for approval")');
    await click('[data-action="activity-settings"]');
    await until('document.getElementById("activity-integrity")?.textContent.includes("chain intact")');
    // Browser-owned storage modes, security status and rule explanations.
    await run('window.weft.execute("storage.setSiteMode", {hostname: "example.com", mode: "session"})');
    await click("#privacy-button");
    await until('document.getElementById("storage-policy")?.textContent.includes("example.com") && document.getElementById("threat-status")?.textContent.includes("Reputation provider")');
    await click('[data-action="storage-mode"][data-host="example.com"][data-mode="default"]');
    await until('!document.getElementById("storage-policy").textContent.includes("example.com")');
    await click('[data-action="storage-coverage"]');
    await until('document.querySelector(".coverage-table")?.textContent.includes("IndexedDB")');
    await click('[data-action="close-dialog"]');
    await click('[data-action="explain-url"]');
    await fill("url", "https://xn--bcher-kva.example/");
    await submit();
    await until('document.getElementById("dialog-title")?.textContent === "Why this outcome" && document.getElementById("dialog-content").textContent.includes("bücher.example")');
    await click('[data-action="close-dialog"]');
    // A source run reports its real update state and offers no network check.
    await click("#settings-button");
    await click('[data-section="updates"]');
    await until(
      'document.getElementById("update-center")?.textContent.includes("Running from source")',
    );
    assert.equal(
      await run('document.querySelector("[data-action=check-updates]").disabled'),
      true,
    );
    const updateCheck = await run(
      'window.weft.executeOutcome("update.check", {})',
    );
    assert.equal(updateCheck.error.code, "unavailable");
    assert.match(updateCheck.error.message, /source/);
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
          env: electronEnv({
            WEFT_TEST_PROFILE: profile,
            WEFT_PORT: String(port),
            WEFT_TOKEN: "gui-fixture-token-0123456789abcdef",
          }),
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
