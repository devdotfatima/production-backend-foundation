import { describe, expect, it } from 'vitest';
import {
  candidateMetadataHashes,
  candidateOpaqueTokenHashes,
  constantTimeEqual,
  decryptSecret,
  encryptSecret,
  hashOpaqueToken,
  hashSecret,
  randomOtp,
  randomToken,
  verifySecret,
} from '../dist/src/lib/crypto.js';

describe('credential primitives', () => {
  it('hashes and verifies password-like secrets with Argon2id', async () => {
    const hash = await hashSecret('correct horse battery staple');
    expect(hash).toMatch(/^\$argon2id\$/);
    await expect(verifySecret(hash, 'correct horse battery staple')).resolves.toBe(true);
    await expect(verifySecret(hash, 'wrong')).resolves.toBe(false);
  });

  it('encrypts sensitive outbox values with authenticated encryption', () => {
    const encrypted = encryptSecret('123456');
    expect(encrypted).not.toContain('123456');
    expect(decryptSecret(encrypted)).toBe('123456');
  });

  it('creates stable hashes for opaque-token lookup', () => {
    const token = randomToken();
    expect(hashOpaqueToken(token)).toBe(hashOpaqueToken(token));
    expect(hashOpaqueToken(token)).not.toBe(hashOpaqueToken(`${token}x`));
    expect(candidateOpaqueTokenHashes(token)).toContain(hashOpaqueToken(token));
    expect(candidateMetadataHashes(token)).toHaveLength(2);
  });

  it('uses constant-time equality and six-digit OTPs', () => {
    expect(constantTimeEqual('same', 'same')).toBe(true);
    expect(constantTimeEqual('same', 'different')).toBe(false);
    expect(randomOtp()).toMatch(/^\d{6}$/);
  });
});
