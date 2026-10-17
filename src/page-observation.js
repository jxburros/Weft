/**
 * Semantic page observation. The page function below runs in a dedicated
 * Chromium isolated world: it shares the DOM with the page but not page
 * JavaScript globals or prototypes, so page scripts cannot read the reference
 * table or replace the functions used to resolve, click or fill elements.
 * No remote debugging port is opened.
 */
export const OBSERVATION_WORLD = 1717;

// Fields whose values must never leave the page through observation routes.
export const SENSITIVE_FIELD_CSS = [
  'input[type="password" i]', 'input[autocomplete*="cc-" i]', 'input[autocomplete*="one-time-code" i]',
  'input[autocomplete*="current-password" i]', 'input[autocomplete*="new-password" i]',
  'textarea[autocomplete*="one-time-code" i]', 'textarea[autocomplete*="cc-" i]',
].join(',');
// User-origin !important rules outrank page styles and are invisible to page DOM observers.
export const MASK_CSS = `${SENSITIVE_FIELD_CSS} { color: transparent !important; text-shadow: none !important; -webkit-text-fill-color: transparent !important; caret-color: transparent !important; }`;

const CONTROL_CHARACTERS = /[\u0000-\u0008\u000b-\u001f\u007f‎‏‪-‮⁦-⁩]/g;
/** Page-sourced strings are untrusted data: remove control/bidi overrides and cap them. */
export function pageString(value, limit = 1000) {
  return String(value ?? '').replace(CONTROL_CHARACTERS, '').slice(0, limit);
}

export function pngSize(base64) {
  const bytes = Buffer.from(base64.slice(0, 64), 'base64');
  return bytes.length >= 24 ? { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) } : null;
}

/* eslint-disable no-undef -- executed inside the page's isolated world. */
function weftObservation(op, args) {
  const state = globalThis.__weftObservation ??= { next: 1, nextFrame: 1, refs: new Map(), ids: new WeakMap(), frames: new WeakMap() };
  const nameLimit = 200;
  const clean = (value, limit = nameLimit) => {
    const text = String(value ?? '').replace(/[\u0000-\u0008\u000b-\u001f\u007f‎‏‪-‮⁦-⁩]/g, '').replace(/\s+/g, ' ').trim();
    return text.length > limit ? { text: text.slice(0, limit), truncated: true } : { text, truncated: false };
  };
  const sensitiveAutocomplete = /\b(cc-[a-z-]+|one-time-code|current-password|new-password)\b/i;
  const sensitiveName = /pass(word|code|phrase)?|\botp\b|one.?time|\bcvc|\bcvv|\bcsc\b|card.?(number|num|no)\b|security.?code|\bpin\b|\bssn\b|secret|token|api.?key/i;
  const isField = el => ['input', 'textarea', 'select'].includes(el.localName) || el.isContentEditable;
  const sensitive = el => isField(el) && ((el.localName === 'input' && el.type === 'password')
    || sensitiveAutocomplete.test(el.getAttribute('autocomplete') || '')
    || sensitiveName.test([el.getAttribute('name'), el.id, el.getAttribute('aria-label'), el.getAttribute('placeholder')].filter(Boolean).join(' ')));
  const inputRoles = { button: 'button', submit: 'button', reset: 'button', image: 'button', file: 'button', color: 'button', checkbox: 'checkbox', radio: 'radio', range: 'slider', number: 'spinbutton', search: 'searchbox' };
  const landmarkParents = 'article, aside, main, nav, section';
  const role = el => {
    const explicit = (el.getAttribute('role') || '').trim().split(/\s+/)[0];
    if (explicit && !['none', 'presentation', 'generic'].includes(explicit)) return explicit;
    if (explicit) return null;
    const tag = el.localName;
    if (tag === 'input') return el.type === 'hidden' ? null : inputRoles[el.type] || 'textbox';
    if (/^h[1-6]$/.test(tag)) return 'heading';
    if (el.isContentEditable && (el.parentElement === null || !el.parentElement.isContentEditable)) return 'textbox';
    return ({
      a: el.hasAttribute('href') ? 'link' : null, area: el.hasAttribute('href') ? 'link' : null, button: 'button', textarea: 'textbox',
      select: el.multiple || el.size > 1 ? 'listbox' : 'combobox', img: el.getAttribute('alt') === '' ? null : 'img',
      nav: 'navigation', main: 'main', aside: 'complementary', form: 'form', dialog: 'dialog', ul: 'list', ol: 'list', menu: 'list',
      li: 'listitem', table: 'table', tr: 'row', th: 'columnheader', td: 'cell', progress: 'progressbar', meter: 'meter',
      summary: 'button', details: 'group', fieldset: 'group', p: 'paragraph', article: 'article', hr: 'separator', blockquote: 'blockquote',
      header: el.parentElement?.closest(landmarkParents) ? null : 'banner', footer: el.parentElement?.closest(landmarkParents) ? null : 'contentinfo',
      section: el.hasAttribute('aria-label') || el.hasAttribute('aria-labelledby') ? 'region' : null,
      iframe: 'iframe', frame: 'iframe', canvas: 'canvas', video: 'video', audio: 'audio', embed: 'embed', object: 'embed',
      svg: el.hasAttribute('aria-label') || el.querySelector?.(':scope > title') ? 'img' : null,
    })[tag] ?? null;
  };
  const fromContent = new Set(['button', 'link', 'heading', 'option', 'cell', 'columnheader', 'rowheader', 'tab', 'menuitem', 'menuitemcheckbox', 'menuitemradio', 'treeitem', 'switch', 'tooltip', 'checkbox', 'radio']);
  const accessibleName = (el, nodeRole) => {
    const doc = el.ownerDocument;
    const labelledBy = (el.getAttribute('aria-labelledby') || '').split(/\s+/).filter(Boolean).map(id => doc.getElementById(id)?.textContent || '').join(' ');
    if (clean(labelledBy).text) return clean(labelledBy);
    if (clean(el.getAttribute('aria-label')).text) return clean(el.getAttribute('aria-label'));
    if (isField(el) || el.localName === 'meter' || el.localName === 'progress') {
      const labels = [...(el.labels || [])].map(label => label.textContent).join(' ');
      if (clean(labels).text) return clean(labels);
      if (el.localName === 'input' && ['button', 'submit', 'reset'].includes(el.type)) return clean(el.value || (el.type === 'submit' ? 'Submit' : el.type === 'reset' ? 'Reset' : ''));
      return clean(el.getAttribute('placeholder') || el.getAttribute('title'));
    }
    if (el.localName === 'img' || el.localName === 'area') return clean(el.getAttribute('alt') || el.getAttribute('title'));
    if (el.localName === 'svg') return clean(el.querySelector(':scope > title')?.textContent);
    if (el.localName === 'iframe' || el.localName === 'frame') return clean(el.getAttribute('title') || el.getAttribute('name'));
    if (['fieldset', 'details', 'table', 'figure'].includes(el.localName)) {
      const caption = el.querySelector(':scope > legend, :scope > summary, :scope > caption, :scope > figcaption');
      if (caption) return clean(caption.textContent);
    }
    if (fromContent.has(nodeRole)) return clean(el.textContent);
    return clean(el.getAttribute('title'));
  };
  const fingerprint = (el, nodeRole, name) => `${el.localName}|${nodeRole}|${name.text.slice(0, 120)}`;
  const visible = el => typeof el.checkVisibility !== 'function' || el.checkVisibility({ visibilityProperty: true })
    || el.ownerDocument.defaultView.getComputedStyle(el).display === 'contents';
  const viewport = () => ({ url: clean(location.href, 16384).text, width: innerWidth, height: innerHeight, scrollX: Math.round(scrollX), scrollY: Math.round(scrollY),
    devicePixelRatio, documentWidth: document.documentElement.scrollWidth, documentHeight: document.documentElement.scrollHeight, visibility: document.visibilityState });

  if (op === 'viewport') return viewport();

  if (op === 'snapshot') {
    const maxNodes = args.maxNodes, maxVisit = 50000;
    const nodes = [], frames = [{ frameId: 'f0', parentFrameId: null, url: clean(location.href, 2048).text, accessible: true }];
    const counts = { visited: 0, hidden: 0, omitted: 0, sensitiveInputs: 0, opaque: 0, lazyImages: 0, busy: 0, inaccessibleFrames: 0, openShadowRoots: 0 };
    const virtualized = [];
    let truncated = null;
    if (state.refs.size > 20000) for (const [ref, entry] of state.refs) if (!entry.el.deref()?.isConnected) state.refs.delete(ref);
    const refFor = (el, frameId, print) => {
      let ref = state.ids.get(el);
      if (!ref) { ref = `${frameId}e${state.next++}`; state.ids.set(el, ref); }
      state.refs.set(ref, { el: new WeakRef(el), fingerprint: print });
      return ref;
    };
    const emit = node => {
      if (nodes.length >= maxNodes) { counts.omitted++; truncated ??= { reason: 'maxNodes', limit: maxNodes }; return false; }
      nodes.push(node); return true;
    };
    const walk = (parent, depth, frameId, offset, suppressText) => {
      const children = parent.shadowRoot ? (counts.openShadowRoots++, [...parent.shadowRoot.childNodes])
        : parent.localName === 'slot' && parent.assignedNodes({ flatten: true }).length ? parent.assignedNodes({ flatten: true }) : [...parent.childNodes];
      for (const child of children) {
        if (counts.visited++ > maxVisit) { truncated = { reason: 'visitLimit', limit: maxVisit }; return; }
        if (child.nodeType === 3) {
          if (suppressText) continue;
          const text = clean(child.textContent);
          if (text.text) emit({ role: 'text', name: text.text, ...(text.truncated && { nameTruncated: true }), depth, frame: frameId });
          continue;
        }
        if (child.nodeType !== 1 || ['script', 'style', 'template', 'noscript', 'head', 'meta', 'link', 'option', 'datalist'].includes(child.localName)) continue;
        if (child.hidden || child.getAttribute('aria-hidden') === 'true' || !visible(child)) { counts.hidden++; continue; }
        const nodeRole = role(child);
        let nextDepth = depth, suppress = suppressText;
        if (child.localName === 'img' && child.loading === 'lazy' && !child.complete) counts.lazyImages++;
        if (child.getAttribute('aria-busy') === 'true') counts.busy++;
        if (nodeRole) {
          const name = accessibleName(child, nodeRole);
          const rect = child.getBoundingClientRect();
          const box = { x: Math.round(rect.x + offset.x), y: Math.round(rect.y + offset.y), width: Math.round(rect.width), height: Math.round(rect.height) };
          const node = { ref: refFor(child, frameId, fingerprint(child, nodeRole, name)), role: nodeRole, depth, frame: frameId };
          if (name.text) node.name = name.text;
          if (name.truncated) node.nameTruncated = true;
          if (nodeRole === 'heading') node.level = Number(child.getAttribute('aria-level')) || Number(child.localName.slice(1)) || undefined;
          if (child.localName === 'a' && child.href) { try { const url = new URL(child.href); url.username = ''; url.password = ''; node.href = url.href.slice(0, 2048); } catch { /* Invalid link. */ } }
          if (isField(child)) {
            if (sensitive(child)) { counts.sensitiveInputs++; node.value = null; node.redacted = 'sensitive-field'; node.hasValue = !!(child.value || child.textContent); }
            else if (child.localName === 'select') node.value = clean([...child.selectedOptions].map(option => option.textContent).join(', ')).text;
            else if (!['checkbox', 'radio', 'button', 'submit', 'reset', 'image', 'file'].includes(child.type)) node.value = clean(child.isContentEditable ? child.textContent : child.value).text;
            if (['checkbox', 'radio'].includes(child.type)) node.checked = child.checked;
            if (child.required) node.required = true;
            if (child.readOnly) node.readonly = true;
          }
          if (child.getAttribute('aria-checked')) node.checked = child.getAttribute('aria-checked') === 'mixed' ? 'mixed' : child.getAttribute('aria-checked') === 'true';
          for (const key of ['expanded', 'selected', 'pressed']) if (child.hasAttribute(`aria-${key}`)) node[key] = child.getAttribute(`aria-${key}`) === 'true';
          if (child.disabled || child.getAttribute('aria-disabled') === 'true') node.disabled = true;
          if (child === child.ownerDocument.activeElement && child !== child.ownerDocument.body) node.focused = true;
          if (args.includeBoxes) { node.box = box; node.inViewport = box.x < innerWidth && box.y < innerHeight && box.x + box.width > 0 && box.y + box.height > 0; }
          if (['canvas', 'video', 'audio', 'embed'].includes(nodeRole) || (nodeRole === 'img' && !name.text)) { node.opaque = true; counts.opaque++; }
          if (child.localName === 'img' && child.loading === 'lazy' && !child.complete) node.lazy = true;
          if (['list', 'listbox', 'grid', 'table', 'tree', 'treegrid', 'feed', 'rowgroup'].includes(nodeRole)) {
            const items = child.querySelectorAll(':scope > [role=row], :scope > [role=listitem], :scope > [role=option], :scope > [role=treeitem], :scope > [role=article], :scope > li, :scope > tr, :scope > tbody > tr, :scope > [aria-setsize]');
            const declaredRaw = Number(child.getAttribute('aria-rowcount') || items[0]?.getAttribute('aria-setsize'));
            if (declaredRaw === -1 || nodeRole === 'feed') virtualized.push({ ref: node.ref, role: nodeRole, rendered: items.length, declared: 'unknown' });
            else if (Number.isFinite(declaredRaw) && declaredRaw > items.length) virtualized.push({ ref: node.ref, role: nodeRole, rendered: items.length, declared: declaredRaw });
          }
          if (!emit(node)) continue;
          nextDepth = depth + 1;
          if (fromContent.has(nodeRole) || isField(child)) suppress = true;
          if (nodeRole === 'iframe') {
            const frameId = state.frames.get(child) ?? `f${state.nextFrame++}`;
            state.frames.set(child, frameId);
            node.childFrame = frameId;
            let doc = null;
            try { doc = child.contentDocument; } catch { /* Cross-origin. */ }
            let origin = null;
            try { origin = child.src ? new URL(child.src, location.href).origin : location.origin; } catch { /* Invalid source. */ }
            if (doc?.body) {
              frames.push({ frameId, parentFrameId: node.frame, url: clean(doc.location.href, 2048).text, accessible: true });
              const frameRect = child.getBoundingClientRect();
              walk(doc.body, nextDepth, frameId, { x: offset.x + frameRect.x + child.clientLeft, y: offset.y + frameRect.y + child.clientTop }, false);
            } else {
              counts.inaccessibleFrames++;
              frames.push({ frameId, parentFrameId: node.frame, origin, accessible: false, reason: origin && origin !== location.origin ? 'cross-origin' : 'unavailable' });
            }
            continue;
          }
        }
        walk(child, nextDepth, frameId, offset, suppress);
        if (truncated?.reason === 'visitLimit') return;
      }
    };
    if (document.body) walk(document.body, 0, 'f0', { x: 0, y: 0 }, false);
    return { url: clean(location.href, 16384).text, title: clean(document.title, 1000).text, viewport: viewport(), nodes, frames, counts, virtualized, truncated,
      refs: nodes.filter(node => node.ref).map(node => node.ref) };
  }

  // Element operations by snapshot ref or CSS selector.
  let el;
  if (args.ref) {
    const entry = state.refs.get(args.ref);
    el = entry?.el.deref();
    if (!el) return { ok: false, reason: 'unknown_ref' };
    if (!el.isConnected) return { ok: false, reason: 'detached' };
    const nodeRole = role(el);
    if (fingerprint(el, nodeRole, accessibleName(el, nodeRole)) !== entry.fingerprint) return { ok: false, reason: 'changed' };
  } else {
    try { el = document.querySelector(args.selector); } catch { return { ok: false, reason: 'invalid_selector' }; }
    if (!el) return { ok: false, reason: 'not_found' };
  }
  if (op === 'box') {
    let rect = el.getBoundingClientRect(), x = rect.x, y = rect.y;
    for (let frame = el.ownerDocument.defaultView?.frameElement; frame; frame = frame.ownerDocument.defaultView?.frameElement) {
      const frameRect = frame.getBoundingClientRect(); x += frameRect.x + frame.clientLeft; y += frameRect.y + frame.clientTop;
    }
    return { ok: true, box: { x, y, width: rect.width, height: rect.height }, viewport: viewport(), frame: state.ids.get(el)?.replace(/e\d+$/, '') || 'f0' };
  }
  if (op === 'click') {
    if (el.disabled) return { ok: false, reason: 'disabled' };
    el.scrollIntoView?.({ block: 'nearest', inline: 'nearest' });
    // A pointer click focuses focusable targets; element.click() alone does not.
    if (typeof el.focus === 'function' && el.tabIndex >= 0) el.focus({ preventScroll: true });
    el.click();
    return { ok: true };
  }
  if (op === 'fill') {
    const value = args.value;
    const view = el.ownerDocument.defaultView;
    if (el instanceof view.HTMLInputElement || el instanceof view.HTMLTextAreaElement || el instanceof view.HTMLSelectElement) {
      if (el.disabled || el.readOnly) return { ok: false, reason: 'not_editable' };
      const prototype = el instanceof view.HTMLInputElement ? view.HTMLInputElement.prototype : el instanceof view.HTMLTextAreaElement ? view.HTMLTextAreaElement.prototype : view.HTMLSelectElement.prototype;
      Object.getOwnPropertyDescriptor(prototype, 'value').set.call(el, value);
    } else if (el.isContentEditable) el.textContent = value;
    else return { ok: false, reason: 'not_editable' };
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
    return { ok: true };
  }
  if (op === 'focus') { el.focus?.(); return { ok: true }; }
  return { ok: false, reason: 'unsupported' };
}
/* eslint-enable no-undef */

export function observationScript(op, args = {}) {
  return `(${weftObservation.toString()})(${JSON.stringify(op)}, ${JSON.stringify(args)})`;
}

/** Sensitive-focus probe for image observation routes. */
export const SENSITIVE_FOCUS_SCRIPT = `(() => { const el = document.activeElement; return !!el && el.matches?.(${JSON.stringify(SENSITIVE_FIELD_CSS)}); })()`;
