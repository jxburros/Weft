/**
 * The record editor and delete confirmation.
 * Moved from src/gui.js (#119); `g` holds live bindings to gui.js state and helpers.
 */
let g;
/** Connect these views to the GUI's shared context (called once by gui.js). */
export function bindRecordsViews(context) {
  g = context;
}

export function editRecord(kind, id, prefill = null) {
  const r = id ? (g.state[kind] || []).find((r) => r.id === id) : prefill;
  let fields = "";
  if (kind === "siteRules") {
    fields =
      g.choice(
        "Rule status",
        "enabled",
        [
          ["true", "Enabled"],
          ["false", "Inactive"],
        ],
        String(r?.enabled !== false),
      ) +
      g.field(
        "Domain (for example, example.com)",
        "hostname",
        r?.hostname || "",
        "text",
        true,
      ) +
      g.choice(
        "Behavior",
        "behavior",
        [
          ["block", "Block"],
          ["warn", "Warn"],
        ],
        r?.behavior || "block",
      ) +
      g.choice(
        "Coverage",
        "mode",
        [
          ["navigation", "Visits, redirects, and popups"],
          ["connection", "All matching browser connections"],
        ],
        r?.mode || "navigation",
      ) +
      g.choice(
        "Scope",
        "scope",
        [
          ["workspace", "This workspace"],
          ["global", "Every workspace"],
        ],
        r?.scope || "workspace",
      ) +
      g.choice(
        "Subdomains",
        "includeSubdomains",
        [
          ["true", "Include subdomains"],
          ["false", "Exact hostname only"],
        ],
        String(r?.includeSubdomains ?? true),
      ) +
      g.field("Path prefix", "path", r?.path || "/") +
      g.field("Reason", "reason", r?.reason || "Personal preference") +
      g.area("Note", "note", r?.note || "") +
      g.area("Evidence links (one HTTP(S) URL per line)", "evidence", (r?.evidence || []).join("\n")) +
      g.field("Review by (optional)", "reviewBy", r?.reviewBy || "", "date");
  } else {
    fields = g.field("Title", "title", r?.title || "", "text", true);
    if (kind === "materials")
      fields +=
        g.choice(
          "Type",
          "kind",
          [
            ["note", "Note"],
            ["website", "Website reference"],
            ["file", "Stored file"],
            ["linked-file", "File reference (manual notes only)"],
            ["service", "Service reference (manual notes only)"],
          ],
          r?.kind || "note",
        ) +
        g.field("Website URL (optional)", "url", r?.url || "", "url") +
        g.area("Notes or content", "content", r?.content || "") +
        (!r
          ? '<label class="file-upload">Attach a file (up to 10 MB)<input id="material-file" type="file"></label>'
          : "") +
        g.choice(
          "Pinned",
          "pinned",
          [
            ["false", "No"],
            ["true", "Yes"],
          ],
          String(r?.pinned || false),
        ) +
        g.knowledge.recordDetails(kind, r);
    if (kind === "context")
      fields +=
        g.choice(
          "Category",
          "category",
          [
            ["confirmed", "Confirmed information"],
            ["findings", "Agent findings"],
            ["questions", "Open questions"],
            ["instructions", "Instructions & preferences"],
            ["decisions", "Decisions"],
          ],
          r?.category || "questions",
        ) +
        g.area("Content", "content", r?.content || "", true) +
        g.area("Sources (one per line)", "sources", r?.sources?.join("\n") || "") +
        g.knowledge.recordDetails(kind, r);
    if (kind === "tasks")
      fields +=
        g.area("Objective", "objective", r?.objective || "") +
        // A task run by the task runtime changes state only through its own controls.
        (r?.executor
          ? ""
          : g.choice(
              "State",
              "status",
              ["queued", "running", "waiting_on_human", "paused", "completed", "failed", "cancelled"].map((p) => [p, g.phaseLabel(p)]),
              r?.status === "waiting" ? "waiting_on_human" : r?.status || "queued",
            )) +
        g.field("Assignee", "assignee", r?.assignee || "human") +
        g.area("Checkpoint / completed work", "checkpoint", r?.checkpoint || "") +
        g.field("Next step", "nextStep", r?.nextStep || "") +
        g.field("Blocker", "blocker", r?.blocker || "") +
        (r?.executor ? "" : g.area("Executable steps (optional JSON array; saving never runs them — use Start)", "plan", r?.plan?.length ? g.stepsJson(r.plan) : ""));
    if (kind === "workflows") fields += g.workflowFields(r);
  }
  g.formDialog(
    `${id ? "Edit" : "New"} ${kind === "siteRules" ? "site rule" : kind === "materials" ? "material" : kind === "context" ? "context record" : kind === "tasks" ? "task" : kind === "workflows" ? "workflow" : "conversation"}`,
    fields,
    async (values) => {
      if ("url" in values && !values.url) {
        if (id) values.url = null;
        else delete values.url;
      }
      if ("enabled" in values) values.enabled = values.enabled === "true";
      if ("pinned" in values) values.pinned = values.pinned === "true";
      if ("includeSubdomains" in values)
        values.includeSubdomains = values.includeSubdomains === "true";
      if (kind === "siteRules") {
        values.evidence = values.evidence.split("\n").map((s) => s.trim()).filter(Boolean);
        if (!values.reviewBy) {
          if (r?.reviewBy) values.reviewBy = null;
          else delete values.reviewBy;
        }
      }
      if (kind === "context")
        values.sources = values.sources
          .split("\n")
          .map((s) => s.trim())
          .filter(Boolean);
      if (kind === "workflows") Object.assign(values, g.workflowValues(values));
      if (kind === "tasks" && "plan" in values) values.plan = g.parseStepsJson(values.plan);
      const file = g.$("material-file")?.files[0];
      if (file) {
        if (file.size > 10 * 1024 * 1024)
          throw new Error("Choose a file smaller than 10 MB.");
        values.kind = "file";
        values.filename = file.name;
        values.mimeType = file.type || "application/octet-stream";
        values.fileBase64 = await new Promise((resolve, reject) => {
          const reader = new FileReader();
          reader.onload = () => resolve(reader.result.split(",")[1]);
          reader.onerror = reject;
          reader.readAsDataURL(file);
        });
      }
      const result = await g.execute(
        `${kind}.${id ? "update" : "create"}`,
        id
          ? { id: r.id, changes: values, expectedRevision: r.revision }
          : { workspaceId: g.ws().id, ...values },
      );
      if (kind === "conversations") {
        g.conversationId = result.id;
        g.openAgent();
      }
    },
    {
      save: id ? "Save changes" : "Create",
      extra: id
        ? g.action(
            "delete-record",
            "Delete",
            "trash",
            `data-kind="${kind}" data-id="${g.esc(r.id)}"`,
            "secondary danger",
          ) + (["context", "materials"].includes(kind) ? g.knowledge.shareButton(kind, r.id) : "")
          + (["materials", "tasks"].includes(kind) ? g.action("open-in-pane", "Open in new pane", "split", `data-kind="${kind === "materials" ? "material" : "task"}" data-id="${g.esc(r.id)}"`) : "")
          + (kind === "materials" ? g.action("move-record", "Move to workspace…", "", `data-kind="materials" data-id="${g.esc(r.id)}"`) : "")
        : kind === "materials" ? g.knowledge.materialDialogExtras() : "",
    },
  );
}
export async function confirmDelete(kind, id) {
  // Deleting a workspace lists its open pages and can reopen them in Everything (#99).
  const open = kind === "workspaces" ? g.tabs.filter((t) => t.workspaceId === id && t.url !== "about:blank" && !t.blocked) : [];
  g.formDialog(
    "Delete this item?",
    `<p>This permanently removes the selected ${kind === "workspaces" ? "workspace and its saved project contents" : "item"}. This cannot be undone.</p>`
      + (open.length ? `<p>${open.length} open page${open.length === 1 ? "" : "s"} in this workspace:</p><ul>${open.map((t) => `<li>${g.esc(g.displayTitle(t))} <small>${g.esc(g.host(t.url))}</small></li>`).join("")}</ul><label class="inline-check"><input type="checkbox" name="move-tabs" checked> Reopen these pages in Everything (sign-ins and page state are not moved)</label>` : ""),
    async (values) => {
      await g.execute(`${kind}.delete`, { id, ...(kind === "workspaces" && open.length ? { moveTabsToEverything: Object.hasOwn(values, "move-tabs") } : {}) });
    },
    { save: "Delete permanently" },
  );
}
