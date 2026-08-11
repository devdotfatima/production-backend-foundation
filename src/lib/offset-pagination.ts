import { errors } from '#app/lib/errors.js';

export interface OffsetPaginationInput {
  page: number;
  pageSize: number;
}

export interface OffsetPagination {
  page: number;
  pageSize: number;
  totalItems: number;
  totalPages: number;
  hasNext: boolean;
  hasPrevious: boolean;
}

export interface OffsetPage<TItem> {
  items: TItem[];
  pagination: OffsetPagination;
}

/** Beyond this row offset, `OFFSET`/`COUNT(*)` scans get expensive; use cursor pagination instead. */
const MAX_OFFSET_ROWS = 50_000;

function assertValidInput(input: OffsetPaginationInput): void {
  if (!Number.isInteger(input.page) || input.page < 1) {
    throw new TypeError('page must be a positive integer');
  }
  if (!Number.isInteger(input.pageSize) || input.pageSize < 1) {
    throw new TypeError('pageSize must be a positive integer');
  }
}

export function buildOffsetPagination(
  input: OffsetPaginationInput & { totalItems: number },
): OffsetPagination {
  assertValidInput(input);
  const { page, pageSize, totalItems } = input;
  const totalPages = totalItems === 0 ? 0 : Math.ceil(totalItems / pageSize);

  return {
    page,
    pageSize,
    totalItems,
    totalPages,
    hasNext: page < totalPages,
    hasPrevious: page > 1 && totalItems > 0,
  };
}

/**
 * Applies the shared offset-pagination contract: validates `page`/`pageSize`, rejects
 * pages deep enough to make `OFFSET`/`COUNT(*)` an expensive scan, runs the page fetch
 * and total count together, and shapes the result.
 *
 * `fetchPage` and `countTotal` must read the same snapshot when the two must not drift
 * from each other — bind both to the same `prisma.$transaction([...])` call rather than
 * invoking this against two independent reads.
 */
export async function paginateOffset<TItem>(
  input: OffsetPaginationInput,
  fetchPage: (args: { skip: number; take: number }) => Promise<TItem[]>,
  countTotal: () => Promise<number>,
): Promise<OffsetPage<TItem>> {
  assertValidInput(input);
  const { page, pageSize } = input;
  const skip = (page - 1) * pageSize;
  if (skip > MAX_OFFSET_ROWS) {
    throw errors.badRequest(
      `Page ${page} is beyond the maximum offset depth; use cursor pagination for deeper results`,
    );
  }

  const [items, totalItems] = await Promise.all([
    fetchPage({ skip, take: pageSize }),
    countTotal(),
  ]);
  return { items, pagination: buildOffsetPagination({ page, pageSize, totalItems }) };
}
