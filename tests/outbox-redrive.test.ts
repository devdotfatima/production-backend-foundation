import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => {
  const transaction = {
    outboxEvent: {
      findFirst: vi.fn(),
      updateMany: vi.fn(),
      findUniqueOrThrow: vi.fn(),
    },
    auditEvent: { create: vi.fn() },
  };
  return {
    transaction,
    prisma: { $transaction: vi.fn() },
  };
});

vi.mock('#app/lib/prisma.js', () => ({ prisma: mocks.prisma }));
vi.mock('#app/lib/crypto.js', () => ({
  hashMetadata: vi.fn((value: string) => `metadata:${value}`),
}));

import { redriveDeadLetterEvent } from '../dist/src/modules/outbox/outbox.service.js';

describe('dead-letter redrive', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.prisma.$transaction.mockImplementation(
      (callback: (tx: typeof mocks.transaction) => Promise<unknown>) => callback(mocks.transaction),
    );
    mocks.transaction.outboxEvent.findFirst.mockResolvedValue({
      id: 'event-id',
      status: 'DEAD_LETTER',
      deliveryGeneration: 2,
    });
    mocks.transaction.outboxEvent.updateMany.mockResolvedValue({ count: 1 });
    mocks.transaction.outboxEvent.findUniqueOrThrow.mockResolvedValue({
      id: 'event-id',
      status: 'PENDING',
      deliveryGeneration: 3,
    });
    mocks.transaction.auditEvent.create.mockResolvedValue({});
  });

  it('resets delivery state and increments the BullMQ generation atomically', async () => {
    await expect(
      redriveDeadLetterEvent('event-id', 'admin-id', {
        ip: '127.0.0.1',
        requestId: 'request-id',
        userAgent: 'test',
      }),
    ).resolves.toMatchObject({ status: 'PENDING', deliveryGeneration: 3 });

    const reset = mocks.transaction.outboxEvent.updateMany.mock.calls[0]?.[0] as {
      where?: Record<string, unknown>;
      data?: Record<string, unknown>;
    };
    expect(reset.where).toEqual({
      id: 'event-id',
      status: 'DEAD_LETTER',
      deliveryGeneration: 2,
    });
    expect(reset.data).toMatchObject({
      status: 'PENDING',
      attempts: 0,
      deliveryGeneration: { increment: 1 },
      claimToken: null,
      deadLetteredAt: null,
      lastError: null,
    });

    const audit = mocks.transaction.auditEvent.create.mock.calls[0]?.[0] as {
      data?: Record<string, unknown>;
    };
    expect(audit.data).toMatchObject({
      actorUserId: 'admin-id',
      action: 'outbox.dead_letter.redriven',
      entityId: 'event-id',
    });
  });
});
