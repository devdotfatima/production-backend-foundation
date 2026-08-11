import type { Request } from 'express';
import { cookieNames } from '#app/lib/cookies.js';

export const CLIENT_TYPE_HEADER = 'x-client-type';

export function isMobileClient(request: Request): boolean {
  return request.header(CLIENT_TYPE_HEADER)?.toLowerCase() === 'mobile';
}

export function getBearerToken(request: Request): string | undefined {
  const header = request.header('authorization');
  if (!header?.startsWith('Bearer ')) return undefined;
  return header.slice('Bearer '.length).trim() || undefined;
}

/** Access token for `authenticate`: bearer header first, cookie fallback. */
export function resolveAccessToken(request: Request): string | undefined {
  const bearer = getBearerToken(request);
  if (bearer) return bearer;
  const cookies = request.cookies as Record<string, unknown> | undefined;
  const token = cookies?.[cookieNames.access];
  return typeof token === 'string' ? token : undefined;
}

/** Refresh token for `/refresh`: mobile JSON body, cookie fallback. */
export function resolveRefreshToken(request: Request): string | undefined {
  if (isMobileClient(request)) {
    const token = (request.body as Record<string, unknown> | undefined)?.refreshToken;
    return typeof token === 'string' ? token : undefined;
  }
  const cookies = request.cookies as Record<string, unknown> | undefined;
  const token = cookies?.[cookieNames.refresh];
  return typeof token === 'string' ? token : undefined;
}

/** True when this request relies on the ambient cookie session (and so needs CSRF). */
export function usesCookieAuth(request: Request): boolean {
  return !getBearerToken(request) && !isMobileClient(request);
}
