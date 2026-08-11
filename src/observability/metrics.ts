import { timingSafeEqual } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import { collectDefaultMetrics, Counter, Gauge, Registry } from 'prom-client';
import { env } from '#app/config/env.js';
import { getConfiguredPoolSize, getInFlightQueryCount } from '#app/lib/prisma.js';
import { appLogger } from '#app/observability/logger.js';

/**
 * One registry per process. The API and worker processes each run their own instance of this
 * module (separate Node processes), so there is exactly one Registry per process -- no
 * cross-process aggregation happens here; that is Prometheus's job at scrape time.
 */
export const metricsRegistry = new Registry();

collectDefaultMetrics({ register: metricsRegistry });

new Gauge({
  name: 'db_model_queries_in_flight',
  help: 'Prisma model operations currently in flight in this process; this is not pool usage.',
  registers: [metricsRegistry],
  collect() {
    this.set(getInFlightQueryCount());
  },
});

const configuredPoolSize = getConfiguredPoolSize();
if (configuredPoolSize !== undefined) {
  new Gauge({
    name: 'db_configured_connection_limit',
    help: 'Configured Prisma connection_limit for this process; this is not live pool capacity.',
    registers: [metricsRegistry],
  }).set(configuredPoolSize);
}

const rateLimitRejectionsTotal = new Counter({
  name: 'rate_limit_rejections_total',
  help: 'Total rate-limit rejections in this process, by fixed call-site scope.',
  labelNames: ['scope'],
  registers: [metricsRegistry],
});

const chatMessagesTotal = new Counter({
  name: 'chat_messages_total',
  help: 'Committed chat messages broadcast by this process.',
  registers: [metricsRegistry],
});

export function recordChatMessage(): void {
  chatMessagesTotal.inc();
}

/** `scope` is a bounded, deploy-time call-site value, never request input. */
export function recordRateLimitRejection(scope: string): void {
  rateLimitRejectionsTotal.inc({ scope });
}

/**
 * Registered unconditionally so the metric always exists in a scrape (reads 0 when chat is
 * disabled or this process is the worker) rather than appearing and disappearing with the flag.
 */
export function registerChatConnectionGauge(getConnectionCount: () => number): void {
  new Gauge({
    name: 'chat_connections_current',
    help: 'Live socket.io connections held by this process.',
    registers: [metricsRegistry],
    collect() {
      this.set(getConnectionCount());
    },
  });
}

export function registerChatRoomGauge(getRoomCount: () => number): void {
  new Gauge({
    name: 'chat_conversation_rooms_current',
    help: 'Conversation rooms currently held by this process.',
    registers: [metricsRegistry],
    collect() {
      this.set(getRoomCount());
    },
  });
}

function authorized(authorization: string | undefined): boolean {
  if (!env.METRICS_BEARER_TOKEN) return true;
  const expected = Buffer.from(`Bearer ${env.METRICS_BEARER_TOKEN}`);
  const actual = Buffer.from(authorization ?? '');
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

export function startMetricsServer(port: number): Server | null {
  if (!env.METRICS_ENABLED) return null;

  const server = createServer((request, response) => {
    if (request.method !== 'GET' || request.url !== '/metrics') {
      response.writeHead(404).end();
      return;
    }
    if (!authorized(request.headers.authorization)) {
      response.writeHead(401, { 'WWW-Authenticate': 'Bearer' }).end();
      return;
    }
    metricsRegistry
      .metrics()
      .then((body) => {
        response.writeHead(200, { 'Content-Type': metricsRegistry.contentType });
        response.end(body);
      })
      .catch((error: unknown) => {
        appLogger.error({ err: error }, 'Failed to collect metrics');
        if (!response.headersSent) response.writeHead(500);
        response.end();
      });
  });

  server.listen(port, env.METRICS_HOST, () => {
    appLogger.info({ host: env.METRICS_HOST, port }, 'Metrics server listening');
  });
  return server;
}
