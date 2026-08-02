import type { PrismaClient } from '@prisma/client';
import type { UploadProviderAdapter } from '#app/modules/uploads/uploads.provider.js';

export type UploadCleanupDatabase = Pick<PrismaClient, 'upload'>;

export async function expirePendingUploads(
  database: UploadCleanupDatabase,
  provider: UploadProviderAdapter | null,
  options: { now?: Date; batchSize?: number } = {},
) {
  if (!provider) return { expired: 0, failures: 0 };
  const now = options.now ?? new Date();
  const batchSize = options.batchSize ?? 500;
  let cursor: string | undefined;
  let expired = 0;
  let failures = 0;

  while (true) {
    const uploads = await database.upload.findMany({
      where: {
        provider: provider.kind,
        status: 'PENDING',
        deletedAt: null,
        uploadExpiresAt: { lt: now },
      },
      take: batchSize,
      ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
      orderBy: [{ uploadExpiresAt: 'asc' }, { id: 'asc' }],
      select: { id: true, objectKey: true, contentType: true },
    });
    for (const upload of uploads) {
      try {
        await provider.deleteObject({
          objectKey: upload.objectKey,
          contentType: upload.contentType,
        });
        const updated = await database.upload.updateMany({
          where: { id: upload.id, status: 'PENDING' },
          data: { status: 'FAILED' },
        });
        expired += updated.count;
      } catch {
        failures += 1;
      }
    }
    if (uploads.length < batchSize) break;
    cursor = uploads.at(-1)?.id;
  }
  return { expired, failures };
}
