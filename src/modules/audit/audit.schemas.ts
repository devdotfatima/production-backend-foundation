import { z } from 'zod';

export const auditListQuery = z.object({
  cursor: z.uuid().optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
  actorUserId: z.uuid().optional(),
  entityType: z.string().max(100).optional(),
});

export const auditListRequestValidation = { query: auditListQuery } as const;
