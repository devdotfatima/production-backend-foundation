import { z } from 'zod';

export const outboxEventIdParams = z.object({ id: z.uuid() });

export const deadLetterListQuery = z.object({
  cursor: z.uuid().optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
});

export const deadLetterListRequestValidation = { query: deadLetterListQuery } as const;
export const redriveOutboxRequestValidation = { params: outboxEventIdParams } as const;
