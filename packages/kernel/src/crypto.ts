import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
  timingSafeEqual,
} from 'node:crypto';

/**
 * Credential encryption at rest (AES-256-GCM).
 *
 * The architecture doc requires `IntegrationCredential.encryptedBlob` to be
 * AES-256-GCM. This module is the only place that touches plaintext secrets.
 *
 * Envelope format (base64url of the whole buffer):
 *
 *   [ 1 byte version ][ 12 byte IV ][ 16 byte auth tag ][ ciphertext … ]
 *
 * The version byte means the format can change without ambiguity, and the IV is
 * random per encryption so identical secrets produce different ciphertexts
 * (defeating equality-based inference from the database alone).
 */

const VERSION = 1;
const IV_LENGTH = 12; // 96-bit nonce, the GCM standard
const TAG_LENGTH = 16;
export const KEY_LENGTH = 32; // AES-256

export class CredentialCryptoError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CredentialCryptoError';
  }
}

/**
 * Derive a 32-byte key from a passphrase-free env value.
 *
 * The env var is expected to already be 32 bytes of entropy (hex, base64 or
 * raw). We accept hex/base64 for operator convenience and validate length so a
 * misconfigured deployment fails loudly at boot rather than silently weakening
 * encryption.
 */
export function normalizeKey(material: string | Buffer): Buffer {
  if (Buffer.isBuffer(material)) {
    if (material.length !== KEY_LENGTH) {
      throw new CredentialCryptoError(
        `TCPCORE_CREDENTIAL_KEY must be ${KEY_LENGTH} bytes, received ${material.length}`,
      );
    }
    return material;
  }

  const trimmed = material.trim();

  if (/^[0-9a-fA-F]{64}$/.test(trimmed)) {
    return Buffer.from(trimmed, 'hex');
  }

  // Accept standard base64 and base64url of exactly 32 bytes. base64url is the
  // encoding used everywhere else in this codebase (licence tokens, credential
  // envelopes), so refusing it here was a surprise that pushed operators toward
  // a hand-rolled key.
  if (/^[A-Za-z0-9+/_-]+={0,2}$/.test(trimmed)) {
    const normalised = trimmed.replace(/-/g, '+').replace(/_/g, '/');
    const decoded = Buffer.from(normalised, 'base64');

    // Strict round-trip: `Buffer.from` silently ignores characters outside the
    // alphabet, so re-encode and compare rather than trusting the decode. This
    // is what rejects a valid-looking string carrying hidden junk, and it stops
    // a 32-character passphrase from being reinterpreted as base64.
    const roundTrips =
      decoded.toString('base64').replace(/=+$/, '') === normalised.replace(/=+$/, '');

    if (roundTrips && decoded.length === KEY_LENGTH) {
      return decoded;
    }
  }

  // Otherwise a 32-byte raw string is the key.
  if (Buffer.byteLength(trimmed, 'utf8') === KEY_LENGTH) {
    return Buffer.from(trimmed, 'utf8');
  }

  throw new CredentialCryptoError(
    `TCPCORE_CREDENTIAL_KEY must encode exactly ${KEY_LENGTH} bytes ` +
      `(64 hex chars, base64/base64url of 32 bytes, or 32 raw characters). ` +
      `Generate one with: node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"`,
  );
}

export function encryptSecret(plaintext: string, key: Buffer): string {
  if (key.length !== KEY_LENGTH) {
    throw new CredentialCryptoError(`encryption key must be ${KEY_LENGTH} bytes`);
  }

  const iv = randomBytes(IV_LENGTH);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();

  return Buffer.concat([Buffer.from([VERSION]), iv, tag, ciphertext]).toString('base64url');
}

export function decryptSecret(envelope: string, key: Buffer): string {
  if (key.length !== KEY_LENGTH) {
    throw new CredentialCryptoError(`encryption key must be ${KEY_LENGTH} bytes`);
  }

  let raw: Buffer;
  try {
    raw = Buffer.from(envelope, 'base64url');
  } catch {
    throw new CredentialCryptoError('credential blob is not valid base64url');
  }

  if (raw.length < 1 + IV_LENGTH + TAG_LENGTH) {
    throw new CredentialCryptoError('credential blob is truncated');
  }

  const version = raw[0];
  if (version !== VERSION) {
    throw new CredentialCryptoError(`unsupported credential blob version ${version}`);
  }

  const iv = raw.subarray(1, 1 + IV_LENGTH);
  const tag = raw.subarray(1 + IV_LENGTH, 1 + IV_LENGTH + TAG_LENGTH);
  const ciphertext = raw.subarray(1 + IV_LENGTH + TAG_LENGTH);

  try {
    const decipher = createDecipheriv('aes-256-gcm', key, iv);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8');
  } catch {
    // Deliberately opaque: a GCM failure can mean tampering *or* a wrong key,
    // and distinguishing them is not useful to a caller.
    throw new CredentialCryptoError(
      'credential blob failed authentication (tampered or wrong key)',
    );
  }
}

/**
 * Render a secret for display. Shows at most the last 4 characters, and never
 * enough of the value to narrow a brute-force search meaningfully.
 */
export function maskSecret(secret: string): string {
  if (!secret) return '(empty)';
  if (secret.length <= 8) return '••••••••';
  return `••••••••${secret.slice(-4)}`;
}

/**
 * A short, stable, non-reversible fingerprint of a stored value.
 *
 * This exists so an operator can answer "is the credential this deployment is
 * using the one I uploaded?" without the plaintext ever being decrypted for
 * display. The same input always yields the same fingerprint, and a rotated
 * credential yields a different one, so two environments can be compared
 * safely. It reveals nothing about the secret: it is a SHA-256 digest truncated
 * to 12 hex characters, and the input is already ciphertext.
 */
export function fingerprintSecret(value: string): string {
  if (!value) return '(empty)';
  return createHash('sha256').update(value, 'utf8').digest('hex').slice(0, 12);
}

/** Constant-time comparison for token/secret equality checks. */
export function safeEqual(a: string, b: string): boolean {
  const bufA = Buffer.from(a, 'utf8');
  const bufB = Buffer.from(b, 'utf8');
  if (bufA.length !== bufB.length) return false;
  return timingSafeEqual(bufA, bufB);
}

export function generateKeyHex(): string {
  return randomBytes(KEY_LENGTH).toString('hex');
}
