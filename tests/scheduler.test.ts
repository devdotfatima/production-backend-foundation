import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  redisSet: vi.fn(),
  redisGet: vi.fn(),
  redisEval: vi.fn(),
  handler: vi.fn(),
  captureException: vi.fn(),
  loggerError: vi.fn(),
}));

vi.mock('#app/config/env.js', () => ({
  env: { QUEUE_PREFIX: 'test', SCHEDULER_TIMEZONE: 'UTC', SCHEDULER_STALE_AFTER_HOURS: 36 },
}));
vi.mock('#app/lib/redis.js', () => ({
  appRedis: { set: mocks.redisSet, get: mocks.redisGet, eval: mocks.redisEval },
  createRedisConnection: () => ({ on: vi.fn(), disconnect: vi.fn() }),
}));
vi.mock('#app/observability/logger.js', () => ({
  appLogger: { info: vi.fn(), warn: vi.fn(), error: mocks.loggerError },
}));
vi.mock('#app/observability/sentry.js', () => ({ captureException: mocks.captureException }));
vi.mock('#app/scheduler/scheduler.registry.js', () => ({
  scheduledJobs: [
    {
      name: 'test-job',
      cron: '0 3 * * *',
      description: 'test',
      timeoutMs: 50,
      handler: mocks.handler,
    },
  ],
  findScheduledJob: (name: string) =>
    name === 'test-job'
      ? {
          name: 'test-job',
          cron: '0 3 * * *',
          description: 'test',
          timeoutMs: 50,
          handler: mocks.handler,
        }
      : undefined,
}));

import { getJobState, listJobStates, runScheduledJob } from '../dist/src/scheduler/scheduler.js';

function lastRecordedState(): Record<string, unknown> {
  const raw = mocks.redisSet.mock.calls.at(-1)?.[1] as string;
  return JSON.parse(raw) as Record<string, unknown>;
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.redisSet.mockResolvedValue('OK');
  mocks.redisGet.mockResolvedValue(null);
  mocks.redisEval.mockResolvedValue(1);
});

describe('running a scheduled job', () => {
  it('records a successful run so staleness is observable', async () => {
    // An unmonitored job is indistinguishable from one that stopped running weeks ago.
    mocks.handler.mockResolvedValue({ deleted: 12 });

    await expect(runScheduledJob('test-job')).resolves.toEqual({ deleted: 12 });

    expect(lastRecordedState()).toMatchObject({ lastStatus: 'success' });
    expect(lastRecordedState().lastRunAt).toEqual(expect.any(String));
  });

  it('records a failure and reports it rather than swallowing it', async () => {
    mocks.handler.mockRejectedValue(new Error('boom'));

    await expect(runScheduledJob('test-job')).rejects.toThrow(/boom/);

    expect(lastRecordedState()).toMatchObject({ lastStatus: 'failure', lastError: 'boom' });
    expect(mocks.captureException).toHaveBeenCalled();
  });

  it('times out a job that hangs instead of blocking the queue forever', async () => {
    mocks.handler.mockImplementation(
      (signal: AbortSignal) =>
        new Promise((_resolve, reject) => {
          signal.addEventListener(
            'abort',
            () => reject(signal.reason instanceof Error ? signal.reason : new Error('Job aborted')),
            { once: true },
          );
        }),
    );

    await expect(runScheduledJob('test-job')).rejects.toThrow(/exceeded 50ms/);
    expect(lastRecordedState()).toMatchObject({ lastStatus: 'failure' });
    expect(mocks.handler.mock.calls.at(-1)?.[0]).toBeInstanceOf(AbortSignal);
  });

  it('rejects overlapping runs using a distributed lease', async () => {
    mocks.redisSet.mockResolvedValueOnce(null);
    await expect(runScheduledJob('test-job')).rejects.toThrow(/already running/);
    expect(mocks.handler).not.toHaveBeenCalled();
  });

  it('refuses an unknown job name', async () => {
    await expect(runScheduledJob('nope')).rejects.toThrow(/Unknown scheduled job/);
  });

  it('truncates a long error rather than storing it whole', async () => {
    mocks.handler.mockRejectedValue(new Error('x'.repeat(2000)));
    await expect(runScheduledJob('test-job')).rejects.toThrow();
    expect(String(lastRecordedState().lastError)).toHaveLength(500);
  });
});

describe('job state', () => {
  it('returns null when a job has never run', async () => {
    await expect(getJobState('test-job')).resolves.toBeNull();
  });

  it('survives a corrupted state record', async () => {
    // A malformed value must not take down the status endpoint.
    mocks.redisGet.mockResolvedValue('not json');
    await expect(getJobState('test-job')).resolves.toBeNull();
  });

  it('lists every registered job with its schedule', async () => {
    const states = await listJobStates();
    expect(states).toEqual([
      expect.objectContaining({ name: 'test-job', cron: '0 3 * * *', timezone: 'UTC' }),
    ]);
  });
});
