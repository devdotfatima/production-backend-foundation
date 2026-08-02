import { z } from 'zod';

export const createServiceAccountSchema = z.object({
  name: z.string().trim().min(1).max(100),
  permissions: z.array(z.string().trim().min(1).max(100)).max(100).default([]),
});
export const serviceAccountIdParams = z.object({ serviceAccountId: z.uuid() });
export const apiKeyIdParams = serviceAccountIdParams.extend({ apiKeyId: z.uuid() });
export const createApiKeySchema = z.object({
  name: z.string().trim().min(1).max(100),
  expiresAt: z.coerce.date().optional(),
});
export const createServiceAccountRequestValidation = { body: createServiceAccountSchema } as const;
export const createApiKeyRequestValidation = {
  params: serviceAccountIdParams,
  body: createApiKeySchema,
} as const;
export const apiKeyIdRequestValidation = { params: apiKeyIdParams } as const;
