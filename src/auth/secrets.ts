/**
 * Envelope encryption for TOTP secrets at rest.
 *
 * In production the data key comes from AWS KMS in ap-southeast-2 (ADR-0025).
 * This module keeps the interface so the swap is a provider change, not a schema
 * change: what is stored is always `iv || authTag || ciphertext`.
 */
import { createCipheriv, createDecipheriv, randomBytes, createHash } from 'node:crypto';

const IV_BYTES = 12;
const TAG_BYTES = 16;

function key(): Buffer {
  const raw = process.env.LOTLINE_SECRET_KEY;
  if (!raw) {
    if (process.env.NODE_ENV === 'production') {
      // Failing to start is the correct behaviour. A development fallback key in
      // production would silently make every stored secret recoverable by anyone
      // who has read the source.
      throw new Error('LOTLINE_SECRET_KEY is required in production');
    }
    return createHash('sha256').update('lotline-development-key').digest();
  }
  return createHash('sha256').update(raw).digest();
}

export function sealSecret(plaintext: string): Buffer {
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv('aes-256-gcm', key(), iv);
  const enc = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), enc]);
}

export function openSecret(sealed: Buffer): string {
  const iv = sealed.subarray(0, IV_BYTES);
  const tag = sealed.subarray(IV_BYTES, IV_BYTES + TAG_BYTES);
  const enc = sealed.subarray(IV_BYTES + TAG_BYTES);
  const decipher = createDecipheriv('aes-256-gcm', key(), iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(enc), decipher.final()]).toString('utf8');
}
