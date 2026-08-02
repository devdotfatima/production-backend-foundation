import { Worker, type Job } from 'bullmq';
import type { OutboxEvent } from '@prisma/client';
import { env } from '#app/config/env.js';
import { createRedisConnection } from '#app/lib/redis.js';
import { prisma } from '#app/lib/prisma.js';
import type { NotificationProviders } from '#app/modules/notifications/providers.js';
import { processStoredStripeEvent } from '#app/modules/stripe/stripe.webhooks.service.js';
import { deliverCustomerWebhook } from '#app/modules/customer-webhooks/customer-webhooks.service.js';
import { deliveryFailureDisposition } from '#app/modules/outbox/outbox.policy.js';
import { appLogger } from '#app/observability/logger.js';
import { captureException } from '#app/observability/sentry.js';
import { enforceRateLimit } from '#app/lib/rate-limit.js';
import { outboxQueueNames, type NotificationJobData } from '#app/queues/notification.queue.js';

function stripeWebhookEventId(event: OutboxEvent): string | undefined {
  if (event.channel !== 'INTERNAL' || event.eventType !== 'stripe.event_received') return undefined;
  const value = event.payload as { stripeWebhookEventId?: unknown };
  return typeof value.stripeWebhookEventId === 'string' ? value.stripeWebhookEventId : undefined;
}

async function processInternal(event: OutboxEvent): Promise<void> {
  if (event.eventType === 'customer.webhook') {
    const value = event.payload as { deliveryId?: unknown };
    if (typeof value.deliveryId !== 'string')
      throw new Error('Missing customer webhook delivery id');
    await deliverCustomerWebhook(value.deliveryId);
    return;
  }
  if (event.eventType !== 'stripe.event_received')
    throw new Error(`Unsupported internal event: ${event.eventType}`);
  const webhookEventId = stripeWebhookEventId(event);
  if (!webhookEventId) throw new Error('Missing Stripe event id');

  await prisma.stripeWebhookEvent.update({
    where: { id: webhookEventId },
    data: { status: 'PROCESSING', lastError: null },
  });
  await processStoredStripeEvent(webhookEventId);
}

async function recordDeliveryFailure(
  event: OutboxEvent,
  generation: number,
  error: unknown,
  disposition: 'RETRY' | 'DEAD_LETTER',
): Promise<boolean> {
  const now = new Date();
  const message = error instanceof Error ? error.message.slice(0, 2_000) : 'Unknown worker error';
  const webhookEventId = stripeWebhookEventId(event);

  const recorded = await prisma.$transaction(async (tx) => {
    const updated = await tx.outboxEvent.updateMany({
      where: {
        id: event.id,
        deliveryGeneration: generation,
        status: { notIn: ['DELIVERED', 'DEAD_LETTER'] },
      },
      data: {
        status: disposition === 'DEAD_LETTER' ? 'DEAD_LETTER' : 'ENQUEUED',
        failedAt: disposition === 'DEAD_LETTER' ? now : null,
        deadLetteredAt: disposition === 'DEAD_LETTER' ? now : null,
        lastError: message,
      },
    });
    if (updated.count !== 1) return false;

    if (webhookEventId) {
      await tx.stripeWebhookEvent.updateMany({
        where: { id: webhookEventId },
        data: { status: 'FAILED', lastError: message },
      });
    }
    return true;
  });

  if (recorded && disposition === 'DEAD_LETTER') {
    appLogger.error(
      { err: error, outboxId: event.id, eventType: event.eventType, generation },
      'Outbox event moved to dead letter',
    );
    captureException(error, {
      outboxId: event.id,
      eventType: event.eventType,
      deliveryGeneration: generation,
    });
  }
  return recorded;
}

async function reconcileExhaustedJob(job: Job<NotificationJobData>, error: Error): Promise<void> {
  const configuredAttempts = typeof job.opts.attempts === 'number' ? job.opts.attempts : 1;
  const exhaustedAttempts = job.attemptsMade >= Math.max(1, configuredAttempts);
  const exhaustedStalls = /stalled more than/i.test(error.message);
  if (!exhaustedAttempts && !exhaustedStalls) return;

  const generation = Number.isInteger(job.data.generation) ? job.data.generation : 0;
  const event = await prisma.outboxEvent.findUnique({ where: { id: job.data.outboxId } });
  if (
    !event ||
    event.deletedAt ||
    event.status === 'DELIVERED' ||
    event.status === 'DEAD_LETTER' ||
    event.deliveryGeneration !== generation
  ) {
    return;
  }
  await recordDeliveryFailure(event, generation, error, 'DEAD_LETTER');
}

export async function processNotification(
  job: Job<NotificationJobData>,
  providers: NotificationProviders,
): Promise<void> {
  const generation = Number.isInteger(job.data.generation) ? job.data.generation : 0;
  const event = await prisma.outboxEvent.findUnique({ where: { id: job.data.outboxId } });
  if (
    !event ||
    event.deletedAt ||
    event.status === 'DELIVERED' ||
    event.status === 'DEAD_LETTER' ||
    event.deliveryGeneration !== generation
  ) {
    return;
  }
  if (event.expiresAt && event.expiresAt <= new Date()) {
    await prisma.outboxEvent.updateMany({
      where: { id: event.id, deliveryGeneration: generation, status: { not: 'DELIVERED' } },
      data: {
        status: 'DEAD_LETTER',
        failedAt: new Date(),
        deadLetteredAt: new Date(),
        lastError: 'Business expiry elapsed before delivery',
      },
    });
    return;
  }

  const started = await prisma.outboxEvent.updateMany({
    where: {
      id: event.id,
      deliveryGeneration: generation,
      status: { notIn: ['DELIVERED', 'DEAD_LETTER'] },
    },
    data: {
      status: 'PROCESSING',
      attempts: { increment: 1 },
      claimedAt: null,
      claimExpiresAt: null,
      claimToken: null,
    },
  });
  if (started.count !== 1) return;

  try {
    if (event.channel === 'EMAIL') {
      await enforceRateLimit(
        'provider-delivery:email',
        'all',
        env.EMAIL_HOURLY_SEND_LIMIT,
        60 * 60,
        {
          redisFailureMode: 'deny',
          alertAtRatio: 0.8,
        },
      );
      await providers.sendEmail(event.eventType, event.payload);
    } else if (event.channel === 'SMS') {
      await enforceRateLimit('provider-delivery:sms', 'all', env.SMS_HOURLY_SEND_LIMIT, 60 * 60, {
        redisFailureMode: 'deny',
        alertAtRatio: 0.8,
      });
      await providers.sendSms(event.eventType, event.payload);
    } else if (event.channel === 'PUSH') await providers.sendPush(event.payload);
    else await processInternal(event);

    const delivered = await prisma.outboxEvent.updateMany({
      where: { id: event.id, deliveryGeneration: generation, status: 'PROCESSING' },
      data: {
        status: 'DELIVERED',
        deliveredAt: new Date(),
        failedAt: null,
        deadLetteredAt: null,
        lastError: null,
      },
    });
    if (delivered.count !== 1) throw new Error('Outbox delivery state changed unexpectedly');
  } catch (error) {
    const configuredAttempts =
      typeof job.opts.attempts === 'number' ? job.opts.attempts : undefined;
    const disposition = deliveryFailureDisposition(job.attemptsMade, configuredAttempts);
    await recordDeliveryFailure(event, generation, error, disposition);
    throw error;
  }
}

const channelConcurrency = {
  EMAIL: () => env.EMAIL_WORKER_CONCURRENCY,
  SMS: () => env.SMS_WORKER_CONCURRENCY,
  PUSH: () => env.PUSH_WORKER_CONCURRENCY,
  INTERNAL: () => env.INTERNAL_WORKER_CONCURRENCY,
} as const;

function attachWorkerLogging(worker: Worker<NotificationJobData>): void {
  worker.on('completed', (job) => appLogger.info({ jobId: job.id }, 'Notification job completed'));
  worker.on('failed', (job, error) => {
    appLogger.error({ jobId: job?.id, err: error }, 'Notification worker attempt failed');
    if (job) {
      void reconcileExhaustedJob(job, error).catch((reconciliationError: unknown) => {
        appLogger.error(
          { err: reconciliationError, jobId: job.id },
          'Failed to reconcile exhausted outbox job',
        );
        captureException(reconciliationError, { jobId: job.id, outboxId: job.data.outboxId });
      });
    }
  });
  worker.on('error', (error) => appLogger.error({ err: error }, 'Notification worker error'));
}

export function startNotificationWorkers(
  providers: NotificationProviders,
): Worker<NotificationJobData>[] {
  return env.WORKER_CHANNELS.map((channel) => {
    const name = outboxQueueNames[channel];
    const worker = new Worker<NotificationJobData>(
      name,
      (job) => processNotification(job, providers),
      {
        connection: createRedisConnection(`${name}-worker`),
        prefix: env.QUEUE_PREFIX,
        concurrency: channelConcurrency[channel](),
        limiter: { max: 100, duration: 1_000 },
      },
    );
    attachWorkerLogging(worker);
    return worker;
  });
}
