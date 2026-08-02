import type { RequestHandler } from 'express';
import { errors } from '#app/lib/errors.js';
import { authenticateApiKey } from '#app/modules/service-accounts/service-accounts.service.js';

export function requireApiKey(permission?: string): RequestHandler {
  return async (request, _response, next) => {
    const rawKey = request.header('x-api-key');
    if (!rawKey) return next(errors.unauthenticated('API key required'));
    const identity = await authenticateApiKey(rawKey, permission);
    if (!identity) return next(errors.forbidden('Invalid API key or permission'));
    request.serviceAuth = identity;
    next();
  };
}
