import { Redis, type RedisOptions } from 'ioredis';
import { env } from '#app/config/env.js';

export function createRedisConnection(
  name: string,
  options: Omit<RedisOptions, 'connectionName'> = {},
): Redis {
  return new Redis(env.REDIS_URL, {
    enableReadyCheck: true,
    maxRetriesPerRequest: null,
    lazyConnect: true,
    ...options,
    connectionName: `${env.QUEUE_PREFIX}:${name}`,
  });
}

// Request-scoped rate limiting must reject promptly when Redis is unhealthy.
// Queue connections keep the shared BullMQ-safe null retry setting above.
export const appRedis = createRedisConnection('app', {
  commandTimeout: 1_000,
  maxRetriesPerRequest: 1,
});
