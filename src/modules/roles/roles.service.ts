import { prisma } from '#app/lib/prisma.js';
import { withAuditedTransaction } from '#app/lib/audited-transaction.js';
import type { RequestMetadata } from '#app/lib/request-metadata.js';

export async function listRoles() {
  return prisma.role.findMany({
    where: { deletedAt: null },
    orderBy: { name: 'asc' },
    include: {
      permissions: {
        where: { deletedAt: null },
        select: { permission: { select: { code: true, description: true } } },
      },
    },
  });
}

export async function createRole(
  input: { name: string; description?: string; permissions: string[] },
  actorUserId: string,
  metadata: RequestMetadata,
) {
  return withAuditedTransaction(async (tx, audit) => {
    const role = await tx.role.create({
      data: {
        name: input.name,
        description: input.description,
        permissions: {
          create: input.permissions.map((code) => ({ permission: { connect: { code } } })),
        },
      },
    });
    await audit({
      actorUserId,
      action: 'role.created',
      entityType: 'role',
      entityId: role.id,
      ...metadata,
    });
    return role;
  });
}

export async function assignRole(
  input: { userId: string; roleId: string },
  actorUserId: string,
  metadata: RequestMetadata,
) {
  return withAuditedTransaction(async (tx, audit) => {
    const assignment = await tx.userRole.upsert({
      where: { userId_roleId: input },
      create: input,
      update: { deletedAt: null },
    });
    await tx.user.update({
      where: { id: input.userId },
      data: { permissionEpoch: { increment: 1 } },
    });
    await audit({
      actorUserId,
      action: 'role.assigned',
      entityType: 'user',
      entityId: input.userId,
      metadata: { roleId: input.roleId },
      ...metadata,
    });
    return assignment;
  });
}
