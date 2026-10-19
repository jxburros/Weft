/**
 * Pane layouts for a workspace's browse area (#101): 1 to 4 panes holding live tabs, saved captures
 * (including the offline archive preview) or workspace documents. Pure functions shared by the trusted
 * GUI (which draws dividers, frames and document panes) and the main process (which validates the
 * rectangles it gives native page views). Panes are a display concern only and grant no authority.
 */
export const PANE_LAYOUTS = Object.freeze({
  '1': { panes: 1, label: 'One pane' },
  '2-columns': { panes: 2, label: 'Two side by side' },
  '2-rows': { panes: 2, label: 'Two stacked' },
  '3-main': { panes: 3, label: 'One large and two stacked' },
  '3-columns': { panes: 3, label: 'Three columns' },
  '4-grid': { panes: 4, label: 'Four in a grid' },
});
export const MAX_PANES = 4;
// Below this size a pane is unusable: the layout collapses (for example 4 → 2) with a notice.
export const MIN_PANE = Object.freeze({ width: 320, height: 200 });
export const PANE_GAP = 6;
const DEFAULT_SIZES = Object.freeze({ '1': [], '2-columns': [0.5], '2-rows': [0.5], '3-main': [0.6, 0.5], '3-columns': [1 / 3, 2 / 3], '4-grid': [0.5, 0.5] });

export const paneCount = layout => PANE_LAYOUTS[layout]?.panes ?? 1;
export const defaultSizes = layout => [...(DEFAULT_SIZES[layout] ?? [])];
const clamp = (value, low, high) => Math.min(high, Math.max(low, value));

/** Sizes are divider positions as fractions; anything invalid falls back to the default for the layout. */
export function normalizeSizes(layout, sizes) {
  const fallback = defaultSizes(layout);
  if (!Array.isArray(sizes) || sizes.length !== fallback.length || !sizes.every(value => Number.isFinite(value))) return fallback;
  const result = sizes.map(value => clamp(value, 0.15, 0.85));
  if (layout === '3-columns' && result[1] - result[0] < 0.15) return fallback;
  return result;
}

/**
 * Rectangles for each pane inside `box` ({x, y, width, height}), in pane order, separated by `gap`.
 * Every rectangle has an integer position and a size of at least 1 pixel.
 */
export function paneRects(layout, box, sizes, gap = PANE_GAP) {
  const s = normalizeSizes(layout, sizes);
  const { x, y, width, height } = box;
  const rect = (rx, ry, rw, rh) => ({ x: Math.round(rx), y: Math.round(ry), width: Math.max(1, Math.round(rw)), height: Math.max(1, Math.round(rh)) });
  const split = (total, fraction) => { const first = Math.floor((total - gap) * fraction); return [first, total - gap - first]; };
  if (layout === '2-columns') { const [a, b] = split(width, s[0]); return [rect(x, y, a, height), rect(x + a + gap, y, b, height)]; }
  if (layout === '2-rows') { const [a, b] = split(height, s[0]); return [rect(x, y, width, a), rect(x, y + a + gap, width, b)]; }
  if (layout === '3-main') {
    const [a, b] = split(width, s[0]); const [c, d] = split(height, s[1]);
    return [rect(x, y, a, height), rect(x + a + gap, y, b, c), rect(x + a + gap, y + c + gap, b, d)];
  }
  if (layout === '3-columns') {
    const usable = width - 2 * gap; const first = Math.floor(usable * s[0]); const second = Math.floor(usable * s[1]) - first;
    return [rect(x, y, first, height), rect(x + first + gap, y, second, height), rect(x + first + second + 2 * gap, y, usable - first - second, height)];
  }
  if (layout === '4-grid') {
    const [a, b] = split(width, s[0]); const [c, d] = split(height, s[1]);
    return [rect(x, y, a, c), rect(x + a + gap, y, b, c), rect(x, y + c + gap, a, d), rect(x + a + gap, y + c + gap, b, d)];
  }
  return [rect(x, y, width, height)];
}

/**
 * Dividers that can be dragged or moved with the keyboard: each names the size index it changes, its
 * orientation and its rectangle (the gap between panes). Coordinates match paneRects.
 */
export function paneDividers(layout, box, sizes, gap = PANE_GAP) {
  const rects = paneRects(layout, box, sizes, gap);
  const vertical = (index, left, top = box.y, height = box.height) => ({ index, orientation: 'vertical', x: left.x + left.width, y: top, width: gap, height });
  const horizontal = (index, upper, left = box.x, width = box.width) => ({ index, orientation: 'horizontal', x: left, y: upper.y + upper.height, width, height: gap });
  if (layout === '2-columns') return [vertical(0, rects[0])];
  if (layout === '2-rows') return [horizontal(0, rects[0])];
  if (layout === '3-main') return [vertical(0, rects[0]), horizontal(1, rects[1], rects[1].x, rects[1].width)];
  if (layout === '3-columns') return [vertical(0, rects[0]), vertical(1, rects[1])];
  if (layout === '4-grid') return [vertical(0, rects[0]), horizontal(1, rects[0])];
  return [];
}

/** The size fraction a divider would have at a pointer position. */
export function sizeAt(layout, box, divider, point, sizes) {
  const s = normalizeSizes(layout, sizes);
  const fraction = divider.orientation === 'vertical' ? (point.x - box.x) / Math.max(1, box.width) : (point.y - box.y) / Math.max(1, box.height);
  if (layout === '3-main' && divider.index === 1) {
    const rects = paneRects(layout, box, s);
    s[1] = (point.y - box.y) / Math.max(1, rects[1].height + rects[2].height);
  } else s[divider.index] = fraction;
  return normalizeSizes(layout, s);
}

/** The largest layout at most `wanted` panes that fits `box`; returns {layout, collapsed}. */
export function fitLayout(layout, box) {
  const order = { '4-grid': ['4-grid', '2-columns', '2-rows', '1'], '3-main': ['3-main', '2-columns', '2-rows', '1'], '3-columns': ['3-columns', '2-columns', '2-rows', '1'],
    '2-columns': ['2-columns', '2-rows', '1'], '2-rows': ['2-rows', '2-columns', '1'], '1': ['1'] }[layout] ?? ['1'];
  for (const candidate of order) {
    const rects = paneRects(candidate, box, defaultSizes(candidate));
    if (candidate === '1' || rects.every(rect => rect.width >= MIN_PANE.width && rect.height >= MIN_PANE.height)) return { layout: candidate, collapsed: candidate !== layout };
  }
  return { layout: '1', collapsed: layout !== '1' };
}

/** Legacy split view (resume `split`) as a two-pane layout. */
export function panesFromSplit(activeTabId, split) {
  const items = [activeTabId != null ? { type: 'tab', id: activeTabId } : null];
  if (split?.tabId != null) return { layout: '2-columns', items: [...items, { type: 'tab', id: split.tabId }], focused: split.focusedPane === 'secondary' ? 1 : 0, sizes: [0.5] };
  return { layout: '1', items, focused: 0, sizes: [] };
}

/** Same item (type and id) in two panes is not allowed: a tab or document is visible once. */
export const paneKey = item => (item ? `${item.type}:${item.id}` : '');
