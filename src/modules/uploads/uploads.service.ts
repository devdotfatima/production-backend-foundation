import type { Upload } from '@prisma/client';
import { uuidV7 } from '#app/lib/id.js';
import { env } from '#app/config/env.js';
import { errors } from '#app/lib/errors.js';
import { withAuditedTransaction } from '#app/lib/audited-transaction.js';
import { paginateCursor } from '#app/lib/cursor-pagination.js';
import { prisma } from '#app/lib/prisma.js';
import type { RequestMetadata } from '#app/lib/request-metadata.js';
import type { UploadProviderAdapter } from '#app/modules/uploads/uploads.provider.js';
import {
  detectContentType,
  requiresDocumentCdr,
  scanUploadBytes,
} from '#app/modules/uploads/upload-security.js';

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
  const usage = await prisma.upload.aggregate({
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

  const key = objectKey(userId);
  const expiresAt = new Date(Date.now() + env.UPLOAD_URL_TTL_SECONDS * 1_000);
  const upload = await prisma.upload.create({
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
  const bytes = await provider.readObject({
    objectKey: upload.objectKey,
    contentType: upload.contentType,
    visibility: upload.visibility,
  });
  const detectedContentType = detectContentType(bytes);
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

  await prisma.upload.update({ where: { id: upload.id }, data: { status: 'SCANNING' } });
  let scan: Awaited<ReturnType<typeof scanUploadBytes>>;
  try {
    scan = await scanUploadBytes({
      uploadId: upload.id,
      filename: upload.originalName,
      contentType: upload.contentType,
      bytes,
    });
  } catch {
    await prisma.upload.update({
      where: { id: upload.id },
      data: { status: 'QUARANTINED', scanVerdict: 'ERROR' },
    });
    throw errors.serviceUnavailable('Upload scanner is temporarily unavailable');
  }
  if (scan.verdict === 'MALICIOUS') {
    await provider.deleteObject({
      objectKey: upload.objectKey,
      contentType: upload.contentType,
      visibility: upload.visibility,
    });
  }
  const ready = await withAuditedTransaction(async (tx, audit) => {
    const accepted = scan.verdict === 'CLEAN';
    await tx.upload.update({
      where: { id: upload.id },
      data: {
        status: accepted ? 'READY' : 'REJECTED',
        scanProvider: scan.provider,
        scanReference: scan.reference,
        scanVerdict: scan.verdict,
        scannedAt: new Date(),
        readyAt: accepted ? new Date() : null,
        url: accepted && upload.visibility === 'PUBLIC' ? stored.url : null,
      },
    });
    await audit({
      actorUserId: userId,
      action: accepted ? 'upload.ready' : 'upload.rejected',
      entityType: 'upload',
      entityId: upload.id,
      metadata: { scanProvider: scan.provider, verdict: scan.verdict },
      ...metadata,
    });
    return tx.upload.findUniqueOrThrow({ where: { id: upload.id } });
  });
  return serializeUpload(ready);
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
    where: { id: uploadId, userId, status: 'READY', deletedAt: null },
  });
  if (!upload) throw errors.notFound('Upload not found');
  if (upload.provider !== provider.kind) {
    throw errors.serviceUnavailable('The configured upload provider has changed');
  }
  const now = new Date();
  const periodStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
  await prisma.$transaction(async (tx) => {
    const current = await tx.uploadBandwidthUsage.findUnique({
      where: { userId_periodStart: { userId, periodStart } },
    });
    const nextBytes =
      Number(current?.bytes ?? 0n) + Number(upload.actualSize ?? upload.expectedSize);
    if (nextBytes > env.UPLOAD_USER_MONTHLY_BANDWIDTH_QUOTA_BYTES) {
      throw errors.forbidden('Monthly download bandwidth quota exceeded');
    }
    await tx.uploadBandwidthUsage.upsert({
      where: { userId_periodStart: { userId, periodStart } },
      create: { userId, periodStart, bytes: BigInt(nextBytes) },
      update: { bytes: BigInt(nextBytes) },
    });
  });
  return {
    url: await provider.createDownloadUrl({
      objectKey: upload.objectKey,
      contentType: upload.contentType,
      visibility: upload.visibility,
    }),
    expiresInSeconds: provider.kind === 'S3' ? env.UPLOAD_URL_TTL_SECONDS : null,
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
