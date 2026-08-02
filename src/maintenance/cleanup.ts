import '#app/instrument.js';
import { prisma } from '#app/lib/prisma.js';
import { runRetentionCleanup } from '#app/maintenance/retention.js';
import { expirePendingUploads } from '#app/maintenance/upload-cleanup.js';
import { createUploadProvider } from '#app/modules/uploads/uploads.provider.js';
import { env } from '#app/config/env.js';
import { appLogger } from '#app/observability/logger.js';
import { captureException, flushSentry } from '#app/observability/sentry.js';

try {
  const expiredUploads = await expirePendingUploads(prisma, createUploadProvider(env), {
    batchSize: env.RETENTION_BATCH_SIZE,
  });
  const result = await runRetentionCleanup();
  appLogger.info({ ...result, expiredUploads }, 'Retention cleanup completed');
} catch (error) {
  process.exitCode = 1;
  appLogger.fatal({ err: error }, 'Retention cleanup failed');
  captureException(error, { subsystem: 'retention-cleanup' });
} finally {
  await prisma.$disconnect();
  await flushSentry();
}
