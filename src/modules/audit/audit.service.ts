import type { Prisma } from '@prisma/client';
import { uuidV7 } from '#app/lib/id.js';
import { hashMetadata } from '#app/lib/crypto.js';
import { paginateCursor } from '#app/lib/cursor-pagination.js';
import { prisma } from '#app/lib/prisma.js';
import { signAuditEvent } from '#app/modules/audit/audit.integrity.js';

export interface AuditInput {
  actorUserId?: string;
  action: string;
  entityType: string;
  entityId?: string;
  requestId?: string;
  ip?: string;
  userAgent?: string;
  metadata?: Prisma.InputJsonValue;
}

export async function writeAuditEvent(
  tx: Prisma.TransactionClient,
  input: AuditInput,
): Promise<void> {
  const id = uuidV7();
  const createdAt = new Date();
  const ipHash = input.ip ? hashMetadata(input.ip) : undefined;
  const userAgent = input.userAgent?.slice(0, 500);
  const integrityHash = signAuditEvent({
    id,
    actorUserId: input.actorUserId,
    action: input.action,
    entityType: input.entityType,
    entityId: input.entityId,
    requestId: input.requestId,
    ipHash,
    userAgent,
    metadata: input.metadata,
    createdAt,
    updatedAt: createdAt,
    deletedAt: null,
  });
  await tx.auditEvent.create({
    data: {
      id,
      actorUserId: input.actorUserId,
      action: input.action,
      entityType: input.entityType,
      entityId: input.entityId,
      requestId: input.requestId,
      ipHash,
      userAgent,
      metadata: input.metadata,
      integrityHash,
      createdAt,
      updatedAt: createdAt,
    },
  });
}

export async function listAuditEvents(input: {
  cursor?: string;
  limit: number;
  actorUserId?: string;
  entityType?: string;
}) {
  const page = await paginateCursor(input, (pagination) =>
    prisma.auditEvent.findMany({
      where: {
        deletedAt: null,
        actorUserId: input.actorUserId,
        entityType: input.entityType,
      },
      ...pagination,
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    }),
  );
  return { events: page.items, nextCursor: page.nextCursor };
}
