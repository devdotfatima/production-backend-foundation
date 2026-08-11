import { prisma } from '#app/lib/prisma.js';
import { deterministicOrder, textSearch } from '#app/middleware/query-options.js';
import { publishChatRevocation } from '#app/modules/chat/chat.revocations.js';
import { withAuditedTransaction } from '#app/lib/audited-transaction.js';
import { paginateCursor } from '#app/lib/cursor-pagination.js';
import { assertResourceOwner } from '#app/lib/resource-ownership.js';
import type { RequestMetadata } from '#app/lib/request-metadata.js';

export const publicUserSelect = {
  id: true,
  email: true,
  phone: true,
  displayName: true,
  locale: true,
  status: true,
  emailVerifiedAt: true,
  phoneVerifiedAt: true,
  createdAt: true,
  updatedAt: true,
} as const;

export async function getCurrentUser(userId: string) {
  return prisma.user.findFirst({
    where: { id: userId, deletedAt: null },
    select: {
      ...publicUserSelect,
      roles: {
        where: { deletedAt: null },
        select: { role: { select: { name: true } } },
      },
    },
  });
}

export async function registerDevice(userId: string, input: { token: string; platform?: string }) {
  const existing = await prisma.device.findUnique({
    where: { fcmToken: input.token },
    select: { id: true, userId: true },
  });

  if (existing) {
    assertResourceOwner(existing.userId, userId);
    return prisma.device.update({
      where: { id: existing.id, userId },
      data: { platform: input.platform, lastSeenAt: new Date(), deletedAt: null },
      select: { id: true, platform: true, lastSeenAt: true },
    });
  }

  return prisma.device.create({
    data: { userId, fcmToken: input.token, platform: input.platform },
    select: { id: true, platform: true, lastSeenAt: true },
  });
}

export async function listDevices(userId: string) {
  return prisma.device.findMany({
    where: { userId, deletedAt: null },
    orderBy: [{ lastSeenAt: 'desc' }, { createdAt: 'desc' }],
    select: { id: true, platform: true, lastSeenAt: true, createdAt: true },
  });
}

export async function unregisterDevice(
  userId: string,
  deviceId: string,
  metadata: RequestMetadata,
) {
  return withAuditedTransaction(async (tx, audit) => {
    const removed = await tx.device.updateMany({
      where: { id: deviceId, userId, deletedAt: null },
      data: { deletedAt: new Date() },
    });
    if (removed.count !== 1) return false;
    await audit({
      actorUserId: userId,
      action: 'device.unregistered',
      entityType: 'device',
      entityId: deviceId,
      ...metadata,
    });
    return true;
  });
}

export async function updateOwnProfile(
  userId: string,
  input: { displayName?: string | null; phone?: string | null; locale?: string },
  metadata: RequestMetadata,
) {
  return withAuditedTransaction(async (tx, audit) => {
    const current = await tx.user.findFirst({
      where: { id: userId, deletedAt: null },
      select: { phone: true },
    });
    if (!current) return null;

    const data = {
      ...(input.displayName !== undefined ? { displayName: input.displayName } : {}),
      ...(input.locale !== undefined ? { locale: input.locale } : {}),
      ...(input.phone !== undefined
        ? {
            phone: input.phone,
            ...(input.phone !== current.phone ? { phoneVerifiedAt: null } : {}),
          }
        : {}),
    };
    const updated = await tx.user.update({
      where: { id: userId },
      data,
      select: publicUserSelect,
    });
    await audit({
      actorUserId: userId,
      action: 'user.profile_updated',
      entityType: 'user',
      entityId: userId,
      metadata: { fields: Object.keys(input) },
      ...metadata,
    });
    return updated;
  });
}

export async function listSessions(userId: string, currentSessionId: string) {
  const sessions = await prisma.session.findMany({
    where: { userId, revokedAt: null, deletedAt: null },
    orderBy: [{ lastSeenAt: 'desc' }, { createdAt: 'desc' }],
    select: {
      id: true,
      userAgent: true,
      createdAt: true,
      lastSeenAt: true,
      expiresAt: true,
    },
  });
  return sessions.map((session) => ({
    ...session,
    current: session.id === currentSessionId,
  }));
}

export async function listUsers(input: {
  cursor?: string;
  limit: number;
  search?: string;
  status?: 'PENDING' | 'ACTIVE' | 'SUSPENDED' | 'DISABLED';
  sort: 'createdAt' | 'email' | 'displayName' | 'id';
  order: 'asc' | 'desc';
}) {
  const page = await paginateCursor(input, (pagination) =>
    prisma.user.findMany({
      where: {
        deletedAt: null,
        status: input.status,
        ...textSearch(input.search, ['email', 'displayName']),
      },
      ...pagination,
      orderBy: deterministicOrder(input.sort, input.order),
      select: publicUserSelect,
    }),
  );
  return { users: page.items, nextCursor: page.nextCursor };
}

export async function updateUser(
  id: string,
  input: { displayName?: string | null; status?: 'PENDING' | 'ACTIVE' | 'SUSPENDED' | 'DISABLED' },
  actorUserId: string,
  metadata: RequestMetadata,
) {
  const updated = await withAuditedTransaction(async (tx, audit) => {
    const updated = await tx.user.update({ where: { id }, data: input, select: publicUserSelect });
    if (input.status === 'SUSPENDED' || input.status === 'DISABLED') {
      const revokedAt = new Date();
      await tx.session.updateMany({
        where: { userId: id, revokedAt: null },
        data: { revokedAt, revokeReason: `account_${input.status.toLowerCase()}` },
      });
      await tx.refreshToken.updateMany({
        where: { userId: id, revokedAt: null },
        data: { revokedAt },
      });
    }
    await audit({
      actorUserId,
      action: 'user.updated',
      entityType: 'user',
      entityId: id,
      metadata: { fields: Object.keys(input) },
      ...metadata,
    });
    return updated;
  });
  if (input.status === 'SUSPENDED' || input.status === 'DISABLED') {
    await publishChatRevocation(id);
  }
  return updated;
}
