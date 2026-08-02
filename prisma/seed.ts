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
  ['service-accounts:write', 'Manage service accounts and API keys'],
] as const;

async function main(): Promise<void> {
  for (const [code, description] of permissions) {
    await prisma.permission.upsert({
      where: { code },
      create: { code, description },
      update: { description, deletedAt: null },
    });
  }

  const admin = await prisma.role.upsert({
    where: { name: 'admin' },
    create: { name: 'admin', description: 'Global administrator', isSystem: true },
    update: { deletedAt: null },
  });

  const allPermissions = await prisma.permission.findMany({ where: { deletedAt: null } });
  for (const permission of allPermissions) {
    await prisma.rolePermission.upsert({
      where: { roleId_permissionId: { roleId: admin.id, permissionId: permission.id } },
      create: { roleId: admin.id, permissionId: permission.id },
      update: { deletedAt: null },
    });
  }

  const bootstrapEmail = process.env.BOOTSTRAP_ADMIN_EMAIL?.trim().toLowerCase();
  if (bootstrapEmail) {
    const user = await prisma.user.findUnique({ where: { email: bootstrapEmail } });
    if (!user) throw new Error(`BOOTSTRAP_ADMIN_EMAIL user does not exist: ${bootstrapEmail}`);
    await prisma.userRole.upsert({
      where: { userId_roleId: { userId: user.id, roleId: admin.id } },
      create: { userId: user.id, roleId: admin.id },
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
