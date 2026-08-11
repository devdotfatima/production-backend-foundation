import type { Prisma } from '@prisma/client';
import { env } from '#app/config/env.js';

export const DEFAULT_ORGANIZATION_SLUG = 'default';
export const DEFAULT_ORGANIZATION_NAME = 'Default';

/** System roles are global definitions (`organizationId = null`) that any organization assigns. */
export async function findGlobalRoleId(
  tx: Prisma.TransactionClient,
  name: string,
): Promise<string> {
  const role = await tx.role.findFirst({
    where: { name, organizationId: null, deletedAt: null },
    select: { id: true },
  });
  if (!role) {
    throw new Error(
      `System role "${name}" is missing. Run \`npm run db:seed\` before enabling TENANCY_MODE.`,
    );
  }
  return role.id;
}

/**
 * The organization a new session starts in.
 *
 * `single` mode creates one implicit organization on demand and joins every user to it, so a
 * B2C product gets tenant-correct data without exposing organization concepts. `multi` resumes
 * the user's earliest active membership; a user with none operates without a tenant until they
 * create an organization or accept an invitation.
 */
export async function resolveInitialOrganizationId(
  tx: Prisma.TransactionClient,
  userId: string,
): Promise<string | null> {
  if (env.TENANCY_MODE === 'disabled') return null;

  if (env.TENANCY_MODE === 'single') {
    const organization = await tx.organization.upsert({
      where: { slug: DEFAULT_ORGANIZATION_SLUG },
      create: { slug: DEFAULT_ORGANIZATION_SLUG, name: DEFAULT_ORGANIZATION_NAME },
      update: {},
      select: { id: true },
    });
    const roleId = await findGlobalRoleId(tx, 'member');
    await tx.membership.upsert({
      where: { organizationId_userId: { organizationId: organization.id, userId } },
      create: {
        organizationId: organization.id,
        userId,
        roleId,
        status: 'ACTIVE',
        joinedAt: new Date(),
      },
      update: { status: 'ACTIVE', deletedAt: null },
    });
    return organization.id;
  }

  const membership = await tx.membership.findFirst({
    where: { userId, status: 'ACTIVE', deletedAt: null },
    orderBy: { createdAt: 'asc' },
    select: { organizationId: true },
  });
  return membership?.organizationId ?? null;
}
