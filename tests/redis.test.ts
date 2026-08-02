import { describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ Redis: vi.fn() }));

vi.mock('ioredis', () => ({ Redis: mocks.Redis }));

import { createRedisConnection } from '../dist/src/lib/redis.js';

describe('Redis connections', () => {
  it('bounds app Redis commands while preserving BullMQ-safe defaults', () => {
    const appCall = mocks.Redis.mock.calls[0] as unknown[];
    const appOptions = appCall[1] as Record<string, unknown>;

    expect(appOptions).toMatchObject({
      maxRetriesPerRequest: 1,
      commandTimeout: 1_000,
    });

    createRedisConnection('queue-test');
    const queueCall = mocks.Redis.mock.calls.at(-1) as unknown[];
    const queueOptions = queueCall[1] as Record<string, unknown>;

    expect(queueOptions).toMatchObject({ maxRetriesPerRequest: null });
  });
});
