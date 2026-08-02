import { z } from 'zod';

export const createUploadSchema = z.object({
  filename: z.string().trim().min(1).max(255),
  contentType: z.string().trim().toLowerCase().min(3).max(255),
  size: z.coerce.number().int().positive(),
  visibility: z.enum(['PRIVATE', 'PUBLIC']).default('PRIVATE'),
});

export const uploadIdParams = z.object({ uploadId: z.uuid() });

export const uploadsListQuery = z.object({
  cursor: z.uuid().optional(),
  limit: z.coerce.number().int().min(1).max(100).default(25),
});

export const createUploadRequestValidation = { body: createUploadSchema } as const;
export const uploadIdRequestValidation = { params: uploadIdParams } as const;
export const uploadsListRequestValidation = { query: uploadsListQuery } as const;
