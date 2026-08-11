import '#app/instrument.js';
import { prisma } from '#app/lib/prisma.js';
import { withoutTenantScope } from '#app/lib/request-context.js';
import { verifyAuditIntegrity } from '#app/maintenance/audit-verify.job.js';
import { appLogger } from '#app/observability/logger.js';
import { captureException, flushSentry } from '#app/observability/sentry.js';

// Standalone entrypoint for deployments using external cron. The scheduled-job path calls the
// same handler, so the two cannot drift.
try {
  const result = await withoutTenantScope('audit-integrity-verification', verifyAuditIntegrity);
  if (result.invalid > 0 || result.unsigned > 0) {
    process.exitCode = 1;
    appLogger.error(result, 'Audit integrity verification failed');
  } else {
    appLogger.info(result, 'Audit integrity verification completed');
  }
} catch (error) {
  process.exitCode = 1;
  appLogger.fatal({ err: error }, 'Audit integrity verification failed');
  captureException(error, { subsystem: 'audit-integrity-verification' });
} finally {
  await prisma.$disconnect();
  await flushSentry();
}
