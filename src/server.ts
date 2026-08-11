import '#app/instrument.js';
import { createServer } from 'node:http';
import { buildApp } from '#app/app.js';
import { env } from '#app/config/env.js';
import { appRedis } from '#app/lib/redis.js';
import { prisma } from '#app/lib/prisma.js';
import { createChatGateway } from '#app/modules/chat/chat.gateway.js';
import { appLogger } from '#app/observability/logger.js';
import { flushSentry } from '#app/observability/sentry.js';
import { shutdownTracing } from '#app/observability/tracing.js';
import {
  registerChatConnectionGauge,
  registerChatRoomGauge,
  startMetricsServer,
} from '#app/observability/metrics.js';

const app = buildApp();
const server = createServer(app);
// Shares the HTTP server so websockets and REST use one port and one TLS terminator.
const chatGateway = env.CHAT_ENABLED ? createChatGateway(server) : null;
registerChatConnectionGauge(() => chatGateway?.server.engine.clientsCount ?? 0);
registerChatRoomGauge(
  () =>
    [...(chatGateway?.server.sockets.adapter.rooms.keys() ?? [])].filter((room) =>
      room.includes(':conversation:'),
    ).length,
);
const metricsServer = startMetricsServer(env.METRICS_API_PORT);

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
  // Drained before the HTTP server closes: open sockets otherwise hold the server open until the
  // force timer fires, and clients get a hard reset instead of a reconnect instruction.
  if (chatGateway) await chatGateway.drain();
  server.closeIdleConnections();
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
  if (metricsServer) await new Promise<void>((resolve) => metricsServer.close(() => resolve()));
  await prisma.$disconnect();
  if (appRedis.status === 'wait') appRedis.disconnect();
  else await appRedis.quit();
  await shutdownTracing();
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
