import type { NextFunction, Request, Response } from 'express';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  eval: vi.fn(),
  hashMetadata: vi.fn((value: string) => `metadata:${value}`),
  captureException: vi.fn(),
  loggerInfo: vi.fn(),
  loggerWarn: vi.fn(),
}));

vi.mock('#app/lib/redis.js', () => ({ appRedis: { eval: mocks.eval } }));
vi.mock('#app/lib/crypto.js', () => ({ hashMetadata: mocks.hashMetadata }));
vi.mock('#app/observability/logger.js', () => ({
  appLogger: { info: mocks.loggerInfo, warn: mocks.loggerWarn },
}));
vi.mock('#app/observability/sentry.js', () => ({ captureException: mocks.captureException }));

import { errors } from '#app/lib/errors.js';
import { errorHandler } from '../dist/src/middleware/error-handler.js';
import { BoundedRateLimitFallback, enforceRateLimit } from '../dist/src/lib/rate-limit.js';

function responseDouble() {
  const json = vi.fn();
  const setHeader = vi.fn();
  const status = vi.fn();
  const response = { status, setHeader, json };
  status.mockReturnValue(response);
  return { response: response as unknown as Response, setHeader, status, json };
}

const request = {
  id: 'request-123',
  method: 'GET',
  path: '/health',
} as unknown as Request;

describe('rate limiting', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('uses Redis TTL as the Retry-After duration when a limit is exceeded', async () => {
    mocks.eval.mockResolvedValue([4, 12]);

    await expect(enforceRateLimit('test', 'user:user-1', 3, 60)).rejects.toMatchObject({
      statusCode: 429,
      retryAfterSeconds: 12,
    });
  });

  it('uses the local fallback when Redis is unavailable', async () => {
    mocks.eval.mockRejectedValue(new Error('Redis unavailable'));

    await expect(enforceRateLimit('fallback', 'user:user-1', 2, 60)).resolves.toMatchObject({
      count: 1,
      limit: 2,
    });
    await expect(enforceRateLimit('fallback', 'user:user-1', 2, 60)).resolves.toMatchObject({
      count: 2,
      limit: 2,
    });
    await expect(enforceRateLimit('fallback', 'user:user-1', 2, 60)).rejects.toMatchObject({
      statusCode: 429,
    });
    expect(mocks.loggerWarn).toHaveBeenCalled();
    expect(mocks.captureException).toHaveBeenCalledWith(
      expect.any(Error),
      expect.objectContaining({ subsystem: 'rate-limit', failureMode: 'local' }),
    );
  });

  it('fails closed for sensitive operations when Redis is unavailable', async () => {
    mocks.eval.mockRejectedValue(new Error('Redis unavailable'));

    await expect(
      enforceRateLimit('otp:send', 'user@example.com', 3, 60, {
        redisFailureMode: 'deny',
      }),
    ).rejects.toMatchObject({ statusCode: 503, code: 'SERVICE_UNAVAILABLE' });
  });

  it('bounds fallback memory and evicts the oldest key', () => {
    const fallback = new BoundedRateLimitFallback(2);

    fallback.increment('first', 60, 1_000);
    fallback.increment('second', 60, 1_000);
    fallback.increment('third', 60, 1_000);

    expect(fallback.size).toBe(2);
    expect(fallback.increment('first', 60, 1_000).count).toBe(1);
  });

  it('sets Retry-After on every AppError 429 response', () => {
    const { response, setHeader, status, json } = responseDouble();
    const next = vi.fn<(error?: unknown) => void>();

    errorHandler(errors.rateLimited(undefined, 12), request, response, next as NextFunction);

    expect(setHeader).toHaveBeenCalledWith('Retry-After', '12');
    expect(status).toHaveBeenCalledWith(429);
    expect(json).toHaveBeenCalled();
  });
});
