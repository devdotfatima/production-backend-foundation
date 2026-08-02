import '#app/instrument.js';
import { createServer } from 'node:http';
import { buildApp } from '#app/app.js';
import { env } from '#app/config/env.js';
import { appRedis } from '#app/lib/redis.js';
import { prisma } from '#app/lib/prisma.js';
import { appLogger } from '#app/observability/logger.js';
import { flushSentry } from '#app/observability/sentry.js';

const app = buildApp();
const server = createServer(app);

server.listen(env.PORT, env.HOST, () => {
  appLogger.info({ host: env.HOST, port: env.PORT }, 'API server listening');
});

let shuttingDown = false;
async function shutdown(signal: string): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  appLogger.info({ signal }, 'Shutting down API server');

  const forceTimer = setTimeout(() => process.exit(1), 10_000);
  forceTimer.unref();
  server.closeIdleConnections();
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
  await prisma.$disconnect();
  if (appRedis.status === 'wait') appRedis.disconnect();
  else await appRedis.quit();
  await flushSentry();
  clearTimeout(forceTimer);
}

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    void shutdown(signal)
      .then(() => process.exit(0))
      .catch((error: unknown) => {
        appLogger.fatal({ err: error }, 'Graceful shutdown failed');
        process.exit(1);
      });
  });
}

process.on('unhandledRejection', (error) => {
  appLogger.fatal({ err: error }, 'Unhandled promise rejection');
});

process.on('uncaughtException', (error) => {
  appLogger.fatal({ err: error }, 'Uncaught exception');
  void shutdown('uncaughtException').finally(() => process.exit(1));
});
