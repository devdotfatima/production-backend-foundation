import { SignJWT, jwtVerify } from 'jose';
import { env } from '#app/config/env.js';

const secret = new TextEncoder().encode(env.JWT_ACCESS_SECRET);
const issuer = 'backend-foundation';
const audience = 'backend-foundation-api';

/**
 * The active organization is deliberately absent. `authenticate` reads the session on every
 * request regardless, so a token claim would add a second source of truth that can diverge from
 * `Session.activeOrganizationId` after an organization switch — silently acting in the wrong
 * tenant. The session row is authoritative.
 */
export interface AccessClaims {
  userId: string;
  sessionId: string;
}

export async function signAccessToken(claims: AccessClaims): Promise<string> {
  return new SignJWT({ sid: claims.sessionId })
    .setProtectedHeader({ alg: 'HS256', typ: 'JWT' })
    .setSubject(claims.userId)
    .setIssuer(issuer)
    .setAudience(audience)
    .setIssuedAt()
    .setExpirationTime(`${env.ACCESS_TOKEN_TTL_MINUTES}m`)
    .sign(secret);
}

export async function verifyAccessToken(token: string): Promise<AccessClaims> {
  const { payload } = await jwtVerify(token, secret, {
    algorithms: ['HS256'],
    issuer,
    audience,
  });

  if (!payload.sub || typeof payload.sid !== 'string') {
    throw new Error('Access token is missing required claims');
  }
  return { userId: payload.sub, sessionId: payload.sid };
}
