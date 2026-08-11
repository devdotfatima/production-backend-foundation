import { describe, expect, it, vi } from 'vitest';
import { buildOffsetPagination, paginateOffset } from '#app/lib/offset-pagination.js';

describe('buildOffsetPagination', () => {
  it('derives totalPages and boundary flags from totalItems', () => {
    expect(buildOffsetPagination({ page: 2, pageSize: 10, totalItems: 25 })).toEqual({
      page: 2,
      pageSize: 10,
      totalItems: 25,
      totalPages: 3,
      hasNext: true,
      hasPrevious: true,
    });
  });

  it('reports no next/previous page on an empty result', () => {
    expect(buildOffsetPagination({ page: 1, pageSize: 10, totalItems: 0 })).toEqual({
      page: 1,
      pageSize: 10,
      totalItems: 0,
      totalPages: 0,
      hasNext: false,
      hasPrevious: false,
    });
  });

  it('rejects a non-positive page', () => {
    expect(() => buildOffsetPagination({ page: 0, pageSize: 10, totalItems: 0 })).toThrow(
      /page must be a positive integer/,
    );
  });

  it('rejects a non-positive pageSize', () => {
    expect(() => buildOffsetPagination({ page: 1, pageSize: 0, totalItems: 0 })).toThrow(
      /pageSize must be a positive integer/,
    );
  });
});

describe('paginateOffset', () => {
  it('computes skip from page and pageSize and shapes the response', async () => {
    const fetchPage = vi.fn().mockResolvedValue([{ id: 'a' }, { id: 'b' }]);
    const countTotal = vi.fn().mockResolvedValue(42);

    const result = await paginateOffset({ page: 3, pageSize: 10 }, fetchPage, countTotal);

    expect(fetchPage).toHaveBeenCalledWith({ skip: 20, take: 10 });
    expect(result).toEqual({
      items: [{ id: 'a' }, { id: 'b' }],
      pagination: {
        page: 3,
        pageSize: 10,
        totalItems: 42,
        totalPages: 5,
        hasNext: true,
        hasPrevious: true,
      },
    });
  });

  it('rejects offsets deep enough to make OFFSET/COUNT(*) expensive', async () => {
    const fetchPage = vi.fn();
    const countTotal = vi.fn();

    await expect(
      paginateOffset({ page: 6_000, pageSize: 10 }, fetchPage, countTotal),
    ).rejects.toMatchObject({ statusCode: 400 });
    expect(fetchPage).not.toHaveBeenCalled();
    expect(countTotal).not.toHaveBeenCalled();
  });

  it('rejects a non-integer page before calling either query', async () => {
    const fetchPage = vi.fn();
    const countTotal = vi.fn();

    await expect(
      paginateOffset({ page: 1.5, pageSize: 10 }, fetchPage, countTotal),
    ).rejects.toThrow(/page must be a positive integer/);
    expect(fetchPage).not.toHaveBeenCalled();
  });
});
