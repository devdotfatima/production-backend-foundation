import { Queue, Worker, type Job } from 'bullmq';
import { randomUUID } from 'node:crypto';
import { env } from '#app/config/env.js';
import { appRedis, createRedisConnection } from '#app/lib/redis.js';
import { appLogger } from '#app/observability/logger.js';
import { captureException } from '#app/observability/sentry.js';
import { findScheduledJob, scheduledJobs } from '#app/scheduler/scheduler.registry.js';

export const SCHEDULER_QUEUE = 'scheduled-jobs';

export interface JobRunState {
  lastRunAt: string;
  lastDurationMs: number;
  lastStatus: 'success' | 'failure';
  lastError?: string;
}

function stateKey(name: string): string {
  return `${env.QUEUE_PREFIX}:scheduler:state:${name}`;
}

function lockKey(name: string): string {
  return `${env.QUEUE_PREFIX}:scheduler:lock:${name}`;
}

async function releaseLock(name: string, token: string): Promise<void> {
  await appRedis
    .eval(
      "if redis.call('get', KEYS[1]) == ARGV[1] then return redis.call('del', KEYS[1]) else return 0 end",
      1,
      lockKey(name),
      token,
    )
    .catch(() => undefined);
}

/**
 * Recorded so staleness is observable. An unmonitored scheduled job is indistinguishable from a
 * scheduled job that silently stopped running three weeks ago.
 */
async function recordRun(name: string, state: JobRunState): Promise<void> {
  await appRedis.set(stateKey(name), JSON.stringify(state)).catch(() => undefined);
}

export async function getJobState(name: string): Promise<JobRunState | null> {
  const raw = await appRedis.get(stateKey(name)).catch(() => null);
  if (!raw) return null;
  try {
    return JSON.parse(raw) as JobRunState;
  } catch {
    return null;
  }
}

export async function listJobStates() {
  return Promise.all(
    scheduledJobs.map(async (job) => ({
      name: job.name,
      cron: job.cron,
      description: job.description,
      timezone: env.SCHEDULER_TIMEZONE,
      state: await getJobState(job.name),
    })),
  );
}

/** Runs one job with a timeout, recording the outcome either way. */
export async function runScheduledJob(name: string): Promise<Record<string, unknown>> {
  const job = findScheduledJob(name);
  if (!job) throw new Error(`Unknown scheduled job: ${name}`);

  const startedAt = Date.now();
  const lockToken = randomUUID();
  const acquired = await appRedis.set(lockKey(name), lockToken, 'PX', job.timeoutMs + 60_000, 'NX');
  if (acquired !== 'OK') throw new Error(`Scheduled job ${name} is already running`);
  const controller = new AbortController();
  let timer: NodeJS.Timeout | undefined;
  try {
    const result = await Promise.race([
      job.handler(controller.signal),
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => {
          const error = new Error(`Scheduled job ${name} exceeded ${job.timeoutMs}ms`);
          controller.abort(error);
          reject(error);
        }, job.timeoutMs);
      }),
    ]);
    await recordRun(name, {
      lastRunAt: new Date().toISOString(),
      lastDurationMs: Date.now() - startedAt,
      lastStatus: 'success',
    });
    appLogger.info({ job: name, result, metric: 'scheduler.run' }, 'Scheduled job completed');
    return result;
  } catch (error) {
    await recordRun(name, {
      lastRunAt: new Date().toISOString(),
      lastDurationMs: Date.now() - startedAt,
      lastStatus: 'failure',
      lastError: error instanceof Error ? error.message.slice(0, 500) : 'Unknown error',
    });
    appLogger.error({ err: error, job: name, metric: 'scheduler.failure' }, 'Scheduled job failed');
    captureException(error, { subsystem: 'scheduler', job: name });
    throw error;
  } finally {
    if (timer) clearTimeout(timer);
    await releaseLock(name, lockToken);
  }
}

/** Enqueues an on-call run; the HTTP request never executes maintenance work inline. */
export async function enqueueScheduledJob(name: string): Promise<{ jobId: string }> {
  if (!findScheduledJob(name)) throw new Error(`Unknown scheduled job: ${name}`);
  const queue = new Queue(SCHEDULER_QUEUE, {
    connection: createRedisConnection('scheduler-manual-trigger'),
    prefix: env.QUEUE_PREFIX,
  });
  try {
    const queued = await queue.add(
      name,
      { trigger: 'manual' },
      {
        jobId: `manual-${name}-${randomUUID()}`,
        removeOnComplete: 50,
        removeOnFail: 100,
      },
    );
    if (!queued.id) throw new Error('Scheduler queue did not assign a job id');
    return { jobId: queued.id };
  } finally {
    await queue.close();
  }
}

export interface SchedulerHandle {
  queue: Queue;
  worker: Worker;
  close(): Promise<void>;
}

/**
 * Registers repeatable jobs with BullMQ. Job schedulers are keyed by name, so re-registering on
 * every boot is idempotent and several API replicas cannot produce duplicate runs.
 */
export async function startScheduler(): Promise<SchedulerHandle> {
  const queue = new Queue(SCHEDULER_QUEUE, {
    connection: createRedisConnection('scheduler-queue'),
    prefix: env.QUEUE_PREFIX,
  });

  for (const job of scheduledJobs) {
    await queue.upsertJobScheduler(
      job.name,
      { pattern: job.cron, tz: env.SCHEDULER_TIMEZONE },
      { name: job.name, opts: { removeOnComplete: 50, removeOnFail: 100 } },
    );
  }

  // Any scheduler entry no longer in the registry would otherwise keep firing forever.
  const known = new Set(scheduledJobs.map((job) => job.name));
  for (const existing of await queue.getJobSchedulers(0, 100)) {
    if (existing.key && !known.has(existing.key)) await queue.removeJobScheduler(existing.key);
  }

  const worker = new Worker(SCHEDULER_QUEUE, async (job: Job) => runScheduledJob(job.name), {
    connection: createRedisConnection('scheduler-worker'),
    prefix: env.QUEUE_PREFIX,
    concurrency: 1,
  });
  worker.on('error', (error) => appLogger.error({ err: error }, 'Scheduler worker error'));

  appLogger.info(
    { jobs: scheduledJobs.map((job) => job.name), timezone: env.SCHEDULER_TIMEZONE },
    'Scheduled jobs registered',
  );

  return {
    queue,
    worker,
    async close() {
      await worker.close();
      await queue.close();
    },
  };
}
