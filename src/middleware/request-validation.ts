import type { Request, RequestHandler } from 'express';
import type { z } from 'zod';
import { errors } from '#app/lib/errors.js';

type RequestValidationSource = 'body' | 'headers' | 'params' | 'query';
type RequestValidationSchemas = Partial<Record<RequestValidationSource, z.ZodType>>;

type ValidatedRequestData<TSchemas extends RequestValidationSchemas> = {
  -readonly [TSource in keyof TSchemas]-?: TSchemas[TSource] extends z.ZodType
    ? z.output<TSchemas[TSource]>
    : never;
};

const validationSources = [
  'headers',
  'params',
  'query',
  'body',
] as const satisfies readonly RequestValidationSource[];

function parseInput<TSchema extends z.ZodType>(
  schema: TSchema,
  input: unknown,
  source: RequestValidationSource,
): z.output<TSchema> {
  const result = schema.safeParse(input);
  if (!result.success) {
    throw errors.badRequest('Validation failed', {
      source,
      ...result.error.flatten(),
    });
  }
  return result.data;
}

/**
 * Parses each configured request source exactly once and stores the transformed
 * outputs separately from Express' raw request properties.
 */
export function validateRequest<TSchemas extends RequestValidationSchemas>(
  schemas: TSchemas,
): RequestHandler {
  return (request, _response, next) => {
    try {
      const validated: Partial<Record<RequestValidationSource, unknown>> = {};

      for (const source of validationSources) {
        const schema = schemas[source];
        if (schema) validated[source] = parseInput(schema, request[source], source);
      }

      request.validated = { ...request.validated, ...validated };
      next();
    } catch (error) {
      next(error);
    }
  };
}

/** Returns typed data cached by validateRequest without parsing it again. */
export function getValidated<TSchemas extends RequestValidationSchemas>(
  request: Request,
  schemas: TSchemas,
): ValidatedRequestData<TSchemas> {
  for (const source of Object.keys(schemas) as RequestValidationSource[]) {
    if (!Object.hasOwn(request.validated ?? {}, source)) {
      throw new Error(`Validated request ${source} is unavailable`);
    }
  }
  return request.validated as ValidatedRequestData<TSchemas>;
}
