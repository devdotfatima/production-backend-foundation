import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Readable } from 'node:stream';

const mocks = vi.hoisted(() => {
  const transaction = {
    $executeRaw: vi.fn(),
    upload: {
      create: vi.fn(),
      aggregate: vi.fn(),
      updateMany: vi.fn(),
      update: vi.fn(),
      findUniqueOrThrow: vi.fn(),
    },
    auditEvent: { create: vi.fn() },
    outboxEvent: { create: vi.fn() },
  };
  return {
    transaction,
    prisma: {
      upload: {
        create: vi.fn(),
        update: vi.fn(),
        findFirst: vi.fn(),
        findMany: vi.fn(),
        aggregate: vi.fn(),
      },
      message: { findFirst: vi.fn() },
      uploadBandwidthUsage: { create: vi.fn(), updateMany: vi.fn() },
      $transaction: vi.fn(),
    },
    scanMode: 'disabled',
    downloadMode: 'proxy',
  };
});

vi.mock('#app/config/env.js', () => ({
  env: {
    UPLOAD_ALLOWED_MIME_TYPES: ['image/png', 'application/pdf'],
    UPLOAD_MAX_BYTES: 1_024,
    get UPLOAD_SCAN_MODE() {
      return mocks.scanMode;
    },
    UPLOAD_URL_TTL_SECONDS: 600,
    get UPLOAD_DOWNLOAD_MODE() {
      return mocks.downloadMode;
    },
    UPLOAD_DOWNLOAD_URL_TTL_SECONDS: 60,
    UPLOAD_USER_MONTHLY_BANDWIDTH_QUOTA_BYTES: 10_000,
    NODE_ENV: 'test',
    QUEUE_PREFIX: 'test',
    AUDIT_INTEGRITY_SECRET: '',
    COOKIE_SECRET: 'test-cookie-secret-at-least-32-characters',
  },
}));
vi.mock('#app/lib/prisma.js', () => ({ prisma: mocks.prisma }));
vi.mock('#app/lib/crypto.js', () => ({
  hashMetadata: vi.fn((value: string) => `metadata:${value}`),
}));

import {
  completeUpload,
  createUploadDownload,
  initiateUpload,
} from '../dist/src/modules/uploads/uploads.service.js';

function uploadRecord(status: 'PENDING' | 'READY' | 'FAILED' = 'PENDING') {
  const now = new Date();
  return {
    id: '00000000-0000-4000-8000-000000000001',
    userId: '00000000-0000-4000-8000-000000000002',
    provider: 'S3' as const,
    status,
    visibility: 'PRIVATE' as const,
    objectKey: 'user/2026/08/object',
    originalName: 'avatar.png',
    contentType: 'image/png',
    expectedSize: 100n,
    actualSize: status === 'READY' ? 100n : null,
    checksum: status === 'READY' ? 'checksum' : null,
    url: null,
    uploadExpiresAt: new Date(now.getTime() + 600_000),
    readyAt: status === 'READY' ? now : null,
    createdAt: now,
    updatedAt: now,
    deletedAt: null,
  };
}

function providerDouble() {
  return {
    kind: 'S3' as const,
    createUpload: vi.fn(),
    inspectObject: vi.fn(),
    readObjectPrefix: vi.fn(),
    createDownloadUrl: vi.fn(),
    createDirectDownload: vi.fn(),
    openDownload: vi.fn(),
    deleteObject: vi.fn(),
  };
}

describe('upload service', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.scanMode = 'disabled';
    mocks.downloadMode = 'proxy';
    mocks.prisma.$transaction.mockImplementation(
      (callback: (tx: typeof mocks.transaction) => Promise<unknown>) => callback(mocks.transaction),
    );
    mocks.transaction.auditEvent.create.mockResolvedValue({});
    mocks.transaction.$executeRaw.mockResolvedValue(0);
    mocks.transaction.upload.aggregate.mockResolvedValue({ _sum: { expectedSize: 0n } });
    mocks.transaction.outboxEvent.create.mockResolvedValue({});
    mocks.prisma.uploadBandwidthUsage.create.mockResolvedValue({});
  });

  it('creates an owner-scoped record and returns a direct provider instruction', async () => {
    const provider = providerDouble();
    const expiresAt = new Date(Date.now() + 600_000);
    provider.createUpload.mockResolvedValue({
      method: 'PUT',
      url: 'https://s3.example.test/signed',
      headers: { 'content-type': 'image/png', 'content-length': '100' },
      expiresAt,
    });
    mocks.transaction.upload.create.mockImplementation(
      ({ data }: { data: Record<string, unknown> }) =>
        Promise.resolve({
          ...uploadRecord(),
          ...data,
          id: '00000000-0000-4000-8000-000000000001',
          createdAt: new Date(),
          updatedAt: new Date(),
          actualSize: null,
          checksum: null,
          url: null,
          readyAt: null,
          deletedAt: null,
          status: 'PENDING',
        }),
    );
    mocks.prisma.upload.update.mockImplementation(({ data }: { data: Record<string, unknown> }) =>
      Promise.resolve({ ...uploadRecord(), ...data }),
    );

    const result = await initiateUpload(
      '00000000-0000-4000-8000-000000000002',
      { filename: 'avatar.png', contentType: 'image/png', size: 100, visibility: 'PRIVATE' },
      provider,
    );

    expect(result.directive.method).toBe('PUT');
    const createInput = mocks.transaction.upload.create.mock.calls[0]?.[0] as unknown as {
      data: Record<string, unknown>;
    };
    expect(createInput.data).toMatchObject({
      userId: '00000000-0000-4000-8000-000000000002',
      provider: 'S3',
      expectedSize: 100n,
    });
  });

  it('verifies size and content type before marking an upload ready', async () => {
    const provider = providerDouble();
    const pending = uploadRecord();
    const ready = uploadRecord('READY');
    mocks.prisma.upload.findFirst.mockResolvedValue(pending);
    provider.inspectObject.mockResolvedValue({
      size: 100,
      contentType: 'image/png',
      checksum: 'checksum',
    });
    provider.readObjectPrefix.mockResolvedValue(
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    );
    mocks.transaction.upload.updateMany.mockResolvedValue({ count: 1 });
    mocks.transaction.upload.update.mockResolvedValue(ready);
    mocks.transaction.upload.findUniqueOrThrow.mockResolvedValue(ready);

    await expect(
      completeUpload(
        pending.userId,
        pending.id,
        { requestId: 'request-1', ip: '127.0.0.1', userAgent: 'test' },
        provider,
      ),
    ).resolves.toMatchObject({ status: 'READY', expectedSize: 100, actualSize: 100 });
    expect(mocks.transaction.auditEvent.create).toHaveBeenCalled();
  });

  it('deletes a mismatched provider object and fails completion', async () => {
    const provider = providerDouble();
    const pending = uploadRecord();
    mocks.prisma.upload.findFirst.mockResolvedValue(pending);
    provider.inspectObject.mockResolvedValue({ size: 99, contentType: 'image/png' });
    provider.deleteObject.mockResolvedValue(undefined);
    mocks.prisma.upload.update.mockResolvedValue(uploadRecord('FAILED'));

    await expect(
      completeUpload(
        pending.userId,
        pending.id,
        { requestId: 'request-1', ip: '127.0.0.1', userAgent: 'test' },
        provider,
      ),
    ).rejects.toMatchObject({ statusCode: 400 });
    expect(provider.deleteObject).toHaveBeenCalledWith({
      objectKey: pending.objectKey,
      contentType: pending.contentType,
      visibility: 'PRIVATE',
    });
  });

  it('queues scanner work instead of holding the completion request open', async () => {
    mocks.scanMode = 'webhook';
    const provider = providerDouble();
    const pending = uploadRecord();
    const quarantined = { ...pending, status: 'QUARANTINED' as const, actualSize: 100n };
    const scanning = { ...quarantined, status: 'SCANNING' as const };
    mocks.prisma.upload.findFirst.mockResolvedValue(pending);
    provider.inspectObject.mockResolvedValue({
      size: 100,
      contentType: 'image/png',
      checksum: 'checksum',
    });
    provider.readObjectPrefix.mockResolvedValue(
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    );
    mocks.transaction.upload.updateMany.mockResolvedValue({ count: 1 });
    mocks.transaction.upload.update.mockResolvedValue(scanning);
    mocks.transaction.upload.findUniqueOrThrow
      .mockResolvedValueOnce(quarantined)
      .mockResolvedValueOnce(scanning);

    await expect(
      completeUpload(
        pending.userId,
        pending.id,
        { requestId: 'request-1', ip: '127.0.0.1', userAgent: 'test' },
        provider,
      ),
    ).resolves.toMatchObject({ status: 'SCANNING' });

    expect(provider.createDownloadUrl).not.toHaveBeenCalled();
    const outboxCreate = mocks.transaction.outboxEvent.create.mock.calls[0]?.[0] as unknown as {
      data: { eventType: string; channel: string; payload: { uploadId: string } };
    };
    expect(outboxCreate.data).toMatchObject({
      eventType: 'upload.scan.requested',
      channel: 'INTERNAL',
      payload: { uploadId: pending.id },
    });
  });

  it('opens an authenticated stream and charges quota without exposing a reusable URL', async () => {
    const provider = providerDouble();
    const ready = uploadRecord('READY');
    const body = Readable.from(['download-bytes']);
    mocks.prisma.upload.findFirst.mockResolvedValue(ready);
    provider.openDownload.mockResolvedValue({
      body,
      contentLength: 100,
      contentType: 'image/png',
    });

    const result = await createUploadDownload(ready.userId, ready.id, provider);

    expect(result).toMatchObject({
      delivery: 'proxy',
      body,
      filename: 'avatar.png',
      contentLength: 100,
      contentType: 'image/png',
    });
    expect(provider.createDownloadUrl).not.toHaveBeenCalled();
    const usageCreate = mocks.prisma.uploadBandwidthUsage.create.mock.calls[0]?.[0] as unknown as {
      data: { bytes: bigint; userId: string };
    };
    expect(usageCreate.data).toMatchObject({ bytes: 100n, userId: ready.userId });
  });

  it('reserves quota and returns a short-lived direct URL in redirect mode', async () => {
    mocks.downloadMode = 'redirect';
    const provider = providerDouble();
    const ready = uploadRecord('READY');
    const expiresAt = new Date(Date.now() + 60_000);
    mocks.prisma.upload.findFirst.mockResolvedValue(ready);
    provider.createDirectDownload.mockResolvedValue({
      url: 'https://s3.example.test/short-lived-download',
      expiresAt,
    });

    await expect(createUploadDownload(ready.userId, ready.id, provider)).resolves.toMatchObject({
      delivery: 'redirect',
      url: 'https://s3.example.test/short-lived-download',
      expiresAt,
      contentLength: 100,
    });
    expect(provider.openDownload).not.toHaveBeenCalled();
    expect(provider.createDirectDownload).toHaveBeenCalledWith(
      expect.objectContaining({ filename: ready.originalName, expiresInSeconds: 60 }),
    );
    expect(mocks.prisma.uploadBandwidthUsage.create).toHaveBeenCalled();
  });

  it('lets an active chat participant download an attachment uploaded by another participant', async () => {
    const provider = providerDouble();
    const ready = uploadRecord('READY');
    const participantUserId = '00000000-0000-4000-8000-000000000099';
    mocks.prisma.upload.findFirst.mockResolvedValue(ready);
    mocks.prisma.message.findFirst.mockResolvedValue({ id: 'message-1' });
    provider.openDownload.mockResolvedValue({
      body: Readable.from(['shared']),
      contentLength: 100,
      contentType: 'image/png',
    });

    await expect(
      createUploadDownload(participantUserId, ready.id, provider),
    ).resolves.toMatchObject({ filename: ready.originalName });
    const messageLookup = mocks.prisma.message.findFirst.mock.calls[0]?.[0] as unknown as {
      where: {
        uploadId: string;
        conversation: {
          participants: {
            some: { userId: string; leftAt: null; deletedAt: null };
          };
        };
      };
      select: { id: boolean };
    };
    expect(messageLookup.where.uploadId).toBe(ready.id);
    expect(messageLookup.where.conversation.participants.some).toEqual({
      userId: participantUserId,
      leftAt: null,
      deletedAt: null,
    });
    expect(messageLookup.select).toEqual({ id: true });
  });
});
