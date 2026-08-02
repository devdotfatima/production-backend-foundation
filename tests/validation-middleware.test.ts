import type { NextFunction, Request, Response } from 'express';
import { z } from 'zod';
import { describe, expect, it, vi } from 'vitest';
import { getValidated, validateRequest } from '../dist/src/middleware/request-validation.js';

describe('request validation middleware', () => {
  it('validates body, headers, params, and query and caches transformed output', () => {
    let transformations = 0;
    const schemas = {
      body: z.object({
        name: z
          .string()
          .trim()
          .transform((value) => {
            transformations += 1;
            return value.toUpperCase();
          }),
      }),
      params: z.object({ id: z.string().trim() }),
      query: z.object({ limit: z.coerce.number().int() }),
      headers: z.object({ 'idempotency-key': z.string().min(8) }),
    } as const;
    const request = {
      body: { name: ' Alice ' },
      params: { id: ' user-1 ' },
      query: { limit: '25' },
      headers: { 'idempotency-key': 'request-123' },
    } as unknown as Request;
    const next = vi.fn<(error?: unknown) => void>();

    validateRequest(schemas)(request, {} as Response, next as NextFunction);

    expect(next).toHaveBeenCalledWith();
    expect(getValidated(request, schemas)).toEqual({
      body: { name: 'ALICE' },
      params: { id: 'user-1' },
      query: { limit: 25 },
      headers: { 'idempotency-key': 'request-123' },
    });
    expect(transformations).toBe(1);

    getValidated(request, schemas);
    expect(transformations).toBe(1);
  });

  it('passes a source-specific validation error to Express', () => {
    const request = { body: { limit: 'invalid' } } as Request;
    const next = vi.fn<(error?: unknown) => void>();

    validateRequest({ body: z.object({ limit: z.number() }) })(
      request,
      {} as Response,
      next as NextFunction,
    );

    const error: unknown = next.mock.calls[0]?.[0];
    expect(error).toMatchObject({
      statusCode: 400,
      code: 'BAD_REQUEST',
      details: { source: 'body' },
    });
    expect(request.validated).toBeUndefined();
  });
});
