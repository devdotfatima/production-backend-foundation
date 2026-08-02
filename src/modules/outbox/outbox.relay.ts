import { randomUUID } from 'node:crypto';
import type { OutboxEvent } from '@prisma/client';
import { prisma } from '#app/lib/prisma.js';
import { createRedisConnection } from '#app/lib/redis.js';
import { OUTBOX_NUDGE_CHANNEL } from '#app/modules/outbox/outbox.service.js';
import { outboxJobId } from '#app/modules/outbox/outbox.policy.js';
import { appLogger } from '#app/observability/logger.js';
import type { OutboxQueueMap } from '#app/queues/notification.queue.js';

const OUTBOX_BATCH_SIZE = 100;
const OUTBOX_CLAIM_LEASE_MS = 30_000;
const OUTBOX_RELAY_INTERVAL_MS = 2_000;
const OUTBOX_MAX_BATCHES_PER_TICK = 10;
const OUTBOX_ENQUEUE_RETRY_DELAY_MS = 5_000;

let relayTimer: NodeJS.Timeout | undefined;
let relaySubscriber: ReturnType<typeof createRedisConnection> | undefined;
let relaying = false;

/** Atomically partitions available rows between relay replicas without blocking peers. */
export async function claimOutboxBatch(batchSize = OUTBOX_BATCH_SIZE): Promise<OutboxEvent[]> {
  const now = new Date();
  const claimExpiresAt = new Date(now.getTime() + OUTBOX_CLAIM_LEASE_MS);
  const claimToken = randomUUID();

  return prisma.$transaction(
    (tx) =>
      tx.$queryRaw<OutboxEvent[]>`
      WITH candidates AS (
        SELECT "id"
        FROM "outbox_events"
        WHERE "deletedAt" IS NULL
          AND "availableAt" <= ${now}
          AND ("expiresAt" IS NULL OR "expiresAt" > ${now})
          AND (
            "status" = CAST('PENDING' AS "OutboxStatus")
            OR (
              "status" = CAST('CLAIMED' AS "OutboxStatus")
              AND "claimExpiresAt" <= ${now}
            )
          )
        ORDER BY "createdAt" ASC
        LIMIT ${batchSize}
        FOR UPDATE SKIP LOCKED
      )
      UPDATE "outbox_events" AS event
      SET
        "status" = CAST('CLAIMED' AS "OutboxStatus"),
        "claimedAt" = ${now},
        "claimExpiresAt" = ${claimExpiresAt},
        "claimToken" = CAST(${claimToken} AS UUID),
        "updatedAt" = ${now}
      FROM candidates
      WHERE event."id" = candidates."id"
      RETURNING event.*
    `,
  );
}

async function releaseClaimAfterEnqueueFailure(event: OutboxEvent, error: unknown): Promise<void> {
  const message = error instanceof Error ? error.message.slice(0, 2_000) : 'Unknown enqueue error';
  await prisma.outboxEvent.updateMany({
    where: { id: event.id, status: 'CLAIMED', claimToken: event.claimToken },
    data: {
      status: 'PENDING',
      availableAt: new Date(Date.now() + OUTBOX_ENQUEUE_RETRY_DELAY_MS),
      claimedAt: null,
      claimExpiresAt: null,
      claimToken: null,
      lastError: message,
    },
  });
}

async function enqueueClaimedEvent(event: OutboxEvent, queues: OutboxQueueMap): Promise<void> {
  if (!event.claimToken) throw new Error(`Outbox event ${event.id} is missing its claim token`);

  try {
    await queues[event.channel].add(
      event.channel.toLowerCase(),
      { outboxId: event.id, generation: event.deliveryGeneration },
      { jobId: outboxJobId(event.id, event.deliveryGeneration) },
    );
    await prisma.outboxEvent.updateMany({
      where: { id: event.id, status: 'CLAIMED', claimToken: event.claimToken },
      data: {
        status: 'ENQUEUED',
        enqueuedAt: new Date(),
        claimedAt: null,
        claimExpiresAt: null,
        claimToken: null,
        lastError: null,
      },
    });
  } catch (error) {
    await releaseClaimAfterEnqueueFailure(event, error);
    throw error;
  }
}

export async function relayOutboxBatch(
  queues: OutboxQueueMap,
  batchSize = OUTBOX_BATCH_SIZE,
): Promise<number> {
  const events = await claimOutboxBatch(batchSize);
  const results = await Promise.allSettled(
    events.map((event) => enqueueClaimedEvent(event, queues)),
  );

  for (const [index, result] of results.entries()) {
    if (result.status === 'rejected') {
      appLogger.error(
        { err: result.reason, outboxId: events[index]?.id },
        'Failed to enqueue claimed outbox event',
      );
    }
  }
  return events.length;
}

export async function relayAvailableOutbox(queues: OutboxQueueMap): Promise<number> {
  if (relaying) return 0;
  relaying = true;
  let total = 0;
  try {
    for (let batch = 0; batch < OUTBOX_MAX_BATCHES_PER_TICK; batch += 1) {
      const count = await relayOutboxBatch(queues);
      total += count;
      if (count < OUTBOX_BATCH_SIZE) break;
    }
    return total;
  } finally {
    relaying = false;
  }
}

function scheduleRelay(queues: OutboxQueueMap): void {
  void relayAvailableOutbox(queues).catch((error: unknown) => {
    appLogger.error({ err: error }, 'Outbox relay failed');
  });
}

export function startOutboxRelay(queues: OutboxQueueMap): void {
  if (relayTimer) return;
  scheduleRelay(queues);
  relayTimer = setInterval(() => scheduleRelay(queues), OUTBOX_RELAY_INTERVAL_MS);
  relayTimer.unref();
  relaySubscriber = createRedisConnection('outbox-nudge-subscriber');
  relaySubscriber.on('message', (channel) => {
    if (channel === OUTBOX_NUDGE_CHANNEL) scheduleRelay(queues);
  });
  void relaySubscriber.subscribe(OUTBOX_NUDGE_CHANNEL).catch((error: unknown) => {
    appLogger.warn({ err: error }, 'Outbox instant-nudge subscription is unavailable');
  });
}

export function stopOutboxRelay(): void {
  if (relayTimer) clearInterval(relayTimer);
  relayTimer = undefined;
  relaySubscriber?.disconnect();
  relaySubscriber = undefined;
}
