import type { ErrorRequestHandler, RequestHandler } from 'express';
import { Prisma } from '@prisma/client';
import { AppError } from '#app/lib/errors.js';
import { sendError } from '#app/lib/api-response.js';
import { captureException } from '#app/observability/sentry.js';

export const notFoundHandler: RequestHandler = (request, response) => {
  sendError(request, response, {
    status: 404,
    code: 'NOT_FOUND',
    message: `Route ${request.method} ${request.path} was not found`,
  });
};

export const errorHandler: ErrorRequestHandler = (error: unknown, request, response, _next) => {
  void _next;
  if (error instanceof AppError) {
    sendError(request, response, {
      status: error.statusCode,
      code: error.code,
      message: error.message,
      details: error.details,
      retryAfterSeconds: error.retryAfterSeconds,
    });
    return;
  }

  if (error instanceof Prisma.PrismaClientKnownRequestError) {
    if (error.code === 'P2002') {
      sendError(request, response, {
        status: 409,
        code: 'CONFLICT',
        message: 'The resource already exists',
      });
      return;
    }
    if (error.code === 'P2025') {
      sendError(request, response, {
        status: 404,
        code: 'NOT_FOUND',
        message: 'Resource not found',
      });
      return;
    }
  }

  if (error instanceof SyntaxError && 'body' in error) {
    sendError(request, response, {
      status: 400,
      code: 'BAD_REQUEST',
      message: 'Malformed JSON request body',
    });
    return;
  }

  request.log?.error({ err: error }, 'Unhandled request error');
  captureException(error, { requestId: request.id, method: request.method, path: request.path });
  sendError(request, response, {
    status: 500,
    code: 'INTERNAL_ERROR',
    message: 'An unexpected error occurred',
  });
};
