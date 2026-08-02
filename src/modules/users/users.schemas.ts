import { z } from 'zod';
import { createListQuerySchema } from '#app/middleware/query-options.js';

export const userIdParams = z.object({ id: z.uuid() });
export const usersListQuery = createListQuerySchema([
  'createdAt',
  'email',
  'displayName',
  'id',
] as const).extend({
  status: z.enum(['PENDING', 'ACTIVE', 'SUSPENDED', 'DISABLED']).optional(),
});
export const updateUserSchema = z.object({
  displayName: z.string().trim().min(1).max(100).nullable().optional(),
  status: z.enum(['PENDING', 'ACTIVE', 'SUSPENDED', 'DISABLED']).optional(),
});
export const updateOwnProfileSchema = z.object({
  displayName: z.string().trim().min(1).max(100).nullable().optional(),
  phone: z
    .string()
    .regex(/^\+[1-9]\d{7,14}$/, 'Phone must be in E.164 format')
    .nullable()
    .optional(),
});
export const deviceIdParams = z.object({ deviceId: z.uuid() });
export const sessionIdParams = z.object({ sessionId: z.uuid() });

export const usersListRequestValidation = { query: usersListQuery } as const;
export const updateUserRequestValidation = {
  params: userIdParams,
  body: updateUserSchema,
} as const;
export const updateOwnProfileRequestValidation = { body: updateOwnProfileSchema } as const;
export const deviceIdRequestValidation = { params: deviceIdParams } as const;
export const sessionIdRequestValidation = { params: sessionIdParams } as const;
