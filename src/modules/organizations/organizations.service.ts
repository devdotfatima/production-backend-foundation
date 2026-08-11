import { Prisma } from '@prisma/client';
import { env } from '#app/config/env.js';
import { withAuditedTransaction } from '#app/lib/audited-transaction.js';
import {
  candidateOpaqueTokenHashes,
  encryptSecret,
  hashOpaqueToken,
  randomToken,
} from '#app/lib/crypto.js';
import { paginateCursor } from '#app/lib/cursor-pagination.js';
import { errors } from '#app/lib/errors.js';
import { prisma } from '#app/lib/prisma.js';
import type { RequestMetadata } from '#app/lib/request-metadata.js';
import { findGlobalRoleId } from '#app/modules/organizations/organizations.tenancy.js';
import { publishChatRevocation } from '#app/modules/chat/chat.revocations.js';
import { addOutboxEvent } from '#app/modules/outbox/outbox.service.js';

const INVITATION_TTL_MS = 7 * 24 * 60 * 60 * 1000;

const organizationSelect = {
  id: true,
  slug: true,
  name: true,
  status: true,
  settings: true,
  createdAt: true,
  updatedAt: true,
} as const;

const membershipSelect = {
  id: true,
  userId: true,
  status: true,
  joinedAt: true,
  createdAt: true,
  role: { select: { id: true, name: true } },
  user: { select: { id: true, email: true, displayName: true } },
} as const;

function slugify(value: string): string {
  const slug = value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 64);
  if (slug.length < 2) throw errors.badRequest('Organization name must yield a usable slug');
  return slug;
}

/**
 * A role may be assigned inside an organization only when it is a global system role or one the
 * organization owns. Without this an attacker could grant themselves another tenant's role.
 */
async function assertAssignableRole(
  tx: Prisma.TransactionClient,
  roleId: string,
  organizationId: string,
): Promise<{ id: string; name: string }> {
  const role = await tx.role.findFirst({
    where: { id: roleId, deletedAt: null, OR: [{ organizationId: null }, { organizationId }] },
    select: { id: true, name: true },
  });
  if (!role) throw errors.badRequest('Role is not assignable in this organization');
  return role;
}

/** Serializes owner-changing operations for one organization across every API replica. */
async function lockOrganizationMemberships(
  tx: Prisma.TransactionClient,
  organizationId: string,
): Promise<void> {
  await tx.$executeRaw(
    Prisma.sql`SELECT pg_advisory_xact_lock(hashtextextended(${'organization-owners:' + organizationId}, 0))`,
  );
}

async function countActiveOwners(
  tx: Prisma.TransactionClient,
  organizationId: string,
): Promise<number> {
  return tx.membership.count({
    where: {
      organizationId,
      status: 'ACTIVE',
      deletedAt: null,
      role: { name: 'owner', deletedAt: null },
    },
  });
}

export async function listMyOrganizations(userId: string) {
  const memberships = await prisma.membership.findMany({
    where: { userId, status: 'ACTIVE', deletedAt: null, organization: { deletedAt: null } },
    orderBy: { createdAt: 'asc' },
    select: {
      role: { select: { id: true, name: true } },
      organization: { select: organizationSelect },
    },
  });
  return memberships.map((membership) => ({
    ...membership.organization,
    role: membership.role,
  }));
}

export async function getOrganization(organizationId: string) {
  const organization = await prisma.organization.findFirst({
    where: { id: organizationId, deletedAt: null },
    select: organizationSelect,
  });
  if (!organization) throw errors.notFound('Organization not found');
  return organization;
}

export async function createOrganization(
  input: { name: string; slug?: string },
  actorUserId: string,
  metadata: RequestMetadata,
) {
  if (env.TENANCY_MODE !== 'multi') {
    throw errors.conflict('Organizations can only be created when TENANCY_MODE=multi');
  }
  const slug = input.slug ?? slugify(input.name);

  return withAuditedTransaction(async (tx, audit) => {
    const existing = await tx.organization.findFirst({ where: { slug }, select: { id: true } });
    if (existing) throw errors.conflict('Organization slug is already taken');

    const organization = await tx.organization.create({
      data: { slug, name: input.name },
      select: organizationSelect,
    });
    // The creator becomes owner; otherwise a new organization would be unmanageable.
    await tx.membership.create({
      data: {
        organizationId: organization.id,
        userId: actorUserId,
        roleId: await findGlobalRoleId(tx, 'owner'),
        status: 'ACTIVE',
        joinedAt: new Date(),
      },
    });
    await tx.user.update({
      where: { id: actorUserId },
      data: { permissionEpoch: { increment: 1 } },
    });
    await audit({
      actorUserId,
      action: 'organization.created',
      entityType: 'organization',
      entityId: organization.id,
      metadata: { slug },
      ...metadata,
    });
    return organization;
  });
}

export async function updateOrganization(
  organizationId: string,
  input: { name?: string; settings?: Record<string, unknown> },
  actorUserId: string,
  metadata: RequestMetadata,
) {
  return withAuditedTransaction(async (tx, audit) => {
    const updated = await tx.organization.updateMany({
      where: { id: organizationId, deletedAt: null },
      data: {
        ...(input.name === undefined ? {} : { name: input.name }),
        ...(input.settings === undefined
          ? {}
          : { settings: input.settings as Prisma.InputJsonValue }),
      },
    });
    if (updated.count === 0) throw errors.notFound('Organization not found');

    await audit({
      actorUserId,
      action: 'organization.updated',
      entityType: 'organization',
      entityId: organizationId,
      metadata: { fields: Object.keys(input) },
      ...metadata,
    });
    return tx.organization.findFirstOrThrow({
      where: { id: organizationId },
      select: organizationSelect,
    });
  });
}

/** Rewrites the session's authoritative tenant after proving active membership. */
export async function switchOrganization(
  userId: string,
  sessionId: string,
  organizationId: string,
  metadata: RequestMetadata,
) {
  const organization = await withAuditedTransaction(async (tx, audit) => {
    const membership = await tx.membership.findFirst({
      where: {
        userId,
        organizationId,
        status: 'ACTIVE',
        deletedAt: null,
        organization: { status: 'ACTIVE', deletedAt: null },
      },
      select: { id: true },
    });
    if (!membership) throw errors.forbidden('You are not an active member of that organization');

    const switched = await tx.session.updateMany({
      where: { id: sessionId, userId, revokedAt: null, deletedAt: null },
      data: { activeOrganizationId: organizationId },
    });
    if (switched.count === 0) throw errors.unauthenticated();

    await audit({
      actorUserId: userId,
      action: 'organization.switched',
      entityType: 'organization',
      entityId: organizationId,
      ...metadata,
    });
    return getOrganizationInTransaction(tx, organizationId);
  });
  // A live socket is bound to the previous tenant identity and rooms until reconnect.
  await publishChatRevocation(userId);
  return organization;
}

async function getOrganizationInTransaction(tx: Prisma.TransactionClient, organizationId: string) {
  return tx.organization.findFirstOrThrow({
    where: { id: organizationId },
    select: organizationSelect,
  });
}

export async function listMembers(
  organizationId: string,
  input: { cursor?: string; limit: number },
) {
  const page = await paginateCursor(input, (pagination) =>
    prisma.membership.findMany({
      where: { organizationId, deletedAt: null },
      ...pagination,
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
      select: membershipSelect,
    }),
  );
  return { members: page.items, nextCursor: page.nextCursor };
}

export async function changeMemberRole(
  organizationId: string,
  userId: string,
  roleId: string,
  actorUserId: string,
  metadata: RequestMetadata,
) {
  return withAuditedTransaction(async (tx, audit) => {
    await lockOrganizationMemberships(tx, organizationId);
    const newRole = await assertAssignableRole(tx, roleId, organizationId);
    const target = await tx.membership.findFirst({
      where: { organizationId, userId, deletedAt: null },
      select: { id: true, status: true, role: { select: { name: true } } },
    });
    if (!target) throw errors.notFound('Membership not found');
    if (
      target.status === 'ACTIVE' &&
      target.role.name === 'owner' &&
      newRole.name !== 'owner' &&
      (await countActiveOwners(tx, organizationId)) <= 1
    ) {
      throw errors.conflict('An organization must keep at least one active owner');
    }

    const changed = await tx.membership.updateMany({
      where: { id: target.id, deletedAt: null },
      data: { roleId },
    });
    if (changed.count === 0) throw errors.notFound('Membership not found');

    // The affected member's cached permission decisions must not outlive the change.
    await tx.user.update({ where: { id: userId }, data: { permissionEpoch: { increment: 1 } } });
    await audit({
      actorUserId,
      action: 'organization.member.role_changed',
      entityType: 'membership',
      entityId: `${organizationId}:${userId}`,
      metadata: { organizationId, userId, roleId },
      ...metadata,
    });
    return tx.membership.findFirstOrThrow({
      where: { organizationId, userId },
      select: membershipSelect,
    });
  });
}

export async function removeMember(
  organizationId: string,
  userId: string,
  actorUserId: string,
  metadata: RequestMetadata,
): Promise<void> {
  await withAuditedTransaction(async (tx, audit) => {
    await lockOrganizationMemberships(tx, organizationId);
    const target = await tx.membership.findFirst({
      where: { organizationId, userId, deletedAt: null },
      select: { id: true, status: true, role: { select: { name: true } } },
    });
    if (!target) throw errors.notFound('Membership not found');
    if (
      target.status === 'ACTIVE' &&
      target.role.name === 'owner' &&
      (await countActiveOwners(tx, organizationId)) <= 1
    ) {
      throw errors.conflict('An organization must keep at least one active owner');
    }

    await tx.membership.update({
      where: { id: target.id },
      data: { deletedAt: new Date(), status: 'SUSPENDED' },
    });
    // Sessions pinned to this organization must stop resolving it immediately.
    await tx.session.updateMany({
      where: { userId, activeOrganizationId: organizationId },
      data: { activeOrganizationId: null },
    });
    await tx.user.update({ where: { id: userId }, data: { permissionEpoch: { increment: 1 } } });
    await audit({
      actorUserId,
      action: 'organization.member.removed',
      entityType: 'membership',
      entityId: `${organizationId}:${userId}`,
      metadata: { organizationId, userId },
      ...metadata,
    });
  });
  await publishChatRevocation(userId);
}

export async function createInvitation(
  organizationId: string,
  input: { email: string; roleId: string },
  actorUserId: string,
  metadata: RequestMetadata,
) {
  const token = randomToken(32);
  const email = input.email.trim().toLowerCase();

  const invitation = await withAuditedTransaction(async (tx, audit) => {
    await assertAssignableRole(tx, input.roleId, organizationId);
    const organization = await tx.organization.findFirstOrThrow({
      where: { id: organizationId, deletedAt: null },
      select: { name: true },
    });
    const invitedUser = await tx.user.findFirst({
      where: { email, deletedAt: null },
      select: { id: true, locale: true },
    });

    const created = await tx.invitation.create({
      data: {
        organizationId,
        email,
        roleId: input.roleId,
        tokenHash: hashOpaqueToken(token),
        expiresAt: new Date(Date.now() + INVITATION_TTL_MS),
        invitedByUserId: actorUserId,
      },
      select: { id: true, email: true, expiresAt: true, createdAt: true },
    });
    await addOutboxEvent(tx, {
      aggregateType: 'invitation',
      aggregateId: created.id,
      eventType: 'organization.invitation',
      channel: 'EMAIL',
      payload: {
        destination: email,
        invitationId: created.id,
        encryptedToken: encryptSecret(token),
        organizationId,
        organizationName: organization.name,
        expiresInDays: '7',
        ...(invitedUser ? { userId: invitedUser.id, locale: invitedUser.locale } : {}),
      },
      dedupeKey: `organization-invitation:${created.id}`,
      expiresAt: created.expiresAt,
    });
    await audit({
      actorUserId,
      action: 'organization.invitation.created',
      entityType: 'invitation',
      entityId: created.id,
      metadata: { organizationId, email },
      ...metadata,
    });
    return created;
  });

  // Shown once; only the hash is stored.
  return { ...invitation, token };
}

export async function acceptInvitation(
  rawToken: string,
  userId: string,
  metadata: RequestMetadata,
) {
  return withAuditedTransaction(async (tx, audit) => {
    const invitation = await tx.invitation.findFirst({
      where: {
        tokenHash: { in: candidateOpaqueTokenHashes(rawToken) },
        acceptedAt: null,
        revokedAt: null,
        deletedAt: null,
        expiresAt: { gt: new Date() },
        organization: { status: 'ACTIVE', deletedAt: null },
      },
      select: { id: true, organizationId: true, email: true, roleId: true },
    });
    if (!invitation) throw errors.notFound('Invitation is invalid or has expired');

    const user = await tx.user.findFirst({
      where: { id: userId, deletedAt: null },
      select: { email: true, emailVerifiedAt: true },
    });
    // Otherwise a leaked invitation link would let any authenticated account join the tenant.
    if (
      !user?.email ||
      !user.emailVerifiedAt ||
      user.email.toLowerCase() !== invitation.email.toLowerCase()
    ) {
      throw errors.forbidden('This invitation was issued to a different verified email address');
    }

    await tx.membership.upsert({
      where: {
        organizationId_userId: { organizationId: invitation.organizationId, userId },
      },
      create: {
        organizationId: invitation.organizationId,
        userId,
        roleId: invitation.roleId,
        status: 'ACTIVE',
        joinedAt: new Date(),
      },
      update: {
        roleId: invitation.roleId,
        status: 'ACTIVE',
        deletedAt: null,
        joinedAt: new Date(),
      },
    });
    await tx.invitation.update({
      where: { id: invitation.id },
      data: { acceptedAt: new Date() },
    });
    await tx.user.update({ where: { id: userId }, data: { permissionEpoch: { increment: 1 } } });
    await audit({
      actorUserId: userId,
      action: 'organization.invitation.accepted',
      entityType: 'invitation',
      entityId: invitation.id,
      metadata: { organizationId: invitation.organizationId },
      ...metadata,
    });
    return getOrganizationInTransaction(tx, invitation.organizationId);
  });
}

export async function revokeInvitation(
  organizationId: string,
  invitationId: string,
  actorUserId: string,
  metadata: RequestMetadata,
): Promise<void> {
  await withAuditedTransaction(async (tx, audit) => {
    const revoked = await tx.invitation.updateMany({
      where: { id: invitationId, organizationId, acceptedAt: null, revokedAt: null },
      data: { revokedAt: new Date() },
    });
    if (revoked.count === 0) throw errors.notFound('Invitation not found');

    await audit({
      actorUserId,
      action: 'organization.invitation.revoked',
      entityType: 'invitation',
      entityId: invitationId,
      metadata: { organizationId },
      ...metadata,
    });
  });
}
