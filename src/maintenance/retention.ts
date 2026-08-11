import {
  OutboxStatus,
  Prisma,
  StripeEventStatus,
  UploadStatus,
  type PrismaClient,
} from '@prisma/client';
import { env } from '#app/config/env.js';
import { prisma } from '#app/lib/prisma.js';

const DAY_MS = 24 * 60 * 60 * 1_000;

export type RetentionCleanupDatabase = Pick<
  PrismaClient,
  | 'auditEvent'
  | 'idempotencyRecord'
  | 'invitation'
  | 'otpChallenge'
  | 'outboxEvent'
  | 'session'
  | 'stripeWebhookEvent'
  | 'upload'
  | 'uploadBandwidthUsage'
>;

export type RetentionCleanupOptions = {
  dataRetentionDays?: number;
  auditRetentionDays?: number;
  batchSize?: number;
  now?: Date;
  signal?: AbortSignal;
};

export type RetentionCleanupResult = {
  auditDeletionEnabled: boolean;
  cutoffs: {
    data: Date;
    audit: Date | null;
  };
  deleted: {
    auditEvents: number;
    idempotencyRecords: number;
    invitations: number;
    otpChallenges: number;
    outboxEvents: number;
    sessions: number;
    stripeWebhookEvents: number;
    uploads: number;
    uploadBandwidthRows: number;
  };
};

type IdRow = { id: string };

export async function deleteInBatches(
  batchSize: number,
  selectBatch: (take: number) => Promise<IdRow[]>,
  deleteBatch: (ids: string[]) => Promise<{ count: number }>,
  signal?: AbortSignal,
): Promise<number> {
  if (!Number.isInteger(batchSize) || batchSize < 1) {
    throw new TypeError('batchSize must be a positive integer');
  }

  let deleted = 0;
  while (true) {
    signal?.throwIfAborted();
    const rows = await selectBatch(batchSize);
    if (rows.length === 0) return deleted;

    signal?.throwIfAborted();
    const result = await deleteBatch(rows.map(({ id }) => id));
    deleted += result.count;
    if (rows.length < batchSize) return deleted;
  }
}

function validateRetentionDays(name: string, days: number, allowZero = false): void {
  if (!Number.isInteger(days) || days < (allowZero ? 0 : 1)) {
    throw new TypeError(`${name} must be ${allowZero ? 'a non-negative' : 'a positive'} integer`);
  }
}

export async function runRetentionCleanup(
  options: RetentionCleanupOptions = {},
  database: RetentionCleanupDatabase = prisma,
): Promise<RetentionCleanupResult> {
  const dataRetentionDays = options.dataRetentionDays ?? env.DATA_RETENTION_DAYS;
  const auditRetentionDays = options.auditRetentionDays ?? env.AUDIT_RETENTION_DAYS;
  const batchSize = options.batchSize ?? env.RETENTION_BATCH_SIZE;
  const now = options.now ?? new Date();

  validateRetentionDays('dataRetentionDays', dataRetentionDays);
  validateRetentionDays('auditRetentionDays', auditRetentionDays, true);
  if (!Number.isInteger(batchSize) || batchSize < 1) {
    throw new TypeError('batchSize must be a positive integer');
  }
  if (Number.isNaN(now.getTime())) throw new TypeError('now must be a valid date');

  const dataCutoff = new Date(now.getTime() - dataRetentionDays * DAY_MS);
  const auditCutoff =
    auditRetentionDays === 0 ? null : new Date(now.getTime() - auditRetentionDays * DAY_MS);
  const bandwidthCutoff = new Date(
    Date.UTC(dataCutoff.getUTCFullYear(), dataCutoff.getUTCMonth(), 1),
  );

  const idempotencyRecords = await deleteInBatches(
    batchSize,
    (take) =>
      database.idempotencyRecord.findMany({
        // A record is complete only when it has both parts required for a replay. Preserve expired
        // incomplete leases indefinitely: the external side effect may have succeeded before the
        // process could persist its result, so releasing that fingerprint can duplicate the work.
        where: {
          expiresAt: { lt: now },
          statusCode: { not: null },
          response: { not: Prisma.AnyNull },
        },
        select: { id: true },
        orderBy: { expiresAt: 'asc' },
        take,
      }),
    (ids) =>
      database.idempotencyRecord.deleteMany({
        where: {
          id: { in: ids },
          expiresAt: { lt: now },
          statusCode: { not: null },
          response: { not: Prisma.AnyNull },
        },
      }),
    options.signal,
  );

  const invitations = await deleteInBatches(
    batchSize,
    (take) =>
      database.invitation.findMany({
        where: {
          OR: [
            { expiresAt: { lt: dataCutoff } },
            { acceptedAt: { lt: dataCutoff } },
            { revokedAt: { lt: dataCutoff } },
          ],
        },
        select: { id: true },
        orderBy: { id: 'asc' },
        take,
      }),
    (ids) =>
      database.invitation.deleteMany({
        where: {
          id: { in: ids },
          OR: [
            { expiresAt: { lt: dataCutoff } },
            { acceptedAt: { lt: dataCutoff } },
            { revokedAt: { lt: dataCutoff } },
          ],
        },
      }),
    options.signal,
  );

  const uploadBandwidthRows = await deleteInBatches(
    batchSize,
    (take) =>
      database.uploadBandwidthUsage.findMany({
        where: { periodStart: { lt: bandwidthCutoff } },
        select: { id: true },
        orderBy: { periodStart: 'asc' },
        take,
      }),
    (ids) =>
      database.uploadBandwidthUsage.deleteMany({
        where: { id: { in: ids }, periodStart: { lt: bandwidthCutoff } },
      }),
    options.signal,
  );

  const otpChallenges = await deleteInBatches(
    batchSize,
    (take) =>
      database.otpChallenge.findMany({
        where: { expiresAt: { lt: dataCutoff } },
        select: { id: true },
        orderBy: { expiresAt: 'asc' },
        take,
      }),
    (ids) =>
      database.otpChallenge.deleteMany({
        where: { id: { in: ids }, expiresAt: { lt: dataCutoff } },
      }),
    options.signal,
  );

  const sessions = await deleteInBatches(
    batchSize,
    (take) =>
      database.session.findMany({
        where: {
          OR: [{ expiresAt: { lt: dataCutoff } }, { revokedAt: { lt: dataCutoff } }],
        },
        select: { id: true },
        orderBy: { id: 'asc' },
        take,
      }),
    (ids) =>
      database.session.deleteMany({
        where: {
          id: { in: ids },
          OR: [{ expiresAt: { lt: dataCutoff } }, { revokedAt: { lt: dataCutoff } }],
        },
      }),
    options.signal,
  );

  const outboxTerminalStatuses = [OutboxStatus.DELIVERED, OutboxStatus.DEAD_LETTER];
  const outboxEvents = await deleteInBatches(
    batchSize,
    (take) =>
      database.outboxEvent.findMany({
        where: {
          status: { in: outboxTerminalStatuses },
          updatedAt: { lt: dataCutoff },
        },
        select: { id: true },
        orderBy: { id: 'asc' },
        take,
      }),
    (ids) =>
      database.outboxEvent.deleteMany({
        where: {
          id: { in: ids },
          status: { in: outboxTerminalStatuses },
          updatedAt: { lt: dataCutoff },
        },
      }),
    options.signal,
  );

  const stripeWebhookEvents = await deleteInBatches(
    batchSize,
    (take) =>
      database.stripeWebhookEvent.findMany({
        where: {
          status: StripeEventStatus.PROCESSED,
          createdAt: { lt: dataCutoff },
        },
        select: { id: true },
        orderBy: { createdAt: 'asc' },
        take,
      }),
    (ids) =>
      database.stripeWebhookEvent.deleteMany({
        where: {
          id: { in: ids },
          status: StripeEventStatus.PROCESSED,
          createdAt: { lt: dataCutoff },
        },
      }),
    options.signal,
  );

  const uploads = await deleteInBatches(
    batchSize,
    (take) =>
      database.upload.findMany({
        where: {
          status: { in: [UploadStatus.FAILED, UploadStatus.DELETED] },
          updatedAt: { lt: dataCutoff },
        },
        select: { id: true },
        orderBy: { id: 'asc' },
        take,
      }),
    (ids) =>
      database.upload.deleteMany({
        where: {
          id: { in: ids },
          status: { in: [UploadStatus.FAILED, UploadStatus.DELETED] },
          updatedAt: { lt: dataCutoff },
        },
      }),
    options.signal,
  );

  const auditEvents = auditCutoff
    ? await deleteInBatches(
        batchSize,
        (take) =>
          database.auditEvent.findMany({
            where: { createdAt: { lt: auditCutoff } },
            select: { id: true },
            orderBy: { createdAt: 'asc' },
            take,
          }),
        (ids) =>
          database.auditEvent.deleteMany({
            where: { id: { in: ids }, createdAt: { lt: auditCutoff } },
          }),
        options.signal,
      )
    : 0;

  return {
    auditDeletionEnabled: auditCutoff !== null,
    cutoffs: { data: dataCutoff, audit: auditCutoff },
    deleted: {
      auditEvents,
      idempotencyRecords,
      invitations,
      otpChallenges,
      outboxEvents,
      sessions,
      stripeWebhookEvents,
      uploads,
      uploadBandwidthRows,
    },
  };
}
