import type { NotificationChannel } from '@prisma/client';
import { prisma } from '#app/lib/prisma.js';
import { getRequestContext, withoutTenantScope } from '#app/lib/request-context.js';

export const notificationTopics = ['product_updates'] as const;
export type NotificationTopic = (typeof notificationTopics)[number];

function preferenceScope(): { scopeKey: string; organizationId: string | null } {
  const context = getRequestContext();
  const organizationId = context?.kind === 'request' ? context.organizationId : undefined;
  return organizationId
    ? { scopeKey: organizationId, organizationId }
    : { scopeKey: 'global', organizationId: null };
}

export async function listNotificationPreferences(userId: string) {
  const scope = preferenceScope();
  const query = () =>
    prisma.notificationPreference.findMany({
      where: {
        userId,
        scopeKey: scope.scopeKey,
        organizationId: scope.organizationId,
        deletedAt: null,
      },
      orderBy: [{ channel: 'asc' }, { topic: 'asc' }],
      select: { channel: true, topic: true, enabled: true, updatedAt: true },
    });
  const rows = scope.organizationId
    ? await query()
    : await withoutTenantScope('global-notification-preferences', query);
  const existing = new Map(rows.map((row) => [`${row.channel}:${row.topic}`, row]));
  return notificationTopics.map(
    (topic) =>
      existing.get(`EMAIL:${topic}`) ?? { channel: 'EMAIL' as const, topic, enabled: true },
  );
}

export async function setNotificationPreference(
  userId: string,
  input: { channel: NotificationChannel; topic: NotificationTopic; enabled: boolean },
) {
  const scope = preferenceScope();
  const write = () =>
    prisma.notificationPreference.upsert({
      where: {
        userId_scopeKey_channel_topic: {
          userId,
          scopeKey: scope.scopeKey,
          channel: input.channel,
          topic: input.topic,
        },
        organizationId: scope.organizationId,
      },
      create: { userId, ...scope, ...input },
      update: { enabled: input.enabled, deletedAt: null },
      select: { channel: true, topic: true, enabled: true, updatedAt: true },
    });
  return scope.organizationId
    ? write()
    : withoutTenantScope('global-notification-preferences', write);
}

export async function notificationAllowed(
  userId: string,
  channel: NotificationChannel,
  topic: NotificationTopic,
  organizationId?: string,
): Promise<boolean> {
  const scopeKeys = organizationId ? [organizationId, 'global'] : ['global'];
  const rows = await prisma.notificationPreference.findMany({
    where: { userId, channel, topic, scopeKey: { in: scopeKeys }, deletedAt: null },
    select: { scopeKey: true, enabled: true },
  });
  const exact = organizationId ? rows.find((row) => row.scopeKey === organizationId) : undefined;
  return exact?.enabled ?? rows.find((row) => row.scopeKey === 'global')?.enabled ?? true;
}
