/**
 * Browser-owned page context menu (#89). `contextMenuItems` is pure: it turns Chromium's
 * context-menu params into the menu a person sees. The Browser runs the chosen item through the
 * same URL admission, site rules and download gating as any other navigation or download.
 */
const httpUrl = value => { try { return /^https?:$/.test(new URL(value).protocol); } catch { return false; } };
const ellipsis = (text, max = 32) => { const value = String(text ?? '').replace(/\s+/g, ' ').trim(); return value.length > max ? `${value.slice(0, max - 1)}…` : value; };

/**
 * @param params Electron context-menu params (linkURL, srcURL, mediaType, selectionText, isEditable, editFlags, misspelledWord, dictionarySuggestions).
 * @param state {canGoBack, canGoForward, protectedOperation, searchName, keyLabel(id)}
 * @returns menu entries: {id, label, enabled?, accelerator?, argument?} or {type: 'separator'}
 */
export function contextMenuItems(params = {}, state = {}) {
  const items = [];
  const section = entries => { const shown = entries.filter(Boolean); if (!shown.length) return; if (items.length) items.push({ type: 'separator' }); items.push(...shown); };
  const flags = params.editFlags ?? {};
  const restricted = Boolean(state.protectedOperation);
  if (params.isEditable && params.misspelledWord) {
    const suggestions = (params.dictionarySuggestions ?? []).slice(0, 5);
    section([
      ...suggestions.map(word => ({ id: 'replace-misspelling', label: word, argument: word })),
      suggestions.length ? null : { id: 'no-suggestions', label: 'No spelling suggestions', enabled: false },
      { id: 'add-to-dictionary', label: `Add “${ellipsis(params.misspelledWord, 24)}” to dictionary`, argument: params.misspelledWord },
    ]);
  }
  if (params.linkURL) {
    const usable = httpUrl(params.linkURL);
    section([
      { id: 'open-link', label: 'Open link in new tab', enabled: usable },
      { id: 'copy-link', label: 'Copy link address' },
      { id: 'save-link', label: 'Download linked file', enabled: usable && !restricted },
    ]);
  }
  if (params.mediaType === 'image' && params.srcURL) {
    const usable = httpUrl(params.srcURL);
    section([
      { id: 'open-image', label: 'Open image in new tab', enabled: usable },
      { id: 'copy-image', label: 'Copy image', enabled: !restricted },
      { id: 'copy-image-address', label: 'Copy image address' },
      { id: 'save-image', label: 'Download image', enabled: usable && !restricted },
    ]);
  }
  if (params.isEditable) {
    section([
      { id: 'cut', label: 'Cut', enabled: Boolean(flags.canCut), accelerator: 'CmdOrCtrl+X' },
      { id: 'copy', label: 'Copy', enabled: Boolean(flags.canCopy), accelerator: 'CmdOrCtrl+C' },
      { id: 'paste', label: 'Paste', enabled: Boolean(flags.canPaste), accelerator: 'CmdOrCtrl+V' },
      { id: 'select-all', label: 'Select all', enabled: flags.canSelectAll !== false, accelerator: 'CmdOrCtrl+A' },
    ]);
  } else if (params.selectionText?.trim()) {
    section([
      { id: 'copy', label: 'Copy', accelerator: 'CmdOrCtrl+C' },
      { id: 'search-selection', label: `Search ${state.searchName || 'the web'} for “${ellipsis(params.selectionText)}”` },
      { id: 'send-selection', label: 'Send selected text to Weft', enabled: !restricted },
    ]);
  }
  if (!params.linkURL && !(params.mediaType === 'image') && !params.isEditable && !params.selectionText?.trim()) {
    section([
      { id: 'back', label: 'Back', enabled: Boolean(state.canGoBack) },
      { id: 'forward', label: 'Forward', enabled: Boolean(state.canGoForward) },
      { id: 'reload', label: 'Reload' },
    ]);
    section([
      { id: 'save-page', label: 'Save page to workspace', enabled: !restricted },
      { id: 'print', label: 'Print…', enabled: !restricted },
    ]);
  }
  section([
    { id: 'view-source', label: 'View page source', enabled: !restricted && Boolean(state.sourceAvailable) },
    { id: 'inspect', label: 'Inspect', enabled: !restricted && state.devtoolsAllowed !== false },
  ]);
  const accelerators = { 'view-source': 'view-source', inspect: 'devtools', reload: 'reload', back: 'back', forward: 'forward', print: 'print' };
  for (const item of items) if (!item.accelerator && accelerators[item.id] && state.keyLabel) item.accelerator = state.keyLabel(accelerators[item.id]);
  return items;
}
