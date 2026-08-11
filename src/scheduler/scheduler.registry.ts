import { env } from '#app/config/env.js';
import { prisma } from '#app/lib/prisma.js';
import { withoutTenantScope } from '#app/lib/request-context.js';
import { runRetentionCleanup } from '#app/maintenance/retention.js';
import { expirePendingUploads } from '#app/maintenance/upload-cleanup.js';
import { verifyAuditIntegrity } from '#app/maintenance/audit-verify.job.js';
import { createUploadProvider } from '#app/modules/uploads/uploads.provider.js';

export interface ScheduledJob {
  name: string;
  /** Standard five-field cron expression, interpreted in `SCHEDULER_TIMEZONE`. */
  cron: string;
  description: string;
  timeoutMs: number;
  handler: (signal: AbortSignal) => Promise<Record<string, unknown>>;
}

/**
 * Scheduled work lives here rather than in a deployment's crontab, so a client project gets the
 * schedule by cloning the template instead of by remembering to configure it. The standalone
 * `maintenance:*` entrypoints still exist for serverless deploys that prefer external cron —
 * both paths call the same handlers.
 */
export const scheduledJobs: ScheduledJob[] = [
  {
    name: 'retention-cleanup',
    cron: '15 3 * * *',
    description: 'Delete expired operational data and abandoned uploads.',
    timeoutMs: 10 * 60_000,
    handler: (signal) =>
      withoutTenantScope('retention-cleanup', async () => {
        const expiredUploads = await expirePendingUploads(prisma, createUploadProvider(env), {
          batchSize: env.RETENTION_BATCH_SIZE,
          signal,
        });
        const result = await runRetentionCleanup({ signal });
        return { ...result, expiredUploads };
      }),
  },
  {
    name: 'audit-integrity-verification',
    cron: '0 4 * * *',
    description: 'Verify HMAC integrity signatures across stored audit events.',
    timeoutMs: 30 * 60_000,
    handler: (signal) =>
      withoutTenantScope('audit-integrity-verification', () => verifyAuditIntegrity(signal)),
  },
];

export function findScheduledJob(name: string): ScheduledJob | undefined {
  return scheduledJobs.find((job) => job.name === name);
}
