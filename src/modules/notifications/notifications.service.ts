import type { NotificationChannel, Prisma } from '@prisma/client';
import { addOutboxEvent } from '#app/modules/outbox/outbox.service.js';

interface UserNotificationInput {
  userId: string;
  eventType: string;
  channels: NotificationChannel[];
  payload: Prisma.InputJsonObject;
  dedupeKey: string;
}

export interface ProductAnnouncementInput {
  userId: string;
  destination: string;
  organizationId?: string;
  headline: string;
  message: string;
  actionUrl: string;
  dedupeKey: string;
}

export async function queueProductAnnouncement(
  tx: Prisma.TransactionClient,
  input: ProductAnnouncementInput,
): Promise<void> {
  await addOutboxEvent(tx, {
    aggregateType: 'user',
    aggregateId: input.userId,
    eventType: 'product.announcement',
    channel: 'EMAIL',
    payload: {
      userId: input.userId,
      destination: input.destination,
      topic: 'product_updates',
      headline: input.headline,
      message: input.message,
      actionUrl: input.actionUrl,
      ...(input.organizationId ? { organizationId: input.organizationId } : {}),
    },
    dedupeKey: `${input.dedupeKey}:email`,
  });
}

export async function queueUserNotification(
  tx: Prisma.TransactionClient,
  input: UserNotificationInput,
): Promise<void> {
  await Promise.all(
    input.channels.map((channel) =>
      addOutboxEvent(tx, {
        aggregateType: 'user',
        aggregateId: input.userId,
        eventType: input.eventType,
        channel,
        payload: input.payload,
        dedupeKey: `${input.dedupeKey}:${channel.toLowerCase()}`,
      }),
    ),
  );
}
