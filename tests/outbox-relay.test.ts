import type { OutboxEvent } from '@prisma/client';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  queryRaw: vi.fn(),
  transaction: vi.fn(),
  updateMany: vi.fn(),
  queueAdd: vi.fn(),
  loggerError: vi.fn(),
}));

vi.mock('#app/lib/prisma.js', () => ({
  prisma: {
    $transaction: mocks.transaction,
    outboxEvent: { updateMany: mocks.updateMany },
  },
}));
vi.mock('#app/observability/logger.js', () => ({
  appLogger: { error: mocks.loggerError },
}));

import { relayOutboxBatch } from '../dist/src/modules/outbox/outbox.relay.js';

const queues = {
  EMAIL: { add: mocks.queueAdd },
  SMS: { add: mocks.queueAdd },
  PUSH: { add: mocks.queueAdd },
  INTERNAL: { add: mocks.queueAdd },
} as never;

function claimedEvent(id: string, generation = 0): OutboxEvent {
  const now = new Date();
  return {
    id,
    aggregateType: 'user',
    aggregateId: 'user-id',
    eventType: 'auth.otp',
    channel: 'EMAIL',
    payload: {},
    traceContext: null,
    dedupeKey: `dedupe-${id}`,
    status: 'CLAIMED',
    attempts: 0,
    deliveryGeneration: generation,
    availableAt: now,
    expiresAt: null,
    claimedAt: now,
    claimExpiresAt: new Date(now.getTime() + 30_000),
    claimToken: '00000000-0000-4000-8000-000000000001',
    enqueuedAt: null,
    deliveredAt: null,
    failedAt: null,
    deadLetteredAt: null,
    lastError: null,
    createdAt: now,
    updatedAt: now,
    deletedAt: null,
  };
}

describe('outbox relay claims', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.transaction.mockImplementation(
      (callback: (tx: { $queryRaw: typeof mocks.queryRaw }) => Promise<unknown>) =>
        callback({ $queryRaw: mocks.queryRaw }),
    );
    mocks.queueAdd.mockResolvedValue({});
    mocks.updateMany.mockResolvedValue({ count: 1 });
  });

  it('uses a non-blocking database claim and enqueues the claimed generation', async () => {
    mocks.queryRaw.mockResolvedValue([claimedEvent('event-1', 2)]);

    await expect(relayOutboxBatch(queues)).resolves.toBe(1);

    const queryParts = mocks.queryRaw.mock.calls[0]?.[0] as readonly string[];
    expect(queryParts.join(' ')).toContain('FOR UPDATE SKIP LOCKED');
    expect(mocks.queueAdd).toHaveBeenCalledWith(
      'email',
      { outboxId: 'event-1', generation: 2 },
      { jobId: 'outbox-event-1-2' },
    );
  });

  it('allows concurrent relay batches to process disjoint claimed rows', async () => {
    mocks.queryRaw
      .mockResolvedValueOnce([claimedEvent('event-1')])
      .mockResolvedValueOnce([claimedEvent('event-2')]);

    await expect(
      Promise.all([relayOutboxBatch(queues), relayOutboxBatch(queues)]),
    ).resolves.toEqual([1, 1]);

    expect(mocks.queueAdd).toHaveBeenCalledTimes(2);
    expect(mocks.queueAdd).toHaveBeenCalledWith(
      'email',
      { outboxId: 'event-1', generation: 0 },
      { jobId: 'outbox-event-1-0' },
    );
    expect(mocks.queueAdd).toHaveBeenCalledWith(
      'email',
      { outboxId: 'event-2', generation: 0 },
      { jobId: 'outbox-event-2-0' },
    );
  });

  it('releases a claim for delayed retry when Redis enqueueing fails', async () => {
    mocks.queryRaw.mockResolvedValue([claimedEvent('event-1')]);
    mocks.queueAdd.mockRejectedValue(new Error('Redis unavailable'));

    await expect(relayOutboxBatch(queues)).resolves.toBe(1);

    const release = mocks.updateMany.mock.calls[0]?.[0] as {
      where?: Record<string, unknown>;
      data?: Record<string, unknown>;
    };
    expect(release.where).toMatchObject({ id: 'event-1', status: 'CLAIMED' });
    expect(release.data).toMatchObject({
      status: 'PENDING',
      claimToken: null,
      lastError: 'Redis unavailable',
    });
    expect(mocks.loggerError).toHaveBeenCalled();
  });
});
