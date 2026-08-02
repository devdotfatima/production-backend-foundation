import '#app/instrument.js';
import { appRedis } from '#app/lib/redis.js';
import { prisma } from '#app/lib/prisma.js';
import { env } from '#app/config/env.js';
import { createNotificationProviders } from '#app/modules/notifications/providers.js';
import { startOutboxRelay, stopOutboxRelay } from '#app/modules/outbox/outbox.relay.js';
import { appLogger } from '#app/observability/logger.js';
import { flushSentry } from '#app/observability/sentry.js';
import { closeOutboxQueues, createOutboxQueues } from '#app/queues/notification.queue.js';
import { startNotificationWorkers } from '#app/queues/notification.worker.js';

const providers = createNotificationProviders({ config: env, database: prisma, logger: appLogger });
const queues = createOutboxQueues();
const workers = startNotificationWorkers(providers);
startOutboxRelay(queues);
appLogger.info(
  { channels: env.WORKER_CHANNELS },
  'Channel-isolated queue workers and transactional outbox relay started',
);

let shuttingDown = false;
async function shutdown(signal: string): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  appLogger.info({ signal }, 'Shutting down worker');
  stopOutboxRelay();
  await Promise.all(workers.map((worker) => worker.close()));
  await closeOutboxQueues(queues);
  await providers.close();
  await prisma.$disconnect();
  if (appRedis.status === 'wait') appRedis.disconnect();
  else await appRedis.quit();
  await flushSentry();
}

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    void shutdown(signal)
      .then(() => process.exit(0))
      .catch((error: unknown) => {
        appLogger.fatal({ err: error }, 'Worker shutdown failed');
        process.exit(1);
      });
  });
}
