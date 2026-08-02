export interface CursorPaginationInput {
  cursor?: string;
  limit: number;
}

export interface CursorPaginationQuery {
  take: number;
  cursor?: { id: string };
  skip?: number;
}

export interface CursorPage<TItem> {
  items: TItem[];
  nextCursor: string | null;
}

/**
 * Applies the shared `limit + 1` cursor-pagination contract to a Prisma query.
 *
 * Callers remain responsible for a deterministic order whose final tie-breaker
 * is `id`, so the returned item id is safe to use as the next cursor.
 */
export async function paginateCursor<TItem extends { id: string }>(
  input: CursorPaginationInput,
  fetchPage: (query: CursorPaginationQuery) => Promise<TItem[]>,
): Promise<CursorPage<TItem>> {
  const items = await fetchPage({
    take: input.limit + 1,
    ...(input.cursor ? { cursor: { id: input.cursor }, skip: 1 } : {}),
  });
  const hasMore = items.length > input.limit;
  const pageItems = hasMore ? items.slice(0, input.limit) : items;

  return {
    items: pageItems,
    nextCursor: hasMore ? (pageItems.at(-1)?.id ?? null) : null,
  };
}
