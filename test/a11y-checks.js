/**
 * In-page accessibility checks injected into the real GUI renderer by test/accessibility.test.js.
 * Everything is computed from rendered, computed styles in Chromium (not from token values):
 * text/state contrast with alpha compositing and opacity, focus-indicator contrast, target size,
 * keyboard reachability bookkeeping, and clipping/overlap at large text and zoom.
 * The source is serialised with Function.prototype.toString, so it must stay self-contained.
 */
export function installChecks() {
  const parse = (value) => {
    const m = /rgba?\(([^)]+)\)/.exec(value || "");
    if (!m) return null;
    const [r, g, b, a = 1] = m[1].split(/[ ,/]+/).filter(Boolean).map(Number);
    return { r, g, b, a };
  };
  const over = (top, bottom) => {
    const a = top.a + bottom.a * (1 - top.a);
    if (!a) return { r: 0, g: 0, b: 0, a: 0 };
    const mix = (c) => (top[c] * top.a + bottom[c] * bottom.a * (1 - top.a)) / a;
    return { r: mix("r"), g: mix("g"), b: mix("b"), a };
  };
  const luminance = ({ r, g, b }) => {
    const lin = (c) => { c /= 255; return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4; };
    return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
  };
  const ratio = (a, b) => { const [x, y] = [luminance(a), luminance(b)].sort((p, q) => q - p); return (x + 0.05) / (y + 0.05); };
  const opacity = (el) => { let o = 1; for (let n = el; n && n.nodeType === 1; n = n.parentElement) o *= Number(getComputedStyle(n).opacity); return o; };
  /** Effective background behind an element: composite every ancestor background (and a dialog's own surface) down to the page. */
  const background = (el) => {
    const layers = [];
    for (let n = el; n && n.nodeType === 1; n = n.parentElement) {
      const c = parse(getComputedStyle(n).backgroundColor);
      if (c && c.a > 0) layers.push(c);
      if (c && c.a >= 1) break;
    }
    let result = parse(getComputedStyle(document.documentElement).backgroundColor) || { r: 255, g: 255, b: 255, a: 1 };
    for (const layer of layers.reverse()) result = over(layer, result);
    return { ...result, a: 1 };
  };
  const foreground = (el) => {
    const c = parse(getComputedStyle(el).color) || { r: 0, g: 0, b: 0, a: 1 };
    const bg = background(el);
    return { color: over({ ...c, a: c.a * opacity(el) }, bg), bg };
  };
  const visible = (el) => {
    if (!el.isConnected || el.closest("[hidden],[inert]")) return false;
    const s = getComputedStyle(el);
    if (s.visibility === "hidden" || s.display === "none") return false;
    const r = el.getBoundingClientRect();
    return r.width > 0 && r.height > 0;
  };
  const describe = (el) => {
    const label = el.getAttribute("aria-label") || el.textContent?.trim().replace(/\s+/g, " ").slice(0, 40) || el.getAttribute("name") || "";
    return `${el.tagName.toLowerCase()}${el.id ? "#" + el.id : ""}${el.dataset?.action ? `[data-action=${el.dataset.action}]` : ""}${el.className && typeof el.className === "string" ? "." + el.className.trim().split(/\s+/).join(".") : ""} "${label}"`;
  };
  const interactive = (root = document) => [...root.querySelectorAll('button, a[href], input:not([type=hidden]), select, textarea, summary, [tabindex]:not([tabindex="-1"])')]
    .filter((el) => visible(el) && !el.closest("#command-desk[hidden]"));
  const scope = () => (document.getElementById("lock-screen") || (document.getElementById("dialog").open ? document.getElementById("dialog") : document));
  const textOf = (el) => [...el.childNodes].filter((n) => n.nodeType === 3).map((n) => n.textContent).join("").trim();
  const large = (el) => { const s = getComputedStyle(el); const size = parseFloat(s.fontSize); return size >= 24 || (size >= 18.66 && Number(s.fontWeight) >= 600); };

  window.__a11y = {
    ratio, describe, interactive, visible,
    /** Text contrast of every visible text-bearing element in the current scope, including disabled/selected/error states. */
    contrast() {
      const failures = [];
      const states = { disabled: 0, selected: 0, error: 0, text: 0 };
      for (const el of scope().querySelectorAll("*")) {
        if (!visible(el) || !textOf(el) || ["SCRIPT", "STYLE", "OPTION"].includes(el.tagName)) continue;
        // Decorative text only: the wordmark image alternative and kbd hints are still checked.
        const control = el.closest("button, a, input, select, textarea, summary, label");
        const disabled = Boolean(el.closest(":disabled, [aria-disabled=true]")) || Boolean(control?.matches(":disabled"));
        const selected = Boolean(el.closest(".active, [aria-current], [aria-selected=true], [aria-pressed=true], .current"));
        const error = Boolean(el.closest(".form-error, .danger, [role=alert]"));
        const { color, bg } = foreground(el);
        const value = ratio(color, bg);
        const kind = disabled ? "disabled" : error ? "error" : selected ? "selected" : "text";
        states[kind]++;
        // Disabled controls are exempt from WCAG 1.4.3; Weft still keeps them at 3:1 so their labels stay readable.
        const minimum = disabled ? 3 : large(el) ? 3 : 4.5;
        if (value + 0.005 < minimum) failures.push({ kind, element: describe(el), ratio: Number(value.toFixed(2)), minimum });
      }
      return { failures, states };
    },
    /** Every focusable control shows a visible indicator with at least 3:1 against the surface behind it. */
    async focusIndicators() {
      const failures = [];
      const controls = interactive(scope()).filter((el) => !el.disabled);
      for (const el of controls) {
        el.focus({ preventScroll: false });
        if (document.activeElement !== el) continue;
        await new Promise((r) => requestAnimationFrame(r));
        // Polling may replace a control while it is being measured; the replacement is measured on its own turn.
        if (!el.isConnected) continue;
        let ring = el;
        let s = getComputedStyle(el);
        // Composite fields draw the ring on their container (address bar).
        if ((s.outlineStyle === "none" || parseFloat(s.outlineWidth) === 0) && el.closest(".address-field")) { ring = el.closest(".address-field"); s = getComputedStyle(ring); }
        const width = s.outlineStyle === "none" ? 0 : parseFloat(s.outlineWidth);
        if (width < 2) { failures.push({ element: describe(el), problem: `outline ${s.outlineStyle} ${s.outlineWidth}` }); continue; }
        const color = parse(s.outlineColor);
        if (!color) { failures.push({ element: describe(el), problem: `unparsed outline colour ${s.outlineColor}` }); continue; }
        const behind = background(ring.parentElement || ring);
        const value = ratio(over(color, behind), behind);
        if (value < 3) failures.push({ element: describe(el), problem: `indicator contrast ${value.toFixed(2)}:1` });
      }
      document.activeElement?.blur();
      return { checked: controls.length, failures };
    },
    /** WCAG 2.2 target size (minimum): 24 x 24 CSS px, with the standard spacing exception for undersized targets. */
    targets() {
      const failures = [];
      const controls = interactive(scope());
      const rects = controls.map((el) => el.getBoundingClientRect());
      controls.forEach((el, i) => {
        const r = rects[i];
        if (r.width >= 24 && r.height >= 24) return;
        // Inline links inside sentences are exempt.
        if (el.tagName === "A" && getComputedStyle(el).display === "inline") return;
        // A checkbox or radio whose whole label row is the target.
        const label = el.closest("label");
        if (label && ["checkbox", "radio"].includes(el.type)) { const lr = label.getBoundingClientRect(); if (lr.height >= 24 && lr.width >= 24) return; }
        const cx = r.left + r.width / 2, cy = r.top + r.height / 2;
        const clash = rects.some((o, j) => j !== i && Math.max(o.left - cx, 0, cx - o.right) ** 2 + Math.max(o.top - cy, 0, cy - o.bottom) ** 2 < 144);
        failures.push({ element: describe(el), size: `${Math.round(r.width)}x${Math.round(r.height)}`, spacingException: !clash });
      });
      return { checked: controls.length, failures: failures.filter((f) => !f.spacingException) };
    },
    /** Elements a keyboard user must be able to reach in the current scope, as stable descriptions. */
    tabbable() {
      return interactive(scope()).filter((el) => !el.disabled && el.tabIndex >= 0 && !el.closest("details:not([open]) > :not(summary)")).map((el) => ({ id: describe(el), element: describe(el) }));
    },
    focusedId() { const el = document.activeElement; return el && el !== document.body && el !== document.getElementById("dialog") ? describe(el) : null; },
    /** Clipped or overlapping essential controls and horizontal overflow (large text, zoom, minimum window). */
    layout() {
      const problems = [];
      if (document.documentElement.scrollWidth > innerWidth + 1) problems.push(`document overflows horizontally: ${document.documentElement.scrollWidth} > ${innerWidth}`);
      // Only the part of a control that its scroll containers actually show can overlap anything.
      const shown = (el) => {
        const r = el.getBoundingClientRect();
        let box = { left: r.left, top: r.top, right: r.right, bottom: r.bottom };
        for (let n = el.parentElement; n && n !== document.documentElement; n = n.parentElement) {
          const s = getComputedStyle(n);
          if (!/(auto|scroll|hidden|clip)/.test(s.overflowX + s.overflowY)) continue;
          const p = n.getBoundingClientRect();
          box = { left: Math.max(box.left, p.left), top: Math.max(box.top, p.top), right: Math.min(box.right, p.right), bottom: Math.min(box.bottom, p.bottom) };
        }
        return box;
      };
      const controls = interactive(scope());
      const rects = controls.map(shown);
      controls.forEach((el, i) => {
        const r = el.getBoundingClientRect();
        // A control must be inside the viewport or inside a scroll container that can reveal it.
        let clipped = false;
        for (let n = el.parentElement; n && n !== document.body; n = n.parentElement) {
          const s = getComputedStyle(n);
          if (/(auto|scroll)/.test(s.overflowX + s.overflowY)) break;
          if (/(hidden|clip)/.test(s.overflowX + s.overflowY)) {
            const p = n.getBoundingClientRect();
            if (r.right > p.right + 1 || r.bottom > p.bottom + 1 || r.left < p.left - 1) { clipped = true; break; }
          }
        }
        if (clipped) problems.push(`clipped: ${describe(el)}`);
        const v = rects[i];
        for (let j = i + 1; j < controls.length; j++) {
          const o = rects[j];
          const w = Math.min(v.right, o.right) - Math.max(v.left, o.left), h = Math.min(v.bottom, o.bottom) - Math.max(v.top, o.top);
          if (w > 2 && h > 2 && !controls[j].contains(el) && !el.contains(controls[j]) && !el.closest("label")?.contains(controls[j])) problems.push(`overlap: ${describe(el)} / ${describe(controls[j])}`);
        }
      });
      // Text that is cut off without an ellipsis (an ellipsis is an intentional, titled truncation).
      for (const el of scope().querySelectorAll("h1, h2, h3, p, strong, label, button, small, .notice")) {
        if (!visible(el) || el.closest(".visually-hidden")) continue;
        const s = getComputedStyle(el);
        if (s.textOverflow === "ellipsis" || !/(hidden|clip)/.test(s.overflowX + s.overflowY)) continue;
        if (el.scrollWidth > el.clientWidth + 2 || el.scrollHeight > el.clientHeight + 2) problems.push(`text clipped: ${describe(el)}`);
      }
      return problems;
    },
    /** Running animations and transitions (must be none under reduced motion). */
    motion() {
      return [...document.querySelectorAll("*")].filter((el) => { const s = getComputedStyle(el); return (s.animationName !== "none" && parseFloat(s.animationDuration) > 0) || parseFloat(s.transitionDuration) > 0; }).map(describe).slice(0, 20);
    },
    /** Smallest rendered font size of visible text. */
    minFont() {
      let min = Infinity, where = "";
      for (const el of scope().querySelectorAll("*")) { if (!visible(el) || !textOf(el)) continue; const size = parseFloat(getComputedStyle(el).fontSize); if (size < min) { min = size; where = describe(el); } }
      return { min, where };
    },
  };
}
