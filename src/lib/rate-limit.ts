import { appRedis } from '#app/lib/redis.js';
import { env } from '#app/config/env.js';
import { errors } from '#app/lib/errors.js';
import { hashMetadata } from '#app/lib/crypto.js';
import { appLogger } from '#app/observability/logger.js';
import { recordRateLimitRejection } from '#app/observability/metrics.js';
import { captureException } from '#app/observability/sentry.js';

const incrementScript = `
local count = redis.call('INCR', KEYS[1])
if count == 1 then redis.call('EXPIRE', KEYS[1], ARGV[1]) end
local ttl = redis.call('TTL', KEYS[1])
return { count, ttl }
`;

const REDIS_ALERT_INTERVAL_MS = 60_000;

export type RateLimitOptions = {
  redisFailureMode?: 'local' | 'deny';
  alertAtRatio?: number;
};

export type RateLimitResult = {
  count: number;
  limit: number;
  retryAfterSeconds: number;
};

type LocalCounter = {
  count: number;
  resetAt: number;
};

export class BoundedRateLimitFallback {
  readonly #entries = new Map<string, LocalCounter>();

  constructor(private readonly maxKeys: number) {
    if (!Number.isInteger(maxKeys) || maxKeys < 1) {
      throw new TypeError('maxKeys must be a positive integer');
    }
  }

  increment(
    key: string,
    windowSeconds: number,
    now = Date.now(),
  ): { count: number; retryAfterSeconds: number } {
    const existing = this.#entries.get(key);
    if (existing && existing.resetAt > now) {
      existing.count += 1;
      return {
        count: existing.count,
        retryAfterSeconds: Math.max(1, Math.ceil((existing.resetAt - now) / 1_000)),
      };
    }
    if (existing) this.#entries.delete(key);

    this.#removeExpired(now);
    while (this.#entries.size >= this.maxKeys) {
      const oldestKey = this.#entries.keys().next().value;
      if (!oldestKey) break;
      this.#entries.delete(oldestKey);
    }

    this.#entries.set(key, { count: 1, resetAt: now + windowSeconds * 1_000 });
    return { count: 1, retryAfterSeconds: windowSeconds };
  }

  delete(key: string): void {
    this.#entries.delete(key);
  }

  get size(): number {
    return this.#entries.size;
  }

  #removeExpired(now: number): void {
    for (const [key, entry] of this.#entries) {
      if (entry.resetAt <= now) this.#entries.delete(key);
    }
  }
}

const localFallback = new BoundedRateLimitFallback(env.RATE_LIMIT_FALLBACK_MAX_KEYS);

function recordRejection(scope: string): void {
  // Counted rather than logged: under a flood, one log line per rejection is itself an outage.
  recordRateLimitRejection(scope);
}

let redisFailureCount = 0;
let redisOutageStartedAt: number | undefined;
let lastRedisAlertAt: number | undefined;

function recordRedisFailure(error: unknown, scope: string, failureMode: 'local' | 'deny'): void {
  const now = Date.now();
  redisFailureCount += 1;
  redisOutageStartedAt ??= now;

  appLogger.warn(
    {
      err: error,
      scope,
      failureMode,
      redisFailureCount,
      localFallbackKeys: localFallback.size,
      metric: 'rate_limit.redis_failure',
    },
    'Redis rate-limit check failed',
  );

  if (lastRedisAlertAt === undefined || now - lastRedisAlertAt >= REDIS_ALERT_INTERVAL_MS) {
    lastRedisAlertAt = now;
    captureException(error, {
      subsystem: 'rate-limit',
      scope,
      failureMode,
      redisFailureCount,
    });
  }
}

function recordRedisRecovery(): void {
  if (redisFailureCount === 0) return;

  appLogger.info(
    {
      redisFailureCount,
      outageDurationMs:
        redisOutageStartedAt === undefined ? undefined : Date.now() - redisOutageStartedAt,
      metric: 'rate_limit.redis_recovered',
    },
    'Redis rate-limit checks recovered',
  );
  redisFailureCount = 0;
  redisOutageStartedAt = undefined;
  lastRedisAlertAt = undefined;
}

export async function enforceRateLimit(
  scope: string,
  value: string,
  limit: number,
  windowSeconds: number,
  options: RateLimitOptions = {},
): Promise<RateLimitResult> {
  const key = `rate:${scope}:${hashMetadata(value)}`;
  let result: [number, number];
  try {
    result = (await appRedis.eval(incrementScript, 1, key, windowSeconds)) as [number, number];
  } catch (error) {
    const failureMode = options.redisFailureMode ?? 'local';
    recordRedisFailure(error, scope, failureMode);
    if (failureMode === 'deny') {
      throw errors.serviceUnavailable('Request protection is temporarily unavailable; try again');
    }

    const fallbackResult = localFallback.increment(key, windowSeconds);
    if (fallbackResult.count > limit) {
      recordRejection(scope);
      throw errors.rateLimited(undefined, fallbackResult.retryAfterSeconds);
    }
    return { ...fallbackResult, limit };
  }

  recordRedisRecovery();
  localFallback.delete(key);

  const count = Number(result[0]);
  const ttl = Number(result[1]);
  const retryAfterSeconds = ttl > 0 ? ttl : windowSeconds;
  if (options.alertAtRatio && count === Math.max(1, Math.ceil(limit * options.alertAtRatio))) {
    appLogger.warn(
      { scope, count, limit, retryAfterSeconds, metric: 'rate_limit.capacity_alert' },
      'Rate-limit capacity alert threshold reached',
    );
  }
  if (count > limit) {
    recordRejection(scope);
    throw errors.rateLimited(undefined, retryAfterSeconds);
  }
  return { count, limit, retryAfterSeconds };
}
