import { z } from 'zod';
import { prisma } from '#app/lib/prisma.js';
import { withoutTenantScope } from '#app/lib/request-context.js';
import { cancelCustomerSubscriptions } from '#app/modules/stripe/stripe.subscriptions.service.js';
import type { StripeClient } from '#app/modules/stripe/stripe.client.js';
import type { UploadProviderAdapter } from '#app/modules/uploads/uploads.provider.js';

const accountErasurePayload = z.object({
  userId: z.uuid(),
  stripeCustomerId: z.string().startsWith('cus_').optional(),
});

/**
 * Retry-safe external half of account erasure. Database anonymization commits first; this worker
 * then converges Stripe and object storage without putting network calls inside a transaction.
 */
export async function processAccountErasure(
  payload: unknown,
  dependencies: {
    stripeClient: StripeClient | null;
    uploadProvider: UploadProviderAdapter | null;
  },
): Promise<void> {
  const value = accountErasurePayload.parse(payload);
  if (value.stripeCustomerId) {
    if (!dependencies.stripeClient) {
      throw new Error('Stripe must be configured to finish account erasure');
    }
    await cancelCustomerSubscriptions(value.stripeCustomerId, dependencies.stripeClient);
  }

  await withoutTenantScope('account-erasure-worker', async () => {
    for (;;) {
      const uploads = await prisma.upload.findMany({
        where: {
          userId: value.userId,
          status: 'DELETED',
          storageDeletedAt: null,
          deletedAt: { not: null },
        },
        orderBy: { id: 'asc' },
        take: 100,
        select: {
          id: true,
          provider: true,
          objectKey: true,
          contentType: true,
          visibility: true,
        },
      });
      if (uploads.length === 0) break;
      if (!dependencies.uploadProvider) {
        throw new Error('Upload storage must be configured to finish account erasure');
      }
      for (const upload of uploads) {
        if (dependencies.uploadProvider.kind !== upload.provider) {
          throw new Error(`Upload provider ${upload.provider} is required for account erasure`);
        }
        await dependencies.uploadProvider.deleteObject({
          objectKey: upload.objectKey,
          contentType: upload.contentType,
          visibility: upload.visibility,
        });
        await prisma.upload.update({
          where: { id: upload.id, deletedAt: { not: null } },
          data: {
            objectKey: `erased/${upload.id}`,
            storageDeletedAt: new Date(),
          },
        });
      }
    }
  });
}
