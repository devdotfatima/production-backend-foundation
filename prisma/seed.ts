import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

const permissions = [
  ['users:read', 'View users'],
  ['users:write', 'Create and update users'],
  ['roles:read', 'View roles and permissions'],
  ['roles:write', 'Manage global roles and permissions'],
  ['audit:read', 'View audit events'],
  ['outbox:read', 'View dead-lettered outbox events'],
  ['outbox:write', 'Redrive dead-lettered outbox events'],
  ['organizations:read', 'View organization details'],
  ['organizations:write', 'Create and update organizations'],
  ['members:read', 'View organization members'],
  ['members:write', 'Change and remove organization members'],
  ['invitations:write', 'Invite and revoke organization invitations'],
  ['billing:read', 'View organization billing, subscriptions, payments, and payment methods'],
  ['billing:write', 'Manage organization billing, subscriptions, charges, and refunds'],
  ['scheduler:read', 'View scheduled job status'],
  ['scheduler:write', 'Trigger scheduled jobs manually'],
] as const;

/**
 * Scope comes from how a role is *granted*, not from the role definition:
 * `UserRole` is a global grant that satisfies a check anywhere, while `Membership` grants the
 * same role only inside one organization. System roles therefore stay global definitions
 * (`organizationId = null`) so every organization can assign them.
 */
const systemRoles = [
  {
    name: 'admin',
    description: 'Global administrator',
    permissions: permissions.map(([code]) => code),
  },
  {
    name: 'owner',
    description: 'Organization owner',
    permissions: [
      'organizations:read',
      'organizations:write',
      'members:read',
      'members:write',
      'invitations:write',
      'billing:read',
      'billing:write',
      'audit:read',
    ],
  },
  {
    name: 'member',
    description: 'Organization member',
    permissions: ['organizations:read', 'members:read'],
  },
] as const;

/**
 * A composite unique containing a NULL cannot be used in a Prisma `where`, so global roles are
 * resolved by filter. Uniqueness is still enforced by the `roles_global_name_key` partial index.
 */
async function upsertGlobalRole(name: string, description: string): Promise<string> {
  const existing = await prisma.role.findFirst({ where: { name, organizationId: null } });
  if (existing) {
    await prisma.role.update({
      where: { id: existing.id },
      data: { description, isSystem: true, deletedAt: null },
    });
    return existing.id;
  }
  const created = await prisma.role.create({
    data: { name, description, isSystem: true },
  });
  return created.id;
}

async function main(): Promise<void> {
  for (const [code, description] of permissions) {
    await prisma.permission.upsert({
      where: { code },
      create: { code, description },
      update: { description, deletedAt: null },
    });
  }

  const permissionIdByCode = new Map(
    (await prisma.permission.findMany({ where: { deletedAt: null } })).map((permission) => [
      permission.code,
      permission.id,
    ]),
  );

  const roleIdByName = new Map<string, string>();
  for (const role of systemRoles) {
    const roleId = await upsertGlobalRole(role.name, role.description);
    roleIdByName.set(role.name, roleId);

    for (const code of role.permissions) {
      const permissionId = permissionIdByCode.get(code);
      if (!permissionId) throw new Error(`Seed references an unknown permission: ${code}`);
      await prisma.rolePermission.upsert({
        where: { roleId_permissionId: { roleId, permissionId } },
        create: { roleId, permissionId },
        update: { deletedAt: null },
      });
    }
  }

  const bootstrapEmail = process.env.BOOTSTRAP_ADMIN_EMAIL?.trim().toLowerCase();
  if (bootstrapEmail) {
    const adminRoleId = roleIdByName.get('admin')!;
    const user = await prisma.user.findUnique({ where: { email: bootstrapEmail } });
    if (!user) throw new Error(`BOOTSTRAP_ADMIN_EMAIL user does not exist: ${bootstrapEmail}`);
    await prisma.userRole.upsert({
      where: { userId_roleId: { userId: user.id, roleId: adminRoleId } },
      create: { userId: user.id, roleId: adminRoleId },
      update: { deletedAt: null },
    });
  }
}

main()
  .then(() => prisma.$disconnect())
  .catch(async (error: unknown) => {
    process.stderr.write(`${String(error)}\n`);
    await prisma.$disconnect();
    process.exit(1);
  });
