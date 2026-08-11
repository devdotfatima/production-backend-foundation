import { Prisma, type Upload } from '@prisma/client';
import { uuidV7 } from '#app/lib/id.js';
import { env } from '#app/config/env.js';
import { errors } from '#app/lib/errors.js';
import { withAuditedTransaction } from '#app/lib/audited-transaction.js';
import { paginateCursor } from '#app/lib/cursor-pagination.js';
import { prisma } from '#app/lib/prisma.js';
import { getRequestContext, runWithRequestContext } from '#app/lib/request-context.js';
import type { RequestMetadata } from '#app/lib/request-metadata.js';
import { addOutboxEvent } from '#app/modules/outbox/outbox.service.js';
import type { UploadProviderAdapter } from '#app/modules/uploads/uploads.provider.js';
import {
  detectContentType,
  requiresDocumentCdr,
  scanUpload,
} from '#app/modules/uploads/upload-security.js';

const SIGNATURE_PREFIX_BYTES = 16;

function requireProvider(
  provider: UploadProviderAdapter | null,
): asserts provider is UploadProviderAdapter {
  if (!provider) throw errors.serviceUnavailable('File uploads are not configured');
}

function serializeUpload(upload: Upload) {
  return {
    ...upload,
    expectedSize: Number(upload.expectedSize),
    actualSize: upload.actualSize === null ? null : Number(upload.actualSize),
  };
}

function objectKey(userId: string): string {
  const now = new Date();
  const year = now.getUTCFullYear();
  const month = String(now.getUTCMonth() + 1).padStart(2, '0');
  return `${userId}/${year}/${month}/${uuidV7()}`;
}

function activeOrganizationId(): string | undefined {
  const context = getRequestContext();
  return context?.kind === 'request' ? context.organizationId : undefined;
}

function uploadQuotaScopeKey(userId: string): string {
  const organizationId = activeOrganizationId();
  return organizationId ? `organization:${organizationId}:user:${userId}` : `user:${userId}`;
}

export async function initiateUpload(
  userId: string,
  input: {
    filename: string;
    contentType: string;
    size: number;
    visibility: 'PRIVATE' | 'PUBLIC';
  },
  provider: UploadProviderAdapter | null,
) {
  requireProvider(provider);
  if (!env.UPLOAD_ALLOWED_MIME_TYPES.includes(input.contentType)) {
    throw errors.badRequest('This file type is not allowed');
  }
  if (input.size > env.UPLOAD_MAX_BYTES) {
    throw errors.badRequest(`File exceeds the ${env.UPLOAD_MAX_BYTES}-byte upload limit`);
  }
  const key = objectKey(userId);
  const expiresAt = new Date(Date.now() + env.UPLOAD_URL_TTL_SECONDS * 1_000);
  const quotaScope = uploadQuotaScopeKey(userId);
  const upload = await prisma.$transaction(async (tx) => {
    // One user/tenant can initiate from several API replicas concurrently. The transaction-level
    // advisory lock serializes aggregate + reservation without holding a lock during provider I/O.
    await tx.$executeRaw(
      Prisma.sql`SELECT pg_advisory_xact_lock(hashtextextended(${`upload-storage:${quotaScope}`}, 0))`,
    );
    const usage = await tx.upload.aggregate({
      where: {
        userId,
        deletedAt: null,
        status: { in: ['PENDING', 'QUARANTINED', 'SCANNING', 'READY'] },
      },
      _sum: { expectedSize: true },
    });
    if (Number(usage._sum.expectedSize ?? 0n) + input.size > env.UPLOAD_USER_STORAGE_QUOTA_BYTES) {
      throw errors.forbidden('Per-user storage quota exceeded');
    }
    return tx.upload.create({
      data: {
        userId,
        provider: provider.kind,
        objectKey: key,
        originalName: input.filename,
        contentType: input.contentType,
        visibility: input.visibility,
        expectedSize: BigInt(input.size),
        uploadExpiresAt: expiresAt,
      },
    });
  });

  try {
    const directive = await provider.createUpload({
      objectKey: key,
      contentType: input.contentType,
      size: input.size,
      visibility: input.visibility,
    });
    const persistedUpload =
      directive.expiresAt.getTime() !== expiresAt.getTime()
        ? await prisma.upload.update({
            where: { id: upload.id },
            data: { uploadExpiresAt: directive.expiresAt },
          })
        : upload;
    return { upload: serializeUpload(persistedUpload), directive };
  } catch (error) {
    await prisma.upload.update({ where: { id: upload.id }, data: { status: 'FAILED' } });
    throw error;
  }
}

export async function completeUpload(
  userId: string,
  uploadId: string,
  metadata: RequestMetadata,
  provider: UploadProviderAdapter | null,
) {
  requireProvider(provider);
  const upload = await prisma.upload.findFirst({
    where: { id: uploadId, userId, deletedAt: null },
  });
  if (!upload) throw errors.notFound('Upload not found');
  if (upload.provider !== provider.kind) {
    throw errors.serviceUnavailable('The configured upload provider has changed');
  }
  if (upload.status === 'READY') return serializeUpload(upload);
  if (!['PENDING', 'QUARANTINED'].includes(upload.status)) {
    throw errors.conflict('Upload cannot be completed');
  }

  const stored = await provider.inspectObject({
    objectKey: upload.objectKey,
    contentType: upload.contentType,
    visibility: upload.visibility,
  });
  if (
    stored.size !== Number(upload.expectedSize) ||
    (stored.contentType !== undefined && stored.contentType !== upload.contentType)
  ) {
    await provider.deleteObject({
      objectKey: upload.objectKey,
      contentType: upload.contentType,
      visibility: upload.visibility,
    });
    await prisma.upload.update({ where: { id: upload.id }, data: { status: 'FAILED' } });
    throw errors.badRequest('Uploaded file does not match the declared size or content type');
  }
  const signaturePrefix = await provider.readObjectPrefix({
    objectKey: upload.objectKey,
    contentType: upload.contentType,
    visibility: upload.visibility,
    maxBytes: SIGNATURE_PREFIX_BYTES,
  });
  const detectedContentType = detectContentType(signaturePrefix);
  if (!detectedContentType || detectedContentType !== upload.contentType) {
    await provider.deleteObject({
      objectKey: upload.objectKey,
      contentType: upload.contentType,
      visibility: upload.visibility,
    });
    await prisma.upload.update({
      where: { id: upload.id },
      data: { status: 'REJECTED', detectedContentType, scanVerdict: 'SIGNATURE_MISMATCH' },
    });
    throw errors.badRequest('Uploaded file signature does not match the declared content type');
  }

  const quarantined = await withAuditedTransaction(async (tx, audit) => {
    await tx.upload.updateMany({
      where: { id: upload.id, userId, status: { in: ['PENDING', 'QUARANTINED'] }, deletedAt: null },
      data: {
        status: 'QUARANTINED',
        actualSize: BigInt(stored.size),
        checksum: stored.checksum,
        detectedContentType,
        url: null,
      },
    });
    await audit({
      actorUserId: userId,
      action: 'upload.quarantined',
      entityType: 'upload',
      entityId: upload.id,
      metadata: { provider: upload.provider, contentType: upload.contentType, size: stored.size },
      ...metadata,
    });
    return tx.upload.findUniqueOrThrow({ where: { id: upload.id } });
  });

  if (requiresDocumentCdr(upload.contentType) && env.UPLOAD_SCAN_MODE === 'disabled') {
    return serializeUpload(quarantined);
  }

  if (env.UPLOAD_SCAN_MODE === 'disabled') {
    return finalizeUploadScan(
      upload.id,
      userId,
      { verdict: 'CLEAN', provider: 'signature-only' },
      metadata,
    );
  }

  const scanning = await withAuditedTransaction(async (tx) => {
    await tx.upload.update({
      where: { id: upload.id },
      data: { status: 'SCANNING', scanVerdict: null },
    });
    await addOutboxEvent(tx, {
      aggregateType: 'upload',
      aggregateId: upload.id,
      eventType: 'upload.scan.requested',
      channel: 'INTERNAL',
      payload: { uploadId: upload.id },
      dedupeKey: `upload-scan:${upload.id}:${stored.checksum ?? stored.size}`,
      expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1_000),
    });
    return tx.upload.findUniqueOrThrow({ where: { id: upload.id } });
  });
  return serializeUpload(scanning);
}

async function finalizeUploadScan(
  uploadId: string,
  userId: string,
  scan: Awaited<ReturnType<typeof scanUpload>>,
  metadata: RequestMetadata,
) {
  const ready = await withAuditedTransaction(async (tx, audit) => {
    const accepted = scan.verdict === 'CLEAN';
    await tx.upload.update({
      where: { id: uploadId },
      data: {
        status: accepted ? 'READY' : 'REJECTED',
        scanProvider: scan.provider,
        scanReference: scan.reference,
        scanVerdict: scan.verdict,
        scannedAt: new Date(),
        readyAt: accepted ? new Date() : null,
        url: null,
      },
    });
    await audit({
      actorUserId: userId,
      action: accepted ? 'upload.ready' : 'upload.rejected',
      entityType: 'upload',
      entityId: uploadId,
      metadata: { scanProvider: scan.provider, verdict: scan.verdict },
      ...metadata,
    });
    return tx.upload.findUniqueOrThrow({ where: { id: uploadId } });
  });
  return serializeUpload(ready);
}

/** Worker entrypoint for provider I/O; completion requests only quarantine and enqueue. */
export async function processUploadScan(
  uploadId: string,
  provider: UploadProviderAdapter | null,
): Promise<void> {
  requireProvider(provider);
  const upload = await prisma.upload.findFirst({
    where: {
      id: uploadId,
      status: { in: ['QUARANTINED', 'SCANNING', 'REJECTED'] },
      deletedAt: null,
    },
  });
  if (!upload) return;
  if (upload.provider !== provider.kind) {
    throw new Error(`Upload ${upload.id} belongs to unavailable provider ${upload.provider}`);
  }
  // A previous attempt may have durably rejected the object and crashed during provider deletion.
  // Retry deletion without making the malicious object downloadable or rescanning it.
  if (upload.status === 'REJECTED') {
    if (upload.scanVerdict === 'MALICIOUS' && !upload.storageDeletedAt) {
      await provider.deleteObject({
        objectKey: upload.objectKey,
        contentType: upload.contentType,
        visibility: upload.visibility,
      });
      await prisma.upload.updateMany({
        where: { id: upload.id, status: 'REJECTED', storageDeletedAt: null },
        data: { storageDeletedAt: new Date() },
      });
    }
    return;
  }
  await prisma.upload.updateMany({
    where: { id: upload.id, status: { in: ['QUARANTINED', 'SCANNING'] }, deletedAt: null },
    data: { status: 'SCANNING', scanVerdict: null },
  });

  try {
    const sourceUrl = await provider.createDownloadUrl({
      objectKey: upload.objectKey,
      contentType: upload.contentType,
      visibility: upload.visibility,
    });
    const scan = await scanUpload({
      uploadId: upload.id,
      filename: upload.originalName,
      contentType: upload.contentType,
      size: Number(upload.actualSize ?? upload.expectedSize),
      checksum: upload.checksum ?? undefined,
      sourceUrl,
    });
    await runWithRequestContext(
      {
        kind: 'request',
        requestId: `worker:upload-scan:${upload.id}`,
        userId: upload.userId,
        organizationId: upload.organizationId ?? undefined,
      },
      () =>
        finalizeUploadScan(upload.id, upload.userId, scan, {
          requestId: `worker:upload-scan:${upload.id}`,
          ip: 'internal',
          userAgent: undefined,
        }),
    );
    if (scan.verdict === 'MALICIOUS') {
      await provider.deleteObject({
        objectKey: upload.objectKey,
        contentType: upload.contentType,
        visibility: upload.visibility,
      });
      await prisma.upload.updateMany({
        where: { id: upload.id, status: 'REJECTED', storageDeletedAt: null },
        data: { storageDeletedAt: new Date() },
      });
    }
  } catch (error) {
    await prisma.upload.updateMany({
      where: { id: upload.id, status: 'SCANNING' },
      data: { status: 'QUARANTINED', scanVerdict: 'ERROR' },
    });
    throw error;
  }
}

export async function listUploads(userId: string, input: { cursor?: string; limit: number }) {
  const page = await paginateCursor(input, (pagination) =>
    prisma.upload.findMany({
      where: { userId, deletedAt: null },
      ...pagination,
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    }),
  );
  return {
    uploads: page.items.map(serializeUpload),
    nextCursor: page.nextCursor,
  };
}

export async function createUploadDownload(
  userId: string,
  uploadId: string,
  provider: UploadProviderAdapter | null,
) {
  requireProvider(provider);
  const upload = await prisma.upload.findFirst({
    where: { id: uploadId, status: 'READY', deletedAt: null },
  });
  if (!upload) throw errors.notFound('Upload not found');
  if (upload.userId !== userId) {
    const sharedThroughChat = await prisma.message.findFirst({
      where: {
        uploadId: upload.id,
        deletedAt: null,
        conversation: {
          deletedAt: null,
          participants: {
            some: { userId, leftAt: null, deletedAt: null },
          },
        },
      },
      select: { id: true },
    });
    if (!sharedThroughChat) throw errors.notFound('Upload not found');
  }
  if (upload.provider !== provider.kind) {
    throw errors.serviceUnavailable('The configured upload provider has changed');
  }
  const now = new Date();
  const periodStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
  const increment = upload.actualSize ?? upload.expectedSize;
  const maximum = BigInt(env.UPLOAD_USER_MONTHLY_BANDWIDTH_QUOTA_BYTES);
  if (increment > maximum) {
    throw errors.forbidden('Monthly download bandwidth quota exceeded');
  }
  const scopeKey = uploadQuotaScopeKey(userId);
  const organizationId = activeOrganizationId();
  const chargeQuota = async () => {
    try {
      await prisma.uploadBandwidthUsage.create({
        data: { userId, organizationId, scopeKey, periodStart, bytes: increment },
      });
    } catch (error) {
      if (!(error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002')) {
        throw error;
      }
      // Conditional increment is one statement, so concurrent downloads cannot both spend the
      // same remaining quota.
      const updated = await prisma.uploadBandwidthUsage.updateMany({
        where: { scopeKey, periodStart, bytes: { lte: maximum - increment } },
        data: { bytes: { increment } },
      });
      if (updated.count !== 1) {
        throw errors.forbidden('Monthly download bandwidth quota exceeded');
      }
    }
  };

  if (env.UPLOAD_DOWNLOAD_MODE === 'redirect') {
    if (!provider.createDirectDownload) {
      throw errors.serviceUnavailable('Direct downloads are unavailable for this provider');
    }
    const direct = await provider.createDirectDownload({
      objectKey: upload.objectKey,
      contentType: upload.contentType,
      filename: upload.originalName,
      visibility: upload.visibility,
      expiresInSeconds: env.UPLOAD_DOWNLOAD_URL_TTL_SECONDS,
    });
    await chargeQuota();
    return {
      delivery: 'redirect' as const,
      ...direct,
      filename: upload.originalName,
      contentType: upload.contentType,
      contentLength: Number(increment),
    };
  }

  const download = await provider.openDownload({
    objectKey: upload.objectKey,
    contentType: upload.contentType,
    visibility: upload.visibility,
  });
  try {
    await chargeQuota();
  } catch (error) {
    download.body.destroy();
    throw error;
  }
  return {
    delivery: 'proxy' as const,
    ...download,
    filename: upload.originalName,
    contentType: download.contentType ?? upload.contentType,
    contentLength: download.contentLength ?? Number(increment),
  };
}

export async function deleteUpload(
  userId: string,
  uploadId: string,
  metadata: RequestMetadata,
  provider: UploadProviderAdapter | null,
) {
  requireProvider(provider);
  const upload = await prisma.upload.findFirst({
    where: { id: uploadId, userId, deletedAt: null },
  });
  if (!upload) throw errors.notFound('Upload not found');
  if (upload.provider !== provider.kind) {
    throw errors.serviceUnavailable('The configured upload provider has changed');
  }
  await provider.deleteObject({
    objectKey: upload.objectKey,
    contentType: upload.contentType,
    visibility: upload.visibility,
  });

  await withAuditedTransaction(async (tx, audit) => {
    await tx.upload.update({
      where: { id: upload.id },
      data: { status: 'DELETED', deletedAt: new Date() },
    });
    await audit({
      actorUserId: userId,
      action: 'upload.deleted',
      entityType: 'upload',
      entityId: upload.id,
      metadata: { provider: upload.provider },
      ...metadata,
    });
  });
}
