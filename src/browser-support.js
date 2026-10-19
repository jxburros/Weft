/**
 * Constants, page scripts and small helpers shared by the Browser class (src/browser.js) and the modules
 * split out of it (#119): browser-commands.js, browser-chrome.js, browser-credentials.js and browser-captures.js.
 */
import { matchShortcut } from './shortcuts.js';
import { pageString } from './page-observation.js';

export const mutatingCommands = new Set(['page.navigate', 'page.back', 'page.forward', 'page.reload', 'page.stop', 'page.evaluate', 'page.click', 'page.fill', 'page.clickAt', 'page.press', 'page.zoom', 'page.allowOnce', 'tabs.close', 'tabs.move', 'tabs.pin']);
// Commands whose newly observable site block means the requested input did not complete.
export const inputCommands = new Set(['page.click', 'page.fill', 'page.clickAt', 'page.press', 'page.navigate', 'page.forward', 'page.reload']);
export const rawInputCommands = new Set(['page.clickAt', 'page.press']);
// Page input that could submit a checkout. After a card fill only payments.submit (term-bound approval, ADR 019) may do that.
export const cardGuardedCommands = new Set(['page.click', 'page.fill', 'page.clickAt', 'page.press']);
// During a protected operation and its cooldown, automation may only read tab metadata or give up its lease on that tab.
export const PROTECTED_ALLOWED = new Set(['page.inspect', 'tabs.list', 'tabs.release']);
// Observation routes that would show a brokered secret if the page revealed or copied it as plain text.
export const REVEAL_CHECKED = new Set(['page.snapshot', 'page.screenshot', 'page.pdf']);
export const isHuman = actor => ['human', 'admin'].includes(actor);
/** Page-sourced JSON with control and bidirectional-override characters removed from every string and key. */
export const cleanPageValue = value => typeof value === 'string' ? pageString(value, Infinity)
  : Array.isArray(value) ? value.map(cleanPageValue)
    : value && typeof value === 'object' ? Object.fromEntries(Object.entries(value).map(([key, item]) => [pageString(key, Infinity), cleanPageValue(item)])) : value;
export const failure = (code, message, details) => Object.assign(new Error(message), { code, ...(details && { details }) });
export const stale = (reason, message, details = {}) => failure('stale_state', message, { reason, ...details });
export const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const elementFailures = {
  unknown_ref: () => stale('unknown_ref', 'The element ref is unknown in the current document; take a new page.snapshot'),
  detached: () => stale('element_detached', 'The element was removed from the page after the snapshot; take a new page.snapshot'),
  changed: () => stale('element_changed', 'The element changed role or name after the snapshot; take a new page.snapshot'),
  not_found: () => new Error('Element not found'),
  not_editable: () => new Error('Element is not editable'),
  disabled: () => new Error('Element is disabled'),
  invalid_selector: () => failure('invalid_arguments', 'Invalid CSS selector'),
};
export const elementFailure = reason => (elementFailures[reason] ?? (() => new Error('Element action failed')))();
export const humanOnlyBrowserCommands = new Set(['storage.setSiteMode', 'storage.setDefaultMode', 'threats.install', 'threats.remove', 'threats.configureProvider', 'threats.update', 'downloads.configureScanner', 'launches.approve', 'launches.deny']);
export const navigationCommands = new Set(['page.click', 'page.fill', 'page.navigate', 'page.forward', 'page.reload', 'page.allowOnce']);
export const HUMAN_GESTURE_MS = 2000;
// Popups follow Chromium's transient user activation lifespan (about 5 s after a click or key press in the tab).
export const POPUP_GESTURE_MS = 5000;
// Gap between split panes; the trusted GUI draws the divider and focused-pane frame in it (#36).
export const SPLIT_GAP = 6;
// A pane rectangle from the trusted GUI: a tab or the archive preview, integer bounds inside the window.
export const validPaneRect = pane => pane && typeof pane === 'object' && !Array.isArray(pane)
  && Object.keys(pane).every(key => ['tabId', 'preview', 'x', 'y', 'width', 'height'].includes(key))
  && ((Number.isInteger(pane.tabId) && pane.tabId > 0 && pane.preview == null) || (pane.preview === true && pane.tabId == null))
  && ['x', 'y', 'width', 'height'].every(key => Number.isInteger(pane[key]) && pane[key] >= 0 && pane[key] <= 20000);
/**
 * Browser-owned keys pressed inside a page (#31, #88). Returns the shortcut id, or null. The full
 * table, including which keys a page may keep for itself, is in src/shortcuts.js.
 */
export function chromeShortcut(input, options) {
  return matchShortcut(input, options)?.id ?? null;
}
// Isolated world that reports page-claimable shortcut keys the page did not handle (#88).
export const KEY_WORLD = 1009;
export const keyWatcherScript = nonce => `(() => {
  if (globalThis.__weftKeys) return true;
  globalThis.__weftKeys = true;
  addEventListener('keydown', event => {
    if (!event.isTrusted || event.repeat) return;
    // After dispatch: a handler anywhere in the page may still call preventDefault.
    setTimeout(() => { if (!event.defaultPrevented) console.debug(${JSON.stringify(nonce)} + JSON.stringify({ key: String(event.key).toLowerCase() })); }, 0);
  }, true);
  return true;
})()`;
export const TERMINAL_TASK = new Set(['completed', 'failed', 'cancelled']);
// Commands that work on the stored tab record; every other page/tab command restores a suspended tab first.
export const SUSPENDED_OK = new Set(['tabs.list', 'tabs.close', 'tabs.reorder', 'tabs.closed', 'tabs.reopen', 'tabs.pin', 'tabs.claim', 'tabs.release', 'tabs.takeover', 'tabs.setControlMode', 'tabs.group', 'tabs.search', 'tabs.suspend', 'tabs.activate', 'tabs.duplicate', 'tabs.move', 'page.inspect']);
/** Frame-side check for state a reload would destroy: run in the top frame's isolated world and in each subframe (see pageStateBlockers). */
export const SUSPENSION_CHECK = `(() => {
  const media = [...document.querySelectorAll('video, audio')].some(element => !element.paused && !element.ended);
  const changed = [...document.querySelectorAll('input, textarea, select')].some(element => {
    if (element.disabled || element.type === 'hidden') return false;
    if (element.tagName === 'SELECT') return [...element.options].some(option => option.selected !== option.defaultSelected);
    if (element.type === 'checkbox' || element.type === 'radio') return element.checked !== element.defaultChecked;
    if (element.type === 'file') return Boolean(element.files && element.files.length);
    if (['button', 'submit', 'reset', 'image'].includes(element.type)) return false;
    return element.value !== element.defaultValue;
  });
  const editing = [...document.querySelectorAll('[contenteditable]')].some(element => element.isContentEditable && element.contains(document.activeElement));
  return { media, unsavedInput: changed || editing, fullscreen: Boolean(document.fullscreenElement) };
})()`;
// Subframes checked before suspending a tab; a page with more is not suspended (frame_not_inspected).
export const MAX_CHECKED_FRAMES = 50;
// Schemes that are navigation denials rather than external-application launches.
export const NOT_LAUNCHES = new Set(['http', 'https', 'about', 'data', 'javascript', 'blob', 'file', 'filesystem', 'chrome', 'devtools', 'view-source']);
/** Engine switches that keep speculative connections from running ahead of site rules. */
export function applyEngineHardening(app) {
  app.commandLine.appendSwitch('dns-prefetch-disable');
  app.commandLine.appendSwitch('disable-features', 'PreconnectToSearch,SpeculationRulesPrefetch,Prerender2');
}
export function safeUrl(value) {
  const url = new URL(value);
  if (!['http:', 'https:'].includes(url.protocol) && url.href !== 'about:blank') {
    throw new Error('Only HTTP, HTTPS and about:blank URLs are allowed');
  }
  if (url.username || url.password) throw new Error('URLs must not contain credentials');
  return url.href;
}
/** Isolated-world scan of resources the page references or loaded, plus cross-origin frame boxes. Page data only; nothing is changed. */
export const RESOURCE_SCAN_SCRIPT = `(() => {
  const references = [];
  const add = (value, kind) => { if (!value || references.length >= 5000) return; try { const url = new URL(value, document.baseURI); if (/^https?:$/.test(url.protocol)) references.push({ url: url.href.slice(0, 16384), kind }); } catch {} };
  const srcset = value => String(value || '').split(',').map(part => part.trim().split(/\\s+/)[0]).filter(Boolean);
  for (const el of document.querySelectorAll('img, source, video, audio, track, embed, object, input[type=image], link[href], script[src], iframe[src], frame[src]')) {
    const tag = el.localName;
    if (tag === 'link') {
      const rel = String(el.rel || '').toLowerCase();
      const kind = /stylesheet/.test(rel) ? 'stylesheet' : /icon/.test(rel) ? 'icon' : /modulepreload/.test(rel) || (/preload/.test(rel) && el.as === 'script') ? 'script' : /preload/.test(rel) ? 'preload' : null;
      if (kind) add(el.getAttribute('href'), kind);
      continue;
    }
    if (tag === 'script') { add(el.getAttribute('src'), 'script'); continue; }
    if (tag === 'iframe' || tag === 'frame') { add(el.getAttribute('src'), 'frame'); continue; }
    if (tag === 'object') { add(el.getAttribute('data'), 'object'); continue; }
    if (el.getAttribute('src')) add(el.getAttribute('src'), tag === 'img' || tag === 'input' ? 'image' : 'media');
    for (const item of srcset(el.getAttribute('srcset'))) add(item, 'image');
    if (tag === 'video' && el.getAttribute('poster')) add(el.getAttribute('poster'), 'image');
  }
  for (const entry of performance.getEntriesByType('resource').slice(0, 3000)) add(entry.name, ['script', 'fetch', 'xmlhttprequest', 'beacon'].includes(entry.initiatorType) ? entry.initiatorType : entry.initiatorType === 'iframe' ? 'frame' : entry.initiatorType === 'img' ? 'image' : entry.initiatorType === 'link' || entry.initiatorType === 'css' ? 'stylesheet-resource' : 'resource');
  const frames = [...document.querySelectorAll('iframe, frame')].slice(0, 200).map(frame => {
    let accessible = false; try { accessible = Boolean(frame.contentDocument); } catch {}
    let origin = null; try { origin = new URL(frame.src, location.href).origin; } catch {}
    const r = frame.getBoundingClientRect();
    return { accessible, origin, box: { x: r.x, y: r.y, width: r.width, height: r.height } };
  });
  return { references, frames, viewport: { width: innerWidth, height: innerHeight, devicePixelRatio: devicePixelRatio, scrollX: scrollX, scrollY: scrollY, documentWidth: document.documentElement.scrollWidth, documentHeight: document.documentElement.scrollHeight } };
})()`;
export function bounded(promise, timeout = 8000) {
  let timer;
  return Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('Page capture timed out; show the tab and try again')), timeout); })]).finally(() => clearTimeout(timer));
}
