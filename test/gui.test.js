import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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
    const api = async (command, args) => (await fetch(`http://127.0.0.1:${process.env.WEFT_PORT}/v1/execute`, { method: "POST", headers: { authorization: "Bearer gui-fixture-token", "content-type": "application/json" }, body: JSON.stringify({ command, args }) })).json();
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
      const response = await fetch(`http://127.0.0.1:${process.env.WEFT_PORT}/v1/execute`, { method: "POST", headers: { authorization: "Bearer gui-fixture-token", "content-type": "application/json" }, body: JSON.stringify({ command: "materials.create", args }) });
      return { status: response.status, ...(await response.json()) };
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
