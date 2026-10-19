/**
 * Standard browser keyboard shortcuts (#88), shared by the main process (keys pressed inside a page)
 * and the trusted GUI (keys pressed in the browser chrome). Pure: no Electron or DOM access.
 *
 * `claimable` shortcuts are ones browsers conventionally let a page keep (an editor using Ctrl+D or
 * Ctrl+F): inside a page they run only when the page did not call preventDefault. Every other
 * shortcut (new/close/reopen tab, tab switching, windows, DevTools and the focus keys that stop a
 * page trapping keyboard focus) is intercepted before the page sees it.
 */
export const SHORTCUTS = Object.freeze([
  { id: 'tab-new', label: 'New tab', keys: [{ mod: true, key: 't' }] },
  { id: 'tab-close', label: 'Close tab', keys: [{ mod: true, key: 'w' }] },
  { id: 'tab-reopen', label: 'Reopen closed tab', keys: [{ mod: true, shift: true, key: 't' }] },
  { id: 'tab-next', label: 'Next tab', keys: [{ ctrl: true, key: 'tab' }, { ctrl: true, key: 'pagedown' }, { mac: true, mod: true, alt: true, key: 'arrowright' }] },
  { id: 'tab-previous', label: 'Previous tab', keys: [{ ctrl: true, shift: true, key: 'tab' }, { ctrl: true, key: 'pageup' }, { mac: true, mod: true, alt: true, key: 'arrowleft' }] },
  ...Array.from({ length: 8 }, (_, index) => ({ id: `tab-${index + 1}`, label: `Tab ${index + 1}`, keys: [{ mod: true, key: String(index + 1) }] })),
  { id: 'tab-last', label: 'Last tab', keys: [{ mod: true, key: '9' }] },
  { id: 'back', label: 'Back', claimable: true, keys: [{ other: true, alt: true, key: 'arrowleft' }, { mac: true, mod: true, key: '[' }] },
  { id: 'forward', label: 'Forward', claimable: true, keys: [{ other: true, alt: true, key: 'arrowright' }, { mac: true, mod: true, key: ']' }] },
  { id: 'reload', label: 'Reload', claimable: true, keys: [{ mod: true, key: 'r' }, { key: 'f5' }] },
  { id: 'hard-reload', label: 'Reload without the cache', claimable: true, keys: [{ mod: true, shift: true, key: 'r' }, { shift: true, key: 'f5' }, { ctrl: true, key: 'f5' }] },
  // Esc stops a page only while it is loading; otherwise the key belongs to the page.
  { id: 'stop', label: 'Stop loading', claimable: true, whileLoading: true, keys: [{ key: 'escape' }] },
  { id: 'find', label: 'Find in page', claimable: true, keys: [{ mod: true, key: 'f' }] },
  { id: 'find-next', label: 'Next match', claimable: true, keys: [{ mod: true, key: 'g' }, { key: 'f3' }] },
  { id: 'find-previous', label: 'Previous match', claimable: true, keys: [{ mod: true, shift: true, key: 'g' }, { shift: true, key: 'f3' }] },
  { id: 'print', label: 'Print', claimable: true, keys: [{ mod: true, key: 'p' }] },
  { id: 'zoom-in', label: 'Zoom in', claimable: true, keys: [{ mod: true, key: '=' }, { mod: true, key: '+' }, { mod: true, shift: true, key: '+' }, { mod: true, shift: true, key: '=' }] },
  { id: 'zoom-out', label: 'Zoom out', claimable: true, keys: [{ mod: true, key: '-' }, { mod: true, shift: true, key: '_' }] },
  { id: 'zoom-reset', label: 'Actual size', claimable: true, keys: [{ mod: true, key: '0' }] },
  { id: 'bookmark', label: 'Bookmark this page', claimable: true, keys: [{ mod: true, key: 'd' }] },
  { id: 'view-source', label: 'View page source', claimable: true, keys: [{ other: true, mod: true, key: 'u' }, { mac: true, mod: true, alt: true, key: 'u' }] },
  { id: 'downloads', label: 'Downloads', claimable: true, keys: [{ mod: true, key: 'j' }] },
  { id: 'search-tabs', label: 'Search tabs', claimable: true, keys: [{ mod: true, shift: true, key: 'a' }] },
  { id: 'devtools', label: 'Developer tools', keys: [{ key: 'f12' }, { other: true, mod: true, shift: true, key: 'i' }, { mac: true, mod: true, alt: true, key: 'i' }] },
  { id: 'private-window', label: 'New private window', keys: [{ mod: true, shift: true, key: 'n' }] },
  { id: 'new-window', label: 'New window', keys: [{ mod: true, alt: true, key: 'n' }] },
  // Focus keys (#31): a page can never trap keyboard focus.
  { id: 'address', label: 'Focus the address bar', keys: [{ mod: true, key: 'l' }, { anyMod: true, key: 'l' }, { other: true, alt: true, key: 'd' }] },
  { id: 'palette', label: 'Find anything', keys: [{ mod: true, key: 'k' }, { anyMod: true, key: 'k' }] },
  { id: 'chrome', label: 'Next region', keys: [{ key: 'f6' }] },
  { id: 'chrome-back', label: 'Previous region', keys: [{ shift: true, key: 'f6' }] },
]);
const byId = new Map(SHORTCUTS.map(item => [item.id, item]));
export const shortcut = id => byId.get(id) ?? null;

const isMac = platform => platform === 'darwin';

function matches(binding, input, mac) {
  if (binding.mac && !mac) return false;
  if (binding.other && mac) return false;
  const control = Boolean(input.control), meta = Boolean(input.meta), shift = Boolean(input.shift), alt = Boolean(input.alt);
  let wantControl = Boolean(binding.ctrl), wantMeta = false;
  if (binding.mod) { if (mac) wantMeta = true; else wantControl = true; }
  if (binding.anyMod) { if (!(control || meta) || (control && meta)) return false; }
  else if (control !== wantControl || meta !== wantMeta) return false;
  if (alt !== Boolean(binding.alt)) return false;
  // Shift is significant except for shifted symbols that some layouts need to type the key at all.
  if (shift !== Boolean(binding.shift)) return false;
  return true;
}

/** Normalize the key name of an Electron `input` or DOM KeyboardEvent. */
export function keyName(input) {
  const key = String(input?.key ?? '').toLowerCase();
  if (key === 'add') return '+';
  if (key === 'subtract') return '-';
  return key === 'left' ? 'arrowleft' : key === 'right' ? 'arrowright' : key;
}

/**
 * The shortcut an input event names, or null. `input` is an Electron before-input-event input
 * ({type, key, control, meta, shift, alt, isAutoRepeat}) or a DOM KeyboardEvent-like object.
 */
export function matchShortcut(input, { platform = globalThis.process?.platform, loading = false } = {}) {
  if (!input || (input.type && !['keyDown', 'rawKeyDown', 'keydown'].includes(input.type)) || input.isAutoRepeat || input.repeat) return null;
  const event = { key: keyName(input), control: input.control ?? input.ctrlKey, meta: input.meta ?? input.metaKey, shift: input.shift ?? input.shiftKey, alt: input.alt ?? input.altKey };
  const mac = isMac(platform);
  for (const item of SHORTCUTS) {
    if (item.whileLoading && !loading) continue;
    if (item.keys.some(binding => binding.key === event.key && matches(binding, event, mac))) return item;
  }
  return null;
}

/** ARIA `aria-keyshortcuts` value for a shortcut on this platform, e.g. "Control+T". */
export function ariaKeys(id, platform = globalThis.process?.platform) {
  const item = byId.get(id);
  if (!item) return '';
  const mac = isMac(platform);
  const names = { arrowleft: 'ArrowLeft', arrowright: 'ArrowRight', pageup: 'PageUp', pagedown: 'PageDown', escape: 'Escape', tab: 'Tab', '=': 'Equal', '-': 'Minus', '+': 'Plus', '[': 'BracketLeft', ']': 'BracketRight' };
  return item.keys.filter(binding => !(binding.mac && !mac) && !(binding.other && mac) && !binding.anyMod).slice(0, 2).map(binding => [
    ...(binding.ctrl || (binding.mod && !mac) ? ['Control'] : []), ...(binding.mod && mac ? ['Meta'] : []), ...(binding.alt ? ['Alt'] : []), ...(binding.shift ? ['Shift'] : []),
    names[binding.key] ?? (binding.key.length === 1 ? binding.key.toUpperCase() : binding.key.toUpperCase()),
  ].join('+')).join(' ');
}

/** Human-readable key label for menus and docs, e.g. "Ctrl+Shift+T" or "⌘⇧T". */
export function keyLabel(id, platform = globalThis.process?.platform) {
  return ariaKeys(id, platform).split(' ')[0].replace('Control', 'Ctrl').replace('Meta', isMac(platform) ? 'Cmd' : 'Meta').replace('ArrowLeft', 'Left').replace('ArrowRight', 'Right')
    .replace('Equal', '=').replace('Minus', '-').replace('BracketLeft', '[').replace('BracketRight', ']');
}

/** Browser-standard zoom steps (25%–500%). */
export const ZOOM_STEPS = Object.freeze([0.25, 0.33, 0.5, 0.67, 0.75, 0.8, 0.9, 1, 1.1, 1.25, 1.5, 1.75, 2, 2.5, 3, 4, 5]);
export function nextZoom(current, direction) {
  const value = Number(current) || 1;
  if (direction === 0) return 1;
  if (direction > 0) return ZOOM_STEPS.find(step => step > value + 0.001) ?? ZOOM_STEPS.at(-1);
  return [...ZOOM_STEPS].reverse().find(step => step < value - 0.001) ?? ZOOM_STEPS[0];
}
