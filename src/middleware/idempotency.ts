import type { RequestHandler } from 'express';
import { errors } from '#app/lib/errors.js';

/** Parses a stable business-operation key for controllers that use runIdempotent(). */
export const requireIdempotencyKey: RequestHandler = (request, _response, next) => {
  const value = request.header('idempotency-key')?.trim();
  if (!value || value.length < 8 || value.length > 200) {
    return next(errors.badRequest('A valid Idempotency-Key header is required'));
  }
  request.idempotencyKey = value;
  next();
};
