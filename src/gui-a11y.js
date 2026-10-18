/**
 * Accessibility helpers for the trusted GUI (#31). Announcements go through two
 * dedicated, visually hidden live regions so screen readers hear meaningful
 * changes (completed replies, new agent requests, control changes, results)
 * instead of every status tick, poll re-render or streamed token.
 */
const $ = (id) => document.getElementById(id);
let lastMessage = "";
let lastAt = 0;
let pending;

/** Announce a meaningful change once. Repeats within 1.5 s are dropped; assertive is reserved for safety stops. */
export function announce(message, { assertive = false } = {}) {
  const text = String(message || "").replace(/\s+/g, " ").trim().slice(0, 300);
  if (!text) return;
  const now = Date.now();
  if (text === lastMessage && now - lastAt < 1500) return;
  lastMessage = text;
  lastAt = now;
  const region = $(assertive ? "alert-announcer" : "announcer");
  if (!region) return;
  clearTimeout(pending);
  region.textContent = "";
  // A short gap makes assistive technology treat a repeated string as new.
  pending = setTimeout(() => (region.textContent = text), 60);
}

const focusableSelector = 'button, a[href], input:not([type=hidden]), select, textarea, summary, [tabindex]:not([tabindex="-1"])';

/**
 * Scrollable containers without focusable content cannot be scrolled from the
 * keyboard. Give them a tab stop and a name; containers with controls inside
 * stay as they are.
 */
export function keyboardScrollable(root, label = "Scrollable content") {
  if (!root) return;
  const candidates = [root, ...root.querySelectorAll("pre, .dialog-body, .artifact-text, .tool-result, .palette-results, .redact-canvas, table")];
  for (const element of candidates) {
    if (!element.isConnected) continue;
    const scrolls = element.scrollHeight > element.clientHeight + 1 || element.scrollWidth > element.clientWidth + 1;
    if (!scrolls || element.hasAttribute("tabindex")) continue;
    if (element.querySelector(focusableSelector)) continue;
    element.tabIndex = 0;
    if (!element.getAttribute("role") && !["PRE", "TABLE"].includes(element.tagName)) element.setAttribute("role", "region");
    if (!element.hasAttribute("aria-label") && !element.hasAttribute("aria-labelledby")) element.setAttribute("aria-label", element.dataset.scrollLabel || label);
  }
}

/** After a view change, move focus to its main heading so the new view is read from the top. */
export function focusView(content) {
  const heading = content.querySelector("h1");
  if (heading) {
    heading.tabIndex = -1;
    heading.focus({ preventScroll: true });
  } else content.focus({ preventScroll: true });
}

/**
 * One visual language for browser-owned, trusted surfaces (approvals, payments,
 * sign-ins, site controls, stop pages): a plum band that names Weft as the owner
 * and the kind of decision. Page content can never draw outside its native view,
 * so a band rendered here cannot be imitated by a website.
 */
export function trustedBand(kind, shield) {
  return `<div class="trusted-band">${shield}<span><strong>Weft browser control</strong><span class="trusted-kind">${kind}</span></span></div>`;
}

/** Agent and task state as text plus a distinct marker shape, never colour alone (style guide 10). */
const stateShapes = {
  working: "working", running: "working", queued: "waiting", waiting: "waiting", waiting_on_human: "waiting", paused: "paused",
  completed: "done", failed: "blocked", cancelled: "paused", uncertain: "blocked", blocked: "blocked", agent: "agent", you: "you", assist: "assist", available: "available",
};
export function stateBadge(state, label) {
  const shape = stateShapes[state] || "available";
  return `<span class="state-badge state-${shape}"><span class="state-marker" aria-hidden="true"></span>${label}</span>`;
}
