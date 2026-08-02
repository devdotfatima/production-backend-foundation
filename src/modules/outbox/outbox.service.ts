import type { NotificationChannel, Prisma } from '@prisma/client';
import { errors } from '#app/lib/errors.js';
import { withAuditedTransaction } from '#app/lib/audited-transaction.js';
import { paginateCursor } from '#app/lib/cursor-pagination.js';
import { prisma } from '#app/lib/prisma.js';
import type { RequestMetadata } from '#app/lib/request-metadata.js';
import { appRedis } from '#app/lib/redis.js';
import { env } from '#app/config/env.js';

export interface OutboxInput {
  aggregateType: string;
  aggregateId: string;
  eventType: string;
  channel: NotificationChannel;
  payload: Prisma.InputJsonValue;
  dedupeKey: string;
  availableAt?: Date;
  expiresAt?: Date;
}

export const OUTBOX_NUDGE_CHANNEL = `${env.QUEUE_PREFIX}:outbox:nudge`;

function scheduleRelayNudge(): void {
  if (env.NODE_ENV === 'test') return;
  setImmediate(() => {
    void appRedis.publish(OUTBOX_NUDGE_CHANNEL, 'available').catch(() => {
      // The durable poll remains the safety net while Redis is unavailable.
    });
  });
}

export async function addOutboxEvent(
  tx: Prisma.TransactionClient,
  input: OutboxInput,
): Promise<void> {
  await tx.outboxEvent.create({
    data: {
      aggregateType: input.aggregateType,
      aggregateId: input.aggregateId,
      eventType: input.eventType,
      channel: input.channel,
      payload: input.payload,
      dedupeKey: input.dedupeKey,
      availableAt: input.availableAt,
      expiresAt: input.expiresAt,
    },
  });
  scheduleRelayNudge();
}

const deadLetterSelect = {
  id: true,
  aggregateType: true,
  aggregateId: true,
  eventType: true,
  channel: true,
  status: true,
  attempts: true,
  deliveryGeneration: true,
  availableAt: true,
  expiresAt: true,
  failedAt: true,
  deadLetteredAt: true,
  lastError: true,
  createdAt: true,
  updatedAt: true,
} as const;

export async function listDeadLetterEvents(input: { cursor?: string; limit: number }) {
  const page = await paginateCursor(input, (pagination) =>
    prisma.outboxEvent.findMany({
      where: { status: 'DEAD_LETTER', deletedAt: null },
      ...pagination,
      orderBy: [{ deadLetteredAt: 'desc' }, { id: 'desc' }],
      select: deadLetterSelect,
    }),
  );
  return { events: page.items, nextCursor: page.nextCursor };
}

export async function redriveDeadLetterEvent(
  id: string,
  actorUserId: string,
  metadata: RequestMetadata,
) {
  return withAuditedTransaction(async (tx, audit) => {
    const existing = await tx.outboxEvent.findFirst({
      where: { id, deletedAt: null },
      select: { id: true, status: true, deliveryGeneration: true, expiresAt: true },
    });
    if (!existing) throw errors.notFound('Outbox event not found');
    if (existing.status !== 'DEAD_LETTER') {
      throw errors.conflict('Only dead-lettered outbox events can be redriven');
    }
    if (existing.expiresAt && existing.expiresAt <= new Date()) {
      throw errors.conflict('Expired outbox events cannot be redriven');
    }

    const reset = await tx.outboxEvent.updateMany({
      where: {
        id,
        status: 'DEAD_LETTER',
        deliveryGeneration: existing.deliveryGeneration,
      },
      data: {
        status: 'PENDING',
        attempts: 0,
        deliveryGeneration: { increment: 1 },
        availableAt: new Date(),
        claimedAt: null,
        claimExpiresAt: null,
        claimToken: null,
        enqueuedAt: null,
        deliveredAt: null,
        failedAt: null,
        deadLetteredAt: null,
        lastError: null,
      },
    });
    if (reset.count !== 1) throw errors.conflict('Outbox event state changed; retry the request');

    await audit({
      actorUserId,
      action: 'outbox.dead_letter.redriven',
      entityType: 'outbox_event',
      entityId: id,
      metadata: { previousGeneration: existing.deliveryGeneration },
      ...metadata,
    });

    return tx.outboxEvent.findUniqueOrThrow({ where: { id }, select: deadLetterSelect });
  });
}
