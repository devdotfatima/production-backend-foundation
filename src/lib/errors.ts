export type ErrorCode =
  | 'BAD_REQUEST'
  | 'UNAUTHENTICATED'
  | 'FORBIDDEN'
  | 'NOT_FOUND'
  | 'CONFLICT'
  | 'RATE_LIMITED'
  | 'SERVICE_UNAVAILABLE'
  | 'INVALID_CSRF_TOKEN'
  | 'INTERNAL_ERROR';

export class AppError extends Error {
  constructor(
    public readonly statusCode: number,
    public readonly code: ErrorCode,
    message: string,
    public readonly details?: unknown,
    public readonly retryAfterSeconds?: number,
  ) {
    super(message);
    this.name = 'AppError';
  }
}

export const errors = {
  badRequest: (message = 'The request is invalid', details?: unknown) =>
    new AppError(400, 'BAD_REQUEST', message, details),
  unauthenticated: (message = 'Authentication required') =>
    new AppError(401, 'UNAUTHENTICATED', message),
  forbidden: (message = 'You do not have permission to perform this action') =>
    new AppError(403, 'FORBIDDEN', message),
  notFound: (message = 'Resource not found') => new AppError(404, 'NOT_FOUND', message),
  conflict: (message = 'The request conflicts with current state') =>
    new AppError(409, 'CONFLICT', message),
  rateLimited: (message = 'Too many requests; try again later', retryAfterSeconds = 1) =>
    new AppError(429, 'RATE_LIMITED', message, undefined, Math.max(1, retryAfterSeconds)),
  serviceUnavailable: (message = 'The requested service is unavailable') =>
    new AppError(503, 'SERVICE_UNAVAILABLE', message),
  invalidCsrf: () => new AppError(403, 'INVALID_CSRF_TOKEN', 'Invalid CSRF token'),
};
