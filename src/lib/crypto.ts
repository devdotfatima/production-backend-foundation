import {
  createCipheriv,
  createDecipheriv,
  createHash,
  createHmac,
  hkdfSync,
  randomBytes,
  timingSafeEqual,
} from 'node:crypto';
import argon2 from 'argon2';
import { env } from '#app/config/env.js';

const argonOptions = {
  type: argon2.argon2id,
  memoryCost: 19_456,
  timeCost: 2,
  parallelism: 1,
} as const;

export function randomToken(bytes = 48): string {
  return randomBytes(bytes).toString('base64url');
}

export function randomOtp(): string {
  const value = randomBytes(4).readUInt32BE(0) % 1_000_000;
  return value.toString().padStart(6, '0');
}

const cryptoKeyring =
  Object.keys(env.CRYPTO_KEYRING).length > 0
    ? env.CRYPTO_KEYRING
    : { [env.CRYPTO_ACTIVE_KEY_ID]: env.TOKEN_HASH_SECRET };
const activeKeyId = env.CRYPTO_ACTIVE_KEY_ID;
const keyDerivationSalt = Buffer.from('backend-foundation:crypto:v1', 'utf8');

type CryptoPurpose = 'opaque-token' | 'metadata' | 'encryption';

function derivedKey(keyId: string, purpose: CryptoPurpose): Buffer {
  const master = cryptoKeyring[keyId];
  if (!master) throw new Error(`Unknown cryptographic key id: ${keyId}`);
  return Buffer.from(
    hkdfSync('sha256', Buffer.from(master, 'utf8'), keyDerivationSalt, Buffer.from(purpose), 32),
  );
}

function versionedHmac(
  keyId: string,
  purpose: Exclude<CryptoPurpose, 'encryption'>,
  value: string,
) {
  const digest = createHmac('sha256', derivedKey(keyId, purpose)).update(value).digest('base64url');
  return `v1.${keyId}.${digest}`;
}

export function hashOpaqueToken(token: string): string {
  return versionedHmac(activeKeyId, 'opaque-token', token);
}

/** All lookup hashes accepted during rotation, including the pre-keyring legacy format. */
export function candidateOpaqueTokenHashes(token: string): string[] {
  return [
    ...Object.keys(cryptoKeyring).map((keyId) => versionedHmac(keyId, 'opaque-token', token)),
    createHmac('sha256', env.TOKEN_HASH_SECRET).update(token).digest('base64url'),
  ];
}

export function encryptSecret(value: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', derivedKey(activeKeyId, 'encryption'), iv);
  const ciphertext = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return ['v1', activeKeyId, iv, tag, ciphertext]
    .map((part) => (typeof part === 'string' ? part : part.toString('base64url')))
    .join('.');
}

export function decryptSecret(value: string): string {
  const parts = value.split('.');
  let key: Buffer;
  let ivPart: string;
  let tagPart: string;
  let ciphertextPart: string;
  if (parts.length === 5 && parts[0] === 'v1') {
    const [, keyId, iv, tag, ciphertext] = parts as [string, string, string, string, string];
    key = derivedKey(keyId, 'encryption');
    ivPart = iv;
    tagPart = tag;
    ciphertextPart = ciphertext;
  } else if (parts.length === 3) {
    // Transitional reader for values produced before key IDs and HKDF were introduced.
    key = createHash('sha256').update(env.TOKEN_HASH_SECRET).digest();
    [ivPart, tagPart, ciphertextPart] = parts as [string, string, string];
  } else {
    throw new Error('Invalid encrypted payload');
  }
  const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(ivPart, 'base64url'));
  decipher.setAuthTag(Buffer.from(tagPart, 'base64url'));
  return Buffer.concat([
    decipher.update(Buffer.from(ciphertextPart, 'base64url')),
    decipher.final(),
  ]).toString('utf8');
}

export function hashMetadata(value: string): string {
  return versionedHmac(activeKeyId, 'metadata', value);
}

export async function hashSecret(value: string): Promise<string> {
  return argon2.hash(value, argonOptions);
}

export async function verifySecret(hash: string, candidate: string): Promise<boolean> {
  try {
    return await argon2.verify(hash, candidate);
  } catch {
    return false;
  }
}

export function constantTimeEqual(left: string, right: string): boolean {
  const leftBuffer = Buffer.from(left);
  const rightBuffer = Buffer.from(right);
  if (leftBuffer.length !== rightBuffer.length) {
    timingSafeEqual(leftBuffer, Buffer.alloc(leftBuffer.length));
    return false;
  }
  return timingSafeEqual(leftBuffer, rightBuffer);
}

export function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

export function normalizePhone(phone: string): string {
  return phone.replace(/[\s()-]/g, '');
}
