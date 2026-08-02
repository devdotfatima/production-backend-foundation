import type { Request, Response } from 'express';

interface SuccessOptions<T> {
  status?: number;
  message?: string;
  data?: T;
  meta?: Record<string, unknown>;
}

export function sendSuccess<T = null>(
  request: Request,
  response: Response,
  options: SuccessOptions<T> = {},
): void {
  response.status(options.status ?? 200).json({
    success: true,
    message: options.message ?? 'Request completed successfully',
    data: options.data ?? null,
    error: null,
    meta: {
      requestId: request.id,
      ...options.meta,
    },
  });
}

export function sendError(
  request: Request,
  response: Response,
  options: {
    status: number;
    code: string;
    message: string;
    details?: unknown;
    retryAfterSeconds?: number;
  },
): void {
  if (options.status === 429) {
    response.setHeader('Retry-After', String(Math.max(1, options.retryAfterSeconds ?? 1)));
  }
  response.status(options.status).json({
    success: false,
    message: options.message,
    data: null,
    error: {
      code: options.code,
      details: options.details ?? null,
    },
    meta: { requestId: request.id },
  });
}
