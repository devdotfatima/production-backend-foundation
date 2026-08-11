import { Prisma } from '@prisma/client';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const idempotencyRecord = vi.hoisted(() => ({
  findFirst: vi.fn(),
  deleteMany: vi.fn(),
  create: vi.fn(),
  update: vi.fn(),
  updateMany: vi.fn(),
}));

vi.mock('#app/lib/prisma.js', () => ({ prisma: { idempotencyRecord } }));

import { canonicalizeIdempotencyInput, runIdempotent } from '../dist/src/lib/idempotency.js';

describe('durable idempotency', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    idempotencyRecord.findFirst.mockResolvedValue(null);
    idempotencyRecord.create.mockResolvedValue({ id: 'record-1' });
    idempotencyRecord.update.mockResolvedValue({});
    idempotencyRecord.updateMany.mockResolvedValue({ count: 1 });
    idempotencyRecord.deleteMany.mockResolvedValue({ count: 1 });
  });

  it('uses a stable fingerprint independent of object key order', () => {
    expect(canonicalizeIdempotencyInput({ b: 2, a: { d: 4, c: 3 } })).toBe(
      canonicalizeIdempotencyInput({ a: { c: 3, d: 4 }, b: 2 }),
    );
    expect(canonicalizeIdempotencyInput({ value: 1 })).not.toBe(
      canonicalizeIdempotencyInput({ value: 2 }),
    );
  });

  it('encrypts replay payloads and returns the stored response without rerunning the operation', async () => {
    const operation = vi.fn().mockResolvedValue({
      statusCode: 201,
      response: { secret: 'one-time-secret', id: 'resource-1' },
    });
    const first = await runIdempotent({
      actorKey: 'user:1',
      scope: 'keys.create',
      key: 'operation-123',
      request: { name: 'CI' },
      operation,
    });
    expect(first.replayed).toBe(false);

    const createCall: unknown = idempotencyRecord.create.mock.calls[0]?.[0];
    const updateCall: unknown = idempotencyRecord.updateMany.mock.calls[0]?.[0];
    const createData = (
      createCall as {
        data: { actorKey: string; scope: string; keyHash: string; requestHash: string };
      }
    ).data;
    const updateData = (
      updateCall as { data: { statusCode: number; response: Record<string, unknown> } }
    ).data;
    expect(JSON.stringify(updateData.response)).not.toContain('one-time-secret');
    idempotencyRecord.findFirst.mockResolvedValueOnce({
      id: 'record-1',
      ...createData,
      ...updateData,
      expiresAt: new Date(Date.now() + 60_000),
    });

    const replayOperation = vi.fn();
    const replay = await runIdempotent({
      actorKey: 'user:1',
      scope: 'keys.create',
      key: 'operation-123',
      request: { name: 'CI' },
      operation: replayOperation,
    });
    expect(replay).toEqual({
      statusCode: 201,
      response: { secret: 'one-time-secret', id: 'resource-1' },
      replayed: true,
    });
    expect(replayOperation).not.toHaveBeenCalled();
  });

  it('releases an unfinished operation lease without forgetting its fingerprint', async () => {
    await expect(
      runIdempotent({
        actorKey: 'user:1',
        scope: 'webhooks.create',
        key: 'operation-456',
        request: { url: 'https://example.com/hook' },
        operation: async () => {
          throw new Error('temporary failure');
        },
      }),
    ).rejects.toThrow('temporary failure');
    expect(idempotencyRecord.deleteMany).not.toHaveBeenCalled();
    const release = idempotencyRecord.updateMany.mock.calls.at(-1)?.[0] as unknown as {
      where: { id: string; statusCode: number | null };
      data: { lockToken: string | null };
    };
    expect(release.where).toMatchObject({ id: 'record-1', statusCode: null });
    expect(release.data).toMatchObject({ lockToken: null });
  });

  it('turns a concurrent unique-key loser into an in-progress conflict', async () => {
    idempotencyRecord.create.mockRejectedValueOnce(
      new Prisma.PrismaClientKnownRequestError('duplicate idempotency key', {
        code: 'P2002',
        clientVersion: '6.19.3',
      }),
    );

    await expect(
      runIdempotent({
        actorKey: 'user:1',
        scope: 'webhooks.create',
        key: 'operation-789',
        request: { url: 'https://example.com/hook' },
        operation: vi.fn(),
      }),
    ).rejects.toMatchObject({ statusCode: 409 });
  });
});
