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

export const createRoleRequestValidation = { body: roleSchema } as const;
export const assignRoleRequestValidation = { body: assignmentSchema } as const;
