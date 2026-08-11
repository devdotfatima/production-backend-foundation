import type { NotificationChannel } from '@prisma/client';
import { Queue } from 'bullmq';
import { env } from '#app/config/env.js';
import { createRedisConnection } from '#app/lib/redis.js';
import { OUTBOX_MAX_DELIVERY_ATTEMPTS } from '#app/modules/outbox/outbox.policy.js';

export interface NotificationJobData {
  outboxId: string;
  generation: number;
  /** W3C propagation fields; domain payloads remain tracing-agnostic. */
  traceContext?: Record<string, string>;
}

export const outboxQueueNames = {
  EMAIL: 'notifications-email',
  SMS: 'notifications-sms',
  PUSH: 'notifications-push',
  INTERNAL: 'internal-events',
} as const satisfies Record<NotificationChannel, string>;

export type OutboxQueueMap = Record<NotificationChannel, Queue<NotificationJobData>>;

export function createOutboxQueues(): OutboxQueueMap {
  return Object.fromEntries(
    Object.entries(outboxQueueNames).map(([channel, name]) => [
      channel,
      new Queue<NotificationJobData>(name, {
        connection: createRedisConnection(`${name}-queue`),
        prefix: env.QUEUE_PREFIX,
        defaultJobOptions: {
          attempts: OUTBOX_MAX_DELIVERY_ATTEMPTS,
          backoff: { type: 'exponential', delay: 1_000 },
          removeOnComplete: { count: 5_000, age: 24 * 60 * 60 },
          removeOnFail: { count: 10_000, age: 7 * 24 * 60 * 60 },
        },
      }),
    ]),
  ) as OutboxQueueMap;
}

export async function closeOutboxQueues(queues: OutboxQueueMap): Promise<void> {
  await Promise.all(Object.values(queues).map((queue) => queue.close()));
}
