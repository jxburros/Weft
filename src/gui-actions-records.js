/**
 * Material, task, memory, inbox, mailbox, review and workflow actions.
 * Moved from the act() switch in src/gui.js (#119). Each handler receives the clicked button and its
 * data-action, data-id and data-kind; `g` holds live bindings to gui.js state and helpers.
 */
let g;

const handlers = {
  "new-material": async (button, a, id, kind) => {
    g.editRecord("materials");
  },
  "new-task": async (button, a, id, kind) => {
    g.editRecord("tasks");
  },
  "new-record": async (button, a, id, kind) => {
    g.editRecord(kind);
  },
  "edit-record": async (button, a, id, kind) => {
    if (kind === "tasks" && g.records("tasks").find((t) => t.id === id)?.executor) await g.taskDetail(id);
    else g.editRecord(kind, id);
  },
  "edit-task-record": async (button, a, id, kind) => {
    g.closeDialog();
    g.editRecord("tasks", id);
  },
  "task-detail": async (button, a, id, kind) => {
    await g.taskDetail(id);
  },
  "task-start": async (button, a, id, kind) => {
    await g.startTaskDialog(id);
  },
  "task-pause": async (button, a, id, kind) => {
    const paused = await g.execute("tasks.pause", { id });
    if (paused.submitted?.length) g.toast(`Paused. ${paused.submitted.length} step already submitted will be recorded when it returns.`);
    if (g.$("dialog").open) await g.taskDetail(id);
  },
  "task-continue": async (button, a, id, kind) => {
    await g.execute("tasks.continue", { id, ...(button.dataset.ack ? { disclosureAck: true } : {}) });
    await g.taskDetail(id);
  },
  "task-cancel": async (button, a, id, kind) => {
    await g.execute("tasks.cancel", { id, note: "Cancelled by you" });
    await g.taskDetail(id);
  },
  "task-redirect": async (button, a, id, kind) => {
    await g.redirectDialog(id);
  },
  "task-reassign": async (button, a, id, kind) => {
    await g.reassignDialog(id);
  },
  "task-review": async (button, a, id, kind) => {
    await g.execute("tasks.review", { id, stepId: button.dataset.step, decision: button.dataset.decision });
    await g.taskDetail(id);
  },
  "task-review-edit": async (button, a, id, kind) => {
    const t = await g.execute("tasks.get", { id }, true);
    g.formDialog(
      "Edit remaining steps",
      `<p>The edited steps replace this review point and every step after it, then the task continues.</p>${g.area("Steps (JSON)", "steps", g.stepsJson(t.plan.slice(t.run.cursor)), true)}${g.field("Note", "note", "")}`,
      async (values) => {
        await g.execute("tasks.review", { id, stepId: button.dataset.step, decision: "edit", steps: g.parseStepsJson(values.steps), ...(values.note ? { note: values.note } : {}) });
        await g.taskDetail(id);
      },
      { save: "Save and approve", wide: true },
    );
  },
  "task-reconcile": async (button, a, id, kind) => {
    const result = await g.execute("tasks.reconcile", { id, operationId: button.dataset.op, determination: button.dataset.determination });
    if (result.determination.status === "unknown") g.toast(`The recorded lookup could not tell: ${result.determination.detail || "no final status"}. Check the destination yourself.`);
    await g.taskDetail(id);
  },
  "task-retry": async (button, a, id, kind) => {
    const t = g.records("tasks").find((r) => r.id === id);
    g.retryDialog(id, button.dataset.step, t?.status === "uncertain" || Boolean(button.dataset.op));
  },
  "task-credential-grant": async (button, a, id, kind) => {
    g.formDialog(
      "Let this task use a saved sign-in",
      `<p>The task may fill this one saved sign-in on its authorized sites without asking each time, for a limited number of uses. Agents never see the password.</p>${g.field("Uses (1–20)", "uses", "1", "number", true)}${g.field("For how many minutes", "minutes", "60", "number", true)}`,
      async (values) => {
        await g.execute("credentials.grantTask", { id: button.dataset.credential, taskId: id, uses: Number(values.uses), minutes: Number(values.minutes) });
        await g.execute("tasks.continue", { id, note: "Granted a saved sign-in" });
        await g.taskDetail(id);
      },
      { save: "Grant and continue", trusted: "Sign-in grant" },
    );
  },
  "task-parameters": async (button, a, id, kind) => {
    g.parametersDialog(id, (button.dataset.names || "").split(",").filter(Boolean));
  },
  "manage-learning": async (button, a, id, kind) => {
 await g.manageLearning();
  },
  "configure-learning": async (button, a, id, kind) => {
 await g.configureLearning();
  },
  "add-memory": async (button, a, id, kind) => {
 await g.editMemory();
  },
  "edit-memory": async (button, a, id, kind) => {
 await g.editMemory(id);
  },
  "delete-memory": async (button, a, id, kind) => {
    const { entries } = await g.execute("learning.status", { workspaceId: g.ws().id }, true);
    const memory = entries.find(m => m.id === id);
    if (!memory) throw new Error("Memory no longer exists");
    g.formDialog("Erase memory entry?", `<p>${g.esc(memory.title)}</p><p>The unchanged source revision will not be learned again automatically. Existing conversation copies and backups are separate records.</p>`, async () => {
      await g.execute("memories.delete", { id, expectedRevision: memory.revision }, true);
    }, { save: "Erase entry" });
  },
  "erase-memory": async (button, a, id, kind) => {
    const scope = button.dataset.scope;
    g.formDialog("Erase learned memory?", `<p>This erases ${g.esc(scope)} learned entries and pauses the relevant background learning. Source messages, manual workspace memory, conversations and backups remain separate records.</p>`, async () => {
      await g.execute("learning.erase", { workspaceId: g.ws().id, scope }, true);
    }, { save: "Erase and pause" });
  },
  "capture-selection": async (button, a, id, kind) => {
 await g.captureInbox("selection");
  },
  "capture-expanded": async (button, a, id, kind) => {
 await g.captureInbox('thread');
  },
  "process-inbox": async (button, a, id, kind) => {
 await g.processInbox(id, button.dataset.intent);
  },
  "archive-email": async (button, a, id, kind) => {
    const mail = g.records("materials").find(m => m.id === id);
    await g.execute("materials.update", { id, expectedRevision: mail.revision, changes: { tags: mail.tags.filter(t => !["mailbox", "unread"].includes(t)).concat("archived-mail") } });
;
  },
  "import-email": async (button, a, id, kind) => {
    g.formDialog("Add a forwarded email", '<label>Email file<input id="email-file" type="file" accept=".eml,message/rfc822,text/plain"></label>' + g.area("Or paste the forwarded email (including Subject and From headers)", "raw"), async values => {
      const file = g.$("email-file").files[0];
      if (file && file.size > 450000) throw new Error("Choose an email smaller than 450 KB");
      const raw = file ? await file.text() : values.raw;
      await g.execute("materials.create", g.emailMaterial(raw, { workspaceId: g.ws().id }));
    }, { save: "Add to mailbox", wide: true });
  },
  "read-email": async (button, a, id, kind) => {
    const mail = g.records("materials").find(m => m.id === id && m.tags?.includes("mailbox"));
    if (!mail) throw new Error("Message not found");
    g.openDialog(mail.title, `<p>${g.esc(mail.note)}</p><pre class="tool-result">${g.esc(mail.content)}</pre><div class="inline-actions">${[["summarize", "Summarize"], ["sort", "Sort"], ["remember", "Remember"], ["task", "Make a task"]].map(([intent, label]) => g.action("process-inbox", label, "spark", `data-id="${g.esc(id)}" data-intent="${intent}"`)).join("")}${g.action("archive-email", "Archive", "", `data-id="${g.esc(id)}"`)}</div><p>Agent actions open a draft for your review. Nothing is sent to a model until you send it.</p>`, "", true);
    if (mail.tags.includes("unread")) await g.execute("materials.update", { id, expectedRevision: mail.revision, changes: { tags: mail.tags.filter(t => t !== "unread") } }, true);
  },
  "review-action": async (button, a, id, kind) => {
    const conversation = g.records("conversations").find(c => c.id === g.conversationId);
    const message = conversation?.messages.find(m => m.id === id);
    if (!message) throw new Error("Proposal no longer exists");
    if (conversation.messages.some(m => m.role === "tool" && m.content.includes(`"proposalId":"${id}"`))) throw new Error("This proposal was already decided. Ask for a new proposal if needed.");
    const data = JSON.parse(message.content), p = data.proposal;
    if (data.tool !== "propose_action" || data.workspaceId !== g.ws().id) throw new Error("Proposal belongs to another workspace");
    const targetWorkspace = g.ws().id, targetConversation = conversation.id;
    g.formDialog("Review Ask Weft action", `<p>${g.esc(p.title)}</p><p><strong>${g.esc(p.command)}</strong></p><pre class="tool-result">${g.esc(JSON.stringify(p.args, null, 2))}</pre><p>Approve only if these exact arguments match what you want. This runs once with your authority.</p>`, async () => {
      if (g.ws().id !== targetWorkspace) throw new Error("Workspace changed; review again");
      const outcome = await window.weft.executeOutcome(p.command, p.args);
      await g.execute("conversations.message", { id: targetConversation, role: "tool", content: JSON.stringify({ tool: "action_receipt", proposalId: id, command: p.command, status: outcome.status, ...(outcome.error ? { error: outcome.error.message } : { completed: true }) }) }, true);
      if (outcome.error) throw new Error(outcome.error.message);
      await g.refresh(true); if (g.agentOpen) g.renderMessages();
    }, { save: "Approve and run once", wide: true, trusted: "Your approval applies only to this exact action." });
  },
  "review-proposal": async (button, a, id, kind) => {
    const conversation = g.records("conversations").find((c) => c.messages?.some((m) => m.id === id));
    const message = conversation?.messages.find((m) => m.id === id);
    const proposal = JSON.parse(message.content).proposal;
    g.editRecord("tasks", null, { title: proposal.title, objective: proposal.objective, assignee: "human", plan: (proposal.steps || []).map((s) => ({ kind: "review", title: s.title, ...(s.instruction ? { instruction: s.instruction } : {}) })) });
    g.toast("Review the proposed task. Nothing is created until you save it, and nothing runs until you start it.");
  },
  "record-workflow": async (button, a, id, kind) => {
    const tab = g.active();
    if (!tab || tab.url === "about:blank") { g.toast("Open the page where the workflow starts, then record."); return; }
    const started = await g.execute("workflows.recordStart", { tabId: tab.id }, true);
    g.recordingTab = tab.id;
    await g.refresh(true);
    g.toast(started.notice);
    g.navigateSection("browse");
  },
  "stop-recording": async (button, a, id, kind) => {
    const stopped = await g.execute("workflows.recordStop", { tabId: g.recordingTab }, true);
    g.recordingTab = null;
    await g.refresh(true);
    if (stopped.saved) { g.navigateSection("workflows"); g.editRecord("workflows", stopped.workflow.id); g.toast(`Recorded ${stopped.steps} steps. Typed values were not saved; review and enable the workflow.`); }
    else g.toast("Nothing was recorded.");
  },
  "delete-record": async (button, a, id, kind) => {
    await g.confirmDelete(kind, id);
  },
  "task-state": async (button, a, id, kind) => {
    await g.execute("tasks.transition", {
      id,
      status: button.dataset.state,
      cause: "Changed by you in the workspace",
    });
  },
  "run-workflow": async (button, a, id, kind) => {
    await g.workflowRunDialog(id);
  },
};

/** Bind the handlers to the GUI's shared context and return them by action name. */
export function recordsActions(context) {
  g = context;
  return handlers;
}
