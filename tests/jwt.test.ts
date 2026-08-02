import { SignJWT } from 'jose';
import { describe, expect, it } from 'vitest';
import { signAccessToken, verifyAccessToken } from '../dist/src/lib/jwt.js';

describe('access tokens', () => {
  it('round-trips required session claims', async () => {
    const token = await signAccessToken({ userId: 'user-id', sessionId: 'session-id' });
    await expect(verifyAccessToken(token)).resolves.toEqual({
      userId: 'user-id',
      sessionId: 'session-id',
    });
  });

  it('rejects a token signed with a non-allowlisted algorithm', async () => {
    const secret = new TextEncoder().encode(process.env.JWT_ACCESS_SECRET);
    const token = await new SignJWT({ sid: 'session-id' })
      .setProtectedHeader({ alg: 'HS384' })
      .setSubject('user-id')
      .setIssuer('backend-foundation')
      .setAudience('backend-foundation-api')
      .setExpirationTime('5m')
      .sign(secret);
    await expect(verifyAccessToken(token)).rejects.toThrow();
  });
});
