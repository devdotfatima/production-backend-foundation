import type { Queue } from 'bullmq';
import { Counter, Gauge, Histogram } from 'prom-client';
import { prisma } from '#app/lib/prisma.js';
import { metricsRegistry } from '#app/observability/metrics.js';
import { getJobState } from '#app/scheduler/scheduler.js';
import { scheduledJobs } from '#app/scheduler/scheduler.registry.js';

const workerJobsTotal = new Counter({
  name: 'worker_jobs_total',
  help: 'BullMQ worker attempts by bounded queue name and outcome.',
  labelNames: ['queue', 'outcome'],
  registers: [metricsRegistry],
});

const workerJobDuration = new Histogram({
  name: 'worker_job_duration_seconds',
  help: 'BullMQ worker attempt duration by bounded queue name and outcome.',
  labelNames: ['queue', 'outcome'],
  registers: [metricsRegistry],
  buckets: [0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10, 30, 60],
});

export function recordWorkerJob(
  queue: string,
  outcome: 'succeeded' | 'failed',
  durationMs: number | undefined,
): void {
  const labels = { queue, outcome };
  workerJobsTotal.inc(labels);
  if (durationMs !== undefined && Number.isFinite(durationMs) && durationMs >= 0) {
    workerJobDuration.observe(labels, durationMs / 1_000);
  }
}

/**
 * `queue` is always one of the fixed BullMQ queue names this worker process owns (the outbox
 * channel queues plus the scheduler queue) -- a small set fixed at deploy time, never derived
 * from request input.
 */
export function registerQueueMetrics(queues: Readonly<Record<string, Queue>>): void {
  new Gauge({
    name: 'queue_waiting_jobs',
    help: 'Jobs waiting in each BullMQ queue owned by this worker process.',
    labelNames: ['queue'],
    registers: [metricsRegistry],
    async collect() {
      this.reset();
      await Promise.all(
        Object.entries(queues).map(async ([name, queue]) => {
          this.set({ queue: name }, await queue.getWaitingCount());
        }),
      );
    },
  });

  new Gauge({
    name: 'queue_oldest_waiting_job_age_seconds',
    help: 'Age of the oldest waiting job in each BullMQ queue owned by this worker process.',
    labelNames: ['queue'],
    registers: [metricsRegistry],
    async collect() {
      this.reset();
      const now = Date.now();
      await Promise.all(
        Object.entries(queues).map(async ([name, queue]) => {
          const [oldest] = await queue.getWaiting(0, 0);
          this.set({ queue: name }, oldest ? (now - oldest.timestamp) / 1000 : 0);
        }),
      );
    },
  });
}

/** `channel` is the fixed NotificationChannel enum (EMAIL/SMS/PUSH/INTERNAL), never user input. */
export function registerOutboxMetrics(): void {
  new Gauge({
    name: 'outbox_dead_letter_count',
    help: 'Outbox events currently in DEAD_LETTER status, by channel.',
    labelNames: ['channel'],
    registers: [metricsRegistry],
    async collect() {
      this.reset();
      const rows = await prisma.outboxEvent.groupBy({
        by: ['channel'],
        where: { status: 'DEAD_LETTER' },
        _count: { _all: true },
      });
      for (const row of rows) {
        this.set({ channel: row.channel }, row._count._all);
      }
    },
  });
}

/** Scheduler names come from the static registry, keeping the `job` label bounded. */
export function registerSchedulerMetrics(): void {
  new Gauge({
    name: 'scheduler_last_run_timestamp_seconds',
    help: 'Unix timestamp of the most recent recorded scheduled-job completion.',
    labelNames: ['job'],
    registers: [metricsRegistry],
    async collect() {
      this.reset();
      await Promise.all(
        scheduledJobs.map(async (job) => {
          const state = await getJobState(job.name);
          const timestamp = state ? Date.parse(state.lastRunAt) / 1_000 : 0;
          this.set({ job: job.name }, Number.isFinite(timestamp) ? timestamp : 0);
        }),
      );
    },
  });

  new Gauge({
    name: 'scheduler_last_run_success',
    help: 'Whether the most recently recorded scheduled-job run succeeded (1) or failed (0).',
    labelNames: ['job'],
    registers: [metricsRegistry],
    async collect() {
      this.reset();
      await Promise.all(
        scheduledJobs.map(async (job) => {
          const state = await getJobState(job.name);
          this.set({ job: job.name }, state?.lastStatus === 'success' ? 1 : 0);
        }),
      );
    },
  });
}
