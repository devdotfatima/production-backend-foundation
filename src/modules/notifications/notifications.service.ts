import type { NotificationChannel, Prisma } from '@prisma/client';
import { addOutboxEvent } from '#app/modules/outbox/outbox.service.js';

interface UserNotificationInput {
  userId: string;
  eventType: string;
  channels: NotificationChannel[];
  payload: Prisma.InputJsonObject;
  dedupeKey: string;
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
