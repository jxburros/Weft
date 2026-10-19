/** Runs in Chromium's isolated world. Page markup is untrusted evidence. */
export function captureMessage(mode = 'detect') {
  const visible = el => el && !el.closest('[hidden], [aria-hidden="true"], [contenteditable="true"]') && el.getClientRects().length > 0 && getComputedStyle(el).visibility !== 'hidden';
  const all = (root, selector) => [...root.querySelectorAll(selector)].filter(visible);
  const text = el => el?.innerText?.trim() || '';
  const host = location.hostname.toLowerCase();
  let adapter = null, bodies = [], subject = '', roots = [];
  if (host === 'mail.google.com') {
    adapter = 'gmail';
    bodies = all(document, '.adn .a3s');
    roots = bodies.map(el => el.closest('.adn'));
    subject = text(all(document, 'h2.hP')[0]);
  } else if (['outlook.live.com', 'outlook.office.com', 'outlook.office365.com'].includes(host)) {
    adapter = 'outlook';
    bodies = all(document, '[data-testid="message-body"], [aria-label="Message body"], div[role="document"]');
    bodies = bodies.filter(el => !bodies.some(other => other !== el && other.contains(el)));
    roots = bodies.map(el => el.closest('[data-item-id], [data-convid], [role="main"]') || el.parentElement);
    subject = text(all(document, '[data-testid="message-subject"], [role="heading"][aria-level="2"]')[0]);
  }
  const selection = getSelection();
  const selected = String(selection || '').trim();
  const selectionParent = selection?.anchorNode?.parentElement;
  const safeSelection = selected && !selectionParent?.closest('input, textarea, [contenteditable="true"]');
  if (mode === 'detect') return { available: bodies.length > 0 || Boolean(safeSelection), adapter: bodies.length ? adapter : 'selection', messages: bodies.length };
  const limitations = ['Captured visible text only; hidden messages, attachments and images are not included. Sender and date are page-provided, unverified claims.'];
  if (mode === 'selection') {
    if (!safeSelection) throw new Error('Select message text on the page first. Editable fields are not captured.');
    return { adapter: 'selection', subject: document.title.slice(0, 240), body: selected.slice(0, 200000), sender: '', recipients: '', date: '', url: location.href, messages: 1, truncated: selected.length > 200000, limitations };
  }
  if (!bodies.length) throw new Error('No supported open message found. Select its text and use Send selected text to Weft.');
  const indices = mode === 'thread' ? bodies.map((_, i) => i) : [bodies.length - 1];
  const details = indices.map(i => {
    const root = roots[i];
    const sender = root.querySelector('[email], [data-testid="message-sender"], [data-testid="sender-name"]');
    const date = root.querySelector('time, .g3, [data-testid="message-date"]');
    return { sender: (sender?.getAttribute('email') || text(sender)).slice(0, 1000), recipients: text(root.querySelector('[data-testid="message-recipients"], .hb')).slice(0, 2000), date: (date?.getAttribute('datetime') || date?.getAttribute('title') || text(date)).slice(0, 300), body: text(bodies[i]) };
  });
  const body = details.map(m => mode === 'thread' ? `From: ${m.sender || '(not available)'}\nDate: ${m.date || '(not available)'}\n\n${m.body}` : m.body).join('\n\n---\n\n');
  if (!body.trim()) throw new Error('The message body is empty or unavailable.');
  return { adapter, subject: (subject || document.title).slice(0, 240), ...details.at(-1), body: body.slice(0, 200000), url: location.href, messages: details.length, truncated: body.length > 200000, limitations };
}

export const messageCaptureScript = mode => `(${captureMessage.toString()})(${JSON.stringify(mode)})`;

export function capturedMessageMaterial(message, { workspaceId, title = message.subject, body = message.body, localOnly = true } = {}) {
  return { workspaceId, title: title.trim().slice(0, 240) || 'Captured message', kind: 'note', localOnly,
    url: message.url, tags: ['mailbox', 'unread', 'captured-message'],
    content: `Subject: ${title}\nFrom: ${message.sender || '(not available)'}\nTo: ${message.recipients || '(not available)'}\nDate: ${message.date || '(not available)'}\n\n${body}`,
    note: `Captured from ${message.url}\nCaptured at ${message.capturedAt}\nAdapter: ${message.adapter}; messages: ${message.messages}; navigation version: ${message.navigationVersion}\n${message.limitations.join(' ')}${message.truncated ? ' Text was truncated.' : ''}` };
}
