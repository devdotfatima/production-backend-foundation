import { createHmac, timingSafeEqual } from 'node:crypto';
import { z } from 'zod';
import { env } from '#app/config/env.js';
import { candidateMetadataHashes, hashMetadata, normalizeEmail } from '#app/lib/crypto.js';
import { errors } from '#app/lib/errors.js';
import { prisma } from '#app/lib/prisma.js';
import { withoutTenantScope } from '#app/lib/request-context.js';

const emailEventSchema = z.object({
  id: z.string().min(1).max(255),
  type: z.enum(['delivered', 'bounce', 'complaint']),
  destination: z.email(),
  provider: z.string().min(1).max(100),
  messageId: z.string().min(1).max(500).optional(),
});

function validSignature(rawBody: Buffer, value: string): boolean {
  if (!env.EMAIL_EVENT_WEBHOOK_SECRET) return false;
  const supplied = value.startsWith('sha256=') ? value.slice(7) : value;
  let actual: Buffer;
  try {
    actual = Buffer.from(supplied, 'hex');
  } catch {
    return false;
  }
  const expected = createHmac('sha256', env.EMAIL_EVENT_WEBHOOK_SECRET).update(rawBody).digest();
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

export async function processEmailProviderEvent(rawBody: Buffer, signature: string): Promise<void> {
  if (!validSignature(rawBody, signature)) throw errors.badRequest('Invalid email event signature');
  let json: unknown;
  try {
    json = JSON.parse(rawBody.toString('utf8'));
  } catch {
    throw errors.badRequest('Invalid email event payload');
  }
  const event = emailEventSchema.parse(json);
  const normalized = normalizeEmail(event.destination);
  const destinationHashes = candidateMetadataHashes(normalized);
  const destinationHash = hashMetadata(normalized);
  const status =
    event.type === 'delivered'
      ? ('DELIVERED' as const)
      : event.type === 'bounce'
        ? ('BOUNCED' as const)
        : ('COMPLAINED' as const);

  await withoutTenantScope('email-provider-event', () =>
    prisma.$transaction(async (tx) => {
      await tx.notificationDelivery.updateMany({
        where: {
          OR: [
            ...(event.messageId ? [{ providerMessageId: event.messageId }] : []),
            { destinationHash: { in: destinationHashes } },
          ],
        },
        data: {
          status,
          provider: event.provider,
          deliveredAt: event.type === 'delivered' ? new Date() : null,
        },
      });
      if (event.type === 'bounce' || event.type === 'complaint') {
        await tx.emailSuppression.upsert({
          where: { destinationHash },
          create: {
            destinationHash,
            reason: event.type === 'bounce' ? 'BOUNCE' : 'COMPLAINT',
            provider: event.provider,
            providerEventId: event.id,
          },
          update: {
            reason: event.type === 'bounce' ? 'BOUNCE' : 'COMPLAINT',
            provider: event.provider,
            providerEventId: event.id,
            deletedAt: null,
          },
        });
      }
    }),
  );
}
