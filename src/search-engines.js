/**
 * Address-bar search engines (#91). Pure: shared by settings validation, the trusted GUI and the
 * page context menu. Typed text is sent to the chosen engine only when a person presses Enter or
 * picks "Search the web"; Weft never asks an engine for suggestions.
 */
export const SEARCH_ENGINES = Object.freeze({
  google: { name: 'Google', template: 'https://www.google.com/search?q=%s' },
  duckduckgo: { name: 'DuckDuckGo', template: 'https://duckduckgo.com/?q=%s' },
  bing: { name: 'Bing', template: 'https://www.bing.com/search?q=%s' },
  brave: { name: 'Brave Search', template: 'https://search.brave.com/search?q=%s' },
  startpage: { name: 'Startpage', template: 'https://www.startpage.com/do/search?q=%s' },
  kagi: { name: 'Kagi', template: 'https://kagi.com/search?q=%s' },
});
// Google stays the default because it was the only engine before 1.4; changing it is one setting.
export const DEFAULT_SEARCH_ENGINE = 'google';

/** Reason a custom template is unusable, or null: HTTPS only, exactly one %s, no credentials. */
export function templateProblem(template) {
  const value = String(template ?? '');
  if (!value || value.length > 2048) return 'Enter a search address of at most 2,048 characters';
  if (value.split('%s').length !== 2) return 'The search address must contain %s exactly once';
  let url;
  try { url = new URL(value.replace('%s', 'weft')); } catch { return 'The search address is not a valid URL'; }
  if (url.protocol !== 'https:') return 'The search address must use https://';
  if (url.username || url.password) return 'The search address must not contain credentials';
  return null;
}

/** The engine settings resolve to: a preset, or a validated custom template. Invalid settings fall back to the default. */
export function searchEngine(settings) {
  const chosen = settings?.searchEngine;
  if (chosen?.preset === 'custom' && !templateProblem(chosen.template)) return { id: 'custom', name: String(chosen.name || 'Custom search').slice(0, 60), template: chosen.template };
  const id = Object.hasOwn(SEARCH_ENGINES, chosen?.preset) ? chosen.preset : DEFAULT_SEARCH_ENGINE;
  return { id, ...SEARCH_ENGINES[id] };
}

export function searchUrl(settings, query) {
  return searchEngine(settings).template.replace('%s', encodeURIComponent(String(query).trim().slice(0, 2048)));
}
