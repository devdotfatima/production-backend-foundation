import '#app/instrument.js';
import { prisma } from '#app/lib/prisma.js';
import { verifyAuditEvent } from '#app/modules/audit/audit.integrity.js';
import { appLogger } from '#app/observability/logger.js';
import { captureException, flushSentry } from '#app/observability/sentry.js';

const BATCH_SIZE = 500;

async function verifyStoredAuditEvents() {
  let cursor: string | undefined;
  let signed = 0;
  let unsigned = 0;
  let invalid = 0;

  while (true) {
    const events = await prisma.auditEvent.findMany({
      take: BATCH_SIZE,
      ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
      orderBy: { id: 'asc' },
    });
    for (const event of events) {
      if (!event.integrityHash) unsigned += 1;
      else if (verifyAuditEvent(event)) signed += 1;
      else invalid += 1;
    }
    if (events.length < BATCH_SIZE) break;
    cursor = events.at(-1)?.id;
  }
  return { signed, unsigned, invalid };
}

try {
  const result = await verifyStoredAuditEvents();
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
