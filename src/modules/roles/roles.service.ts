import type { Prisma } from '@prisma/client';
import { prisma } from '#app/lib/prisma.js';
import { withAuditedTransaction } from '#app/lib/audited-transaction.js';
import { errors } from '#app/lib/errors.js';
import type { RequestMetadata } from '#app/lib/request-metadata.js';

const rolePermissionSelect = {
  permissions: {
    where: { deletedAt: null },
    select: { permission: { select: { code: true, description: true } } },
  },
} as const;

/**
 * Every active holder of a role must be invalidated whenever the role's permission
 * set changes, not just the user targeted by the current mutation — otherwise a
 * cached `requirePermission` decision for another holder stays valid for up to the
 * cache TTL after their access was revoked.
 */
async function bumpPermissionEpochForRoleHolders(
  tx: Prisma.TransactionClient,
  roleId: string,
): Promise<void> {
  await tx.user.updateMany({
    where: { roles: { some: { roleId, deletedAt: null } } },
    data: { permissionEpoch: { increment: 1 } },
  });
}

export async function listRoles() {
  return prisma.role.findMany({
    where: { deletedAt: null },
    orderBy: { name: 'asc' },
    include: rolePermissionSelect,
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
    const role = await tx.role.findFirst({
      where: { id: input.roleId, organizationId: null, deletedAt: null },
      select: { id: true },
    });
    if (!role) {
      throw errors.badRequest(
        'Platform role assignment requires a global role; organization roles belong on memberships',
      );
    }
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

export async function revokeRole(
  input: { userId: string; roleId: string },
  actorUserId: string,
  metadata: RequestMetadata,
): Promise<boolean> {
  return withAuditedTransaction(async (tx, audit) => {
    const revoked = await tx.userRole.updateMany({
      where: { userId: input.userId, roleId: input.roleId, deletedAt: null },
      data: { deletedAt: new Date() },
    });
    if (revoked.count === 0) return false;

    await tx.user.update({
      where: { id: input.userId },
      data: { permissionEpoch: { increment: 1 } },
    });
    await audit({
      actorUserId,
      action: 'role.revoked',
      entityType: 'user',
      entityId: input.userId,
      metadata: { roleId: input.roleId },
      ...metadata,
    });
    return true;
  });
}

export async function updateRolePermissions(
  roleId: string,
  permissionCodes: string[],
  actorUserId: string,
  metadata: RequestMetadata,
) {
  return withAuditedTransaction(async (tx, audit) => {
    const role = await tx.role.findFirst({ where: { id: roleId, deletedAt: null } });
    if (!role) throw errors.notFound('Role not found');

    const uniqueCodes = [...new Set(permissionCodes)];
    const permissions = await tx.permission.findMany({
      where: { code: { in: uniqueCodes }, deletedAt: null },
      select: { id: true, code: true },
    });
    if (permissions.length !== uniqueCodes.length) {
      const found = new Set(permissions.map((permission) => permission.code));
      const missing = uniqueCodes.filter((code) => !found.has(code));
      throw errors.badRequest(`Unknown permission codes: ${missing.join(', ')}`);
    }

    const current = await tx.rolePermission.findMany({
      where: { roleId, deletedAt: null },
      select: { permissionId: true },
    });
    const currentIds = new Set(current.map((row) => row.permissionId));
    const desiredIds = new Set(permissions.map((permission) => permission.id));

    const toRemove = [...currentIds].filter((id) => !desiredIds.has(id));
    if (toRemove.length > 0) {
      await tx.rolePermission.updateMany({
        where: { roleId, permissionId: { in: toRemove } },
        data: { deletedAt: new Date() },
      });
    }
    for (const permissionId of desiredIds) {
      if (currentIds.has(permissionId)) continue;
      await tx.rolePermission.upsert({
        where: { roleId_permissionId: { roleId, permissionId } },
        create: { roleId, permissionId },
        update: { deletedAt: null },
      });
    }

    if (role.organizationId) {
      await tx.organization.update({
        where: { id: role.organizationId },
        data: { permissionEpoch: { increment: 1 } },
      });
    } else {
      await bumpPermissionEpochForRoleHolders(tx, roleId);
    }
    await audit({
      actorUserId,
      action: 'role.permissions_updated',
      entityType: 'role',
      entityId: roleId,
      metadata: { permissions: uniqueCodes },
      ...metadata,
    });

    return tx.role.findUniqueOrThrow({ where: { id: roleId }, include: rolePermissionSelect });
  });
}
