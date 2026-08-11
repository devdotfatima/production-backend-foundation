import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => {
  const transaction = {
    role: { findFirst: vi.fn(), findUniqueOrThrow: vi.fn() },
    permission: { findMany: vi.fn() },
    rolePermission: { findMany: vi.fn(), updateMany: vi.fn(), upsert: vi.fn() },
    userRole: { updateMany: vi.fn() },
    user: { update: vi.fn(), updateMany: vi.fn() },
    auditEvent: { create: vi.fn() },
  };
  return {
    transaction,
    prisma: { $transaction: vi.fn() },
  };
});

vi.mock('#app/lib/prisma.js', () => ({ prisma: mocks.prisma }));

import { revokeRole, updateRolePermissions } from '../dist/src/modules/roles/roles.service.js';

const metadata = { ip: '127.0.0.1', requestId: 'request-id', userAgent: 'test' };
const roleId = 'role-1';

describe('role-permission-set changes invalidate every current holder', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.prisma.$transaction.mockImplementation(
      (callback: (tx: typeof mocks.transaction) => Promise<unknown>) => callback(mocks.transaction),
    );
    mocks.transaction.auditEvent.create.mockResolvedValue({});
    mocks.transaction.role.findFirst.mockResolvedValue({ id: roleId, deletedAt: null });
    mocks.transaction.role.findUniqueOrThrow.mockResolvedValue({ id: roleId, permissions: [] });
    mocks.transaction.rolePermission.updateMany.mockResolvedValue({ count: 1 });
    mocks.transaction.rolePermission.upsert.mockResolvedValue({});
    mocks.transaction.user.updateMany.mockResolvedValue({ count: 3 });
  });

  it('bumps the epoch for every active holder of the role, not just one user', async () => {
    mocks.transaction.permission.findMany.mockResolvedValue([
      { id: 'perm-read', code: 'roles:read' },
      { id: 'perm-write', code: 'roles:write' },
    ]);
    mocks.transaction.rolePermission.findMany.mockResolvedValue([
      { permissionId: 'perm-read' },
      { permissionId: 'perm-stale' },
    ]);

    await updateRolePermissions(roleId, ['roles:read', 'roles:write'], 'actor-1', metadata);

    expect(mocks.transaction.rolePermission.updateMany).toHaveBeenCalledWith({
      where: { roleId, permissionId: { in: ['perm-stale'] } },
      data: { deletedAt: expect.any(Date) as Date },
    });
    expect(mocks.transaction.rolePermission.upsert).toHaveBeenCalledTimes(1);
    expect(mocks.transaction.rolePermission.upsert).toHaveBeenCalledWith({
      where: { roleId_permissionId: { roleId, permissionId: 'perm-write' } },
      create: { roleId, permissionId: 'perm-write' },
      update: { deletedAt: null },
    });
    expect(mocks.transaction.user.updateMany).toHaveBeenCalledWith({
      where: { roles: { some: { roleId, deletedAt: null } } },
      data: { permissionEpoch: { increment: 1 } },
    });
    const audit = mocks.transaction.auditEvent.create.mock.calls[0]?.[0] as {
      data?: { action?: unknown };
    };
    expect(audit.data?.action).toBe('role.permissions_updated');
  });

  it('rejects unknown permission codes without mutating anything', async () => {
    mocks.transaction.permission.findMany.mockResolvedValue([
      { id: 'perm-read', code: 'roles:read' },
    ]);

    await expect(
      updateRolePermissions(roleId, ['roles:read', 'not-a-real-permission'], 'actor-1', metadata),
    ).rejects.toMatchObject({ statusCode: 400 });

    expect(mocks.transaction.rolePermission.updateMany).not.toHaveBeenCalled();
    expect(mocks.transaction.rolePermission.upsert).not.toHaveBeenCalled();
    expect(mocks.transaction.user.updateMany).not.toHaveBeenCalled();
  });
});

describe('revoking a role invalidates the specific user it was removed from', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.prisma.$transaction.mockImplementation(
      (callback: (tx: typeof mocks.transaction) => Promise<unknown>) => callback(mocks.transaction),
    );
    mocks.transaction.auditEvent.create.mockResolvedValue({});
  });

  it('soft-deletes the assignment and bumps that user epoch', async () => {
    mocks.transaction.userRole.updateMany.mockResolvedValue({ count: 1 });

    const result = await revokeRole({ userId: 'user-1', roleId }, 'actor-1', metadata);

    expect(result).toBe(true);
    expect(mocks.transaction.user.update).toHaveBeenCalledWith({
      where: { id: 'user-1' },
      data: { permissionEpoch: { increment: 1 } },
    });
    const audit = mocks.transaction.auditEvent.create.mock.calls[0]?.[0] as {
      data?: { action?: unknown };
    };
    expect(audit.data?.action).toBe('role.revoked');
  });

  it('does nothing when the assignment is already inactive', async () => {
    mocks.transaction.userRole.updateMany.mockResolvedValue({ count: 0 });

    const result = await revokeRole({ userId: 'user-1', roleId }, 'actor-1', metadata);

    expect(result).toBe(false);
    expect(mocks.transaction.user.update).not.toHaveBeenCalled();
    expect(mocks.transaction.auditEvent.create).not.toHaveBeenCalled();
  });
});
