import { createHash, createPrivateKey, createPublicKey, generateKeyPairSync, sign, verify } from 'node:crypto';
import { z } from 'zod';

/** Ed25519 release signing for community lists. Pure node:crypto; no network and no key storage. */
export class ListError extends Error {
  constructor(code, message) { super(`${code}: ${message}`); this.name = 'ListError'; this.code = code; }
}
// Domain separation keeps a list signature from being replayed as any other Weft signed document.
const DOMAIN = Buffer.from('weft-community-list-v1\n');
export const MAX_ENVELOPE_BYTES = 1_000_000;
const b64 = z.string().min(1).max(4096).regex(/^[A-Za-z0-9+/]+={0,2}$/);
export const envelopeSchema = z.strictObject({
  format: z.literal('weft-signed-list'), version: z.literal(1),
  payload: z.string().min(2).max(MAX_ENVELOPE_BYTES),
  signatures: z.array(z.strictObject({ keyId: z.string().regex(/^[a-f0-9]{64}$/), signature: b64 })).max(4),
});

export const sha256 = value => createHash('sha256').update(value).digest('hex');
/** Key IDs are the SHA-256 of the SPKI DER bytes, shown to humans for out-of-band comparison. */
export function keyIdOf(publicKeyBase64) { return sha256(parsePublicKey(publicKeyBase64).der); }

export function parsePublicKey(publicKeyBase64) {
  if (typeof publicKeyBase64 !== 'string' || !/^[A-Za-z0-9+/]+={0,2}$/.test(publicKeyBase64) || publicKeyBase64.length > 200) throw new ListError('LIST_KEY', 'Publisher key must be a base64 Ed25519 SPKI public key');
  const der = Buffer.from(publicKeyBase64, 'base64');
  try {
    const key = createPublicKey({ key: der, format: 'der', type: 'spki' });
    if (key.asymmetricKeyType !== 'ed25519') throw new Error('not ed25519');
    return { key, der };
  } catch { throw new ListError('LIST_KEY', 'Publisher key must be a base64 Ed25519 SPKI public key'); }
}

export function generateKeyPair() {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  const publicKeyBase64 = publicKey.export({ type: 'spki', format: 'der' }).toString('base64');
  return { publicKey: publicKeyBase64, keyId: keyIdOf(publicKeyBase64), privateKeyPem: privateKey.export({ type: 'pkcs8', format: 'pem' }) };
}

export function publicKeyOfPrivate(privateKeyPem) {
  try {
    const key = createPrivateKey(privateKeyPem);
    if (key.asymmetricKeyType !== 'ed25519') throw new Error('not ed25519');
    const publicKey = createPublicKey(key).export({ type: 'spki', format: 'der' }).toString('base64');
    return { publicKey, keyId: keyIdOf(publicKey), key };
  } catch { throw new ListError('LIST_KEY', 'Signing key must be an Ed25519 PKCS#8 PEM private key'); }
}

/** Sign the exact payload text (never a re-serialisation), with one signature per supplied private key. */
export function buildEnvelope(payloadText, privateKeyPems) {
  const signatures = privateKeyPems.map(pem => {
    const { keyId, key } = publicKeyOfPrivate(pem);
    return { keyId, signature: sign(null, Buffer.concat([DOMAIN, Buffer.from(payloadText)]), key).toString('base64') };
  });
  if (Buffer.byteLength(payloadText) > MAX_ENVELOPE_BYTES / 2) throw new ListError('LIST_SIZE', 'Signed payload is too large');
  return JSON.stringify({ format: 'weft-signed-list', version: 1, payload: payloadText, signatures }, null, 2) + '\n';
}

export function parseEnvelope(text) {
  if (typeof text !== 'string' || Buffer.byteLength(text) > MAX_ENVELOPE_BYTES) throw new ListError('LIST_SIZE', 'Signed list exceeds the 1,000,000 byte limit');
  let raw;
  try { raw = JSON.parse(text); } catch { throw new ListError('LIST_FORMAT', 'Signed list is not valid JSON'); }
  // A plain data-only list or a manifest with no signatures is never a subscription source.
  if (!raw || typeof raw !== 'object' || raw.format !== 'weft-signed-list' || !Array.isArray(raw.signatures) || !raw.signatures.length) throw new ListError('LIST_UNSIGNED', 'Subscriptions require a signed list envelope (format weft-signed-list with at least one signature)');
  const parsed = envelopeSchema.safeParse(raw);
  if (!parsed.success) throw new ListError('LIST_FORMAT', `Invalid signed list envelope: ${parsed.error.issues[0]?.message || 'schema error'}`);
  let payload;
  try { payload = JSON.parse(parsed.data.payload); } catch { throw new ListError('LIST_FORMAT', 'Signed payload is not valid JSON'); }
  return { envelope: parsed.data, payload };
}

/** True only when `keyId`'s signature over the payload text verifies against `publicKeyBase64`. */
export function signatureValid(envelope, keyId, publicKeyBase64) {
  const { key, der } = parsePublicKey(publicKeyBase64);
  if (sha256(der) !== keyId) return false;
  const entry = envelope.signatures.find(item => item.keyId === keyId);
  if (!entry) return false;
  try { return verify(null, Buffer.concat([DOMAIN, Buffer.from(envelope.payload)]), key, Buffer.from(entry.signature, 'base64')); } catch { return false; }
}
