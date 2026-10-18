/** Email is inert evidence: preserve the original, never render HTML or remote images. */
export function emailMaterial(raw, { workspaceId } = {}) {
  if (typeof raw !== 'string' || !raw.trim() || new TextEncoder().encode(raw).length > 450000) throw new Error('Choose a non-empty email smaller than 450 KB');
  const header = raw.split(/\r?\n\r?\n/, 1)[0].replace(/\r?\n[ \t]+/g, ' ');
  const value = name => header.match(new RegExp(`^${name}:\\s*(.*)$`, 'im'))?.[1]?.trim() || '';
  const subject = value('Subject') || 'Forwarded email';
  return { ...(workspaceId ? { workspaceId } : {}), title: subject.slice(0, 240), kind: 'note', content: raw, note: `Forwarded email · From: ${value('From').slice(0, 300)}\nOriginal message retained as plain text. Sender headers are unverified.`, tags: ['mailbox', 'unread'] };
}
