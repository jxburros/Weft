import { icon } from "./icons.js";
const $ = (id) => document.getElementById(id);
const esc = (value) =>
  String(value ?? "").replace(
    /[&<>"']/g,
    (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        c
      ],
  );
const short = (v, n = 100) =>
  String(v || "").length > n ? String(v).slice(0, n) + "…" : String(v || "");
const date = (value) =>
  value
    ? new Date(value).toLocaleDateString(undefined, {
        month: "short",
        day: "numeric",
      })
    : "Today";
const ago = (value) => {
  const mins = Math.floor((Date.now() - new Date(value).getTime()) / 60000);
  return mins < 1
    ? "Just now"
    : mins < 60
      ? `${mins}m ago`
      : mins < 1440
        ? `${Math.floor(mins / 60)}h ago`
        : date(value);
};
const names = {
  overview: "Overview",
  tabs: "Tabs",
  materials: "Materials",
  context: "Context",
  tasks: "Tasks",
  conversations: "Conversations",
  artifacts: "Artifacts",
  activity: "Activity",
  approvals: "Agent requests",
  workflows: "Workflows",
  settings: "Settings",
  privacy: "Privacy & site rules",
  downloads: "Downloads",
  history: "History",
  bookmarks: "Bookmarks",
  browse: "Live page",
};
const sections = [
  "overview",
  "materials",
  "context",
  "tasks",
  "conversations",
  "artifacts",
  "activity",
];
const sectionIcon = {
  overview: "grid",
  materials: "folder",
  context: "context",
  tasks: "tasks",
  conversations: "chat",
  artifacts: "artifacts",
  activity: "activity",
};
let state = {
  workspaces: [],
  materials: [],
  context: [],
  tasks: [],
  conversations: [],
  artifacts: [],
  activity: [],
  workflows: [],
  siteRules: [],
  settings: {},
};
let tabs = [],
  catalog = {},
  section = "overview",
  models = [],
  modelId = "",
  conversationId = null,
  agentOpen = false,
  chatBusy = false,
  filter = "",
  taskFilter = "",
  splitTabId = null,
  refreshPromise = null,
  lastSnapshot = "",
  toastTimer,
  dialogRestore;
const ws = () =>
  state.workspaces.find((w) => w.id === state.activeWorkspaceId) || {
    name: "My workspace",
    id: "",
  };
const records = (key) =>
  (state[key] || []).filter((r) => r.workspaceId === ws().id);
const active = () => tabs.find((t) => t.active);
const visibleTabs = () =>
  tabs.filter((t) => !t.workspaceId || t.workspaceId === ws().id);
const displayTitle = (t) =>
  t.title && t.title !== "about:blank"
    ? t.title
    : t.url === "about:blank"
      ? "New tab"
      : t.url || "New tab";
const host = (url) => {
  try {
    return new URL(url).hostname || url;
  } catch {
    return url || "Local note";
  }
};
const action = (name, label, ico = "", attrs = "", cls = "secondary") =>
  `<button class="${cls}" data-action="${name}" ${attrs}>${ico ? icon(ico) : ""}${esc(label)}</button>`;
// Polling replaces controls. Keep keyboard focus on the equivalent new control.
function rememberFocus() {
  const element = document.activeElement;
  const attributes = ["data-action", "data-id", "data-section", "data-kind"];
  const selector = element?.id ? `#${CSS.escape(element.id)}` :
    element?.hasAttribute("data-action") ? element.tagName.toLowerCase() + attributes.filter(a => element.hasAttribute(a)).map(a => `[${a}="${CSS.escape(element.getAttribute(a))}"]`).join("") : null;
  return () => {
    const target = element?.isConnected ? element : selector && document.querySelector(selector);
    if (target && !target.closest("[hidden]")) target.focus({ preventScroll: true });
    else $("content").focus({ preventScroll: true });
  };
}
function toast(message) {
  $("toast").textContent = message;
  $("toast").hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => ($("toast").hidden = true), 4500);
}
function errorMessage(e) {
  return String(e.message || e).replace(
    /^Error invoking remote method '[^']+': Error: /,
    "",
  );
}
async function execute(name, args = {}, quiet = false) {
  if (!quiet) $("status").textContent = `Running ${name}…`;
  try {
    const result = await window.weft.execute(name, args);
    if (!quiet) {
      showResult(result);
      $("status").textContent = "Done";
      await refresh(true);
    }
    return result;
  } catch (e) {
    $("status").textContent = errorMessage(e);
    if (!quiet) toast(errorMessage(e));
    throw e;
  }
}
function showResult(result) {
  $("result").textContent = JSON.stringify(result, null, 2);
  $("artifact").replaceChildren();
  if (
    result?.data &&
    ["image/png", "application/pdf"].includes(result.mimeType)
  ) {
    const a = document.createElement("a");
    a.href = `data:${result.mimeType};base64,${result.data}`;
    a.download =
      result.mimeType === "image/png" ? "weft-capture.png" : "weft-page.pdf";
    a.textContent = "Save artifact";
    $("artifact").append(a);
    $("result").textContent = JSON.stringify(
      { ...result, data: `[${result.data.length} base64 characters]` },
      null,
      2,
    );
  }
}
async function refresh(force = false) {
  if (refreshPromise) {
    await refreshPromise;
    if (force) return refresh(true);
    return;
  }
  refreshPromise = refreshState(force);
  try {
    await refreshPromise;
  } finally {
    refreshPromise = null;
  }
}
async function refreshState(force) {
  {
    const [next, nextTabs, browserInfo] = await Promise.all([
      window.weft.execute("workspace.snapshot", {}),
      window.weft.execute("tabs.list", {}),
      window.weft.execute("browser.info", {}),
    ]);
    const snapshot = JSON.stringify([next, nextTabs, browserInfo.automation]);
    state = next;
    tabs = nextTabs;
    if (snapshot !== lastSnapshot || force) {
      lastSnapshot = snapshot;
      const restoreFocus = rememberFocus();
      renderShell();
      renderSafetyNotices(browserInfo.automation);
      if (
        !document.activeElement?.closest(
          "#content input,#content textarea,#content select",
        )
      )
        renderContent();
      if (agentOpen && !chatBusy) renderMessages();
      if (!document.activeElement || document.activeElement === document.body) restoreFocus();
    }
    if (document.activeElement !== $("address"))
      $("address").value =
        section === "browse" && active()?.url !== "about:blank"
          ? active()?.url || ""
          : "";
    layout();
  }
}
function theme() {
  const value = state.settings.theme || "system";
  const dark =
    value === "dark" ||
    (value === "system" && matchMedia("(prefers-color-scheme: dark)").matches);
  document.documentElement.dataset.theme = dark ? "dark" : "light";
  document.querySelector(".wordmark img").src = dark
    ? "../assets/logo/dark/horizontal-dark.svg"
    : "../assets/logo/svg/horizontal-full-color.svg";
  $("theme-toggle").innerHTML = icon(dark ? "sun" : "moon");
}
function renderSafetyNotices(automation) {
  const notices = $("safety-notices");
  const pending = Number(automation?.pendingApprovals) || 0;
  notices.innerHTML = (pending ? `<div class="safety-notice"><strong>${pending} agent request${pending === 1 ? " needs" : "s need"} your decision.</strong> Agent actions wait until you approve or reject them here; page text cannot approve them. ${action("section", "Review requests", "", 'data-section="approvals"', "secondary")}</div>` : "") + (automation?.stopped ? `<div class="safety-notice"><strong>Agent activity is stopped.</strong> Resume enables new automation; tabs remain under your control. ${action("resume-automation", "Resume automation", "", "", "secondary")}</div>` : "") +
    (state.storageWarnings || []).map(w => `<div class="safety-notice"><strong>Storage warning:</strong> ${esc(w.message)}${w.file ? ` <span>${esc(w.file)}</span>` : ""}</div>`).join("");
  notices.hidden = !notices.innerHTML;
}
function renderShell() {
  theme();
  $("workspace-name").textContent = ws().name;
  $("breadcrumb-workspace").textContent = ws().name;
  $("breadcrumb-section").textContent = names[section] || "Workspace";
  $("workspace-buttons").innerHTML = state.workspaces
    .filter((w) => !w.archived)
    .map(
      (w) =>
        `<button class="rail-button workspace-dot ${w.id === ws().id ? "active" : ""}" data-action="switch-workspace" data-id="${esc(w.id)}" aria-label="${esc(w.name)}" title="${esc(w.name)}" ${w.id === ws().id ? 'aria-current="true"' : ""}>${esc(w.icon && w.icon.length < 4 ? w.icon : w.name.slice(0, 2).toUpperCase())}</button>`,
    )
    .join("");
  $("sections").innerHTML = sections
    .map(
      (key) =>
        `<button class="section-link ${section === key ? "active" : ""}" data-action="section" data-section="${key}" ${section === key ? 'aria-current="page"' : ""}>${icon(sectionIcon[key])}<span>${names[key]}</span>${["materials", "tasks", "artifacts"].includes(key) && records(key).length ? `<span class="count">${records(key).length}</span>` : ""}</button>`,
    )
    .join("");
  $("tabs").innerHTML = visibleTabs()
    .map(
      (tab) =>
        `<div class="tab ${tab.active ? "active" : ""}"><button data-action="activate-tab" data-id="${tab.id}" title="${esc(tab.url)}">${icon(tab.pinned ? "pin" : "globe")}<span>${esc(displayTitle(tab))}</span></button><button data-action="close-tab" data-id="${tab.id}" aria-label="Close ${esc(displayTitle(tab))}">×</button></div>`,
    )
    .join("");
  $("agent-toggle").innerHTML = icon("spark") + "<span>Ask Weft</span>";
  $("agent-toggle").classList.toggle("active", agentOpen);
  $("agent-toggle").setAttribute("aria-expanded", String(agentOpen));
  $("toggle-sidebar").setAttribute("aria-expanded", String(!$("app").classList.contains("sidebar-collapsed")));
  $("ownership").textContent =
    section === "browse"
      ? `Control: ${active()?.controller || "available"}${active()?.version ? " · v" + active().version : ""}`
      : "You are in control";
  if (section === "browse" && active()?.warning)
    $("status").textContent = "Site warning: " + active().warning;
  else if (section === "browse" && active()?.communityLabels?.length) {
    const label = active().communityLabels[0];
    $("status").textContent = `Community label (${label.claimKind}, ${label.status}) from ${label.list}: ${label.claim}`;
  }
  $("item-count").textContent =
    `${visibleTabs().length} tab${visibleTabs().length !== 1 ? "s" : ""} · ${records("materials").length} materials`;
  $("back").disabled = !active()?.blocked && !active()?.canGoBack;
  $("forward").disabled = !active()?.canGoForward;
  $("stop").hidden = !active()?.loading;
  $("reload").hidden = !!active()?.loading;
  $("split-view").classList.toggle("sage-color", !!splitTabId);
}
function heading(title, subtitle, button = "") {
  return `<div class="page-heading"><div><h1>${esc(title)}</h1><p>${esc(subtitle)}</p></div>${button}</div>`;
}
function empty(title, body, ico, button = "") {
  return `<div class="empty-card"><div class="empty-icon icon">${icon(ico)}</div><h3>${esc(title)}</h3><p>${esc(body)}</p>${button}</div>`;
}
function overview() {
  const pending = records("tasks").filter(
    (t) => !["completed", "cancelled"].includes(t.status),
  );
  const materials = records("materials")
    .slice()
    .sort(
      (a, b) =>
        Number(b.pinned) - Number(a.pinned) ||
        new Date(b.updatedAt) - new Date(a.updatedAt),
    )
    .slice(0, 3);
  const artifacts = records("artifacts").slice(-3).reverse();
  return `<div class="eyebrow">${icon("grid")} YOUR WORK, WOVEN TOGETHER</div>${heading(ws().name, ws().description || "A little space for everything you’re working on.", action("workspace-menu", "Workspace options", "more"))}
 <div class="intro-panel"><div class="intro-copy"><h2>${records("materials").length || pending.length ? "Pick up where you left off." : "Make room for your next idea."}</h2><p>${records("materials").length || pending.length ? "Your tabs, references, and next steps are right here. Open a page or continue a task to keep your project moving." : "Bring your tabs, notes, and references together. Start with a page, save what matters, and build from there."}</p><div class="inline-actions">${action("new-tab", "Open a new tab", "plus", "", "primary")}${action("section", "Explore materials", "arrow", 'data-section="materials"', "text-button")}</div></div><img class="intro-mark" src="../assets/logo/svg/mark-full-color.svg" alt=""></div>
 <div class="section-heading"><h2>A place to start</h2><span class="muted micro">Built around your project</span></div>
 <div class="quick-grid">${[
   [
     "new-material",
     "note",
     "Save a thought",
     "Notes, links, and files, all together.",
   ],
   [
     "new-task",
     "tasks",
     "Plan the next step",
     "Give your project a clear direction.",
   ],
   ["ask", "spark", "Think with an agent", "Your model. Your conversation."],
 ]
   .map(
     ([a, i, t, d]) =>
       `<button class="quick-card" data-action="${a}"><span class="tile-icon icon">${icon(i)}</span><span><strong>${t}</strong><small>${d}</small></span></button>`,
   )
   .join("")}</div>
 <div class="overview-columns"><section><div class="section-heading"><h2>Materials & references</h2>${action("section", "View all", "arrow", 'data-section="materials"', "text-button")}</div>${materials.length ? materials.map((m) => `<button class="compact-record" data-action="edit-record" data-kind="materials" data-id="${esc(m.id)}">${icon(m.kind === "website" ? "globe" : "note")}<span class="record-text"><strong>${esc(m.title)}</strong><small>${esc(m.kind)} · ${date(m.updatedAt)}</small></span>${icon("chevron")}</button>`).join("") : empty("Keep the good stuff close", "Save useful pages, add your notes, or bring a file into this workspace.", "folder", action("new-material", "Add your first material", "plus", "", "text-button"))}</section>
 <section><div class="section-heading"><h2>Next up</h2>${action("section", "All tasks", "arrow", 'data-section="tasks"', "text-button")}</div>${
   pending.length
     ? pending
         .slice(0, 4)
         .map(
           (t) =>
             `<button class="compact-record" data-action="edit-record" data-kind="tasks" data-id="${esc(t.id)}"><span class="task-check"></span><span class="record-text"><strong>${esc(t.title)}</strong><small>${esc(t.status === "waiting" ? "Waiting for you" : t.status)}${t.blocker ? " · " + esc(short(t.blocker, 50)) : ""}</small></span></button>`,
         )
         .join("")
     : empty(
         "A clear desk. A fresh start.",
         "Turn an idea into a task when you’re ready. Your next steps will live here.",
         "tasks",
         action("new-task", "Create a task", "plus", "", "text-button"),
       )
 }</section></div>
 ${artifacts.length ? `<section class="settings-section"><div class="section-heading"><h2>Recently saved captures</h2>${action("section", "Open collection", "arrow", 'data-section="artifacts"', "text-button")}</div><div class="record-grid">${artifacts.map(artifactCard).join("")}</div></section>` : ""}<div class="workspace-footnote icon">${icon("lock")} Local by default. Your workspace stays ready for your next session.</div>`;
}
function renderContent() {
  if (section === "browse") {
    const tab = active();
    $("content").innerHTML =
      `${tab?.loading ? '<div class="loading-line"></div>' : ""}<div class="browser-placeholder"><img src="../assets/logo/svg/mark-full-color.svg" alt="Weft"><h2>${tab?.blocked ? "This destination is restricted" : tab?.url === "about:blank" ? "Where would you like to go?" : "Your live page"}</h2><p>${tab?.blocked ? esc(tab.blocked.reason || "A site rule stopped this page. Review the matching rule in Privacy & site rules.") : "Enter a website or a search in the address bar above."}</p>${tab?.blocked?.provenance ? (tab.blocked.provenance.signed ? `<p>Signed community list (untrusted claim; ${esc(tab.blocked.provenance.claimKind)}): ${esc(tab.blocked.provenance.listName)} sequence ${esc(tab.blocked.provenance.sequence)}, entry ${esc(tab.blocked.provenance.entryId)} revision ${esc(tab.blocked.provenance.entryRevision)}. Review it with lists.matches.</p>` : `<p>Community list provenance (untrusted): ${esc(tab.blocked.provenance.sourceRepo)} @ ${esc(tab.blocked.provenance.commit)}</p>`) : ""}${tab?.blocked ? '<div class="inline-actions">' + action("blocked-back", "Go back", "back") + action("allow-once", "Allow this visit", "globe") + action("section", "Change rule", "shield", 'data-section="privacy"') + "</div>" : ""}${action("section", "Back to workspace", "back", 'data-section="overview"', "text-button")}</div>`;
    layout();
    return;
  }
  let html = "";
  if (section === "overview") html = overview();
  else if (
    ["materials", "context", "tasks", "conversations", "workflows"].includes(
      section,
    )
  )
    html = collectionView(section);
  else if (section === "tabs")
    html =
      heading(
        "Open tabs",
        "Your pages, with a clear place and a clear owner.",
        action("new-tab", "New tab", "plus", "", "primary"),
      ) + tabTable();
  else if (section === "artifacts")
    html =
      heading(
        "Saved captures",
        "A lasting reference, even when the live page changes.",
        action("capture", "Save current page", "plus", "", "primary"),
      ) +
      (records("artifacts").length
        ? `<div class="record-grid">${records("artifacts").slice().reverse().map(artifactCard).join("")}</div>`
        : empty(
            "Keep a page for later",
            "Save page text and a screenshot as an offline reference. Each new capture preserves the previous version.",
            "artifacts",
            action("new-tab", "Open a page", "globe", "", "text-button"),
          ));
  else if (section === "activity")
    html =
      heading(
        "Activity",
        "The decisions, changes, and progress behind your project.",
        action("section", "Agent requests", "lock", 'data-section="approvals"'),
      ) + activityView();
  else if (section === "approvals")
    html =
      heading(
        "Agent requests",
        "Actions agents asked to take. Nothing here runs until you decide.",
        action("section", "Activity", "activity", 'data-section="activity"'),
      ) + '<div id="approval-list" aria-live="polite"></div>';
  else if (section === "history")
    html =
      heading(
        "Browsing history",
        "Recent visits in this workspace. Stored URL metadata omits known sensitive parameters.",
        action("clear-history", "Clear history", "trash"),
      ) +
      `<div class="activity-list">${
        (state.history || [])
          .filter((r) => r.workspaceId === ws().id)
          .slice()
          .reverse()
          .map(
            (r) =>
              `<button class="compact-record" data-action="open-url" data-url="${esc(r.url)}">${icon("clock")}<span class="record-text"><strong>${esc(r.title)}</strong><small>${esc(host(r.url))} · ${ago(r.visitedAt)}</small></span>${icon("external")}</button>`,
          )
          .join("") ||
        empty(
          "No visits recorded",
          "Pages you visit will appear here.",
          "clock",
        )
      }</div>`;
  else if (section === "bookmarks")
    html =
      heading(
        "Bookmarks",
        "Useful live pages, saved with this project.",
        action("bookmark-page", "Bookmark current page", "bookmark"),
      ) +
      `<div class="record-grid">${
        records("materials")
          .filter((r) => r.kind === "website" && r.pinned)
          .map((r) => recordCard("materials", r))
          .join("") ||
        empty(
          "Keep a useful page handy",
          "Bookmarks also appear as pinned website materials.",
          "bookmark",
        )
      }</div>`;
  else if (section === "privacy") html = privacyView();
  else if (section === "settings") html = settingsView();
  else if (section === "downloads")
    html =
      heading(
        "Downloads",
        "Files saved by this browser. Downloaded files are never opened automatically.",
      ) + '<div id="download-list"></div>';
  $("content").innerHTML = `<div class="page-wrap">${html}</div>`;
  if (section === "downloads") loadDownloads();
  if (section === "activity") void loadActivity();
  if (section === "approvals") void loadApprovals();
  const search = $("collection-search");
  if (search) {
    search.value = filter;
    search.oninput = () => {
      filter = search.value;
      renderCards();
    };
  }
  const select = $("task-filter");
  if (select) {
    select.value = taskFilter;
    select.onchange = () => {
      taskFilter = select.value;
      renderCards();
    };
  }
  layout();
}
function collectionView(kind) {
  const subtitles = {
    materials: "The links, notes, and files that give your project a home.",
    context: "Keep facts, questions, and decisions in view.",
    tasks: "A clear next step. A durable place to pick things up.",
    conversations: "Your thinking, saved with the project.",
    workflows: "Reusable instructions and review points for repeatable work.",
  };
  const label = {
    materials: "Add material",
    context: "Add context",
    tasks: "New task",
    conversations: "New conversation",
    workflows: "New workflow",
  };
  return (
    heading(
      names[kind],
      subtitles[kind],
      action(
        "new-record",
        label[kind],
        "plus",
        `data-kind="${kind}"`,
        "primary",
      ),
    ) +
    `<div class="section-toolbar"><input id="collection-search" placeholder="Search ${kind}…" aria-label="Search ${kind}">${kind === "tasks" ? '<select id="task-filter" aria-label="Filter tasks"><option value="">All states</option><option value="queued">Queued</option><option value="running">Running</option><option value="waiting">Waiting for you</option><option value="paused">Paused</option><option value="completed">Completed</option></select>' : ""}${kind === "tasks" ? action("section", "Workflows", "workflow", 'data-section="workflows"', "text-button") : ""}</div><div id="record-cards">${cards(kind)}</div>`
  );
}
function cards(kind) {
  const list = records(kind)
    .filter(
      (r) =>
        (!filter ||
          JSON.stringify(r).toLowerCase().includes(filter.toLowerCase())) &&
        (!taskFilter || kind !== "tasks" || r.status === taskFilter),
    )
    .slice()
    .reverse();
  if (!list.length)
    return empty(
      filter ? "No matches found" : `Your ${kind} start here`,
      filter
        ? "Try another search."
        : `Add your first ${kind === "materials" ? "note, link, or file" : kind === "context" ? "project fact or question" : kind === "tasks" ? "next step" : kind === "workflows" ? "reusable checklist" : "conversation"} to this workspace.`,
      sectionIcon[kind] || "workflow",
    );
  return `<div class="record-grid">${list.map((r) => recordCard(kind, r)).join("")}</div>`;
}
function renderCards() {
  if ($("record-cards")) $("record-cards").innerHTML = cards(section);
}
function recordCard(kind, r) {
  let tag = r.kind || r.category || r.status || "Conversation";
  if (kind === "workflows") tag = `${r.steps.length} steps`;
  return `<article class="record-card"><div class="card-top"><span class="tag ${r.status === "completed" ? "sage" : r.status === "waiting" ? "clay" : ""}">${r.enabled === false ? "Inactive · " : ""}${esc(tag)}</span>${action("edit-record", "", "more", `data-kind="${kind}" data-id="${esc(r.id)}" aria-label="Edit ${esc(r.title)}"`, "icon-button")}</div><h3>${esc(r.title)}</h3><p>${esc(short(r.content || r.objective || r.description || (kind === "conversations" ? `${r.messages?.length || 0} messages` : ""), 175))}</p>${r.blocker ? `<div class="notice">Waiting: ${esc(short(r.blocker, 100))}</div>` : ""}<div class="record-meta">${r.url ? esc(host(r.url)) + " · " : ""}${date(r.updatedAt)}${r.assignee ? " · " + esc(r.assignee) : ""}</div><div class="inline-actions">${r.url ? action("open-url", "Open page", "external", `data-url="${esc(r.url)}"`) : ""}${kind === "tasks" ? action("task-state", r.status === "completed" ? "Reopen" : "Complete", "check", `data-id="${esc(r.id)}" data-state="${r.status === "completed" ? "queued" : "completed"}"`) + (!["completed", "cancelled", "paused"].includes(r.status) ? action("task-state", "Pause", "pause", `data-id="${esc(r.id)}" data-state="paused"`) : "") : ""}${kind === "conversations" ? action("open-chat", "Continue", "chat", `data-id="${esc(r.id)}"`) : ""}${kind === "workflows" ? action("run-workflow", "Create tasks", "tasks", `data-id="${esc(r.id)}"`) : ""}${kind === "materials" && r.kind === "file" ? action("download-file", "Save file", "download", `data-id="${esc(r.id)}"`) : ""}</div></article>`;
}
function artifactCard(r) {
  const version = r.versions?.at(-1);
  return `<article class="record-card"><div class="card-top"><span class="tag sage">Saved capture</span><span class="muted">v${r.versions?.length || 1}</span></div><div class="empty-icon icon">${icon("artifacts")}</div><h3>${esc(r.title)}</h3><p>${esc(short(r.note || "An offline reference saved to this workspace.", 100))}</p><div class="record-meta">${esc(host(version?.url || version?.sourceUrl || r.url))} · ${date(version?.createdAt || r.createdAt)}</div><div class="inline-actions">${action("view-artifact", "View capture", "artifacts", `data-id="${esc(r.id)}"`)}${action("recapture", "New version", "reload", `data-id="${esc(r.id)}"`)}</div></article>`;
}
function tabTable() {
  return `<table class="tabs-table"><thead><tr><th>PAGE</th><th>CONTROL</th><th>ACTIONS</th></tr></thead><tbody>${visibleTabs()
    .map(
      (t) =>
        `<tr><td>${esc(displayTitle(t))}<small>${esc(short(t.url, 70))}</small></td><td>${esc(t.controller || "available")}<small>Version ${t.version || 1}</small></td><td><div class="inline-actions">${action("activate-tab", "Open", "", 'data-id="' + t.id + '"')}${action("pin-tab", t.pinned ? "Unpin" : "Pin", "pin", `data-id="${t.id}"`)}${action("takeover", "Take control", "", 'data-id="' + t.id + '"')}</div></td></tr>`,
    )
    .join("")}</tbody></table>`;
}
const activityState = { types: "", outcome: "", items: [], cursor: null, loaded: 50 };
const outcomeLabels = { attempted: "Attempted", completed: "Completed", failed: "Failed", denied: "Denied", pending_approval: "Waiting for approval", partial: "Partial", externally_uncertain: "Sent · external result not verified", cancelled: "Cancelled", recorded: "Recorded" };
function activityView() {
  const typeOptions = [["", "All activity"], ["command", "Commands"], ["decision", "Permission decisions"], ["approval", "Approval requests"], ["grant", "Agent access"], ["policy", "Policy"], ["model", "Model destinations"], ["block", "Blocks"], ["override", "Overrides"], ["artifact", "Captures"], ["retention", "Retention"]];
  const outcomeOptions = [["", "All outcomes"], ...Object.entries(outcomeLabels)];
  return `<div class="section-toolbar"><select id="activity-type" aria-label="Filter activity type">${typeOptions.map(([v, l]) => `<option value="${v}" ${activityState.types === v ? "selected" : ""}>${esc(l)}</option>`).join("")}</select><select id="activity-outcome" aria-label="Filter activity outcome">${outcomeOptions.map(([v, l]) => `<option value="${v}" ${activityState.outcome === v ? "selected" : ""}>${esc(l)}</option>`).join("")}</select>${action("activity-settings", "Retention & integrity", "shield", "", "text-button")}</div><div id="activity-entries" aria-live="polite"></div>`;
}
function activityRow(r) {
  const what = r.command || (r.reason || r.type || "").replaceAll("_", " ");
  const who = r.actor === "human" ? "You" : r.actor === "automation" ? "Bootstrap token" : r.actor === "model-reader" ? "Model read tool" : r.actor?.startsWith("client:") ? "Agent connection" : r.actor || "Weft";
  const detail = [outcomeLabels[r.outcome] || r.outcome, r.decision && r.decision !== "auto" ? `decision: ${r.decision}${r.reason ? " (" + r.reason.replaceAll("_", " ") + ")" : ""}` : "", r.actionClass ? r.actionClass.replaceAll("_", " ") : "", r.irreversible ? "cannot be undone" : ""].filter(Boolean).join(" · ");
  const inspect = { type: r.type, actor: r.actor, workspaceId: r.workspaceId, tabId: r.tabId, taskId: r.taskId, targetId: r.targetId, version: r.version, approvalId: r.approvalId, summary: r.summary, detail: r.detail, seq: r.seq, hash: r.hash };
  return `<details class="activity-row"><summary><span class="activity-dot icon">${icon(r.outcome === "denied" || r.type === "block" ? "lock" : r.outcome === "pending_approval" ? "clock" : "check")}</span><span><strong>${esc(what)}</strong><small>${esc(who)} · ${esc(detail)}</small></span><time>${ago(r.at)}</time></summary><pre>${esc(JSON.stringify(inspect, null, 2))}</pre></details>`;
}
async function loadActivity(more = false) {
  const filters = { workspaceId: ws().id, ...(activityState.types && { types: [activityState.types] }), ...(activityState.outcome && { outcome: activityState.outcome }) };
  const page = await execute("activity.list", { ...filters, limit: more ? 50 : Math.min(200, activityState.loaded), ...(more && activityState.cursor && { cursor: activityState.cursor }) }, true).catch(() => null);
  if (!page || !$("activity-entries")) return;
  activityState.items = more ? [...activityState.items, ...page.items] : page.items;
  activityState.loaded = Math.max(50, activityState.items.length);
  activityState.cursor = page.nextCursor;
  $("activity-entries").innerHTML = activityState.items.length
    ? `<div class="activity-list">${activityState.items.map(activityRow).join("")}</div>${page.nextCursor ? `<div class="inline-actions">${action("activity-more", "Show older activity", "clock")}</div>` : ""}<p class="muted">History records what Weft observed and decided. It is not proof that an external website or provider completed an action.</p>`
    : empty("Your project history starts here", "Meaningful changes, agent decisions and approvals appear here with their source and time.", "activity");
}
async function activitySettings() {
  const [integrity, page] = await Promise.all([execute("activity.verify", {}, true), execute("activity.list", { workspaceId: ws().id, limit: 1 }, true)]);
  const retention = page.retention || {};
  formDialog("Retention & integrity",
    `<p>Ordinary activity is kept on this device and removed by age or count. Saved artifacts and records are never removed by activity retention. Secrets are excluded and web addresses are stored without query strings.</p><div class="notice" id="activity-integrity"><strong>Integrity: ${esc(integrity.status === "intact" ? "chain intact" : "chain broken")}</strong> · ${esc(String(integrity.entries))} entries${integrity.reason ? " · " + esc(integrity.reason.replaceAll("_", " ")) : ""}<br><small>${esc(integrity.scope || "")}</small><br><small>Head: ${esc(String(integrity.headHash || "").slice(0, 16))}…</small></div>${field("Keep activity for (days, blank for no age limit)", "maxAgeDays", retention.maxAgeDays ?? "", "number")}${field("Keep at most (entries, blank for no count limit)", "maxEntries", retention.maxEntries ?? "", "number")}<p class="muted">Weft has no crash reporting or telemetry. Any future crash reporting must be opt-in, separate from workspace content, and redacted.</p>`,
    async (values) => {
      const number = (v) => (String(v ?? "").trim() === "" ? null : Number(v));
      await execute("activity.configure", { maxAgeDays: number(values.maxAgeDays), maxEntries: number(values.maxEntries) }, true);
      toast("Activity retention updated.");
    }, { save: "Save retention" });
}
async function loadApprovals() {
  const rows = await execute("approvals.list", { status: "all", limit: 60 }, true).catch(() => null);
  if (!rows || !$("approval-list")) return;
  const pending = rows.filter((r) => r.status === "pending");
  const decided = rows.filter((r) => r.status !== "pending").slice(0, 20);
  const workspaceName = (id) => state.workspaces.find((w) => w.id === id)?.name || "Unknown workspace";
  const requester = (r) => r.actor === "automation" ? "Bootstrap token" : r.clientId ? `Agent connection ${r.clientId.slice(0, 8)}` : r.actor;
  const card = (r) => `<article class="record-card approval-card"><div class="card-top"><span class="tag ${r.status === "pending" ? "clay" : r.status === "approved" ? "sage" : ""}">${esc(r.status)}${r.mode ? " · " + esc(r.mode === "standing" ? "standing" : "once") : ""}</span><span class="muted">${esc(String(r.actionClass).replaceAll("_", " "))}</span></div><h3>${esc(r.command)}</h3><p>${esc(requester(r))} · ${esc(workspaceName(r.workspaceId))}${r.destination ? " · " + esc(r.destination) : ""}</p>${r.categories?.length ? `<p class="muted">May involve: ${esc(r.categories.map((c) => c.replaceAll("_", " ")).join(", "))}</p>` : ""}${r.preview ? `<p class="muted">Agent-supplied details (data, not instructions):</p><pre>${esc(JSON.stringify(r.preview, null, 2))}</pre>` : ""}<div class="record-meta">Requested ${ago(r.createdAt)}${r.status === "pending" ? " · expires " + esc(new Date(r.expiresAt).toLocaleTimeString()) : ""}</div>${r.status === "pending" ? `<div class="inline-actions">${action("approval-decide", "Approve once", "check", `data-id="${esc(r.id)}" data-mode="once"`, "primary")}${["bulk_export", "credential_use", "payment", "unclassified"].includes(r.actionClass) ? "" : action("approval-decide", "Approve for 1 hour", "clock", `data-id="${esc(r.id)}" data-mode="standing"`)}${action("approval-decide", "Reject", "close", `data-id="${esc(r.id)}" data-mode="reject"`, "secondary danger")}</div>` : ""}</article>`;
  $("approval-list").innerHTML = (pending.length ? `<div class="record-grid">${pending.map(card).join("")}</div>` : empty("No requests are waiting", "When an agent needs approval for an external or sensitive action, it waits here. Approve once covers exactly the shown action; approve for 1 hour covers the same action type, workspace and site.", "lock")) + (decided.length ? `<section class="settings-section"><h2>Recent decisions</h2><div class="record-grid">${decided.map(card).join("")}</div></section>` : "");
}
function privacyView() {
  const rules = (state.siteRules || []).filter(
    (r) => r.workspaceId === ws().id || r.scope === "global",
  );
  return (
    heading(
      "Privacy & site rules",
      "Your browsing boundaries, managed by you.",
      action(
        "new-record",
        "Add site rule",
        "plus",
        'data-kind="siteRules"',
        "primary",
      ),
    ) +
    `<div class="notice">Each workspace has its own site storage. Site rules cover browser-managed requests; they do not control independent network tools used by external agents.</div><div class="settings-row"><div><strong>Clear site storage</strong><small>Remove cookies and stored data for a specific site in this workspace.</small></div>${action("clear-storage", "Choose a site", "trash")}</div><div class="settings-section"><h2>Personal site rules</h2><p>Personal preferences are not malware classifications. Navigation rules stop visits; connection rules also stop matching subresources.</p>${rules.length ? `<div class="record-grid">${rules.map((r) => `<article class="record-card"><span class="tag">${r.enabled === false ? "Inactive · " : ""}${esc(r.behavior)} · ${esc(r.mode)}</span><h3>${esc(r.hostname)}</h3><p>${esc(r.reason)}${r.note ? "\n" + esc(r.note) : ""}</p><small>${r.includeSubdomains ? "Includes subdomains" : "Exact hostname"} · ${esc(r.scope)}${r.provenance?.signed ? " · " + esc(r.provenance.claimKind) + " from community list " + esc(r.provenance.listName) + " (entry " + esc(r.provenance.entryId) + ")" : ""}</small><div class="inline-actions">${action("edit-record", "Edit rule", "", 'data-kind="siteRules" data-id="' + esc(r.id) + '"')}${action("delete-record", "Remove", "", 'data-kind="siteRules" data-id="' + esc(r.id) + '"', "secondary danger")}</div></article>`).join("")}</div>` : empty("No personal site rules", "Add a domain when you want this browser to avoid it.", "shield")}</div><div class="settings-section"><h2>Protection coverage</h2><p>Remote pages run sandboxed without Node.js access. Site permission requests and external application launches are denied. Model chat cannot interact with pages or change your policy. Optional read-only tools require an explicit choice for each request.</p><div class="notice">Credential vault operations, payment approval, malware feeds, and comprehensive storage blocking are not available in this build. This browser does not claim to isolate secrets from an agent with unrestricted access to your computer.</div></div>`
  );
}
function settingsView() {
  return (
    heading("Settings", "Make this space work for you.") +
    `<section class="settings-section"><h2>Appearance</h2><div class="settings-row"><div><strong>Color theme</strong><small>Warm surfaces, in light or dark.</small></div><select id="theme-select" aria-label="Color theme"><option value="system" ${state.settings.theme === "system" ? "selected" : ""}>System</option><option value="light" ${state.settings.theme === "light" ? "selected" : ""}>Light</option><option value="dark" ${state.settings.theme === "dark" ? "selected" : ""}>Dark</option></select></div></section><section class="settings-section"><div class="section-heading"><h2>Model connections</h2>${action("new-model", "Add connection", "plus", "", "text-button")}</div><p>Choose where your messages go. No content is sent until you ask. Text chat works with compatible providers. Optional read-only tools can read an explicitly selected page or search this workspace; image input and browser actions are not enabled.</p>${models.map((m) => `<div class="settings-row"><div><strong>${esc(m.name)}</strong><small>${esc(m.model)} · ${esc(m.endpoint)}</small><small>${esc(m.hasApiKey ? "Key available" : m.locality === "on-device endpoint" ? "Local endpoint · no key configured" : "No key configured")}</small></div>${action("edit-model", "Configure", "", 'data-id="' + esc(m.id) + '"')}</div>`).join("")}</section><section class="settings-section"><h2>Workspace data</h2><p>Project metadata is stored locally. Exported projects exclude browser sessions and model credentials. Notes and captures may contain personal information.</p><div class="inline-actions">${action("export-workspace", "Export workspace", "download")}${action("import-workspace", "Import workspace", "upload")}${action("workspace-menu", "Manage workspaces", "grid")}</div></section><section class="settings-section"><h2>Browsing</h2><div class="inline-actions">${action("section", "History", "clock", 'data-section="history"')}${action("section", "Bookmarks", "bookmark", 'data-section="bookmarks"')}</div></section><section class="settings-section"><h2>Agent connections & automation</h2><p>The authenticated CLI, MCP, and REST API share the browser’s command catalog. Use the command desk to inspect available actions.</p><div class="inline-actions">${action("manage-clients", "Manage agent connections", "lock")}${action("commands", "Open command desk", "terminal")}${action("emergency-stop", "Stop all agent activity", "stop", "", "secondary danger")}${action("section", "Workflows", "workflow", 'data-section="workflows"')}</div><div class="notice">Task records and workflow checklists track your work. They do not run an autonomous agent. External agents connect through the authenticated API. Keep its token private.</div></section>`
  );
}
const dataClassLabels = { workspace_records: "Workspace records", conversations: "Conversations", page_content: "Page text", page_capture: "Screenshots and PDFs", browsing_history: "History and downloads", activity: "Activity and requests" };
const levelLabels = { observe: "Observe only", assist: "Ask before any change", scoped: "Local changes; ask before external actions", autonomous: "Standing approval for external actions" };
function grantCard(grant) {
  const names = grant.workspaceIds.map((id) => state.workspaces.find((w) => w.id === id)?.name || id).join(", ");
  const status = grant.revoked ? "Revoked · " : Number(grant.expiresAt) <= Date.now() ? "Expired · " : "";
  const sites = grant.destinations && !grant.destinations.includes("*") ? grant.destinations.join(", ") : "Any site";
  return `<article class="record-card"><h3>${esc(grant.name)}</h3>${grant.purpose ? `<p>${esc(grant.purpose)}</p>` : ""}<p>${esc(grant.scopes.join(", "))}${grant.actionClasses?.length ? " · " + esc(grant.actionClasses.join(", ")) : ""}</p><small>Workspaces: ${esc(names)}${grant.crossWorkspace ? " (cross-workspace)" : ""}</small>${grant.autonomy ? `<small>Autonomy: ${esc(levelLabels[grant.autonomy] || grant.autonomy)} · Sites: ${esc(sites)}</small>` : ""}${grant.dataAccess ? `<small>Data: ${esc(grant.dataAccess.map((d) => dataClassLabels[d] || d).join(", "))}</small>` : ""}${grant.usage ? `<small>Used ${esc(String(grant.usage.count))}${grant.maxCommands ? " of " + esc(String(grant.maxCommands)) : ""} times${grant.taskId ? " · bound to a task" : ""}</small>` : ""}<small>${status}Expiry: ${esc(new Date(grant.expiresAt).toLocaleString())}</small>${!grant.revoked ? `<div class="inline-actions">${action("edit-client", "Change access", "", `data-id="${esc(grant.clientId)}"`)}${action("revoke-client", "Revoke token", "", `data-id="${esc(grant.clientId)}"`, "secondary danger")}</div>` : ""}</article>`;
}
async function manageClients() {
  const [grants, autonomy] = await Promise.all([execute("clients.list", {}, true), execute("autonomy.get", { workspaceId: ws().id }, true)]);
  openDialog("Agent connections",
    `<p>Create a separate, expiring token for each agent. Scope each token to the workspace, sites, data and actions it needs. Changes and revocation apply to the agent’s next command.</p><div class="settings-row"><div><strong>Bootstrap token</strong><small>The token printed at startup.</small></div><select id="bootstrap-level" aria-label="Bootstrap token autonomy">${Object.entries(levelLabels).map(([v, l]) => `<option value="${v}" ${autonomy.bootstrapLevel === v ? "selected" : ""}>${esc(l)}</option>`).join("")}</select></div><div class="settings-row"><div><strong>Limit in this workspace</strong><small>Applies to every agent here.</small></div><select id="workspace-level" aria-label="Workspace autonomy limit"><option value="">No extra limit</option>${Object.entries(levelLabels).map(([v, l]) => `<option value="${v}" ${autonomy.workspaceCeiling === v ? "selected" : ""}>${esc(l)}</option>`).join("")}</select></div>${grants.length ? grants.map(grantCard).join("") : "<p>No scoped agent connections have been created.</p>"}`,
    action("close-dialog", "Close") + action("new-client", "Create connection", "plus", "", "primary"), true);
  $("bootstrap-level").onchange = (e) => void execute("autonomy.update", { bootstrapLevel: e.target.value }, true).then(() => toast("Bootstrap token autonomy updated.")).catch((error) => toast(errorMessage(error)));
  $("workspace-level").onchange = (e) => void execute("autonomy.update", { workspaceId: ws().id, level: e.target.value || null }, true).then(() => toast("Workspace autonomy limit updated.")).catch((error) => toast(errorMessage(error)));
}
function grantFields(grant = {}) {
  const others = state.workspaces.filter((w) => !w.archived && w.id !== ws().id);
  const checked = (list, value, fallback) => ((list ?? fallback).includes(value) ? "checked" : "");
  return `${field("Purpose", "purpose", grant.purpose || "")}<fieldset><legend>Allowed actions</legend><label><input type="checkbox" name="scope" value="read" ${checked(grant.scopes, "read", ["read"])}> Read workspace records and page evidence</label><label><input type="checkbox" name="scope" value="records.write" ${checked(grant.scopes, "records.write", [])}> Create, edit, and delete records</label><label><input type="checkbox" name="scope" value="tabs.control" ${checked(grant.scopes, "tabs.control", [])}> Control tabs, navigate, and interact with pages</label><label><input type="checkbox" name="actionClass" value="code_exec" ${checked(grant.actionClasses, "code_exec", [])}> Run page scripts (always an external action)</label><label><input type="checkbox" name="actionClass" value="cloud_spend" ${checked(grant.actionClasses, "cloud_spend", [])}> Send messages to model connections</label></fieldset>${choice("Autonomy", "autonomy", Object.entries(levelLabels), grant.autonomy || "scoped")}<fieldset><legend>Data this agent may read</legend>${Object.entries(dataClassLabels).map(([v, l]) => `<label><input type="checkbox" name="dataAccess" value="${v}" ${checked(grant.dataAccess, v, Object.keys(dataClassLabels))}> ${esc(l)}</label>`).join("")}</fieldset>${area("Allowed sites (one per line, e.g. https://docs.example.com or *.example.org; blank for any site)", "destinations", (grant.destinations || []).filter((d) => d !== "*").join("\n"))}${field("Command limit (blank for none)", "maxCommands", grant.maxCommands ?? "", "number")}${others.length ? `<fieldset><legend>Additional workspaces</legend>${others.map((w) => `<label><input type="checkbox" name="workspace" value="${esc(w.id)}" ${checked(grant.workspaceIds, w.id, [])}> ${esc(w.name)}</label>`).join("")}<label><input type="checkbox" name="crossWorkspace" value="yes" ${grant.crossWorkspace ? "checked" : ""}> I explicitly allow this agent to work across these workspaces</label></fieldset>` : ""}`;
}
function grantValues(form, current = ws().id) {
  const destinations = String(form.get("destinations") || "").split(/\n+/).map((v) => v.trim()).filter(Boolean);
  const workspaceIds = [current, ...form.getAll("workspace")];
  const scopes = form.getAll("scope");
  if (!scopes.length) throw new Error("Select at least one allowed action.");
  const limit = String(form.get("maxCommands") || "").trim();
  return { purpose: String(form.get("purpose") || "").trim(), scopes, actionClasses: form.getAll("actionClass"), autonomy: form.get("autonomy"), dataAccess: form.getAll("dataAccess"),
    destinations: destinations.length ? destinations : ["*"], maxCommands: limit ? Number(limit) : null,
    workspaceIds, crossWorkspace: workspaceIds.length > 1 && form.get("crossWorkspace") === "yes" };
}
function createClient() {
  openDialog("Create agent connection",
    `<p>This token grants access to <strong>${esc(ws().name)}</strong> unless you explicitly add workspaces. Choose the least access this agent needs. External actions wait for your approval unless you grant standing approval.</p><form id="client-form">${field("Agent name", "name", "", "text", true)}${grantFields()}${choice("Expires after", "ttlSeconds", [["3600", "1 hour"], ["86400", "1 day"], ["604800", "7 days"], ["2592000", "30 days"]], "3600")}<button type="submit" hidden></button></form>`,
    action("close-dialog", "Cancel") + '<button type="submit" form="client-form" class="primary">Create token</button>', true);
  $("client-form").onsubmit = async event => {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const button = $("dialog-content").querySelector('button[form="client-form"]');
    button.disabled = true;
    try {
      // Quiet execution avoids retaining this one-time token in the command desk.
      const grant = await execute("clients.create", { name: form.get("name"), ...grantValues(form), ttlSeconds: Number(form.get("ttlSeconds")) }, true);
      openDialog("Save your agent token",
        `<p>Copy this token now. It will not be shown again after closing this dialog. If it is lost or exposed, revoke it and create a replacement.</p><p>Connection: ${esc(grant.name)}. Expires: ${esc(new Date(grant.expiresAt).toLocaleString())}.</p><label>Agent token<textarea id="new-client-token" readonly autocomplete="off" spellcheck="false"></textarea></label>`,
        action("close-dialog", "Done"));
      $("new-client-token").value = grant.token;
      $("new-client-token").focus();
      $("new-client-token").select();

    } catch (error) {
      if ($("form-error")) $("form-error").textContent = errorMessage(error);
    } finally { button.disabled = false; }
  };
}
async function editClient(id) {
  const grant = (await execute("clients.list", {}, true)).find((g) => g.clientId === id);
  if (!grant) return toast("Agent connection not found.");
  const home = grant.workspaceIds.includes(ws().id) ? ws().id : grant.workspaceIds[0];
  formDialog(`Change access: ${grant.name}`, grantFields(grant), async () => {
    const changes = grantValues(new FormData($("edit-form")), home);
    await execute("clients.update", { clientId: id, changes }, true);
    toast("Access updated. It applies to the agent’s next command.");
    setTimeout(() => void manageClients().catch(() => {}), 0);
  }, { save: "Save access", wide: true });
}
async function loadDownloads() {
  try {
    const rows = await execute("downloads.list", {}, true);
    if (!$("download-list")) return;
    $("download-list").innerHTML = rows.length
      ? rows
          .map(
            (r) =>
              `<div class="activity-row"><span class="activity-dot icon">${icon("download")}</span><div><strong>${esc(r.filename)}</strong><p>${esc(host(r.url))} · ${esc(r.state)} · ${Math.round(r.receivedBytes / 1024)} KB${r.reason ? " · " + esc(r.reason) : ""} · Not scanned</p></div>${r.state === "blocked" ? action("approve-download", "Allow download", "download", 'data-id="' + r.id + '"') : r.state === "progressing" ? action("cancel-download", "Cancel", "", 'data-id="' + r.id + '"') : ""}</div>`,
          )
          .join("")
      : empty(
          "Nothing downloaded yet",
          "Files you download will appear here with their source and status.",
          "download",
        );
  } catch {}
}
function layout() {
  if (!window.weft.layout) return;
  const box = $("content").getBoundingClientRect();
  const show =
    section === "browse" &&
    !!active() &&
    !$("dialog").open &&
    active().url !== "about:blank" &&
    !active().blocked;
  return window.weft
    .layout({
      x: Math.round(box.x),
      y: Math.round(box.y),
      width: Math.floor(box.width),
      height: Math.floor(box.height),
      visible: show,
      ...(splitTabId ? { splitTabId } : {}),
    })
    .catch(() => {});
}
function navigateSection(next) {
  section = next;
  filter = "";
  taskFilter = "";
  renderShell();
  renderContent();
  $("content").scrollTop = 0;
  $("content").focus({ preventScroll: true });
}
function openDialog(title, body, footer = "", wide = false) {
  const desk = $("command-desk");
  if (desk?.closest("#dialog")) {
    desk.hidden = true;
    document.body.append(desk);
  }
  if (!$("dialog").open) dialogRestore = rememberFocus();
  $("dialog").classList.toggle("dialog-wide", wide);
  $("dialog-content").innerHTML =
    `<div class="dialog-header"><h2 id="dialog-title">${esc(title)}</h2><button class="icon-button" data-action="close-dialog" aria-label="Close dialog">${icon("close")}</button></div><div class="dialog-body">${body}<div class="form-error" id="form-error" role="alert"></div></div>${footer ? `<div class="dialog-footer">${footer}</div>` : ""}`;
  if (!$("dialog").open) $("dialog").showModal();
  layout();
  setTimeout(
    () => $("dialog-content").querySelector("input,textarea,select")?.focus(),
    30,
  );
}
function clearDialogSecrets() {
  const token = $("new-client-token");
  if (token) {
    token.value = "";
    token.textContent = "";
    $("dialog-content").replaceChildren();
  }
}
function closeDialog() {
  clearDialogSecrets();
  const desk = $("command-desk");
  if (desk && desk.closest("#dialog")) {
    desk.hidden = true;
    document.body.append(desk);
  }
  $("dialog").close();
  layout();
  dialogRestore?.();
}
function field(label, name, value = "", type = "text", required = false) {
  return `<label>${esc(label)}<input name="${name}" type="${type}" value="${esc(value)}" ${required ? "required" : ""}></label>`;
}
function area(label, name, value = "", required = false) {
  return `<label>${esc(label)}<textarea name="${name}" ${required ? "required" : ""}>${esc(value)}</textarea></label>`;
}
function choice(label, name, options, value) {
  return `<label>${esc(label)}<select name="${name}">${options
    .map((o) => {
      const [v, l] = Array.isArray(o) ? o : [o, o];
      return `<option value="${esc(v)}" ${v === value ? "selected" : ""}>${esc(l)}</option>`;
    })
    .join("")}</select></label>`;
}
function formDialog(
  title,
  fields,
  onSave,
  { save = "Save", extra = "", wide = false } = {},
) {
  openDialog(
    title,
    `<form id="edit-form">${fields}<button type="submit" hidden></button></form>`,
    extra +
      action("close-dialog", "Cancel") +
      `<button type="submit" form="edit-form" class="primary">${save}</button>`,
    wide,
  );
  $("edit-form").onsubmit = async (e) => {
    e.preventDefault();
    const button = $("dialog-content").querySelector("button[form]");
    button.disabled = true;
    try {
      await onSave(Object.fromEntries(new FormData($("edit-form"))));
      closeDialog();
      await refresh(true);
    } catch (error) {
      if ($("dialog").open && $("form-error"))
        $("form-error").textContent = errorMessage(error);
      else toast(errorMessage(error));
    } finally {
      button.disabled = false;
    }
  };
}
function workspaceForm(record) {
  formDialog(
    record ? "Edit workspace" : "Create a workspace",
    field("Workspace name", "name", record?.name || "", "text", true) +
      area(
        "What are you working on?",
        "description",
        record?.description || "",
      ) +
      choice(
        "Workspace symbol",
        "icon",
        ["W", "✦", "○", "□", "△", "✳"],
        record?.icon || "W",
      ),
    async (values) => {
      if (record)
        await execute("workspaces.update", { id: record.id, changes: values });
      else {
        const created = await execute("workspaces.create", values);
        await execute("workspaces.switch", { id: created.id });
        section = "overview";
      }
    },
    { save: record ? "Save changes" : "Create workspace" },
  );
}
function editRecord(kind, id) {
  const r = id ? (state[kind] || []).find((r) => r.id === id) : null;
  let fields = "";
  if (kind === "siteRules") {
    fields =
      choice(
        "Rule status",
        "enabled",
        [
          ["true", "Enabled"],
          ["false", "Inactive"],
        ],
        String(r?.enabled !== false),
      ) +
      field(
        "Domain (for example, example.com)",
        "hostname",
        r?.hostname || "",
        "text",
        true,
      ) +
      choice(
        "Behavior",
        "behavior",
        [
          ["block", "Block"],
          ["warn", "Warn"],
        ],
        r?.behavior || "block",
      ) +
      choice(
        "Coverage",
        "mode",
        [
          ["navigation", "Visits, redirects, and popups"],
          ["connection", "All matching browser connections"],
        ],
        r?.mode || "navigation",
      ) +
      choice(
        "Scope",
        "scope",
        [
          ["workspace", "This workspace"],
          ["global", "Every workspace"],
        ],
        r?.scope || "workspace",
      ) +
      choice(
        "Subdomains",
        "includeSubdomains",
        [
          ["true", "Include subdomains"],
          ["false", "Exact hostname only"],
        ],
        String(r?.includeSubdomains ?? true),
      ) +
      field("Path prefix", "path", r?.path || "/") +
      field("Reason", "reason", r?.reason || "Personal preference") +
      area("Note", "note", r?.note || "");
  } else {
    fields = field("Title", "title", r?.title || "", "text", true);
    if (kind === "materials")
      fields +=
        choice(
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
        field("Website URL (optional)", "url", r?.url || "", "url") +
        area("Notes or content", "content", r?.content || "") +
        (!r
          ? '<label class="file-upload">Attach a file (up to 10 MB)<input id="material-file" type="file"></label>'
          : "") +
        choice(
          "Pinned",
          "pinned",
          [
            ["false", "No"],
            ["true", "Yes"],
          ],
          String(r?.pinned || false),
        );
    if (kind === "context")
      fields +=
        choice(
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
        area("Content", "content", r?.content || "", true) +
        area("Sources (one per line)", "sources", r?.sources?.join("\n") || "");
    if (kind === "tasks")
      fields +=
        area("Objective", "objective", r?.objective || "") +
        choice(
          "State",
          "status",
          [
            ["queued", "Queued"],
            ["running", "Running"],
            ["waiting", "Waiting for you"],
            ["paused", "Paused"],
            ["completed", "Completed"],
            ["failed", "Failed"],
            ["cancelled", "Cancelled"],
          ],
          r?.status || "queued",
        ) +
        field("Assignee", "assignee", r?.assignee || "human") +
        area("Checkpoint / completed work", "checkpoint", r?.checkpoint || "") +
        field("Next step", "nextStep", r?.nextStep || "") +
        field("Blocker", "blocker", r?.blocker || "");
    if (kind === "workflows")
      fields +=
        choice(
          "Workflow status",
          "enabled",
          [
            ["true", "Enabled"],
            ["false", "Inactive"],
          ],
          String(r?.enabled !== false),
        ) +
        area("Description", "description", r?.description || "") +
        area(
          "Steps (one instruction per line)",
          "steps",
          r?.steps?.map((s) => s.instruction).join("\n") || "",
          true,
        ) +
        area("Expected outputs", "expectedOutputs", r?.expectedOutputs || "");
  }
  formDialog(
    `${r ? "Edit" : "New"} ${kind === "siteRules" ? "site rule" : kind === "materials" ? "material" : kind === "context" ? "context record" : kind === "tasks" ? "task" : kind === "workflows" ? "workflow" : "conversation"}`,
    fields,
    async (values) => {
      if ("url" in values && !values.url) {
        if (r) values.url = null;
        else delete values.url;
      }
      if ("enabled" in values) values.enabled = values.enabled === "true";
      if ("pinned" in values) values.pinned = values.pinned === "true";
      if ("includeSubdomains" in values)
        values.includeSubdomains = values.includeSubdomains === "true";
      if (kind === "context")
        values.sources = values.sources
          .split("\n")
          .map((s) => s.trim())
          .filter(Boolean);
      if (kind === "workflows")
        values.steps = values.steps
          .split("\n")
          .filter((s) => s.trim())
          .map((s, i) => ({
            title: `Step ${i + 1}`,
            instruction: s,
            reviewRequired: true,
          }));
      const file = $("material-file")?.files[0];
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
      const result = await execute(
        `${kind}.${r ? "update" : "create"}`,
        r
          ? { id: r.id, changes: values, expectedRevision: r.revision }
          : { workspaceId: ws().id, ...values },
      );
      if (kind === "conversations") {
        conversationId = result.id;
        openAgent();
      }
    },
    {
      save: r ? "Save changes" : "Create",
      extra: r
        ? action(
            "delete-record",
            "Delete",
            "trash",
            `data-kind="${kind}" data-id="${esc(r.id)}"`,
            "secondary danger",
          )
        : "",
    },
  );
}
async function confirmDelete(kind, id) {
  formDialog(
    "Delete this item?",
    `<p>This permanently removes the selected ${kind === "workspaces" ? "workspace and its saved project contents" : "item"}. This cannot be undone.</p>`,
    async () => {
      await execute(`${kind}.delete`, { id });
    },
    { save: "Delete permanently" },
  );
}
async function workspaceMenu() {
  openDialog(
    "Your workspaces",
    state.workspaces
      .map(
        (w) =>
          `<div class="settings-row"><div><strong>${esc(w.name)}</strong><small>${w.archived ? "Archived" : "Active workspace"} · ${date(w.updatedAt)}</small></div><div class="inline-actions">${action(w.archived ? "restore-workspace" : "switch-workspace", w.archived ? "Restore" : "Open", "", 'data-id="' + esc(w.id) + '"')}${action("edit-workspace", "Edit", "", 'data-id="' + esc(w.id) + '"')}${action("archive-workspace", w.archived ? "Delete" : "Archive", "", 'data-id="' + esc(w.id) + '"')}</div></div>`,
      )
      .join("") +
      `<div class="notice">Duplicating copies project records and saved references. Browser login sessions and model credentials are excluded. Copied rules and workflows stay inactive until reviewed.</div><div class="inline-actions">${action("duplicate-workspace", "Duplicate current", "tabs")}${action("export-workspace", "Export current", "download")}</div>`,
    action("new-workspace", "New workspace", "plus", "", "primary"),
    true,
  );
}
async function capture(artifactId) {
  await refresh(true);
  if (!active() || active().url === "about:blank")
    throw new Error("Open a web page before saving a capture.");
  formDialog(
    artifactId ? "Save a new capture version" : "Save page to workspace",
    field("Title", "title", displayTitle(active()), "text", true) +
      area("Why is this useful?", "note", "") +
      choice(
        "Capture",
        "kind",
        [
          ["bundle", "Reference bundle · text + screenshot"],
          ["text", "Readable text"],
          ["screenshot", "Screenshot"],
        ],
        "bundle",
      ) +
      "<p>Saved captures are historical references. Review the page for private information before saving it.</p>",
    async (values) => {
      closeDialog();
      section = "browse";
      renderShell();
      renderContent();
      await layout();
      await new Promise((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(resolve)),
      );
      await execute("artifacts.capture", {
        ...values,
        workspaceId: ws().id,
        tabId: active().id,
        ...(artifactId ? { artifactId } : {}),
      });
      section = "artifacts";
      toast("Saved to your workspace.");
    },
    { save: "Save capture" },
  );
}
async function viewArtifact(id, versionId) {
  const r = await execute(
    "artifacts.get",
    { id, ...(versionId ? { versionId } : {}) },
    true,
  );
  const version = r.version || r.versions?.at(-1) || r;
  const text = version.text ?? r.text ?? "";
  const png = version.pngBase64 ?? r.pngBase64;
  const versions =
    r.versions || state.artifacts.find((a) => a.id === id)?.versions || [];
  openDialog(
    r.title || "Saved capture",
    `<span class="tag sage">Saved capture · Offline</span><div class="notice">${esc(version.url || version.sourceUrl || "Local capture")}<br>${esc(new Date(version.createdAt || r.createdAt).toLocaleString())}<br>${esc((version.limitations || []).join?.(" ") || version.limitations || "Text and image are captured separately. Dynamic or lazy-loaded content may be incomplete.")}</div>${versions.length > 1 ? `<label>Version<select id="capture-version">${versions.map((v, i) => `<option value="${esc(v.id)}" ${v.id === (version.id || versionId) ? "selected" : ""}>Version ${i + 1} · ${date(v.createdAt)}</option>`).join("")}</select></label>` : ""}${png ? `<img class="artifact-image" src="data:image/png;base64,${esc(png)}" alt="Saved page screenshot">` : ""}<pre class="artifact-text">${esc(text)}</pre>`,
    action(
      "delete-record",
      "Delete all versions",
      "trash",
      `data-kind="artifacts" data-id="${esc(id)}"`,
      "secondary danger",
    ) + action("close-dialog", "Close"),
    true,
  );
  if ($("capture-version"))
    $("capture-version").onchange = () =>
      void viewArtifact(id, $("capture-version").value).catch((e) =>
        toast(errorMessage(e)),
      );
}
function downloadJson(name, value) {
  const a = document.createElement("a");
  a.href =
    "data:application/json;charset=utf-8," +
    encodeURIComponent(JSON.stringify(value, null, 2));
  a.download = name;
  a.click();
}
function exportWorkspace() {
  openDialog("Review workspace export",
    `<p>Exports may contain private notes, messages, captures, and files. Model credentials and browser sessions are excluded.</p><form id="export-form">${area("Optional sensitive terms to check (one per line)", "sensitiveTerms")}<p>Terms are checked locally. Images and unsupported binary files cannot be verified by a text scan.</p><button class="primary" type="submit">Prepare export</button></form><div id="export-review" aria-live="polite"></div>`,
    action("close-dialog", "Cancel"));
  $("export-form").onsubmit = async (event) => {
    event.preventDefault();
    const button = event.currentTarget.querySelector("button");
    button.disabled = true;
    try {
      const sensitiveTerms = new FormData(event.currentTarget).get("sensitiveTerms").split(/\r?\n/).map(x => x.trim()).filter(Boolean);
      const bundle = await execute("workspaces.export", { id: ws().id, ...(sensitiveTerms.length ? { sensitiveTerms } : {}) }, true);
      const scan = bundle.residueScan;
      $("export-review").innerHTML = `<div class="notice">${scan ? `Sensitive-term scan: <strong>${esc(scan.status)}</strong>. ${scan.found?.length || 0} term matches; ${scan.unverifiable?.length || 0} items could not be verified. ${esc(scan.scope || "")}` : "No sensitive-term scan requested."} Review this result before saving; a clean text scan does not establish that the export is free of private information.</div><button id="save-export" class="primary">Save reviewed export</button>`;
      $("save-export").onclick = () => {
        downloadJson(`${ws().name.replace(/[^a-z\d -]/gi, "") || "workspace"}.weft.json`, bundle);
        closeDialog();
        toast("Workspace export prepared.");
      };
    } catch (error) {
      $("form-error").textContent = errorMessage(error);
    } finally { button.disabled = false; }
  };
}
function acknowledgeDisclosure(disclosure) {
  return new Promise(resolve => {
    let accepted = false;
    openDialog("Review model destination",
      `<p>Your request will be sent to <strong>${esc(disclosure.endpoint)}</strong> using ${esc(disclosure.model)} (${esc(disclosure.locality)}).</p><ul>${(disclosure.items || []).map(item => `<li>${esc(item.kind)}: ${esc(item.title || item.id || "Request data")} · ${Number(item.bytes) || 0} bytes${item.withheld ? " · withheld" : ""}</li>`).join("")}</ul><p>Total disclosed bytes: ${Number(disclosure.totalBytes) || 0}. Tools: ${esc((disclosure.tools || []).join(", ") || "None")}.</p>${disclosure.toolScope ? `<p>Tool scope: workspace ${esc(disclosure.toolScope.workspaceId)}${disclosure.toolScope.tabId ? `, tab ${esc(disclosure.toolScope.tabId)}` : ""}; at most ${Number(disclosure.toolScope.maxCalls)} calls.</p>` : ""}<p>This acknowledgement applies to this workspace and this model destination. Review your selections before each request.</p>`,
      action("close-dialog", "Cancel") + '<button id="acknowledge-disclosure" class="primary">Acknowledge and send</button>');
    $("dialog").addEventListener("close", () => resolve(accepted), { once: true });
    $("acknowledge-disclosure").onclick = () => { accepted = true; closeDialog(); };
  });
}
function importWorkspace() {
  formDialog(
    "Import a workspace",
    '<p>Imported policies and workflows stay inactive until reviewed. Model keys and browser sessions are not imported.</p><label>Workspace export<input id="import-file" type="file" accept="application/json,.json" required></label>',
    async () => {
      const f = $("import-file").files[0];
      if (!f || f.size > 50 * 1024 * 1024)
        throw new Error("Choose a JSON workspace export under 50 MB.");
      const result = await execute("workspaces.import", {
        data: JSON.parse(await f.text()),
      });
      toast(
        "Workspace imported. Review its contents before enabling policies.",
      );
      if (result.id) await execute("workspaces.switch", { id: result.id });
    },
    { save: "Import as new workspace" },
  );
}
function modelForm(id) {
  const r = models.find((m) => m.id === id);
  formDialog(
    r ? "Configure model connection" : "Add model connection",
    field("Connection name", "name", r?.name || "", "text", true) +
      choice(
        "API format",
        "provider",
        [
          ["openai", "OpenAI-compatible (including local models)"],
          ["anthropic", "Anthropic"],
        ],
        r?.provider || "openai",
      ) +
      field(
        "API base URL",
        "endpoint",
        r?.endpoint || "http://localhost:11434/v1",
        "url",
        true,
      ) +
      field("Model ID", "model", r?.model || "", "text", true) +
      choice(
        "Read-only tool capability (OpenAI-compatible only)",
        "tools",
        [
          ["false", "Text only"],
          ["true", "Enable page reading and workspace search"],
        ],
        String(r?.tools || false),
      ) +
      field(
        "API key (optional; encrypted by the OS)",
        "apiKey",
        "",
        "password",
      ) +
      field("Or environment variable name", "apiKeyEnv", r?.apiKeyEnv || "") +
      "<p>Keys are stored separately from project files. Saving a key requires OS secure storage. Local models may not require a key.</p>",
    async (values) => {
      values.tools = values.tools === "true";
      if (!values.apiKey) delete values.apiKey;
      if (!values.apiKeyEnv) delete values.apiKeyEnv;
      await execute("models.save", { ...values, ...(r ? { id: r.id } : {}) });
      await loadModels();
      if (agentOpen) renderAgent();
    },
    {
      save: "Save connection",
      extra: r
        ? action(
            "delete-model",
            "Remove connection",
            "trash",
            `data-id="${esc(r.id)}"`,
            "secondary danger",
          )
        : "",
    },
  );
}
async function loadModels() {
  models = await execute("models.list", {}, true);
  if (!models.some((m) => m.id === modelId)) modelId = models[0]?.id || "";
}
function openAgent() {
  agentOpen = true;
  void execute("settings.update", { agentPanelOpen: true }, true).catch(
    () => {},
  );
  $("app").classList.add("agent-open");
  $("agent-panel").hidden = false;
  renderShell();
  renderAgent();
  layout();
}
function closeAgent() {
  agentOpen = false;
  void execute("settings.update", { agentPanelOpen: false }, true).catch(
    () => {},
  );
  $("app").classList.remove("agent-open");
  $("agent-panel").hidden = true;
  $("agent-toggle").focus();
  renderShell();
  layout();
}
function renderAgent() {
  const conversation = records("conversations").find(
    (c) => c.id === conversationId,
  );
  if (!conversation) conversationId = null;
  $("agent-panel").innerHTML =
    `<div class="agent-header"><span class="agent-symbol icon">${icon("spark")}</span><div><strong>${esc(conversation?.title || "A thinking partner")}</strong><small>WITH YOUR WORKSPACE</small></div><button class="icon-button" data-action="new-chat" aria-label="New conversation">${icon("plus")}</button><button class="icon-button" data-action="close-agent" aria-label="Close agent panel">${icon("close")}</button></div><div class="agent-model"><select id="chat-model" aria-label="Choose model">${models.map((m) => `<option value="${esc(m.id)}" ${m.id === modelId ? "selected" : ""}>${esc(m.name)} · ${esc(m.model)}</option>`).join("")}</select><small id="model-destination"></small></div><div id="chat-messages" class="chat-messages" role="log" aria-label="Conversation messages" aria-live="polite" aria-relevant="additions text"></div><form id="chat-form" class="chat-composer"><textarea id="chat-input" aria-label="Message your model" placeholder="What would you like to work on?" required></textarea><label class="chat-tool-choice"><input id="allow-read-tools" type="checkbox">Allow reading current tab & workspace search</label><div class="composer-footer"><label><input id="include-context" type="checkbox">Project context (${records("context").length})</label><button class="primary" id="chat-send" type="submit">${icon("arrow")}Send</button></div></form>`;
  updateDestination();
  renderMessages();
  $("chat-model").onchange = () => {
    modelId = $("chat-model").value;
    updateDestination();
  };
  $("chat-form").onsubmit = sendChat;
}
function updateDestination() {
  const m = models.find((m) => m.id === modelId);
  $("model-destination").textContent = m
    ? `${m.endpoint} · ${m.capabilities?.tools ? "Read-only tools available (opt-in below)" : "Text only · No automatic page access"}`
    : "Add a model connection in Settings to start.";
  if ($("allow-read-tools")) {
    $("allow-read-tools").disabled = !m?.capabilities?.tools;
    if (!m?.capabilities?.tools) $("allow-read-tools").checked = false;
  }
}
function renderMessages() {
  if (!$("chat-messages")) return;
  const c = records("conversations").find((c) => c.id === conversationId);
  const messages = c?.messages || [];
  $("chat-messages").innerHTML = messages.length
    ? messages
        .map(
          (m) =>
            `<div class="chat-message ${m.role === "user" ? "user" : "assistant"}"><div class="message-author">${esc(m.role === "user" ? "YOU" : m.role === "tool" ? "READ-ONLY TOOL" : m.model || "MODEL")}${m.status && m.status !== "complete" ? " · " + esc(m.status) : ""}</div><div class="message-body">${m.role === "tool" ? `<details><summary>Source and tool result</summary><pre class="tool-result">${esc(m.content)}</pre></details>` : esc(m.content)}</div></div>`,
        )
        .join("")
    : `<div class="chat-welcome"><span class="agent-symbol icon">${icon("spark")}</span><h3>A little help,<br>a fresh perspective.</h3><p>Think through an idea, make a plan, or ask a question. Choose a model above to get started.</p><button data-action="chat-prompt" data-text="Help me turn a project idea into a clear plan.">Help me make a plan ${icon("arrow")}</button><button data-action="chat-prompt" data-text="Help me organize my research. What should I collect first?">Organize my research ${icon("arrow")}</button><button data-action="section" data-section="settings">Configure a model ${icon("settings")}</button></div>`;
  if (chatBusy)
    $("chat-messages").innerHTML +=
      '<p class="muted">Waiting for your model…</p>';
  $("chat-messages").scrollTop = $("chat-messages").scrollHeight;
}
async function sendChat(e) {
  e.preventDefault();
  if (chatBusy) return;
  const input = $("chat-input"),
    text = input.value.trim();
  if (!text || !modelId) return;
  chatBusy = true;
  $("chat-send").disabled = true;
  try {
    if (!conversationId) {
      const c = await execute(
        "conversations.create",
        { title: short(text, 65), workspaceId: ws().id },
        true,
      );
      conversationId = c.id;
    }
    const context = $("include-context").checked
      ? records("context")
          .slice(0, 12)
          .map((r) => ({
            id: r.id,
            recordType: "context",
            localOnly: !!r.localOnly,
            title: `${r.category}: ${r.title}`,
            content: r.content.slice(0, 100000),
          }))
      : [];
    const request = {
      conversationId, modelId, text, context,
      allowReadTools: $("allow-read-tools").checked,
      ...($("allow-read-tools").checked && active() && active().url !== "about:blank" ? { tabId: active().id } : {}),
    };
    if (catalog["chat.preview"]) {
      const preview = await execute("chat.preview", request, true);
      if (preview.disclosure.requiresAcknowledgement) {
        if (!await acknowledgeDisclosure(preview.disclosure)) return;
        request.disclosureAck = true;
      }
    }
    input.value = "";
    $("chat-messages").innerHTML +=
      `<div class="chat-message user"><div class="message-author">YOU</div><div class="message-body">${esc(text)}</div></div><p class="muted" id="chat-waiting">Waiting for your model… ${action("cancel-chat", "Cancel", "", "", "text-button")}</p>`;
    await execute("chat.send", request, true);
    await refresh(true);
  } catch (error) {
    toast(errorMessage(error));
    await refresh(true);
  } finally {
    chatBusy = false;
    if ($("chat-send")) $("chat-send").disabled = false;
    renderMessages();
  }
}
function selectCommand() {
  const entry = catalog[$("command").value];
  if (!entry) return;
  $("description").textContent = entry.description;
  $("schema").textContent = JSON.stringify(entry.inputSchema, null, 2);
  const args = {};
  for (const key of entry.inputSchema.required || []) {
    const p = entry.inputSchema.properties[key];
    args[key] =
      p.type === "integer"
        ? active()?.id || 1
        : p.type === "boolean"
          ? false
          : p.type === "object"
            ? {}
            : p.type === "array"
              ? []
              : "";
  }
  $("arguments").value = JSON.stringify(args, null, 2);
}
function openCommands() {
  openDialog(
    "Command desk",
    '<p>Every action uses the same command catalog as the CLI, REST API, and MCP.</p><div id="command-slot"></div>',
    "",
    true,
  );
  const desk = $("command-desk");
  desk.className = "command-panel";
  desk.hidden = false;
  $("command-slot").append(desk);
}
function palette() {
  openDialog(
    "Find anything",
    '<input id="palette-query" class="palette-input" aria-label="Search workspaces and commands" placeholder="Search your project or choose an action…"><div id="palette-results" class="palette-results"></div>',
    "",
    true,
  );
  const defaults = [
    ["new-tab", "Open a new tab", "Ctrl T"],
    ["new-material", "Add a material", ""],
    ["new-task", "Create a task", ""],
    ["ask", "Ask your model", ""],
    ["capture", "Save current page", ""],
    ["commands", "Open command desk", ""],
    ...Object.keys(names)
      .filter((k) => k !== "browse")
      .map((k) => ["section", names[k], "", k]),
  ];
  const draw = (items) => ($("palette-results").innerHTML = items);
  $("palette-query").oninput = async () => {
    const q = $("palette-query").value.trim();
    const filtered = defaults.filter((x) =>
      x[1].toLowerCase().includes(q.toLowerCase()),
    );
    let html = filtered
      .map(
        ([a, l, k, s]) =>
          `<button class="palette-item" data-action="${a}" ${s ? 'data-section="' + s + '"' : ""}>${icon("arrow")}${l}<small>${k}</small></button>`,
      )
      .join("");
    if (q) {
      const results = await execute(
        "search.query",
        { query: q, workspaceId: ws().id, limit: 20 },
        true,
      );
      const rows = Array.isArray(results) ? results : results.results || [];
      html += rows
        .map(
          (r) =>
            `<button class="palette-item" data-action="search-result" data-kind="${esc(r.collection || r.type || r.kind)}" data-id="${esc(r.id)}">${icon("file")}${esc(r.title || r.name)}<small>${esc(r.collection || r.type || "")}</small></button>`,
        )
        .join("");
    }
    if ($("palette-results"))
      draw(html || '<p class="muted">No matches found.</p>');
  };
  $("palette-query").oninput();
}
async function openUrl(value) {
  await refresh(true);
  let url = value.trim();
  if (!url) return;
  if (!/^[a-z][a-z\d+.-]*:/i.test(url)) {
    url =
      /\s/.test(url) || (!url.includes(".") && !url.startsWith("localhost"))
        ? `https://www.google.com/search?q=${encodeURIComponent(url)}`
        : `https://${url}`;
  }
  section = "browse";
  renderShell();
  renderContent();
  try {
    await execute(active() ? "page.navigate" : "tabs.new", { url });
  } finally {
    layout();
  }
}
async function act(button) {
  const a = button.dataset.action,
    id = button.dataset.id,
    kind = button.dataset.kind;
  if (button.closest?.(".palette-results")) closeDialog();
  switch (a) {
    case "manage-clients":
      await manageClients();
      break;
    case "new-client":
      createClient();
      break;
    case "revoke-client":
      await execute("clients.revoke", { clientId: id }, true);
      await manageClients();
      break;
    case "edit-client":
      await editClient(id);
      break;
    case "approval-decide": {
      const mode = button.dataset.mode;
      if (mode === "reject") await execute("approvals.reject", { id }, true);
      else await execute("approvals.approve", { id, mode, standingMinutes: 60 }, true);
      toast(mode === "reject" ? "Request rejected. The agent will see the refusal." : mode === "once" ? "Approved once. The agent can now retry exactly this action." : "Approved for 1 hour for this action type, workspace and site.");
      await refresh(true);
      await loadApprovals();
      break;
    }
    case "activity-more":
      await loadActivity(true);
      break;
    case "activity-settings":
      await activitySettings();
      break;
    case "blocked-back":
      await execute("page.back");
      break;
    case "allow-once":
      await execute("page.allowOnce", { tabId: active().id });
      break;
    case "section":
      if ($("dialog").open) closeDialog();
      navigateSection(button.dataset.section);
      break;
    case "new-workspace":
      workspaceForm();
      break;
    case "workspace-menu":
      await workspaceMenu();
      break;
    case "edit-workspace":
      workspaceForm(state.workspaces.find((w) => w.id === id));
      break;
    case "switch-workspace":
      await execute("workspaces.switch", { id });
      conversationId = null;
      splitTabId = null;
      if ($("dialog").open) closeDialog();
      navigateSection("overview");
      if (agentOpen) renderAgent();
      break;
    case "archive-workspace":
      if (state.workspaces.find((w) => w.id === id)?.archived)
        await confirmDelete("workspaces", id);
      else {
        await execute("workspaces.archive", { id });
        await workspaceMenu();
      }
      break;
    case "restore-workspace":
      await execute("workspaces.restore", { id });
      await workspaceMenu();
      break;
    case "duplicate-workspace":
      await execute("workspaces.duplicate", { id: ws().id });
      await workspaceMenu();
      break;
    case "export-workspace":
      exportWorkspace();
      break;
    case "import-workspace":
      importWorkspace();
      break;
    case "new-tab":
      await execute("tabs.new", {});
      navigateSection("browse");
      $("address").focus();
      break;
    case "activate-tab":
      await execute("tabs.activate", { tabId: Number(id) });
      navigateSection("browse");
      break;
    case "close-tab":
      await execute("tabs.close", { tabId: Number(id) });
      if (!visibleTabs().length) navigateSection("overview");
      break;
    case "pin-tab":
      await execute("tabs.pin", {
        tabId: Number(id),
        pinned: !tabs.find((t) => t.id === Number(id))?.pinned,
      });
      break;
    case "takeover":
      await execute("tabs.takeover", { tabId: Number(id) });
      break;
    case "new-material":
      editRecord("materials");
      break;
    case "new-task":
      editRecord("tasks");
      break;
    case "new-record":
      editRecord(kind);
      break;
    case "edit-record":
      editRecord(kind, id);
      break;
    case "delete-record":
      await confirmDelete(kind, id);
      break;
    case "task-state":
      await execute("tasks.transition", {
        id,
        status: button.dataset.state,
        cause: "Changed by you in the workspace",
      });
      break;
    case "run-workflow": {
      const w = records("workflows").find((w) => w.id === id);
      if (w.enabled === false) {
        editRecord("workflows", id);
        toast("Review and enable this imported workflow first.");
        break;
      }
      for (const step of w.steps)
        await execute("tasks.create", {
          workspaceId: ws().id,
          title: short(`${w.title}: ${step.title}`, 239),
          objective: step.instruction,
          status: "queued",
          assignee: "human",
        });
      navigateSection("tasks");
      toast("Workflow steps added as queued tasks.");
      break;
    }
    case "open-url":
      if ($("dialog").open) closeDialog();
      await execute("tabs.new", { url: button.dataset.url });
      navigateSection("browse");
      break;
    case "capture":
      await capture();
      break;
    case "recapture":
      await capture(id);
      break;
    case "view-artifact":
      await viewArtifact(id);
      break;
    case "close-dialog":
      closeDialog();
      break;
    case "ask":
      openAgent();
      break;
    case "new-chat":
      if (chatBusy)
        throw new Error(
          "Cancel the current request before starting a new conversation.",
        );
      conversationId = null;
      renderAgent();
      break;
    case "close-agent":
      closeAgent();
      break;
    case "open-chat":
      conversationId = id;
      openAgent();
      break;
    case "chat-prompt":
      $("chat-input").value = button.dataset.text;
      $("chat-input").focus();
      break;
    case "cancel-chat":
      await execute("chat.cancel", { conversationId }, true);
      break;
    case "new-model":
      modelForm();
      break;
    case "edit-model":
      modelForm(id);
      break;
    case "delete-model":
      await execute("models.delete", { modelId: id });
      await loadModels();
      closeDialog();
      renderContent();
      break;
    case "commands":
      openCommands();
      break;
    case "clear-storage":
      formDialog(
        "Clear site storage",
        field(
          "Site URL",
          "url",
          active()?.url !== "about:blank" ? active()?.url || "" : "",
          "url",
          true,
        ) +
          "<p>This signs you out of the site in this workspace. Server-side account records are not deleted.</p>",
        async (v) => {
          await execute("storage.clear", { url: v.url, workspaceId: ws().id });
        },
        { save: "Clear site data" },
      );
      break;
    case "approve-download":
      await execute("downloads.approve", { downloadId: Number(id) });
      await loadDownloads();
      break;
    case "clear-history":
      formDialog(
        "Clear browsing history?",
        "<p>This removes recorded visits in this workspace. Saved materials and captures remain.</p>",
        async () => {
          await execute("history.clear", { workspaceId: ws().id });
        },
        { save: "Clear history" },
      );
      break;
    case "bookmark-page":
      if (!active() || active().url === "about:blank")
        throw new Error("Open a page before bookmarking it.");
      await execute("bookmarks.create", {
        workspaceId: ws().id,
        title: displayTitle(active()).slice(0, 240),
        url: active().url,
      });
      toast("Bookmark saved.");
      break;
    case "resume-automation":
      await execute("browser.resumeAutomation", {});
      toast("Automation resumed. Tab control remains with you until released.");
      break;
    case "emergency-stop":
      await execute("browser.emergencyStop", {});
      toast(
        "Agent control revoked. Loading, downloads, and model requests stopped.",
      );
      break;
    case "cancel-download":
      await execute("downloads.cancel", { downloadId: Number(id) });
      await loadDownloads();
      break;
    case "search-result":
      if (kind === "artifacts") await viewArtifact(id);
      else if (kind === "workspaces") {
        await execute("workspaces.switch", { id });
        navigateSection("overview");
      } else if (state[kind]) editRecord(kind, id);
      break;
    case "download-file": {
      const r = await execute("materials.get", { id }, true);
      if (!r.fileBase64)
        throw new Error("Stored file bytes were not returned.");
      const link = document.createElement("a");
      link.href = `data:${r.mimeType || "application/octet-stream"};base64,${r.fileBase64}`;
      link.download = r.filename || r.title;
      link.click();
      break;
    }
    case "find-page":
      formDialog(
        "Find in page",
        field("Text to find", "text", "", "text", true),
        async (v) => {
          await execute("page.find", v);
        },
        { save: "Find" },
      );
      break;
    case "zoom-page":
      await execute("page.zoom", { factor: Number(button.dataset.factor) });
      break;
    case "duplicate-tab":
      await execute("tabs.duplicate", { tabId: active().id });
      closeDialog();
      navigateSection("browse");
      break;
    case "save-pdf":
      showResult(await execute("page.pdf"));
      openCommands();
      break;
    case "show-tabs":
      closeDialog();
      navigateSection("tabs");
      break;
    case "move-tab":
      formDialog(
        "Move tab to another workspace",
        choice(
          "Destination",
          "workspaceId",
          state.workspaces
            .filter((w) => !w.archived && w.id !== ws().id)
            .map((w) => [w.id, w.name]),
          "",
        ) +
          "<p>The page reloads in a separate storage container. Login state is not transferred.</p>",
        async (values) => {
          await execute("tabs.move", { tabId: active().id, ...values });
        },
        { save: "Move tab" },
      );
      break;
  }
}
document.addEventListener("click", (event) => {
  const button = event.target.closest("button[data-action]");
  if (button) void act(button).catch((e) => toast(errorMessage(e)));
});
document.addEventListener("change", (event) => {
  if (["activity-type", "activity-outcome"].includes(event.target.id)) {
    activityState[event.target.id === "activity-type" ? "types" : "outcome"] = event.target.value;
    activityState.loaded = 50;
    void loadActivity();
  }
  if (event.target.id === "theme-select")
    void execute("settings.update", { theme: event.target.value }).catch(
      () => {},
    );
});
$("dialog").addEventListener("close", () => {
  if (!$("dialog").open) clearDialogSecrets();
});
$("dialog").addEventListener("cancel", (event) => {
  event.preventDefault();
  closeDialog();
});
$("dialog").addEventListener("click", (event) => {
  if (event.target === $("dialog")) {
    const r = $("dialog").getBoundingClientRect();
    if (
      event.clientX < r.left ||
      event.clientX > r.right ||
      event.clientY < r.top ||
      event.clientY > r.bottom
    )
      closeDialog();
  }
});
for (const [id, name] of Object.entries({
  back: "back",
  forward: "arrow",
  reload: "reload",
  stop: "stop",
  "site-controls": "shield",
  "save-page": "bookmark",
  "split-view": "split",
  "page-more": "more",
  "toggle-sidebar": "sidebar",
  "command-button": "terminal",
  "settings-button": "settings",
}))
  $(id).innerHTML = icon(name);
$("downloads-button").innerHTML = icon("download") + "Downloads";
$("privacy-button").innerHTML = icon("shield") + "Privacy & site rules";
document.querySelector(".search-icon").innerHTML = icon("search");
$("home").onclick = () => navigateSection("overview");
$("workspace-heading").onclick = () => void workspaceMenu();
$("add-workspace").onclick = () => workspaceForm();
$("new-tab").onclick = () =>
  void act({ dataset: { action: "new-tab" } }).catch(() => {});
$("search-button").onclick = palette;
$("command-button").onclick = openCommands;
$("agent-toggle").onclick = () => (agentOpen ? closeAgent() : openAgent());
$("settings-button").onclick = () => navigateSection("settings");
$("downloads-button").onclick = () => navigateSection("downloads");
$("privacy-button").onclick = () => navigateSection("privacy");
$("site-controls").onclick = () => {
  navigateSection("privacy");
};
$("save-page").onclick = () =>
  void capture().catch((e) => toast(errorMessage(e)));
$("theme-toggle").onclick = () =>
  void execute("settings.update", {
    theme: document.documentElement.dataset.theme === "dark" ? "light" : "dark",
  }).catch(() => {});
$("toggle-sidebar").onclick = () => {
  $("app").classList.toggle("sidebar-collapsed");
  $("toggle-sidebar").setAttribute("aria-expanded", String(!$("app").classList.contains("sidebar-collapsed")));
  void execute(
    "settings.update",
    { sidebarCollapsed: $("app").classList.contains("sidebar-collapsed") },
    true,
  ).catch(() => {});
  layout();
};
$("split-view").onclick = () => {
  const other = visibleTabs().find((t) => t.id !== active()?.id);
  if (!other) return toast("Open a second tab to use split view.");
  splitTabId = splitTabId ? null : other.id;
  navigateSection("browse");
};
$("page-more").onclick = () =>
  openDialog(
    "Page tools",
    `<div class="inline-actions">${action("find-page", "Find in page", "search")}${action("bookmark-page", "Bookmark page", "bookmark")}${action("section", "History", "clock", 'data-section="history"')}${action("section", "Bookmarks", "bookmark", 'data-section="bookmarks"')}${action("duplicate-tab", "Duplicate tab", "tabs")}${action("move-tab", "Move to workspace", "folder")}${action("save-pdf", "Print to PDF", "download")}${action("show-tabs", "Manage tabs", "tabs")}${active() ? action("takeover", "Take control", "lock", 'data-id="' + active().id + '"') : ""}</div><div class="settings-row"><strong>Page zoom</strong><div class="inline-actions">${[0.75, 1, 1.25, 1.5].map((f) => action("zoom-page", Math.round(f * 100) + "%", "", `data-factor="${f}"`)).join("")}</div></div>`,
  );
for (const name of ["back", "forward", "reload", "stop"])
  $(name).onclick = () => void execute(`page.${name}`).catch(() => {});
$("navigation").onsubmit = (e) => {
  e.preventDefault();
  void openUrl($("address").value).catch(() => {});
};
$("command").onchange = selectCommand;
$("run").onclick = async () => {
  try {
    await execute($("command").value, JSON.parse($("arguments").value));
  } catch (e) {
    $("status").textContent = errorMessage(e);
  }
};
document.addEventListener("keydown", (e) => {
  if ($("dialog").open) return;
  if ((e.ctrlKey || e.metaKey) && !e.altKey) {
    const key = e.key.toLowerCase();
    if (["k", "l", "t", "w", "f", "j"].includes(key)) e.preventDefault();
    if (key === "k") palette();
    if (key === "l") {
      $("address").focus();
      $("address").select();
    }
    if (key === "t") void act({ dataset: { action: "new-tab" } });
    if (key === "w" && active())
      void act({ dataset: { action: "close-tab", id: active().id } });
    if (key === "f") void act({ dataset: { action: "find-page" } });
    if (key === "j") navigateSection("downloads");
  }
});
new ResizeObserver(layout).observe($("content"));
window.addEventListener("resize", layout);
try {
  catalog = await window.weft.commands();
  for (const name of Object.keys(catalog)) {
    const option = document.createElement("option");
    option.value = option.textContent = name;
    $("command").append(option);
  }
  selectCommand();
  await loadModels();
  await refresh(true);
  $("app").classList.toggle(
    "sidebar-collapsed",
    !!state.settings.sidebarCollapsed,
  );
  $("toggle-sidebar").setAttribute("aria-expanded", String(!state.settings.sidebarCollapsed));
  if (state.settings.agentPanelOpen) openAgent();
  setInterval(() => void refresh().catch(() => {}), 1500);
  $("status").textContent = "Ready";
} catch (error) {
  $("status").textContent = `Startup error: ${errorMessage(error)}`;
  toast(errorMessage(error));
}
