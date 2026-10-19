/**
 * Task detail, executor, plan, redirect/reassign/retry and workflow dialogs.
 * Moved from src/gui.js (#119); `g` holds live bindings to gui.js state and helpers.
 */
let g;
/** Connect these views to the GUI's shared context (called once by gui.js). */
export function bindTasksViews(context) {
  g = context;
}

// ---- Durable tasks, uncertain work and workflows (ADR 016) ---------------------------------
const phaseLabels = { queued: "Queued", running: "Running", waiting_on_human: "Waiting for you", paused: "Paused", completed: "Completed", failed: "Failed", cancelled: "Cancelled", uncertain: "Outcome unknown" };
export const phaseLabel = (status) => phaseLabels[status === "waiting" ? "waiting_on_human" : status] || status;
const unresolvedOps = (t) => (t.operations || []).filter((op) => ["attempted", "uncertain"].includes(op.status) && !["completed", "not_completed", "unknown"].includes(op.determination?.status));
export const needsAttention = (t) => t.status === "uncertain" || unresolvedOps(t).some((op) => op.status === "uncertain") || (t.executor && t.status === "waiting_on_human");
function executorLabel(executor) {
  if (!executor) return "Not running";
  if (executor.type === "client") return `Agent connection ${executor.clientId.slice(0, 8)}`;
  if (executor.type === "automation") return "Automation token";
  return `Weft task runner · ${g.levelLabels[executor.autonomy] || executor.autonomy}`;
}
export function attentionSection() {
  const list = g.records("tasks").filter(needsAttention);
  if (!list.length) return "";
  return `<section class="settings-section attention" aria-labelledby="attention-heading"><div class="section-heading"><h2 id="attention-heading">Needs your attention</h2><span class="muted micro">${list.length} task${list.length === 1 ? "" : "s"}</span></div>${list
    .slice(0, 6)
    .map((t) => `<button class="compact-record" data-action="task-detail" data-id="${g.esc(t.id)}">${g.icon(t.status === "uncertain" ? "shield" : "clock")}<span class="record-text"><strong>${g.esc(t.title)}</strong><small>${g.esc(phaseLabel(t.status))}${t.blocker ? " · " + g.esc(g.short(t.blocker, 90)) : ""}</small></span>${g.icon("chevron")}</button>`)
    .join("")}</section>`;
}
function stepMark(t, step, index) {
  const state = t.run?.steps?.[step.id]?.phase;
  if (state === "completed") return "✓";
  if (state === "uncertain") return "?";
  if (state === "failed") return "✕";
  return index === t.run?.cursor && t.executor ? "▶" : "○";
}
function describeStep(step) {
  if (step.kind === "command") return `${step.command}${step.args?.selector ? ` ${step.args.selector}` : step.args?.url ? ` ${g.host(step.args.url)}` : ""}`;
  if (step.kind === "model") return `Model turn${step.modelId ? ` (${step.modelId})` : ""}`;
  if (step.kind === "handoff") return `Handoff to ${step.to || "human"}`;
  return "Review checkpoint";
}
function blockerActions(t) {
  const b = t.run?.blocker;
  if (!b) return "";
  const attrs = `data-id="${g.esc(t.id)}"`;
  if (["review", "expected_outputs"].includes(b.kind))
    return `<div class="notice">${g.esc(b.message)}${b.instruction ? `<br>${g.esc(b.instruction)}` : ""}${b.expectedOutputs ? `<br>Expected: ${g.esc(b.expectedOutputs)}` : ""}</div><div class="inline-actions">${g.action("task-review", "Approve", "check", `${attrs} data-step="${g.esc(b.stepId)}" data-decision="approve"`, "primary")}${b.kind === "review" ? g.action("task-review-edit", "Edit steps", "note", `${attrs} data-step="${g.esc(b.stepId)}"`) : ""}${g.action("task-review", "Reject", "close", `${attrs} data-step="${g.esc(b.stepId)}" data-decision="reject"`, "secondary danger")}</div>`;
  if (b.kind === "approval") {
    // A sign-in step can instead get a limited task grant for one saved sign-in (ADR 017).
    const step = (t.plan || []).find((s) => s.id === b.stepId);
    let credential = step?.command === "credentials.fill" ? step.args?.id : null;
    const placeholder = /^\{\{\s*(\w+)\s*\}\}$/.exec(credential || "");
    if (placeholder) credential = t.workflowRun?.parameters?.[placeholder[1]] || null;
    return `<div class="notice">${g.esc(b.message)}</div><div class="inline-actions">${g.action("section", "Review requests", "shield", 'data-section="approvals"')}${credential ? g.action("task-credential-grant", "Let this task use the sign-in…", "lock", `${attrs} data-credential="${g.esc(credential)}"`) : ""}</div>`;
  }
  if (b.kind === "disclosure") return `<div class="notice">${g.esc(b.message)}</div><div class="inline-actions">${g.action("task-continue", "Acknowledge destination and continue", "check", `${attrs} data-ack="true"`, "primary")}</div>`;
  if (b.kind === "parameters_required") return `<div class="notice">${g.esc(b.message)}</div><div class="inline-actions">${g.action("task-parameters", "Enter values", "lock", `${attrs} data-names="${g.esc((b.parameters || []).join(","))}"`, "primary")}</div>`;
  if (b.kind === "uncertain") return `<div class="notice">${g.esc(b.message)}</div>`;
  return `<div class="notice">${g.esc(b.message || b.kind)}</div>`;
}
function uncertainReview(t) {
  const ops = unresolvedOps(t).filter((op) => op.status === "uncertain");
  if (!ops.length) return "";
  return `<h3>Work with an unknown outcome</h3><p>Weft does not know whether these actions took effect. Check the destination, then record what happened. Retrying may do the work twice.</p>${ops
    .map((op) => {
      const step = (t.plan || []).find((s) => s.id === op.stepId);
      const attrs = `data-id="${g.esc(t.id)}" data-op="${g.esc(op.id)}"`;
      return `<article class="record-card uncertain-op"><h3>${g.esc(step?.title || op.command)}</h3><p>${g.esc(op.command)} · attempted ${g.esc(new Date(op.attemptedAt).toLocaleString())}${op.error ? ` · ${g.esc(op.error.message)}` : ""}</p><div class="inline-actions">${g.action("task-reconcile", "It happened", "check", `${attrs} data-determination="completed"`)}${g.action("task-reconcile", "It did not happen", "close", `${attrs} data-determination="not_completed"`)}${op.kind === "model" ? g.action("task-reconcile", "Check recorded turn", "search", `${attrs} data-determination="lookup"`) : ""}${g.action("task-retry", "Retry anyway…", "reload", `${attrs} data-step="${g.esc(op.stepId)}"`, "secondary danger")}</div></article>`;
    })
    .join("")}`;
}
export async function taskDetail(id) {
  const t = await g.execute("tasks.get", { id }, true);
  const attrs = `data-id="${g.esc(t.id)}"`;
  const managed = Boolean(t.executor);
  const steps = (t.plan || []).length
    ? `<ol class="step-timeline">${t.plan.map((s, i) => `<li class="${i === t.run?.cursor && managed ? "current" : ""}"><span class="step-mark" aria-hidden="true">${stepMark(t, s, i)}</span><span><strong>${g.esc(s.title)}</strong><small>${g.esc(describeStep(s))}${s.reviewRequired ? " · review first" : ""}${t.run?.steps?.[s.id]?.phase ? " · " + g.esc(t.run.steps[s.id].phase) : ""}</small></span></li>`).join("")}</ol>`
    : "<p>No executable steps. Add steps to run this task, or track it by hand.</p>";
  const history = (t.timeline || []).slice(-25).reverse()
    .map((e) => `<li><small>${g.esc(new Date(e.at).toLocaleString())}</small> ${e.type === "transition" ? `${g.esc(phaseLabel(e.from))} → ${g.esc(phaseLabel(e.to))}` : g.esc(e.type)} · ${g.esc(String(e.reason || e.decision || "").replace(/_/g, " "))} · ${g.esc(e.actor || "")}${e.note ? ` — ${g.esc(g.short(e.note, 160))}` : ""}</li>`)
    .join("");
  const controls = [
    !managed && t.plan?.length && !["completed", "cancelled", "failed", "running", "uncertain"].includes(t.status) ? g.action("task-start", "Start…", "play", attrs, "primary") : "",
    managed && ["running", "waiting_on_human", "queued"].includes(t.status) ? g.action("task-pause", "Pause", "pause", attrs) : "",
    managed && t.status === "paused" ? g.action("task-continue", "Continue", "play", attrs, "primary") : "",
    managed && t.status === "failed" ? g.action("task-retry", "Retry step", "reload", attrs, "primary") : "",
    managed && !["completed", "cancelled", "failed"].includes(t.status) ? g.action("task-redirect", "Redirect…", "arrow", attrs) : "",
    managed ? g.action("task-reassign", "Reassign…", "lock", attrs) : "",
    managed && !["completed", "cancelled"].includes(t.status) ? g.action("task-cancel", "Cancel task", "stop", attrs, "secondary danger") : "",
  ].join("");
  g.openDialog(
    t.title,
    `<div class="task-detail" data-task="${g.esc(t.id)}"><p>${g.stateBadge(t.status, g.esc(phaseLabel(t.status)))} ${g.esc(executorLabel(t.executor))}${managed ? ` · ${Number(t.progress) || 0}%` : ""}${t.workflowRun ? ` · workflow ${g.esc(t.workflowRun.title)}` : ""}</p>${t.objective ? `<p>${g.esc(t.objective)}</p>` : ""}${t.staleness?.stale ? `<div class="notice">Results may be stale: ${g.esc(t.staleness.reasons.join("; "))}</div>` : ""}${blockerActions(t)}${uncertainReview(t)}<h3>Steps</h3>${steps}${t.outputs?.length || t.evidence?.length ? `<p class="muted">Outputs: ${g.esc([...(t.outputs || []), ...(t.evidence || [])].join(", "))}</p>` : ""}<h3>History</h3><ul class="task-history">${history || "<li>No changes yet.</li>"}</ul><p class="muted">Steps run through the same permission checks as any agent command. Accepted page actions are not proof of an external result.</p></div>`,
    controls + g.action("edit-task-record", "Edit record", "note", attrs) + g.action("close-dialog", "Close"),
    true,
  );
  g.openTaskDetail = { id: t.id, revision: t.revision };
}
async function executorField(current) {
  const clients = await g.execute("clients.list", {}, true).catch(() => []);
  const live = clients.filter((c) => !c.revoked && c.expiresAt > Date.now() && c.workspaceIds.includes(g.ws().id));
  const value = current?.type === "client" ? `client|${current.clientId}` : `runner|${current?.autonomy || "scoped"}`;
  return g.choice("Runs as", "executor", [
    ...["observe", "assist", "scoped", "autonomous"].map((level) => [`runner|${level}`, `Weft task runner · ${g.levelLabels[level] || level}`]),
    ...live.map((c) => [`client|${c.clientId}`, `Agent connection: ${c.name}`]),
  ], value);
}
const parseExecutor = (value) => { const [type, rest] = String(value).split("|"); return type === "client" ? { type: "client", clientId: rest } : { type: "runner", autonomy: rest }; };
async function modelField(current) {
  const models = await g.execute("models.list", {}, true).catch(() => []);
  return g.choice("Model for model steps", "modelId", [["", "None"], ...models.map((m) => [m.id, `${m.name} · ${m.model}`])], current || "");
}
export async function startTaskDialog(id) {
  const t = g.records("tasks").find((r) => r.id === id);
  g.formDialog(
    "Start task",
    `<p>Each step runs through the same permission checks and approvals as any agent command. External actions wait for your approval unless the identity you choose may take them.</p><pre class="tool-result">${g.esc(t.plan.map((s, i) => `${i + 1}. ${s.title} — ${describeStep(s)}`).join("\n"))}</pre>${await executorField(null)}${await modelField(t.modelId)}`,
    async (values) => {
      await g.execute("tasks.start", { id, executor: parseExecutor(values.executor), ...(values.modelId ? { modelId: values.modelId } : {}) });
      await taskDetail(id);
    },
    { save: "Start task" },
  );
}
export const stepsJson = (steps) => JSON.stringify(steps || [], null, 2);
export function parseStepsJson(text) {
  if (!text.trim()) return [];
  const value = JSON.parse(text);
  if (!Array.isArray(value)) throw new Error("Steps must be a JSON array.");
  return value;
}
export async function redirectDialog(id) {
  const t = await g.execute("tasks.get", { id }, true);
  const remaining = (t.plan || []).slice(t.run?.cursor || 0);
  g.formDialog(
    "Redirect task",
    `<p>Completed steps and evidence stay. Steps that have not started are replaced.</p>${g.area("Objective", "objective", t.objective || "")}${g.field("Next step", "nextStep", t.nextStep || "")}${await modelField(t.modelId)}${g.area("Remaining steps (JSON)", "steps", stepsJson(remaining))}${g.field("Reason", "note", "")}`,
    async (values) => {
      const steps = parseStepsJson(values.steps);
      await g.execute("tasks.redirect", { id, objective: values.objective, nextStep: values.nextStep, ...(values.modelId ? { modelId: values.modelId } : {}), ...(JSON.stringify(steps) !== JSON.stringify(remaining) ? { steps } : {}), ...(values.note ? { note: values.note } : {}) });
      await taskDetail(id);
    },
    { save: "Redirect", wide: true },
  );
}
export async function reassignDialog(id) {
  const t = g.records("tasks").find((r) => r.id === id);
  g.formDialog(
    "Reassign task",
    `<p>The task runs as the new identity from its next step. Approvals given to the previous identity do not carry over.</p>${await executorField(t.executor)}${g.field("Reason", "note", "")}`,
    async (values) => {
      await g.execute("tasks.reassign", { id, executor: parseExecutor(values.executor), ...(values.note ? { note: values.note } : {}) });
      await taskDetail(id);
    },
    { save: "Reassign" },
  );
}
export function retryDialog(id, stepId, uncertain) {
  g.formDialog(
    uncertain ? "Retry work with an unknown outcome" : "Retry step",
    uncertain
      ? `<p>Weft cannot tell whether this action already happened. Retrying may send a message, submit a form or make a payment twice. Check the destination first; if it already happened, choose “It happened” instead.</p><label><input type="checkbox" name="confirm" required> I checked, and I accept that this may happen twice</label>${g.field("What you checked", "note", "")}`
      : `<p>The step failed without effect. It will run again with the same permission checks.</p>${g.field("Note", "note", "")}`,
    async (values) => {
      await g.execute("tasks.retryStep", { id, ...(stepId ? { stepId } : {}), ...(uncertain ? { confirmDuplicateRisk: values.confirm === "on" } : {}), ...(values.note ? { note: values.note } : {}) });
      await taskDetail(id);
    },
    { save: uncertain ? "Retry anyway" : "Retry" },
  );
}
export function parametersDialog(id, names) {
  g.formDialog(
    "Enter values again",
    `<p>Sensitive values are kept only in memory for this run and are never saved.</p>${names.map((n) => g.field(n, n, "", "password", true)).join("")}`,
    async (values) => {
      await g.execute("tasks.continue", { id, parameters: values });
      await taskDetail(id);
    },
    { save: "Continue" },
  );
}
// Workflow parameters as editable lines: name:type[:optional][=default]
const parameterLine = (p) => typeof p === "string" ? p : `${p.name}:${p.type || "string"}${p.required === false ? ":optional" : ""}${p.sensitive ? ":sensitive" : ""}${p.type === "enum" && p.options?.length ? `:${p.options.join("|")}` : ""}${p.default !== undefined && p.default !== "" ? `=${p.default}` : ""}`;
function parseParameterLines(text) {
  return text.split("\n").map((l) => l.trim()).filter(Boolean).map((line) => {
    const [spec, ...rest] = line.split("=");
    const [name, type = "string", ...flags] = spec.split(":").map((s) => s.trim());
    if (!/^[A-Za-z][A-Za-z0-9_]{0,63}$/.test(name)) return line;
    const parameter = { name, type, required: !flags.includes("optional") };
    if (flags.includes("sensitive")) parameter.sensitive = true;
    const options = flags.find((f) => f.includes("|"));
    if (options) parameter.options = options.split("|");
    if (rest.length) parameter.default = type === "number" ? Number(rest.join("=")) : type === "boolean" ? rest.join("=") === "true" : rest.join("=");
    return parameter;
  });
}
const simpleSteps = (steps) => (steps || []).every((s) => !s.kind || s.kind === "instruction");
export function workflowFields(r) {
  const materials = g.records("materials");
  return (
    g.choice("Workflow status", "enabled", [["true", "Enabled"], ["false", "Inactive"]], String(r?.enabled !== false)) +
    g.area("Description", "description", r?.description || "") +
    g.field("Watch a web URL (optional)", "watchUrl", r?.watch?.url || "", "url") +
    g.field("Check every (minutes)", "watchInterval", r?.watch?.intervalMinutes || 5, "number") +
    g.field("Cooldown between runs (minutes)", "watchCooldown", r?.watch?.cooldownMinutes || 5, "number") +
    g.field("Wake when this text appears (blank: any content change)", "watchContains", r?.watch?.contains || "") +
    `<p>Checks run while Weft is open and unlocked. The first check sets a baseline. Only enabled workflows wake, with the normal task permissions. Public content only; no browser cookies are sent.</p>${r?.watchState ? `<p>Watch: ${g.esc(r.watchState.phase)} · ${g.esc(r.watchState.checkedAt || "")}${r.watchState.error ? " · " + g.esc(r.watchState.error) : ""}</p>` : ""}` +
    g.area("Parameters (one per line: name:type[:optional][:sensitive][=default]; types string, number, boolean, url, enum with a|b options, credential)", "parameters", (r?.parameters || []).map(parameterLine).join("\n")) +
    g.area(
      simpleSteps(r?.steps) ? "Steps (one instruction per line, or a JSON array of executable steps)" : "Steps (JSON array of executable steps)",
      "steps",
      simpleSteps(r?.steps) ? r?.steps?.map((s) => s.instruction).join("\n") || "" : stepsJson(r.steps),
      true,
    ) +
    g.area("Allowed sites (one per line, for example shop.example.com or *.example.com)", "allowedSites", (r?.allowedSites || []).join("\n")) +
    g.area("Credential references (one per line: name=reference; references only, never passwords)", "credentialRefs", (r?.credentialRefs || []).map((c) => `${c.name}=${c.ref}`).join("\n")) +
    (materials.length ? `<fieldset><legend>Required materials</legend>${materials.map((m) => `<label><input type="checkbox" name="materialIds" value="${g.esc(m.id)}" ${r?.materialIds?.includes(m.id) ? "checked" : ""}> ${g.esc(m.title)}</label>`).join("")}</fieldset>` : "") +
    g.area("Expected outputs (you confirm them before a run completes)", "expectedOutputs", r?.expectedOutputs || "")
  );
}
export function workflowValues(values) {
  const watch = values.watchUrl ? { url: values.watchUrl, intervalMinutes: Number(values.watchInterval), cooldownMinutes: Number(values.watchCooldown), ...(values.watchContains ? { contains: values.watchContains } : {}) } : null;
  for (const key of ['watchUrl', 'watchInterval', 'watchCooldown', 'watchContains']) delete values[key];
  values.watch = watch;
  const steps = values.steps.trim().startsWith("[") ? parseStepsJson(values.steps) : values.steps.split("\n").filter((s) => s.trim()).map((s, i) => ({ title: `Step ${i + 1}`, instruction: s, reviewRequired: true }));
  const materialIds = [...document.querySelectorAll('#edit-form [name="materialIds"]:checked')].map((box) => box.value);
  delete values.materialIds;
  return {
    ...values,
    steps,
    parameters: parseParameterLines(values.parameters),
    allowedSites: values.allowedSites.split("\n").map((s) => s.trim()).filter(Boolean),
    credentialRefs: values.credentialRefs.split("\n").map((s) => s.trim()).filter(Boolean).map((line) => { const [name, ...ref] = line.split("="); return { name: name.trim(), ref: ref.join("=").trim() }; }),
    ...(document.querySelector('#edit-form [name="materialIds"]') ? { materialIds } : {}),
  };
}
export async function workflowRunDialog(id) {
  const w = g.records("workflows").find((r) => r.id === id);
  if (w.enabled === false) {
    g.editRecord("workflows", id);
    g.toast("Review and enable this workflow first. Saving or importing a workflow never authorizes it.");
    return;
  }
  const report = await g.execute("workflows.validate", { id }, true);
  const input = (p) => {
    const label = `${p.label || p.name}${p.required ? "" : " (optional)"}${p.description ? ` — ${p.description}` : ""}`;
    if (p.type === "enum") return g.choice(label, `param:${p.name}`, (p.options || []).map((o) => [o, o]), String(p.default ?? ""));
    if (p.type === "boolean") return g.choice(label, `param:${p.name}`, [["true", "Yes"], ["false", "No"]], String(p.default ?? "false"));
    return g.field(label, `param:${p.name}`, p.sensitive ? "" : String(p.default ?? ""), p.sensitive ? "password" : p.type === "number" ? "number" : p.type === "url" ? "url" : "text", p.required);
  };
  const tab = g.active();
  g.formDialog(
    `Run ${w.title}`,
    `<p>The run is a task: every step uses current permissions and your review points. ${w.allowedSites?.length ? `It may only act on ${g.esc(w.allowedSites.join(", "))}.` : ""}</p>${report.errors.filter((e) => !/is required/.test(e)).map((e) => `<div class="notice">${g.esc(e)}</div>`).join("")}${report.parameters.map(input).join("")}${tab && tab.url !== "about:blank" ? g.choice("Start in tab", "tabId", [[String(tab.id), g.displayTitle(tab)], ["", "No tab"]], String(tab.id)) : ""}${await executorField(null)}${await modelField("")}`,
    async (values) => {
      const parameters = {};
      for (const p of report.parameters) {
        const raw = values[`param:${p.name}`];
        if (raw === undefined || (raw === "" && !p.required)) continue;
        parameters[p.name] = p.type === "number" ? Number(raw) : p.type === "boolean" ? raw === "true" : raw;
      }
      const task = await g.execute("workflows.run", { id, parameters, executor: parseExecutor(values.executor), ...(values.tabId ? { tabId: Number(values.tabId) } : {}), ...(values.modelId ? { modelId: values.modelId } : {}) });
      await taskDetail(task.id);
    },
    { save: "Run workflow", wide: true },
  );
}
export function proposalCard(m) {
  let parsed;
  try { parsed = JSON.parse(m.content); } catch { return null; }
  if (parsed?.tool === "propose_action" && parsed.proposal) return `<div class="notice proposal"><strong>Permission requested:</strong> ${g.esc(parsed.proposal.title)}<p>${g.esc(parsed.proposal.command)}</p>${g.action("review-action", "Review action", "shield", `data-id="${g.esc(m.id)}"`)}</div>`;
  if (parsed?.tool !== "propose_task" || !parsed.proposal) return null;
  const p = parsed.proposal;
  return `<div class="notice proposal"><strong>Proposed task (from the model; review before creating):</strong> ${g.esc(p.title)}${p.steps?.length ? `<ol>${p.steps.map((s) => `<li>${g.esc(s.title)}</li>`).join("")}</ol>` : ""}${g.action("review-proposal", "Review proposed task", "tasks", `data-id="${g.esc(m.id)}"`)}</div>`;
}
