import '#app/instrument.js';
import { appRedis } from '#app/lib/redis.js';
import { prisma } from '#app/lib/prisma.js';
import { env } from '#app/config/env.js';
import { appLogger } from '#app/observability/logger.js';
import { flushSentry } from '#app/observability/sentry.js';
import { shutdownTracing } from '#app/observability/tracing.js';
import { buildWorkerRuntime } from '#app/runtime/worker-runtime.js';

const runtime = await buildWorkerRuntime();
appLogger.info(
  { channels: env.WORKER_CHANNELS },
  'Channel-isolated queue workers and transactional outbox relay started',
);

let shuttingDown = false;
async function shutdown(signal: string): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  appLogger.info({ signal }, 'Shutting down worker');
  await runtime.close();
  await prisma.$disconnect();
  if (appRedis.status === 'wait') appRedis.disconnect();
  else await appRedis.quit();
  await shutdownTracing();
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
