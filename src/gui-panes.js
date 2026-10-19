/**
 * Pane layouts in the browse area (#101): 1 to 4 panes holding live tabs, saved captures, materials,
 * tasks or the offline archive preview. Live pages are native views placed over their pane; everything
 * else is drawn here as inert, escaped text and images. The focused tab pane is the active tab, so the
 * address bar, find, zoom, print, shortcuts and Send to Weft keep acting on what the person focused.
 * Panes are display state only and never give an agent anything.
 */
import { PANE_GAP, PANE_LAYOUTS, defaultSizes, fitLayout, normalizeSizes, paneCount, paneDividers, paneKey, paneRects, sizeAt } from "./panes.js";

export const PANE_HEADER = 32;
export const PANE_INSET = 3;
const POSITION = {
  "2-columns": ["Left", "Right"], "2-rows": ["Top", "Bottom"], "3-main": ["Left", "Top right", "Bottom right"],
  "3-columns": ["Left", "Middle", "Right"], "4-grid": ["Top left", "Top right", "Bottom left", "Bottom right"],
};
// Names kept from split view for the first two panes, so existing focus routes and tests stay stable.
export const PANE_NAMES = ["primary", "secondary", "tertiary", "quaternary"];

export function panesUI(ui) {
  const { esc, icon, action, execute, ownerBadge, controlMode, displayTitle, announce } = ui;
  let layout = "1", items = [null], focused = 0, sizes = [], collapsed = null;
  const documents = new Map();

  const count = () => paneCount(layout);
  const label = (index, shown = layout) => (POSITION[shown]?.[index] ?? `Pane ${index + 1}`) + " pane";
  const multi = () => count() > 1;
  const tabIn = (item, tabs) => (item?.type === "tab" ? tabs.find((t) => t.id === item.id) : null);

  function state() {
    return { layout, items: items.slice(0, count()).map((item) => (item ? { ...item } : null)), focused, sizes: normalizeSizes(layout, sizes) };
  }
  /** Apply a saved resume view (older split views arrive already migrated to two panes). */
  function load(saved) {
    layout = PANE_LAYOUTS[saved?.layout] ? saved.layout : "1";
    items = Array.from({ length: count() }, (_, index) => saved?.items?.[index] ?? null);
    focused = Math.min(Math.max(0, saved?.focused ?? 0), count() - 1);
    sizes = normalizeSizes(layout, saved?.sizes);
  }
  /** Keep the panes consistent with live tabs: gone tabs leave empty panes; the active tab is in the focused pane. */
  function sync(tabs, activeTab) {
    items = items.map((item) => (item?.type === "tab" && !tabs.some((t) => t.id === item.id) ? null : item));
    if (!activeTab) return;
    const at = items.findIndex((item) => item?.type === "tab" && item.id === activeTab.id);
    if (at >= 0) { focused = at; return; }
    if (items[focused]?.type === "tab" || !items[focused]) { items[focused] = { type: "tab", id: activeTab.id }; return; }
    const slot = items.findIndex((item) => !item || item.type === "tab");
    if (slot >= 0) { items[slot] = { type: "tab", id: activeTab.id }; focused = slot; } else items[focused] = { type: "tab", id: activeTab.id };
  }
  function setLayout(next, tabs, activeTab) {
    if (!PANE_LAYOUTS[next]) return;
    const kept = items.filter(Boolean);
    layout = next;
    sizes = defaultSizes(next);
    items = Array.from({ length: count() }, (_, index) => kept[index] ?? null);
    // Fill new panes with other open web pages so a new layout is useful at once.
    for (let index = 0; index < items.length; index++) if (!items[index]) {
      const candidate = tabs.find((t) => t.url !== "about:blank" && !t.blocked && !items.some((item) => item?.type === "tab" && item.id === t.id));
      if (candidate) items[index] = { type: "tab", id: candidate.id };
    }
    focused = Math.min(focused, count() - 1);
    sync(tabs, activeTab);
  }
  /** Put a tab or document into a pane: an existing pane showing it gets focus, else the first empty pane, else a new pane. */
  function open(item, tabs, activeTab) {
    const key = paneKey(item);
    const existing = items.findIndex((value) => paneKey(value) === key);
    if (existing >= 0) { focused = existing; return existing; }
    let slot = items.findIndex((value, index) => !value && index < count());
    if (slot < 0) {
      if (count() < 4) { setLayout(count() === 1 ? "2-columns" : count() === 2 ? "3-main" : "4-grid", tabs, activeTab); slot = items.findIndex((value) => !value); }
      if (slot < 0) slot = focused;
    }
    items[slot] = item;
    focused = slot;
    return slot;
  }
  function close(index) {
    if (count() <= 1) return;
    const remaining = items.filter((_, i) => i !== index);
    const next = { 4: "3-main", 3: "2-columns", 2: "1" }[count()];
    layout = next;
    sizes = defaultSizes(next);
    items = Array.from({ length: count() }, (_, i) => remaining[i] ?? null);
    focused = Math.min(focused > index ? focused - 1 : focused, count() - 1);
  }
  function remove(type) { items = items.map((item) => (item?.type === type ? null : item)); }
  function focus(index) { if (index >= 0 && index < count()) focused = index; return items[focused]; }
  function resize(index, delta) {
    const base = normalizeSizes(layout, sizes);
    base[index] = (base[index] ?? 0.5) + delta;
    sizes = normalizeSizes(layout, base);
  }
  function resetSizes() { sizes = defaultSizes(layout); }

  /** The layout actually drawn: a window too small for the chosen layout shows fewer panes, with a notice. */
  function effective(box) {
    const fit = fitLayout(layout, box);
    collapsed = fit.collapsed ? fit.layout : null;
    return fit.layout;
  }
  function geometry(box) {
    const shown = effective(box);
    const visibleItems = shown === layout ? items.slice(0, count()) : orderForCollapse(paneCount(shown));
    return { shown, rects: paneRects(shown, box, shown === layout ? sizes : defaultSizes(shown)), items: visibleItems,
      dividers: shown === layout ? paneDividers(shown, box, sizes) : [] };
  }
  // When collapsing, the focused pane stays visible.
  function orderForCollapse(n) {
    const list = items.slice(0, count());
    const ordered = [list[focused], ...list.filter((_, i) => i !== focused)];
    return ordered.slice(0, n);
  }
  const focusedVisibleIndex = (shown) => (shown === layout ? focused : 0);

  async function documentFor(item, records) {
    const record = records(item.type === "artifact" ? "artifacts" : item.type === "material" ? "materials" : "tasks").find((r) => r.id === item.id);
    const key = `${paneKey(item)}:${item.versionId || ""}:${record?.revision ?? ""}`;
    if (documents.has(key)) return documents.get(key);
    let html;
    try {
      if (item.type === "artifact") {
        const r = await execute("artifacts.get", { id: item.id }, true);
        const versions = r.versions || [];
        const version = versions.find((v) => v.id === item.versionId) || versions.at(-1) || {};
        html = `<p class="pane-doc-meta">Saved capture · ${esc(version.url || version.sourceUrl || "local")} · ${esc(new Date(version.createdAt || r.createdAt).toLocaleString())}</p>`
          + (version.purged ? "<p>The stored content of this version was purged.</p>" : "")
          + (version.pngBase64 ? `<img class="artifact-image" src="data:image/png;base64,${esc(version.pngBase64)}" alt="Saved page screenshot">` : "")
          + `<pre class="artifact-text">${esc(version.text ?? "")}</pre>`;
      } else if (item.type === "material") {
        const r = await execute("materials.get", { id: item.id }, true);
        const mime = String(r.mimeType || "");
        html = `<p class="pane-doc-meta">${esc(r.kind || "note")}${r.url ? " · " + esc(r.url) : ""}</p>`
          + (r.fileBase64 && mime === "image/png" ? `<img class="artifact-image" src="data:image/png;base64,${esc(r.fileBase64)}" alt="${esc(r.title)}">` : "")
          + (r.fileBase64 && /^text\/|json|xml/.test(mime) ? `<pre class="artifact-text">${esc(decode(r.fileBase64))}</pre>` : "")
          + (r.fileBase64 && !/^text\/|json|xml|image\/png/.test(mime) ? `<p>This ${esc(mime || "file")} file is stored in the workspace; it is not rendered in a pane.</p>` : "")
          + (r.content ? `<pre class="artifact-text">${esc(r.content)}</pre>` : "");
      } else {
        const r = record ?? await execute("tasks.get", { id: item.id }, true);
        html = `<p class="pane-doc-meta">Task · ${esc(r.status || "")}</p><p>${esc(r.objective || "")}</p>${r.blocker ? `<p><strong>Blocker:</strong> ${esc(r.blocker)}</p>` : ""}${r.nextStep ? `<p><strong>Next step:</strong> ${esc(r.nextStep)}</p>` : ""}`;
      }
    } catch (error) {
      html = `<p>This item could not be shown: ${esc(error.message || "unavailable")}</p>`;
    }
    documents.set(key, html);
    return html;
  }
  const decode = (base64) => { try { return new TextDecoder().decode(Uint8Array.from(atob(base64), (c) => c.charCodeAt(0))).slice(0, 200000); } catch { return ""; } };

  function title(item, tabs, records) {
    if (!item) return "Empty pane";
    if (item.type === "tab") { const t = tabIn(item, tabs); return t ? displayTitle(t) : "Closed tab"; }
    if (item.type === "preview") return "Offline archive preview";
    const record = records(item.type === "artifact" ? "artifacts" : item.type === "material" ? "materials" : "tasks").find((r) => r.id === item.id);
    return record?.title || "Missing item";
  }

  /**
   * Markup for a multi-pane browse area inside #content. `box` is the content box in window coordinates
   * and `origin` the #content box, so positions are relative to #content.
   */
  function render({ box, origin, tabs, records, previewing, handoff }) {
    const { shown, rects, items: shownItems, dividers } = geometry(box);
    const focusIndex = focusedVisibleIndex(shown);
    const rel = (rect) => `left:${rect.x - origin.x}px;top:${rect.y - origin.y}px;width:${rect.width}px;height:${rect.height}px`;
    const panesHtml = rects.map((rect, index) => {
      const item = shownItems[index];
      const tab = tabIn(item, tabs);
      const name = PANE_NAMES[index];
      const live = tab && tab.url !== "about:blank" && !tab.blocked;
      const header = `<div class="pane-header ${focusIndex === index ? "focused" : ""}" data-pane="${name}" style="${rel({ ...rect, height: PANE_HEADER })}">`
        + `<button type="button" data-action="focus-pane-to" data-pane="${name}" aria-pressed="${focusIndex === index}">${esc(label(index, shown))}</button>`
        + `<span class="pane-title">${esc(title(item, tabs, records))}</span>${tab ? ownerBadge(tab) : ""}${focusIndex === index ? '<span class="pane-focus-label">Focused</span>' : ""}`
        + (count() > 1 ? `<button type="button" class="pane-close" data-action="close-pane" data-index="${index}" aria-label="Close ${esc(label(index, shown))}" title="Close pane">${icon("close")}</button>` : "")
        + "</div>";
      const body = { ...rect, y: rect.y + PANE_HEADER, height: Math.max(1, rect.height - PANE_HEADER) };
      let inner;
      if (live || (item?.type === "preview" && previewing)) inner = ""; // a native view covers this pane
      else if (tab?.blocked) inner = `<p>This page was stopped by a site rule or security finding.</p>${action("focus-pane-to", "Review in this pane", "", `data-pane="${name}"`)}`;
      else if (tab) inner = `<p>${tab.suspended ? "This tab is suspended; it reloads when shown." : "Blank tab. Enter an address in the address bar."}</p>`;
      else if (item && item.type !== "preview") inner = `<div class="pane-doc-body" data-doc="${esc(paneKey(item))}" data-version="${esc(item.versionId || "")}"><p>Loading…</p></div>`;
      else inner = `<p>Choose what this pane shows.</p><div class="inline-actions">${action("pane-choose", "Show a tab…", "tabs", `data-index="${index}" data-kind="tab"`)}${action("pane-choose", "Show a capture…", "artifacts", `data-index="${index}" data-kind="artifact"`)}${action("pane-choose", "Show a material…", "folder", `data-index="${index}" data-kind="material"`)}${action("pane-choose", "Show a task…", "tasks", `data-index="${index}" data-kind="task"`)}</div>`;
      const frame = `<div class="pane-frame ${focusIndex === index ? "focused" : ""} ${tab && controlMode(tab) === "agent-drives" ? "agent" : ""} ${tab && handoff(tab.id) ? "handoff" : ""}" data-pane="${name}" ${tab ? `data-tab="${tab.id}"` : ""} aria-hidden="true" style="${rel({ x: body.x - PANE_INSET, y: body.y - PANE_INSET, width: body.width + 2 * PANE_INSET, height: body.height + 2 * PANE_INSET })}"></div>`;
      return header + frame + (inner ? `<section class="pane-doc" role="region" aria-label="${esc(label(index, shown))}: ${esc(title(item, tabs, records))}" tabindex="-1" data-pane-index="${index}" style="${rel(body)}">${inner}</section>` : "");
    }).join("");
    const dividerHtml = dividers.map((divider) => {
      const value = Math.round(normalizeSizes(layout, sizes)[divider.index] * 100);
      return `<div class="pane-divider ${divider.orientation}" role="separator" tabindex="0" aria-orientation="${divider.orientation}" aria-valuemin="15" aria-valuemax="85" aria-valuenow="${value}" aria-label="Resize panes (arrow keys; Home resets)" data-divider="${divider.index}" style="${rel(divider)}"></div>`;
    }).join("");
    const notice = collapsed ? `<div class="pane-collapse-notice visually-hidden" role="status">This window is too small for ${count()} panes; showing ${paneCount(shown)}. Enlarge the window to see them all.</div>` : "";
    return `<div class="pane-headers" role="group" aria-label="Panes (${paneCount(shown)})">${panesHtml}${dividerHtml}</div>${notice}`;
  }

  /** Fill document panes after render. */
  async function hydrate(records, root) {
    for (const element of root.querySelectorAll(".pane-doc-body[data-doc]")) {
      const [type, ...rest] = element.dataset.doc.split(":");
      const id = rest.join(":");
      const html = await documentFor({ type, id, versionId: element.dataset.version || undefined }, records);
      if (element.isConnected && element.dataset.doc === `${type}:${id}`) element.innerHTML = html;
    }
  }

  /** Native view rectangles for tab panes (and a preview pane) in window coordinates. */
  function nativePanes(box, tabs, previewing) {
    const { rects, items: shownItems } = geometry(box);
    return rects.flatMap((rect, index) => {
      const item = shownItems[index];
      const tab = tabIn(item, tabs);
      const body = { x: rect.x + PANE_INSET, y: rect.y + PANE_HEADER + PANE_INSET, width: Math.max(1, rect.width - 2 * PANE_INSET), height: Math.max(1, rect.height - PANE_HEADER - 2 * PANE_INSET) };
      if (tab && tab.url !== "about:blank" && !tab.blocked) return [{ tabId: tab.id, ...body }];
      if (item?.type === "preview" && previewing) return [{ preview: true, ...body }];
      return [];
    });
  }

  /** Pointer and keyboard resizing; returns true when a key was handled. */
  function dividerKey(event, box) {
    const index = Number(event.target.dataset.divider);
    if (!Number.isInteger(index)) return false;
    const step = event.shiftKey ? 0.1 : 0.02;
    const horizontal = event.target.getAttribute("aria-orientation") === "horizontal";
    const delta = { ArrowLeft: horizontal ? 0 : -step, ArrowRight: horizontal ? 0 : step, ArrowUp: horizontal ? -step : 0, ArrowDown: horizontal ? step : 0 }[event.key];
    if (event.key === "Home") { resetSizes(); return true; }
    if (!delta) return false;
    resize(index, delta);
    announce(`Pane size ${Math.round(normalizeSizes(layout, sizes)[index] * 100)} percent.`);
    void box;
    return true;
  }
  function dragTo(index, box, point) {
    const divider = paneDividers(layout, box, sizes).find((d) => d.index === index);
    if (divider) sizes = sizeAt(layout, box, divider, point, sizes);
  }

  return {
    get layout() { return layout; }, get items() { return items.slice(0, count()); }, get focused() { return focused; }, get collapsed() { return collapsed; },
    multi, label, state, load, sync, setLayout, open, close, remove, focus, resize, resetSizes, render, hydrate, nativePanes, dividerKey, dragTo,
    focusedItem: () => items[focused] ?? null, effective, gap: PANE_GAP,
  };
}
