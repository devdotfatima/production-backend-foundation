import { z } from 'zod';

export const roleSchema = z.object({
  name: z
    .string()
    .trim()
    .min(2)
    .max(64)
    .regex(/^[a-z][a-z0-9_-]+$/),
  description: z.string().trim().max(500).optional(),
  permissions: z.array(z.string().min(1).max(100)).max(100).default([]),
});

export const assignmentSchema = z.object({ userId: z.uuid(), roleId: z.uuid() });

export const roleIdParams = z.object({ id: z.uuid() });
export const updateRolePermissionsSchema = z.object({
  permissions: z.array(z.string().min(1).max(100)).max(100),
});

export const createRoleRequestValidation = { body: roleSchema } as const;
export const assignRoleRequestValidation = { body: assignmentSchema } as const;
export const revokeRoleRequestValidation = { query: assignmentSchema } as const;
export const updateRolePermissionsRequestValidation = {
  params: roleIdParams,
  body: updateRolePermissionsSchema,
} as const;
