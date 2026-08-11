import type { OutboxEvent } from '@prisma/client';
import type { Job } from 'bullmq';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { NotificationJobData } from '../src/queues/notification.queue.js';

const mocks = vi.hoisted(() => {
  const transaction = {
    outboxEvent: { updateMany: vi.fn() },
    stripeWebhookEvent: { updateMany: vi.fn() },
  };
  return {
    transaction,
    prisma: {
      outboxEvent: { findUnique: vi.fn(), updateMany: vi.fn() },
      stripeWebhookEvent: { update: vi.fn() },
      notificationDelivery: {
        findUnique: vi.fn(),
        upsert: vi.fn(),
        update: vi.fn(),
        updateMany: vi.fn(),
      },
      $transaction: vi.fn(),
    },
    sendEmail: vi.fn(),
    sendSms: vi.fn(),
    sendPush: vi.fn(),
    loggerError: vi.fn(),
    captureException: vi.fn(),
  };
});

vi.mock('#app/lib/prisma.js', () => ({
  prisma: mocks.prisma,
  getConfiguredPoolSize: () => undefined,
}));
vi.mock('#app/lib/rate-limit.js', () => ({ enforceRateLimit: vi.fn() }));
vi.mock('#app/observability/logger.js', () => ({
  appLogger: { info: vi.fn(), error: mocks.loggerError },
}));
vi.mock('#app/observability/sentry.js', () => ({
  captureException: mocks.captureException,
}));

import { processNotification } from '../dist/src/queues/notification.worker.js';

const providers = {
  sendEmail: mocks.sendEmail,
  sendSms: mocks.sendSms,
  sendPush: mocks.sendPush,
  close: vi.fn(),
};

function outboxEvent(): OutboxEvent {
  const now = new Date();
  return {
    id: 'event-id',
    aggregateType: 'user',
    aggregateId: 'user-id',
    eventType: 'auth.otp',
    channel: 'EMAIL',
    payload: {},
    traceContext: null,
    dedupeKey: 'dedupe-key',
    status: 'ENQUEUED',
    attempts: 0,
    deliveryGeneration: 0,
    availableAt: now,
    expiresAt: null,
    claimedAt: null,
    claimExpiresAt: null,
    claimToken: null,
    enqueuedAt: now,
    deliveredAt: null,
    failedAt: null,
    deadLetteredAt: null,
    lastError: null,
    createdAt: now,
    updatedAt: now,
    deletedAt: null,
  };
}

function job(attemptsMade: number): Job<NotificationJobData> {
  return {
    data: { outboxId: 'event-id', generation: 0 },
    opts: { attempts: 5 },
    attemptsMade,
  } as Job<NotificationJobData>;
}

describe('notification worker delivery states', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.prisma.outboxEvent.findUnique.mockResolvedValue(outboxEvent());
    mocks.prisma.outboxEvent.updateMany.mockResolvedValue({ count: 1 });
    mocks.prisma.notificationDelivery.upsert.mockResolvedValue({});
    mocks.prisma.notificationDelivery.findUnique.mockResolvedValue(null);
    mocks.prisma.notificationDelivery.update.mockResolvedValue({});
    mocks.prisma.notificationDelivery.updateMany.mockResolvedValue({ count: 1 });
    mocks.transaction.outboxEvent.updateMany.mockResolvedValue({ count: 1 });
    mocks.prisma.$transaction.mockImplementation(
      (callback: (tx: typeof mocks.transaction) => Promise<unknown>) => callback(mocks.transaction),
    );
  });

  it('returns transient failures to BullMQ without making them relay candidates', async () => {
    mocks.sendEmail.mockRejectedValue(new Error('Temporary provider error'));

    await expect(processNotification(job(0), providers)).rejects.toThrow(
      'Temporary provider error',
    );

    const failureUpdate = mocks.transaction.outboxEvent.updateMany.mock.calls[0]?.[0] as {
      data?: Record<string, unknown>;
    };
    expect(failureUpdate.data).toMatchObject({
      status: 'ENQUEUED',
      deadLetteredAt: null,
      lastError: 'Temporary provider error',
    });
    expect(mocks.captureException).not.toHaveBeenCalled();
  });

  it('durably dead-letters the final failed attempt and reports it', async () => {
    mocks.sendEmail.mockRejectedValue(new Error('Permanent provider error'));

    await expect(processNotification(job(4), providers)).rejects.toThrow(
      'Permanent provider error',
    );

    const failureUpdate = mocks.transaction.outboxEvent.updateMany.mock.calls[0]?.[0] as {
      data?: Record<string, unknown>;
    };
    expect(failureUpdate.data?.status).toBe('DEAD_LETTER');
    expect(failureUpdate.data?.deadLetteredAt).toBeInstanceOf(Date);
    expect(mocks.captureException).toHaveBeenCalledWith(
      expect.any(Error),
      expect.objectContaining({ outboxId: 'event-id', deliveryGeneration: 0 }),
    );
  });

  it('marks a successful delivery exactly once for the current generation', async () => {
    mocks.sendEmail.mockResolvedValue({
      status: 'sent',
      provider: 'test',
      messageId: 'message-1',
      templateKey: 'auth-verification-otp',
    });

    await expect(processNotification(job(0), providers)).resolves.toBeUndefined();

    expect(mocks.prisma.outboxEvent.updateMany).toHaveBeenCalledTimes(2);
    const deliveredUpdate = mocks.prisma.outboxEvent.updateMany.mock.calls[1]?.[0] as {
      where?: Record<string, unknown>;
      data?: Record<string, unknown>;
    };
    expect(deliveredUpdate.where).toMatchObject({
      id: 'event-id',
      deliveryGeneration: 0,
      status: 'PROCESSING',
    });
    expect(deliveredUpdate.data?.status).toBe('DELIVERED');
    expect(mocks.sendEmail).toHaveBeenCalledWith('auth.otp', {}, { deliveryId: 'event-id' });
  });

  it('finishes the outbox without resending when provider success was already recorded', async () => {
    mocks.prisma.notificationDelivery.findUnique.mockResolvedValue({ status: 'SENT' });

    await expect(processNotification(job(0), providers)).resolves.toBeUndefined();

    expect(mocks.sendEmail).not.toHaveBeenCalled();
    const update = mocks.prisma.outboxEvent.updateMany.mock.calls.at(-1)?.[0] as unknown as {
      data: { status: string };
    };
    expect(update.data.status).toBe('DELIVERED');
  });
});
