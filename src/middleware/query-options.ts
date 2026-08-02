import { z } from 'zod';

export function createListQuerySchema<TSort extends readonly [string, ...string[]]>(
  sortFields: TSort,
) {
  return z.object({
    cursor: z.uuid().optional(),
    limit: z.coerce.number().int().min(1).max(100).default(25),
    search: z.string().trim().min(1).max(200).optional(),
    sort: z.enum(sortFields).default(sortFields[0]),
    order: z.enum(['asc', 'desc']).default('desc'),
  });
}

export function textSearch(search: string | undefined, fields: string[]) {
  if (!search) return undefined;
  return {
    OR: fields.map((field) => ({ [field]: { contains: search, mode: 'insensitive' as const } })),
  };
}

export function deterministicOrder(sort: string, order: 'asc' | 'desc') {
  return sort === 'id' ? [{ id: order }] : [{ [sort]: order }, { id: order }];
}
