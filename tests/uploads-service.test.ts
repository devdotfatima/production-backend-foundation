import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => {
  const transaction = {
    upload: { updateMany: vi.fn(), update: vi.fn(), findUniqueOrThrow: vi.fn() },
    auditEvent: { create: vi.fn() },
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
      $transaction: vi.fn(),
    },
  };
});

vi.mock('#app/config/env.js', () => ({
  env: {
    UPLOAD_ALLOWED_MIME_TYPES: ['image/png', 'application/pdf'],
    UPLOAD_MAX_BYTES: 1_024,
    UPLOAD_SCAN_MODE: 'disabled',
    UPLOAD_URL_TTL_SECONDS: 600,
    AUDIT_INTEGRITY_SECRET: '',
    COOKIE_SECRET: 'test-cookie-secret-at-least-32-characters',
  },
}));
vi.mock('#app/lib/prisma.js', () => ({ prisma: mocks.prisma }));
vi.mock('#app/lib/crypto.js', () => ({
  hashMetadata: vi.fn((value: string) => `metadata:${value}`),
}));

import { completeUpload, initiateUpload } from '../dist/src/modules/uploads/uploads.service.js';

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
    readObject: vi.fn(),
    createDownloadUrl: vi.fn(),
    deleteObject: vi.fn(),
  };
}

describe('upload service', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.prisma.$transaction.mockImplementation(
      (callback: (tx: typeof mocks.transaction) => Promise<unknown>) => callback(mocks.transaction),
    );
    mocks.transaction.auditEvent.create.mockResolvedValue({});
    mocks.prisma.upload.aggregate.mockResolvedValue({ _sum: { expectedSize: 0n } });
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
    mocks.prisma.upload.create.mockImplementation(({ data }: { data: Record<string, unknown> }) =>
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
    const createInput = mocks.prisma.upload.create.mock.calls[0]?.[0] as unknown as {
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
    provider.readObject.mockResolvedValue(
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
});
