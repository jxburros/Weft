import { createHash } from 'node:crypto';

export const secretKey = /^(?:password|passwd|api[_ -]?key|access[_ -]?token|refresh[_ -]?token|authorization|cookie|cookies|session[_ -]?token|secret|client[_ -]?secret|credential[s]?|private[_ -]?key)$/i;
export function rejectSecretKeys(value) {
  const pending = [value];
  const visited = new Set();
  while (pending.length) {
    const current = pending.pop();
    if (!current || typeof current !== 'object' || visited.has(current)) continue;
    visited.add(current);
    for (const [key, item] of Object.entries(current)) {
      if (secretKey.test(key) || (key === 'parameters' && Array.isArray(item) && item.some(name => typeof name === 'string' && secretKey.test(name)))) throw Object.assign(new Error('SECRET_FIELD: Secret-named fields cannot be stored in project data. Use protected credential storage.'), { code: 'SECRET_FIELD' });
      pending.push(item);
    }
  }
}

// Scan serialized output, including decoded JSON strings and stored text files.
// No OCR or archive parsing: unknown/binary files must never yield "clean".
export function inspectExportResidue(serialized, terms) {
  const termHashes = terms.map(term => createHash('sha256').update(term).digest('hex'));
  const found = new Set();
  const unverifiable = [];
  let data;
  try { data = JSON.parse(serialized); } catch { return { status: 'unverifiable', termHashes, found: [], unverifiable: ['Export is not valid JSON'] }; }
  const scanText = text => terms.forEach((term, index) => { if (text.includes(term)) found.add(termHashes[index]); });
  scanText(serialized);
  const walk = (value, path = '$') => {
    if (typeof value === 'string') { scanText(value); return; }
    if (!value || typeof value !== 'object') return;
    for (const [key, item] of Object.entries(value)) {
      if (key === 'pngBase64' && item) { unverifiable.push(`${path}.pngBase64: image text cannot be verified`); continue; }
      if (key === 'fileBase64' && item) {
        if (/^text\//i.test(value.mimeType || '')) {
          try { scanText(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.from(item, 'base64'))); }
          catch { unverifiable.push(`${path}.fileBase64: unsupported text encoding`); }
        } else unverifiable.push(`${path}.fileBase64: unsupported file format`);
        continue;
      }
      walk(item, `${path}.${key}`);
    }
  };
  walk(data);
  return { status: found.size ? 'found' : unverifiable.length ? 'unverifiable' : 'clean', termHashes, found: [...found], unverifiable, scope: 'Exact case-sensitive supplied terms only; not automatic redaction or a guarantee that the export contains no secrets.' };
}
