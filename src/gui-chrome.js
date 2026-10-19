// Everyday browser chrome in the trusted GUI (#88, #91, #92, #93, #96): keyboard shortcuts, the
// address-bar suggestion list, the find bar, zoom, recently closed tabs and tab drag-reorder.
// gui.js passes in the state and helpers this needs; nothing here talks to a page directly.
import { SHORTCUTS, ariaKeys, keyLabel, matchShortcut } from './shortcuts.js';
import { SEARCH_ENGINES, searchEngine, searchUrl, templateProblem } from './search-engines.js';

export function chromeUI(deps) {
  const { $, esc, icon, toast, announce, execute, errorMessage, act, active, visibleTabs, records, ws, getState, navigateSection, tabSearch, layout,
    focusPage, refresh, openDialog, formDialog, field, captureSelection, savePage } = deps;
  const platform = window.weft.platform || (/Mac/i.test(navigator.platform) ? 'darwin' : 'linux');
  const chrome = (action, args = {}) => window.weft.chrome(action, args);
  const human = (promise) => Promise.resolve(promise).catch((e) => toast(errorMessage(e)));

  // ---- Keyboard shortcuts --------------------------------------------------------------
  /** Pinned tabs first, then each group, then the rest: the order the sidebar shows and Ctrl+Tab follows. */
  function displayOrder() {
    const tabs = visibleTabs();
    const groups = records("tabGroups");
    const grouped = new Set(groups.map((g) => g.id));
    const loose = tabs.filter((t) => !t.groupId || !grouped.has(t.groupId));
    return [...loose.filter((t) => t.pinned), ...groups.flatMap((g) => tabs.filter((t) => t.groupId === g.id)), ...loose.filter((t) => !t.pinned)];
  }
  async function selectTab(index) {
    const order = displayOrder();
    const target = index < 0 ? order.at(-1) : order[index];
    if (target) await act({ dataset: { action: "activate-tab", id: String(target.id) } });
  }
  async function cycleTab(step) {
    const order = displayOrder();
    if (order.length < 2) return;
    const current = order.findIndex((t) => t.active);
    await selectTab((current + step + order.length) % order.length);
  }
  async function zoom(direction) {
    const result = await chrome("zoom", { direction });
    announce(`Zoom ${Math.round(result.factor * 100)}%`);
    await refresh(true);
  }
  const tabShown = () => Boolean(active() && active().url !== "about:blank");
  async function run(id) {
    const tab = /^tab-(\d)$/.exec(id);
    if (tab) return selectTab(Number(tab[1]) - 1);
    switch (id) {
      case "tab-new": return act({ dataset: { action: "new-tab" } });
      case "tab-close": return active() ? act({ dataset: { action: "close-tab", id: String(active().id) } }) : undefined;
      case "tab-reopen": return reopen();
      case "tab-next": return cycleTab(1);
      case "tab-previous": return cycleTab(-1);
      case "tab-last": return selectTab(-1);
      case "back": case "forward": case "reload": case "stop": return tabShown() ? execute(`page.${id}`, {}, true) : undefined;
      case "hard-reload": return tabShown() ? chrome("hard-reload") : undefined;
      case "find": return openFind();
      case "find-next": return $("find-bar").hidden ? openFind() : findStep(true);
      case "find-previous": return $("find-bar").hidden ? openFind() : findStep(false);
      case "print": return tabShown() ? chrome("print") : toast("Open a page to print it.");
      case "zoom-in": return tabShown() ? zoom(1) : undefined;
      case "zoom-out": return tabShown() ? zoom(-1) : undefined;
      case "zoom-reset": return tabShown() ? zoom(0) : undefined;
      case "bookmark": return act({ dataset: { action: "bookmark-page" } });
      case "view-source": { if (!tabShown()) return; await chrome("view-source"); await refresh(true); return navigateSection("browse"); }
      case "devtools": return tabShown() ? chrome("devtools").then(() => refresh(true)) : toast("Open a page to inspect it.");
      case "downloads": return navigateSection("downloads");
      case "search-tabs": return tabSearch();
      case "private-window": return typeof window.weft.openPrivateWindow === "function" ? window.weft.openPrivateWindow() : toast("Private windows are not available in this version of Weft.");
      // A window always shows a workspace (#100): the shortcut moves the current one into a window of its own.
      case "new-window": return window.weft.windows ? window.weft.windows({ action: "move", workspaceId: deps.ws().id }).catch((error) => toast(deps.errorMessage(error))) : toast("Multiple windows are not available in this version of Weft.");
      case "capture-selection": return captureSelection();
      case "save-page": return savePage();
      default: return undefined;
    }
  }
  /** Shortcut ids gui.js handles itself (focus regions and the palette); everything else runs here. */
  const FOCUS_KEYS = new Set(["address", "palette", "chrome", "chrome-back"]);
  const handles = (id) => !FOCUS_KEYS.has(id) && (SHORTCUTS.some((s) => s.id === id) || ["capture-selection", "save-page"].includes(id));
  const inText = (el) => Boolean(el?.closest?.("input, textarea, select, [contenteditable='true']"));
  /** A key pressed in the Weft chrome. Returns true when it was a browser shortcut and has been handled. */
  function onKeydown(e) {
    const match = matchShortcut(e, { platform, loading: Boolean(active()?.loading) });
    if (!match || !handles(match.id)) return false;
    // Text editing keeps its own keys: Alt+arrows move by word, Esc belongs to the field.
    if (inText(e.target) && (["back", "forward", "stop"].includes(match.id) || (match.id === "find-next" && e.key === "F3" && e.target === $("find-input")))) return false;
    if (match.id === "stop") return false;
    e.preventDefault();
    void human(run(match.id));
    return true;
  }
  /** Shortcut ids forwarded from a page (src/browser.js). */
  function onPage(id) {
    if (!handles(id)) return false;
    void human(run(id));
    return true;
  }
  /** aria-keyshortcuts on the controls that have a shortcut, for this platform. */
  function labelControls() {
    const map = { back: "back", forward: "forward", reload: "reload", stop: "stop", "new-tab": "tab-new", "downloads-button": "downloads", "find-next": "find-next", "find-previous": "find-previous" };
    for (const [elementId, shortcutId] of Object.entries(map)) {
      const element = $(elementId);
      if (!element) continue;
      element.setAttribute("aria-keyshortcuts", ariaKeys(shortcutId, platform));
      const label = element.getAttribute("aria-label") || element.textContent.trim();
      element.title = `${label} · ${keyLabel(shortcutId, platform)}`;
    }
    $("find-input")?.setAttribute("aria-keyshortcuts", ariaKeys("find", platform));
    $("find-previous").innerHTML = icon("chevron");
    $("find-next").innerHTML = icon("chevron");
    $("find-close").innerHTML = icon("close");
  }
  /** Shortcut reference shown in Page tools (also in docs/USING-WEFT.md). */
  const shortcutList = () => `<details class="shortcut-list"><summary>Keyboard shortcuts</summary><dl>${SHORTCUTS.filter((s) => !/^tab-[2-8]$/.test(s.id)).map((s) => `<div><dt>${esc(s.id === "tab-1" ? "Tab 1–8" : s.label)}</dt><dd><kbd>${esc(keyLabel(s.id, platform))}</kbd></dd></div>`).join("")}</dl></details>`;

  // ---- Find bar ------------------------------------------------------------------------
  let findReturn = null;
  // The count is announced through the app's single status region (#31), not a second live region.
  function setCount(active, matches) {
    const text = !$("find-input").value ? "" : matches ? `${active} of ${matches}` : "No matches";
    if (text && text !== $("find-count").textContent) announce(text === "No matches" ? text : `Match ${text}`);
    $("find-count").textContent = text;
  }
  async function search({ forward = true, newSession = false } = {}) {
    const text = $("find-input").value;
    if (!text) { await chrome("stop-find"); setCount(0, 0); return; }
    const result = await chrome("find", { text, forward, newSession, matchCase: $("find-case").checked });
    if ($("find-input").value === text) setCount(result.activeMatchOrdinal, result.matches);
  }
  function openFind() {
    if (!tabShown()) return toast("Open a page to find text in it.");
    if ($("find-bar").hidden) findReturn = document.activeElement === document.body ? "page" : document.activeElement;
    $("find-bar").hidden = false;
    layout();
    $("find-input").focus();
    $("find-input").select();
    if ($("find-input").value) void human(search({ newSession: true }));
  }
  const findStep = (forward) => human(search({ forward }));
  async function closeFind() {
    if ($("find-bar").hidden) return;
    $("find-bar").hidden = true;
    setCount(0, 0);
    await chrome("stop-find").catch(() => {});
    layout();
    const back = findReturn;
    findReturn = null;
    if (back && back !== "page" && back.isConnected) back.focus();
    else void focusPage();
  }
  function wireFind() {
    $("find-input").addEventListener("input", () => void human(search({ newSession: true })));
    $("find-case").addEventListener("change", () => void human(search({ newSession: true })));
    $("find-input").addEventListener("keydown", (e) => {
      if (e.key === "Enter" || e.key === "F3") { e.preventDefault(); void findStep(!e.shiftKey); }
      if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); void closeFind(); }
    });
    $("find-bar").addEventListener("keydown", (e) => { if (e.key === "Escape") { e.preventDefault(); void closeFind(); } });
    $("find-next").onclick = () => void findStep(true);
    $("find-previous").onclick = () => void findStep(false);
    $("find-close").onclick = () => void closeFind();
  }

  // ---- Zoom indicator ------------------------------------------------------------------
  function renderZoom(section) {
    const tab = section === "browse" && tabShown() ? active() : null;
    const factor = tab?.zoom ?? 1;
    const show = Boolean(tab) && Math.abs(factor - 1) > 0.001;
    $("zoom-indicator").hidden = !show;
    if (show) {
      $("zoom-indicator").textContent = `${Math.round(factor * 100)}%`;
      $("zoom-indicator").setAttribute("aria-label", `Zoom ${Math.round(factor * 100)}%. Reset to 100%`);
      $("zoom-indicator").setAttribute("aria-keyshortcuts", ariaKeys("zoom-reset", platform));
    }
    // DevTools and source views are shown beside the owner chip.
    const owner = $("page-owner");
    if (owner && tab) owner.dataset.devtools = tab.devtools ? "open" : "";
  }

  // ---- Address-bar suggestions (combobox) ----------------------------------------------
  let suggestions = [];
  let selected = -1;
  const isOpen = () => !$("omnibox-list").hidden;
  const engine = () => searchEngine(getState().settings);
  function suggest(query) {
    const q = query.trim().toLowerCase();
    if (!q) return [];
    const words = q.split(/\s+/);
    const hit = (text) => { const value = String(text || "").toLowerCase(); return words.every((w) => value.includes(w)); };
    const seen = new Set();
    const add = (list, item) => { if (seen.has(item.url)) return; seen.add(item.url); list.push(item); };
    const out = [];
    for (const t of visibleTabs()) if (out.length < 3 && t.url !== "about:blank" && !t.active && hit(`${t.title} ${t.url}`)) add(out, { kind: "tab", title: t.title || t.url, url: t.url, tabId: t.id });
    const bookmarks = [];
    for (const b of records("materials")) if (bookmarks.length < 3 && b.kind === "website" && b.pinned && b.url && hit(`${b.title} ${b.url}`)) add(bookmarks, { kind: "bookmark", title: b.title || b.url, url: b.url });
    const history = [];
    // Only this workspace's history, newest first; clearing history removes it from here too.
    for (const h of [...(getState().history || [])].reverse()) if (history.length < 5 && h.workspaceId === ws().id && hit(`${h.title} ${h.url}`)) add(history, { kind: "history", title: h.title || h.url, url: h.url });
    return [...out, ...bookmarks, ...history, { kind: "search", title: `Search ${engine().name} for “${query.trim().slice(0, 80)}”`, url: searchUrl(getState().settings, query) }];
  }
  const kindLabel = { tab: "Switch to tab", bookmark: "Bookmark", history: "History", search: "Search" };
  function renderSuggestions() {
    const list = $("omnibox-list");
    list.innerHTML = suggestions.map((s, i) => `<div role="option" id="omnibox-option-${i}" class="omnibox-option ${i === selected ? "selected" : ""}" aria-selected="${i === selected}" data-index="${i}">${icon(s.kind === "tab" ? "tabs" : s.kind === "bookmark" ? "bookmark" : s.kind === "history" ? "clock" : "search")}<span class="omnibox-text"><strong>${esc(s.title)}</strong>${s.kind === "search" ? "" : `<small>${esc(s.url)}</small>`}</span><span class="omnibox-kind">${kindLabel[s.kind]}</span></div>`).join("");
    const show = suggestions.length > 0;
    const changed = list.hidden === show;
    list.hidden = !show;
    $("address").setAttribute("aria-expanded", String(show));
    if (selected >= 0) $("address").setAttribute("aria-activedescendant", `omnibox-option-${selected}`);
    else $("address").removeAttribute("aria-activedescendant");
    // The native page view draws above the GUI, so it steps aside while the list is open.
    if (changed) layout();
  }
  function closeSuggestions() {
    if (!suggestions.length && !isOpen()) return;
    suggestions = [];
    selected = -1;
    renderSuggestions();
  }
  async function choose(s) {
    closeSuggestions();
    if (s.kind === "tab") return act({ dataset: { action: "activate-tab", id: String(s.tabId) } });
    return deps.openUrl(s.url);
  }
  function wireOmnibox() {
    const input = $("address");
    input.addEventListener("input", () => { suggestions = suggest(input.value); selected = -1; renderSuggestions(); });
    input.addEventListener("keydown", (e) => {
      if (!isOpen()) { if (e.key === "ArrowDown" && input.value.trim()) { suggestions = suggest(input.value); selected = 0; renderSuggestions(); e.preventDefault(); } return; }
      if (e.key === "ArrowDown" || e.key === "ArrowUp") {
        e.preventDefault();
        selected = (selected + (e.key === "ArrowDown" ? 1 : -1) + suggestions.length + 1) % (suggestions.length + 1);
        if (selected === suggestions.length) selected = -1;
        renderSuggestions();
      } else if (e.key === "Enter" && selected >= 0) {
        e.preventDefault();
        void human(choose(suggestions[selected]));
      } else if (e.key === "Escape") {
        e.preventDefault();
        closeSuggestions();
      }
    });
    input.addEventListener("blur", () => setTimeout(closeSuggestions, 0));
    // mousedown keeps focus in the address field until the choice is made.
    $("omnibox-list").addEventListener("mousedown", (e) => {
      const option = e.target.closest?.(".omnibox-option");
      if (!option) return;
      e.preventDefault();
      void human(choose(suggestions[Number(option.dataset.index)]));
    });
    $("navigation").addEventListener("submit", closeSuggestions, true);
  }

  // ---- Search engine setting -----------------------------------------------------------
  function engineSetting() {
    const current = engine();
    const options = [...Object.entries(SEARCH_ENGINES).map(([id, e]) => [id, e.name]), ["custom", current.id === "custom" ? `Custom: ${current.name}` : "Custom…"]];
    return `<div class="settings-row"><div><strong>Search engine</strong><small>Used by the address bar and “Search the web”. Words are sent only when you press Enter; Weft never asks the engine for suggestions while you type.</small></div><select id="search-engine-select" aria-label="Search engine">${options.map(([id, name]) => `<option value="${esc(id)}" ${current.id === id ? "selected" : ""}>${esc(name)}</option>`).join("")}</select></div>`;
  }
  function customEngine() {
    const current = getState().settings.searchEngine || {};
    formDialog("Custom search engine",
      `${field("Name", "name", current.preset === "custom" ? current.name || "" : "", "text", true)}${field("Search address (https, with %s where the words go)", "template", current.preset === "custom" ? current.template || "" : "https://", "url", true)}`,
      async (values) => {
        const problem = templateProblem(values.template);
        if (problem) throw new Error(problem);
        await execute("settings.update", { searchEngine: { preset: "custom", name: values.name.slice(0, 60), template: values.template } }, true);
        await refresh(true);
        toast("Search engine saved.");
      }, { save: "Use this search engine" });
  }
  document.addEventListener("change", (e) => {
    if (e.target?.id !== "search-engine-select") return;
    if (e.target.value === "custom") return customEngine();
    void human(execute("settings.update", { searchEngine: { preset: e.target.value } }, true).then(() => refresh(true)).then(() => toast(`Search engine: ${SEARCH_ENGINES[e.target.value].name}.`)));
  });

  // ---- Recently closed tabs ------------------------------------------------------------
  const closedTabs = () => (getState().browserSession?.closed || []).filter((c) => c.workspaceId === ws().id).slice().reverse();
  async function reopen(closedId) {
    const result = await execute("tabs.reopen", { workspaceId: ws().id, ...(closedId ? { closedId } : {}) }, true);
    await refresh(true);
    navigateSection("browse");
    announce(`Reopened ${result.title || result.url}`);
    return result;
  }
  function closedDialog() {
    const list = closedTabs();
    openDialog("Recently closed tabs",
      list.length ? `<p>Reopening restores the address, scroll position, zoom, pin and group. It reopens with you in control; form input, sign-ins and in-page state are not restored.</p><ul class="closed-list">${list.map((c) => `<li><span class="record-text"><strong>${esc(c.title || c.url)}</strong><small>${esc(c.url)}</small></span><button type="button" class="secondary" data-action="reopen-closed" data-id="${esc(c.id)}">Reopen</button></li>`).join("")}</ul>` : "<p>No recently closed tabs in this workspace.</p>");
  }
  const closedEntry = () => closedTabs().length ? `<button type="button" class="text-button recently-closed" data-action="recently-closed" aria-keyshortcuts="${esc(ariaKeys("tab-reopen", platform))}">${icon("clock")}<span>Recently closed (${closedTabs().length})</span></button>` : "";

  // ---- Tab drag-reorder and keyboard moves -----------------------------------------------
  let dragging = null;
  const workspaceOrder = () => visibleTabs().map((t) => t.id);
  async function place(tabId, { beforeId = null, afterId = null, pinned, groupId } = {}) {
    const tab = visibleTabs().find((t) => t.id === tabId);
    if (!tab) return;
    if (pinned !== undefined && Boolean(tab.pinned) !== pinned) await execute("tabs.pin", { tabId, pinned }, true);
    if (groupId !== undefined && (tab.groupId || null) !== groupId) await execute("tabs.group", { tabId, groupId }, true);
    const order = workspaceOrder().filter((id) => id !== tabId);
    const anchor = beforeId ?? afterId;
    if (anchor != null && anchor !== tabId) {
      const at = order.indexOf(anchor);
      if (at >= 0) await execute("tabs.reorder", { tabId, index: beforeId != null ? at : at + 1 }, true);
    }
    await refresh(true);
  }
  function moveDialog(tabId, workspaceId) {
    const target = getState().workspaces.find((w) => w.id === workspaceId);
    const tab = visibleTabs().find((t) => t.id === tabId);
    if (!target || !tab) return;
    formDialog("Move tab to another workspace", `<p>Move “${esc(tab.title || tab.url)}” to <strong>${esc(target.name)}</strong>? The page reloads in that workspace's separate storage container. Sign-in state is not transferred.</p>`,
      async () => { await execute("tabs.move", { tabId, workspaceId, expectedVersion: tab.version }, true); }, { save: "Move tab" });
  }
  function dropTarget(el) {
    return el?.closest?.(".workspace-dot, .pinned-tabs, .tab-group, .tab, #tabs") ?? null;
  }
  function wireDrag() {
    const root = document;
    root.addEventListener("dragstart", (e) => {
      const tab = e.target.closest?.("#tabs .tab[data-tab-id]");
      if (!tab) return;
      dragging = Number(tab.dataset.tabId);
      tab.classList.add("dragging");
      try { e.dataTransfer.effectAllowed = "move"; e.dataTransfer.setData("text/plain", tab.title || ""); } catch { /* synthetic */ }
    });
    root.addEventListener("dragend", () => { dragging = null; document.querySelectorAll(".dragging, .drop-before, .drop-after, .drop-into").forEach((el) => el.classList.remove("dragging", "drop-before", "drop-after", "drop-into")); });
    root.addEventListener("dragover", (e) => {
      if (dragging == null) return;
      const target = dropTarget(e.target);
      if (!target || (target.classList.contains("workspace-dot") && target.dataset.id === ws().id)) return;
      e.preventDefault();
      document.querySelectorAll(".drop-before, .drop-after, .drop-into").forEach((el) => el.classList.remove("drop-before", "drop-after", "drop-into"));
      if (target.classList.contains("tab")) {
        const box = target.getBoundingClientRect();
        target.classList.add(e.clientY > box.top + box.height / 2 ? "drop-after" : "drop-before");
      } else target.classList.add("drop-into");
    });
    root.addEventListener("drop", (e) => {
      if (dragging == null) return;
      const tabId = dragging;
      const target = dropTarget(e.target);
      dragging = null;
      document.querySelectorAll(".dragging, .drop-before, .drop-after, .drop-into").forEach((el) => el.classList.remove("dragging", "drop-before", "drop-after", "drop-into"));
      if (!target) return;
      e.preventDefault();
      if (target.classList.contains("workspace-dot")) { if (target.dataset.id !== ws().id) moveDialog(tabId, target.dataset.id); return; }
      if (target.classList.contains("pinned-tabs")) return void human(place(tabId, { pinned: true, groupId: null }));
      if (target.classList.contains("tab")) {
        const other = visibleTabs().find((t) => t.id === Number(target.dataset.tabId));
        if (!other || other.id === tabId) return;
        const box = target.getBoundingClientRect();
        const after = e.clientY > box.top + box.height / 2;
        return void human(place(tabId, { [after ? "afterId" : "beforeId"]: other.id, pinned: Boolean(other.pinned), groupId: other.groupId || null }));
      }
      if (target.classList.contains("tab-group")) return void human(place(tabId, { groupId: target.dataset.groupId, pinned: false }));
      return void human(place(tabId, { pinned: false, groupId: null }));
    });
    // Keyboard alternative: Alt+Shift+Up/Down on a tab moves it within its section.
    $("tabs").addEventListener("keydown", (e) => {
      if (!e.altKey || !e.shiftKey || e.ctrlKey || e.metaKey || !["ArrowUp", "ArrowDown"].includes(e.key)) return;
      const element = e.target.closest?.(".tab[data-tab-id]");
      if (!element) return;
      e.preventDefault();
      const tabId = Number(element.dataset.tabId);
      const tab = visibleTabs().find((t) => t.id === tabId);
      const section = displayOrder().filter((t) => Boolean(t.pinned) === Boolean(tab.pinned) && (t.groupId || null) === (tab.groupId || null));
      const at = section.findIndex((t) => t.id === tabId);
      const neighbor = section[at + (e.key === "ArrowUp" ? -1 : 1)];
      if (!neighbor) return announce(`${tab.title || tab.url} is already ${e.key === "ArrowUp" ? "first" : "last"} here.`);
      void human(place(tabId, { [e.key === "ArrowUp" ? "beforeId" : "afterId"]: neighbor.id }).then(() => {
        document.querySelector(`#tabs .tab[data-tab-id="${tabId}"] button[data-action="activate-tab"]`)?.focus();
        announce(`Moved ${tab.title || tab.url} to position ${at + (e.key === "ArrowUp" ? 0 : 2)} of ${section.length}.`);
      }));
    });
  }

  function actions(button) {
    switch (button.dataset.action) {
      case "recently-closed": closedDialog(); return true;
      case "reopen-closed": void human(reopen(button.dataset.id).then(() => deps.closeDialog())); return true;
      case "open-find": deps.closeDialog(); setTimeout(openFind, 0); return true;
      case "print-page": deps.closeDialog(); void human(chrome("print")); return true;
      case "zoom-step": void human(zoom(Number(button.dataset.direction))); return true;
      case "view-source": deps.closeDialog(); void human(run("view-source")); return true;
      case "open-devtools": deps.closeDialog(); void human(run("devtools")); return true;
      default: return false;
    }
  }

  function init() {
    labelControls();
    wireFind();
    wireOmnibox();
    wireDrag();
    window.weft.onNotice?.((message) => toast(message));
    $("zoom-indicator").onclick = () => void human(zoom(0));
  }

  return { init, onKeydown, onPage, renderZoom, isOpen, closeSuggestions, closeFind, engineSetting, closedEntry, actions, shortcutList, displayOrder, platform };
}
