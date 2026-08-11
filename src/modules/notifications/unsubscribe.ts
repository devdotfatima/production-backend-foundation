import { createHmac, timingSafeEqual } from 'node:crypto';
import { z } from 'zod';
import { env } from '#app/config/env.js';
import {
  setNotificationPreference,
  notificationTopics,
} from '#app/modules/notifications/notification-preferences.service.js';

const unsubscribePayload = z.object({
  v: z.literal(1),
  userId: z.uuid(),
  topic: z.enum(notificationTopics),
  exp: z.number().int().positive(),
});

function signature(payload: string): Buffer {
  return createHmac('sha256', env.TOKEN_HASH_SECRET)
    .update(`email-unsubscribe:v1:${payload}`)
    .digest();
}

export function createUnsubscribeToken(
  userId: string,
  topic: (typeof notificationTopics)[number],
  expiresInDays = 30,
): string {
  const payload = Buffer.from(
    JSON.stringify({
      v: 1,
      userId,
      topic,
      exp: Math.floor(Date.now() / 1_000) + expiresInDays * 24 * 60 * 60,
    }),
  ).toString('base64url');
  return `${payload}.${signature(payload).toString('base64url')}`;
}

export function verifyUnsubscribeToken(token: string) {
  const [payload, encodedSignature, extra] = token.split('.');
  if (!payload || !encodedSignature || extra) return null;
  let actual: Buffer;
  try {
    actual = Buffer.from(encodedSignature, 'base64url');
  } catch {
    return null;
  }
  const expected = signature(payload);
  if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) return null;
  try {
    const parsed = unsubscribePayload.parse(
      JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')),
    );
    return parsed.exp > Math.floor(Date.now() / 1_000) ? parsed : null;
  } catch {
    return null;
  }
}

export async function unsubscribeWithToken(token: string): Promise<boolean> {
  const payload = verifyUnsubscribeToken(token);
  if (!payload) return false;
  // One-click unsubscribe is deliberately global: a recipient should not have to repeat it for
  // every organization that can address the same mailbox.
  await setNotificationPreference(payload.userId, {
    channel: 'EMAIL',
    topic: payload.topic,
    enabled: false,
  });
  return true;
}
