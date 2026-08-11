import type { Server } from 'node:http';
import type { Worker } from 'bullmq';
import { env } from '#app/config/env.js';
import { prisma } from '#app/lib/prisma.js';
import { createNotificationProviders } from '#app/modules/notifications/providers.js';
import type { NotificationProviders } from '#app/modules/notifications/providers.js';
import { startOutboxRelay, stopOutboxRelay } from '#app/modules/outbox/outbox.relay.js';
import { createStripeClient } from '#app/modules/stripe/stripe.client.js';
import type { StripeClient } from '#app/modules/stripe/stripe.client.js';
import { createUploadProvider } from '#app/modules/uploads/uploads.provider.js';
import type { UploadProviderAdapter } from '#app/modules/uploads/uploads.provider.js';
import { appLogger } from '#app/observability/logger.js';
import { startMetricsServer } from '#app/observability/metrics.js';
import {
  registerOutboxMetrics,
  registerQueueMetrics,
  registerSchedulerMetrics,
} from '#app/observability/queue-metrics.js';
import { closeOutboxQueues, createOutboxQueues } from '#app/queues/notification.queue.js';
import type { NotificationJobData, OutboxQueueMap } from '#app/queues/notification.queue.js';
import { startNotificationWorkers } from '#app/queues/notification.worker.js';
import { startScheduler } from '#app/scheduler/scheduler.js';
import type { SchedulerHandle } from '#app/scheduler/scheduler.js';

export interface WorkerModules {
  outbox: boolean;
  scheduler: boolean;
  billing: boolean;
  uploads: boolean;
  metrics: boolean;
}

export const defaultWorkerModules: Readonly<WorkerModules> = {
  outbox: true,
  scheduler: env.SCHEDULER_ENABLED,
  billing: env.BILLING_ENABLED,
  uploads: env.UPLOAD_PROVIDER !== 'disabled',
  metrics: env.METRICS_ENABLED,
};

type NotificationWorker = Worker<NotificationJobData>;

/** Process-level factories are injectable so client projects can replace infrastructure cleanly. */
export interface WorkerDependencies {
  notificationProviders?: NotificationProviders;
  outboxQueues?: OutboxQueueMap;
  stripeClient?: StripeClient | null;
  uploadProvider?: UploadProviderAdapter | null;
  createNotificationProviders?: typeof createNotificationProviders;
  createOutboxQueues?: typeof createOutboxQueues;
  startNotificationWorkers?: typeof startNotificationWorkers;
  startOutboxRelay?: typeof startOutboxRelay;
  stopOutboxRelay?: typeof stopOutboxRelay;
  closeOutboxQueues?: typeof closeOutboxQueues;
  startScheduler?: typeof startScheduler;
  startMetricsServer?: typeof startMetricsServer;
  registerQueueMetrics?: typeof registerQueueMetrics;
  registerOutboxMetrics?: typeof registerOutboxMetrics;
  registerSchedulerMetrics?: typeof registerSchedulerMetrics;
}

export interface BuildWorkerOptions {
  modules?: Partial<WorkerModules>;
  dependencies?: WorkerDependencies;
}

export interface WorkerRuntimeHandle {
  modules: Readonly<WorkerModules>;
  workers: NotificationWorker[];
  queues: OutboxQueueMap | null;
  scheduler: SchedulerHandle | null;
  metricsServer: Server | null;
  close(): Promise<void>;
}

export async function buildWorkerRuntime(
  options: BuildWorkerOptions = {},
): Promise<WorkerRuntimeHandle> {
  const modules = { ...defaultWorkerModules, ...options.modules };
  const dependencies = options.dependencies ?? {};
  const makeProviders = dependencies.createNotificationProviders ?? createNotificationProviders;
  const makeQueues = dependencies.createOutboxQueues ?? createOutboxQueues;
  const startWorkers = dependencies.startNotificationWorkers ?? startNotificationWorkers;
  const beginRelay = dependencies.startOutboxRelay ?? startOutboxRelay;
  const endRelay = dependencies.stopOutboxRelay ?? stopOutboxRelay;
  const closeQueues = dependencies.closeOutboxQueues ?? closeOutboxQueues;
  const beginScheduler = dependencies.startScheduler ?? startScheduler;
  const beginMetrics = dependencies.startMetricsServer ?? startMetricsServer;

  let providers: NotificationProviders | null = null;
  let queues: OutboxQueueMap | null = null;
  let workers: NotificationWorker[] = [];

  if (modules.outbox) {
    providers =
      dependencies.notificationProviders ??
      makeProviders({ config: env, database: prisma, logger: appLogger });
    queues = dependencies.outboxQueues ?? makeQueues();
    const stripeClient = modules.billing
      ? Object.hasOwn(dependencies, 'stripeClient')
        ? (dependencies.stripeClient ?? null)
        : createStripeClient()
      : null;
    const uploadProvider = modules.uploads
      ? Object.hasOwn(dependencies, 'uploadProvider')
        ? (dependencies.uploadProvider ?? null)
        : createUploadProvider(env)
      : null;
    workers = startWorkers(providers, { stripeClient, uploadProvider });
    beginRelay(queues);
  }

  const scheduler = modules.scheduler ? await beginScheduler() : null;
  if (modules.metrics) {
    (dependencies.registerQueueMetrics ?? registerQueueMetrics)({
      ...(queues ?? {}),
      ...(scheduler ? { scheduler: scheduler.queue } : {}),
    });
    if (queues) (dependencies.registerOutboxMetrics ?? registerOutboxMetrics)();
    if (scheduler) (dependencies.registerSchedulerMetrics ?? registerSchedulerMetrics)();
  }
  const metricsServer = modules.metrics ? beginMetrics(env.METRICS_WORKER_PORT) : null;

  return {
    modules,
    workers,
    queues,
    scheduler,
    metricsServer,
    async close() {
      if (queues) endRelay();
      if (scheduler) await scheduler.close();
      await Promise.all(workers.map((worker) => worker.close()));
      if (queues) await closeQueues(queues);
      if (metricsServer) {
        await new Promise<void>((resolve) => metricsServer.close(() => resolve()));
      }
      await providers?.close();
    },
  };
}
