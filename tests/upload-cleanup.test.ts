import { describe, expect, it, vi } from 'vitest';
import { expirePendingUploads } from '../dist/src/maintenance/upload-cleanup.js';

describe('expired upload cleanup', () => {
  it('removes orphaned provider objects before failing stale upload records', async () => {
    const database = {
      upload: {
        findMany: vi
          .fn()
          .mockResolvedValueOnce([
            { id: 'upload-1', objectKey: 'user/object', contentType: 'image/png' },
          ]),
        updateMany: vi.fn().mockResolvedValue({ count: 1 }),
      },
    };
    const provider = {
      kind: 'S3' as const,
      createUpload: vi.fn(),
      inspectObject: vi.fn(),
      readObject: vi.fn(),
      createDownloadUrl: vi.fn(),
      deleteObject: vi.fn().mockResolvedValue(undefined),
    };

    await expect(
      expirePendingUploads(database as never, provider, {
        now: new Date('2026-08-02T12:00:00.000Z'),
        batchSize: 100,
      }),
    ).resolves.toEqual({ expired: 1, failures: 0 });
    expect(provider.deleteObject).toHaveBeenCalledWith({
      objectKey: 'user/object',
      contentType: 'image/png',
    });
    expect(database.upload.updateMany).toHaveBeenCalledWith({
      where: { id: 'upload-1', status: 'PENDING' },
      data: { status: 'FAILED' },
    });
  });
});
