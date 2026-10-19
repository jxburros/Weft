/**
 * In-page part of secret-free workflow recording (#10). Runs in an isolated
 * world: page scripts cannot read its nonce or its state. It reports only
 * trusted (real input) clicks on actionable elements and committed field
 * changes, as a CSS selector, an accessible label and a sensitivity hint.
 * Field values are never read.
 */
 
function weftRecorder(nonce) {
  if (window.__weftRecorderNonce === nonce) return true;
  window.__weftRecorderNonce = nonce;
  const unique = selector => { try { return document.querySelectorAll(selector).length === 1; } catch { return false; } };
  const quote = value => value.replace(/["\\]/g, '\\$&');
  const selectorFor = element => {
    if (element.id && unique(`#${CSS.escape(element.id)}`)) return `#${CSS.escape(element.id)}`;
    for (const attribute of ['data-testid', 'data-test', 'name', 'aria-label']) {
      const value = element.getAttribute(attribute);
      if (value && value.length < 200) { const candidate = `${element.localName}[${attribute}="${quote(value)}"]`; if (unique(candidate)) return candidate; }
    }
    const parts = [];
    for (let node = element; node && node.nodeType === 1 && node !== document.body && parts.length < 8; node = node.parentElement) {
      if (node.id && unique(`#${CSS.escape(node.id)}`)) { parts.unshift(`#${CSS.escape(node.id)}`); break; }
      const siblings = node.parentElement ? [...node.parentElement.children].filter(child => child.localName === node.localName) : [];
      parts.unshift(siblings.length > 1 ? `${node.localName}:nth-of-type(${siblings.indexOf(node) + 1})` : node.localName);
    }
    const selector = parts.join(' > ');
    return selector && unique(selector) ? selector : null;
  };
  const label = element => String(element.getAttribute('aria-label') || element.labels?.[0]?.textContent || element.getAttribute('placeholder')
    || (['a', 'button', 'summary'].includes(element.localName) ? element.textContent : '') || element.getAttribute('name') || '').trim().replace(/\s+/g, ' ').slice(0, 80);
  const sensitive = element => element.type === 'password' || /cc-|one-time-code|current-password|new-password/i.test(element.autocomplete || '')
    || /pass|card|cvv|cvc|otp|ssn|token|secret|security.?code|\bpin\b/i.test(`${element.name || ''} ${element.id || ''} ${element.getAttribute('aria-label') || ''}`);
  const send = data => console.log(`weft-record:${nonce}:${JSON.stringify(data)}`);
  const actionable = 'a,button,summary,[role=button],[role=link],[role=tab],[role=menuitem],input[type=submit],input[type=button],input[type=checkbox],input[type=radio],input[type=reset]';
  document.addEventListener('click', event => {
    if (!event.isTrusted) return;
    const element = event.target?.closest?.(actionable);
    const selector = element && selectorFor(element);
    if (selector) send({ type: 'click', selector, label: label(element) });
  }, true);
  document.addEventListener('change', event => {
    if (!event.isTrusted) return;
    const element = event.target;
    if (!(element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement || element instanceof HTMLSelectElement)) return;
    if (element instanceof HTMLInputElement && ['checkbox', 'radio', 'submit', 'button', 'reset', 'file', 'image'].includes(element.type)) return;
    const selector = selectorFor(element);
    if (selector) send({ type: 'fill', selector, label: label(element), sensitive: sensitive(element), password: element.type === 'password' || /current-password|new-password/i.test(element.autocomplete || '') });
  }, true);
  return true;
}
 
export const RECORDING_WORLD = 1207;
export const recordingScript = nonce => `(${weftRecorder.toString()})(${JSON.stringify(nonce)})`;
