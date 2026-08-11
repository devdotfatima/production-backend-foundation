import { Worker, type Job } from 'bullmq';
import type { OutboxEvent } from '@prisma/client';
import { env } from '#app/config/env.js';
import { createRedisConnection } from '#app/lib/redis.js';
import { prisma } from '#app/lib/prisma.js';
import { withoutTenantScope } from '#app/lib/request-context.js';
import type { NotificationProviders } from '#app/modules/notifications/providers.js';
import { processStoredStripeEvent } from '#app/modules/stripe/stripe.webhooks.service.js';
import { deliveryFailureDisposition } from '#app/modules/outbox/outbox.policy.js';
import { appLogger } from '#app/observability/logger.js';
import { captureException } from '#app/observability/sentry.js';
import { recordWorkerJob } from '#app/observability/queue-metrics.js';
import { enforceRateLimit } from '#app/lib/rate-limit.js';
import { outboxQueueNames, type NotificationJobData } from '#app/queues/notification.queue.js';
import { processAccountErasure } from '#app/modules/auth/account-erasure.service.js';
import type { StripeClient } from '#app/modules/stripe/stripe.client.js';
import type { UploadProviderAdapter } from '#app/modules/uploads/uploads.provider.js';
import { processUploadScan } from '#app/modules/uploads/uploads.service.js';
import { hashMetadata, normalizeEmail } from '#app/lib/crypto.js';
import type { ProviderDeliveryResult } from '#app/modules/notifications/providers.js';
import { withSpan, withTraceContext } from '#app/observability/tracing.js';

export interface WorkerRuntimeDependencies {
  stripeClient: StripeClient | null;
  uploadProvider: UploadProviderAdapter | null;
}

function payloadString(payload: unknown, key: string): string | undefined {
  if (!payload || typeof payload !== 'object') return undefined;
  const value = (payload as Record<string, unknown>)[key];
  return typeof value === 'string' && value ? value : undefined;
}

async function recordDeliveryStarted(event: OutboxEvent): Promise<'SEND' | 'ALREADY_RECORDED'> {
  const existing = await prisma.notificationDelivery.findUnique({
    where: { outboxEventId: event.id },
    select: { status: true },
  });
  if (
    existing &&
    ['SENT', 'DELIVERED', 'SUPPRESSED', 'BOUNCED', 'COMPLAINED'].includes(existing.status)
  ) {
    return 'ALREADY_RECORDED';
  }
  const destination = payloadString(event.payload, 'destination');
  await prisma.notificationDelivery.upsert({
    where: { outboxEventId: event.id },
    create: {
      outboxEventId: event.id,
      channel: event.channel,
      userId: payloadString(event.payload, 'userId'),
      organizationId: payloadString(event.payload, 'organizationId'),
      destinationHash: destination ? hashMetadata(normalizeEmail(destination)) : null,
      status: 'PROCESSING',
      attempts: 1,
    },
    update: {
      status: 'PROCESSING',
      attempts: { increment: 1 },
      lastError: null,
    },
  });
  return 'SEND';
}

async function recordDeliveryResult(
  event: OutboxEvent,
  result: ProviderDeliveryResult,
): Promise<void> {
  const sentAt = new Date();
  await prisma.notificationDelivery.update({
    where: { outboxEventId: event.id },
    data: {
      status: result.status === 'suppressed' ? 'SUPPRESSED' : 'SENT',
      provider: result.provider,
      providerMessageId: result.messageId,
      templateKey: result.templateKey,
      sentAt: result.status === 'sent' ? sentAt : null,
      lastError: null,
    },
  });
}

async function recordDeliveryError(event: OutboxEvent, error: unknown): Promise<void> {
  const message = error instanceof Error ? error.message.slice(0, 2_000) : 'Unknown worker error';
  await prisma.notificationDelivery.updateMany({
    where: { outboxEventId: event.id },
    data: { status: 'FAILED', lastError: message },
  });
}

function stripeWebhookEventId(event: OutboxEvent): string | undefined {
  if (event.channel !== 'INTERNAL' || event.eventType !== 'stripe.event_received') return undefined;
  const value = event.payload as { stripeWebhookEventId?: unknown };
  return typeof value.stripeWebhookEventId === 'string' ? value.stripeWebhookEventId : undefined;
}

async function processInternal(
  event: OutboxEvent,
  dependencies: WorkerRuntimeDependencies | undefined,
): Promise<void> {
  if (event.eventType === 'account.erasure.requested') {
    if (!dependencies) throw new Error('Account-erasure worker dependencies are unavailable');
    await processAccountErasure(event.payload, dependencies);
    return;
  }
  if (event.eventType === 'upload.scan.requested') {
    if (!dependencies?.uploadProvider) {
      throw new Error('Upload-scanning worker dependencies are unavailable');
    }
    const uploadId = payloadString(event.payload, 'uploadId');
    if (!uploadId) throw new Error('Missing upload id');
    await processUploadScan(uploadId, dependencies.uploadProvider);
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
  dependencies?: WorkerRuntimeDependencies,
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
      status: { in: ['ENQUEUED', 'FAILED'] },
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
  const deliveryStart = await recordDeliveryStarted(event);
  if (deliveryStart === 'ALREADY_RECORDED') {
    await prisma.outboxEvent.updateMany({
      where: { id: event.id, deliveryGeneration: generation, status: 'PROCESSING' },
      data: {
        status: 'DELIVERED',
        deliveredAt: new Date(),
        failedAt: null,
        deadLetteredAt: null,
        lastError: null,
      },
    });
    return;
  }

  try {
    let delivery: ProviderDeliveryResult;
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
      delivery = await providers.sendEmail(event.eventType, event.payload, {
        deliveryId: event.id,
      });
    } else if (event.channel === 'SMS') {
      await enforceRateLimit('provider-delivery:sms', 'all', env.SMS_HOURLY_SEND_LIMIT, 60 * 60, {
        redisFailureMode: 'deny',
        alertAtRatio: 0.8,
      });
      delivery = await providers.sendSms(event.eventType, event.payload, {
        deliveryId: event.id,
      });
    } else if (event.channel === 'PUSH') {
      delivery = await providers.sendPush(event.payload, { deliveryId: event.id });
    } else {
      await processInternal(event, dependencies);
      delivery = { status: 'sent', provider: 'internal' };
    }

    await recordDeliveryResult(event, delivery);

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
    await recordDeliveryError(event, error);
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

function jobDurationMs(job: Job<NotificationJobData>): number | undefined {
  return job.finishedOn !== undefined && job.processedOn !== undefined
    ? job.finishedOn - job.processedOn
    : undefined;
}

function attachWorkerLogging(worker: Worker<NotificationJobData>, queue: string): void {
  worker.on('completed', (job) => {
    recordWorkerJob(queue, 'succeeded', jobDurationMs(job));
    appLogger.info({ jobId: job.id }, 'Notification job completed');
  });
  worker.on('failed', (job, error) => {
    recordWorkerJob(queue, 'failed', job ? jobDurationMs(job) : undefined);
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
  dependencies?: WorkerRuntimeDependencies,
): Worker<NotificationJobData>[] {
  return env.WORKER_CHANNELS.map((channel) => {
    const name = outboxQueueNames[channel];
    const worker = new Worker<NotificationJobData>(
      name,
      // Jobs are dequeued outside any request, so the tenant is carried by the outbox payload
      // rather than by ambient context.
      (job) =>
        withTraceContext(job.data.traceContext, () =>
          withSpan(
            'outbox.process',
            {
              'messaging.system': 'bullmq',
              'messaging.destination.name': name,
              'messaging.operation.name': 'process',
            },
            () =>
              withoutTenantScope('notification-worker', () =>
                processNotification(job, providers, dependencies),
              ),
          ),
        ),
      {
        connection: createRedisConnection(`${name}-worker`),
        prefix: env.QUEUE_PREFIX,
        concurrency: channelConcurrency[channel](),
        limiter: { max: 100, duration: 1_000 },
      },
    );
    attachWorkerLogging(worker, name);
    return worker;
  });
}
