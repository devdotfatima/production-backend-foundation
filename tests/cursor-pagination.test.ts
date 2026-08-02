import { describe, expect, it, vi } from 'vitest';
import { paginateCursor } from '#app/lib/cursor-pagination.js';

describe('paginateCursor', () => {
  it('requests one extra item and exposes a next cursor', async () => {
    const fetchPage = vi.fn().mockResolvedValue([{ id: 'one' }, { id: 'two' }, { id: 'three' }]);

    const page = await paginateCursor({ limit: 2 }, fetchPage);

    expect(fetchPage).toHaveBeenCalledWith({ take: 3 });
    expect(page).toEqual({ items: [{ id: 'one' }, { id: 'two' }], nextCursor: 'two' });
  });

  it('applies a Prisma cursor and does not mutate query results', async () => {
    const queryResults = [{ id: 'two' }];
    const fetchPage = vi.fn().mockResolvedValue(queryResults);

    const page = await paginateCursor({ cursor: 'one', limit: 2 }, fetchPage);

    expect(fetchPage).toHaveBeenCalledWith({ take: 3, cursor: { id: 'one' }, skip: 1 });
    expect(page).toEqual({ items: queryResults, nextCursor: null });
    expect(queryResults).toEqual([{ id: 'two' }]);
  });
});
