import { prisma } from '#app/lib/prisma.js';
import { verifyAuditEvent } from '#app/modules/audit/audit.integrity.js';

const BATCH_SIZE = 500;

export interface AuditIntegrityResult extends Record<string, unknown> {
  signed: number;
  unsigned: number;
  invalid: number;
}

/**
 * Shared by the scheduled job and the standalone `maintenance:audit-verify` entrypoint, so the
 * two execution paths cannot drift apart.
 */
export async function verifyAuditIntegrity(signal?: AbortSignal): Promise<AuditIntegrityResult> {
  let cursor: string | undefined;
  let signed = 0;
  let unsigned = 0;
  let invalid = 0;

  for (;;) {
    signal?.throwIfAborted();
    const events = await prisma.auditEvent.findMany({
      take: BATCH_SIZE,
      ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
      orderBy: { id: 'asc' },
    });
    for (const event of events) {
      signal?.throwIfAborted();
      if (!event.integrityHash) unsigned += 1;
      else if (verifyAuditEvent(event)) signed += 1;
      else invalid += 1;
    }
    if (events.length < BATCH_SIZE) break;
    cursor = events.at(-1)?.id;
  }

  return { signed, unsigned, invalid };
}
