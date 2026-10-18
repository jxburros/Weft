import { createHash } from 'node:crypto';
import { MODEL_IMAGE_LIMITS } from './resources.js';

const PNG = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
// Image resolution limits live in one place (src/resources.js) with the capture limits.
export const IMAGE_LIMITS = MODEL_IMAGE_LIMITS;
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');

/** Read PNG dimensions from IHDR without decoding pixels. */
export function inspectPng(bytes) {
  if (!Buffer.isBuffer(bytes) || bytes.length < 24 || !bytes.subarray(0, 8).equals(PNG) || bytes.toString('latin1', 12, 16) !== 'IHDR') return null;
  const width = bytes.readUInt32BE(16);
  const height = bytes.readUInt32BE(20);
  return width > 0 && height > 0 ? { mimeType: 'image/png', width, height, bytes: bytes.length, sha256: sha256(bytes) } : null;
}

/** Rough input-token cost used only for context budgeting; providers report actual usage. */
export const imageTokenEstimate = ({ width, height }) => Math.min(1600, Math.max(85, Math.ceil((width * height) / 750)));

/**
 * Bound actual image bytes before transmission. Oversized images are downscaled only through a
 * supplied decoder (Electron nativeImage in the app); otherwise they are refused, never sent whole.
 */
export async function boundImage(base64, { limits = IMAGE_LIMITS, resizeImage } = {}) {
  const original = Buffer.from(String(base64 || ''), 'base64');
  const info = inspectPng(original);
  if (!info) return { ok: false, reason: 'Only valid PNG image bytes can be sent to a model.' };
  const fits = candidate => candidate.bytes <= limits.maxBytes && candidate.width <= limits.maxEdge && candidate.height <= limits.maxEdge;
  if (fits(info)) return { ok: true, base64: original.toString('base64'), mimeType: info.mimeType, width: info.width, height: info.height, bytes: info.bytes, sha256: info.sha256, original: info, downscaled: false };
  if (!resizeImage) return { ok: false, original: info, reason: `Image is ${info.width}×${info.height} px / ${info.bytes} bytes; the limit is ${limits.maxEdge} px per edge and ${limits.maxBytes} bytes, and downscaling is unavailable here.` };
  let resized;
  try { resized = Buffer.from(await resizeImage(original, { maxEdge: limits.maxEdge })); } catch { resized = null; }
  const next = resized && inspectPng(resized);
  if (!next || !fits(next)) return { ok: false, original: info, reason: 'Image could not be reduced within the transmission limits.' };
  return { ok: true, base64: resized.toString('base64'), mimeType: next.mimeType, width: next.width, height: next.height, bytes: next.bytes, sha256: next.sha256, original: info, downscaled: true };
}

/** Normalize redaction / inaccessible-region metadata that capture producers may attach to a version. */
export function regionSummary(version = {}) {
  const count = value => Array.isArray(value) ? value.length : 0;
  // Sanitized derivatives (src/workspace.js) list image regions ({type:'region'}) and removed text spans ({type:'text'}) in `redactions`.
  const regions = Array.isArray(version.redactions) ? version.redactions.filter(item => item?.type !== 'text').length : 0;
  const text = Array.isArray(version.redactions) ? version.redactions.length - regions : 0;
  return {
    redacted: regions + count(version.redactedRegions),
    inaccessible: count(version.inaccessibleRegions) + count(version.unavailableRegions),
    redactionStatus: typeof version.redactionStatus === 'string' ? version.redactionStatus.slice(0, 40) : 'unknown',
    ...(text ? { redactedText: text } : {}),
  };
}
