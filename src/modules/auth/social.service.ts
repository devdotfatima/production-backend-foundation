import { createRemoteJWKSet, jwtVerify, type JWTPayload } from 'jose';
import { env } from '#app/config/env.js';
import { errors } from '#app/lib/errors.js';

export type SocialProvider = 'GOOGLE' | 'APPLE';

export interface SocialIdentity {
  provider: SocialProvider;
  providerAccountId: string;
  email?: string;
  emailVerified: boolean;
  displayName?: string;
}

const googleKeys = createRemoteJWKSet(new URL('https://www.googleapis.com/oauth2/v3/certs'));
const appleKeys = createRemoteJWKSet(new URL('https://appleid.apple.com/auth/keys'));

function claimString(payload: JWTPayload, key: string): string | undefined {
  const value = payload[key];
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function verifiedEmail(payload: JWTPayload): boolean {
  return payload.email_verified === true || payload.email_verified === 'true';
}

export async function verifySocialIdentity(
  provider: 'google' | 'apple',
  idToken: string,
): Promise<SocialIdentity> {
  const normalizedProvider = provider.toUpperCase() as SocialProvider;
  const audience = normalizedProvider === 'GOOGLE' ? env.GOOGLE_CLIENT_ID : env.APPLE_CLIENT_ID;
  if (!audience) {
    throw new Error(`${normalizedProvider} social login is not configured`);
  }

  const issuer =
    normalizedProvider === 'GOOGLE'
      ? ['https://accounts.google.com', 'accounts.google.com']
      : 'https://appleid.apple.com';
  const keySet = normalizedProvider === 'GOOGLE' ? googleKeys : appleKeys;

  let payload: JWTPayload;
  try {
    ({ payload } = await jwtVerify(idToken, keySet, {
      algorithms: ['RS256'],
      issuer,
      audience,
    }));
  } catch {
    throw errors.unauthenticated('Invalid social identity token');
  }

  const providerAccountId = claimString(payload, 'sub');
  if (!providerAccountId) throw errors.unauthenticated('Invalid social identity token');

  const email = claimString(payload, 'email')?.trim().toLowerCase();
  const emailIsVerified = verifiedEmail(payload);
  if (email && !emailIsVerified) throw errors.unauthenticated('Social email is not verified');

  return {
    provider: normalizedProvider,
    providerAccountId,
    ...(email ? { email } : {}),
    emailVerified: emailIsVerified,
    ...(claimString(payload, 'name') ? { displayName: claimString(payload, 'name') } : {}),
  };
}
