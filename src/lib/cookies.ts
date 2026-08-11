import type { Response } from 'express';
import { env } from '#app/config/env.js';

export const cookieNames = {
  access: env.COOKIE_SECURE ? '__Host-access_token' : 'access_token',
  refresh: env.COOKIE_SECURE ? '__Host-refresh_token' : 'refresh_token',
  csrf: env.COOKIE_SECURE ? '__Host-csrf_token' : 'csrf_token',
} as const;

const baseCookie = {
  path: '/',
  secure: env.COOKIE_SECURE,
  sameSite: env.COOKIE_SAME_SITE,
} as const;

export function setAuthCookies(
  response: Response,
  accessToken: string,
  refreshToken: string,
): void {
  response.cookie(cookieNames.access, accessToken, {
    ...baseCookie,
    httpOnly: true,
    maxAge: env.ACCESS_TOKEN_TTL_MINUTES * 60 * 1000,
  });
  response.cookie(cookieNames.refresh, refreshToken, {
    ...baseCookie,
    httpOnly: true,
    maxAge: env.REFRESH_TOKEN_TTL_DAYS * 24 * 60 * 60 * 1000,
  });
}

export function clearAuthCookies(response: Response): void {
  response.clearCookie(cookieNames.access, baseCookie);
  response.clearCookie(cookieNames.refresh, baseCookie);
}
