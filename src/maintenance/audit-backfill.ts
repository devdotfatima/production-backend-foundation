import '#app/instrument.js';
import { PrismaClient } from '@prisma/client';
import { signAuditEvent } from '#app/modules/audit/audit.integrity.js';
import { appLogger } from '#app/observability/logger.js';

// Use an unextended client: this pre-migration tool must be able to see legacy nullable hashes.
const database = new PrismaClient();
const batchSize = 500;
let updated = 0;

try {
  while (true) {
    const events = await database.auditEvent.findMany({
      where: { integrityHash: null } as never,
      take: batchSize,
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
    });
    if (events.length === 0) break;
    for (const event of events) {
      const integrityHash = signAuditEvent(event);
      const result = await database.auditEvent.updateMany({
        where: { id: event.id, integrityHash: null } as never,
        data: { integrityHash },
      });
      updated += result.count;
    }
  }
  appLogger.info({ updated }, 'Unsigned audit events backfilled');
} finally {
  await database.$disconnect();
}
