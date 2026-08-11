import type { RequestHandler } from 'express';
import { usesCookieAuth } from '#app/lib/auth-transport.js';
import { constantTimeEqual } from '#app/lib/crypto.js';
import { errors } from '#app/lib/errors.js';
import { cookieNames } from '#app/lib/cookies.js';

const unsafeMethods = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

export const csrfProtection: RequestHandler = (request, _response, next) => {
  if (!unsafeMethods.has(request.method)) return next();
  if (request.path === '/api/v1/webhooks/stripe') return next();
  if (!usesCookieAuth(request)) return next();

  const signedCookies = request.signedCookies as Record<string, unknown> | undefined;
  const cookie = signedCookies?.[cookieNames.csrf];
  const header = request.header('x-csrf-token');
  if (typeof cookie !== 'string' || !header || !constantTimeEqual(cookie, header)) {
    return next(errors.invalidCsrf());
  }
  next();
};
