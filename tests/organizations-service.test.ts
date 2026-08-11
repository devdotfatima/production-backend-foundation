import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  tenancyMode: 'multi',
  transaction: {
    $executeRaw: vi.fn(),
    organization: {
      upsert: vi.fn(),
      findFirst: vi.fn(),
      findFirstOrThrow: vi.fn(),
      create: vi.fn(),
      updateMany: vi.fn(),
    },
    membership: {
      upsert: vi.fn(),
      findFirst: vi.fn(),
      count: vi.fn(),
      update: vi.fn(),
      updateMany: vi.fn(),
      create: vi.fn(),
      findFirstOrThrow: vi.fn(),
    },
    invitation: { create: vi.fn(), findFirst: vi.fn(), update: vi.fn(), updateMany: vi.fn() },
    outboxEvent: { create: vi.fn() },
    role: { findFirst: vi.fn() },
    user: { update: vi.fn(), findFirst: vi.fn() },
    session: { updateMany: vi.fn() },
  },
  audit: vi.fn(),
  hashOpaqueToken: vi.fn((value: string) => `hash:${value}`),
  candidateOpaqueTokenHashes: vi.fn((value: string) => [`hash:${value}`]),
  randomToken: vi.fn(() => 'invitation-secret-token'),
  encryptSecret: vi.fn((value: string) => `encrypted:${value}`),
}));

vi.mock('#app/config/env.js', () => ({
  env: {
    get TENANCY_MODE() {
      return mocks.tenancyMode;
    },
  },
}));
vi.mock('#app/lib/prisma.js', () => ({ prisma: mocks.transaction }));
vi.mock('#app/lib/audited-transaction.js', () => ({
  withAuditedTransaction: (operation: (tx: unknown, audit: unknown) => Promise<unknown>) =>
    operation(mocks.transaction, mocks.audit),
}));
vi.mock('#app/lib/crypto.js', () => ({
  hashOpaqueToken: mocks.hashOpaqueToken,
  candidateOpaqueTokenHashes: mocks.candidateOpaqueTokenHashes,
  randomToken: mocks.randomToken,
  encryptSecret: mocks.encryptSecret,
}));
vi.mock('#app/lib/cursor-pagination.js', () => ({
  paginateCursor: vi.fn(async () => ({ items: [], nextCursor: null })),
}));

import {
  acceptInvitation,
  changeMemberRole,
  createInvitation,
  createOrganization,
  removeMember,
  switchOrganization,
} from '../dist/src/modules/organizations/organizations.service.js';
import { resolveInitialOrganizationId } from '../dist/src/modules/organizations/organizations.tenancy.js';

/** The mock only implements the delegates this module touches. */
const tx = mocks.transaction as unknown as Parameters<typeof resolveInitialOrganizationId>[0];

const actor = '00000000-0000-7000-8000-0000000000a1';
const member = '00000000-0000-7000-8000-0000000000b2';
const orgId = '00000000-0000-7000-8000-00000000000a';
const otherOrgId = '00000000-0000-7000-8000-00000000000b';
const roleId = '00000000-0000-7000-8000-0000000000r1';
const metadata = { ip: '203.0.113.7', userAgent: 'test', requestId: 'req-1' };

beforeEach(() => {
  vi.clearAllMocks();
  mocks.tenancyMode = 'multi';
  mocks.transaction.$executeRaw.mockResolvedValue(0);
});

describe('single-mode bootstrap', () => {
  it('does nothing when tenancy is disabled', async () => {
    mocks.tenancyMode = 'disabled';
    await expect(resolveInitialOrganizationId(tx, actor)).resolves.toBeNull();
    expect(mocks.transaction.organization.upsert).not.toHaveBeenCalled();
  });

  it('creates the implicit organization on demand and joins the user', async () => {
    mocks.tenancyMode = 'single';
    mocks.transaction.organization.upsert.mockResolvedValue({ id: orgId });
    mocks.transaction.role.findFirst.mockResolvedValue({ id: roleId });

    await expect(resolveInitialOrganizationId(tx, actor)).resolves.toBe(orgId);

    expect(mocks.transaction.organization.upsert).toHaveBeenCalledWith(
      expect.objectContaining({ where: { slug: 'default' } }),
    );
    expect(mocks.transaction.membership.upsert).toHaveBeenCalled();
  });

  it('fails loudly when the system roles were never seeded', async () => {
    mocks.tenancyMode = 'single';
    mocks.transaction.organization.upsert.mockResolvedValue({ id: orgId });
    mocks.transaction.role.findFirst.mockResolvedValue(null);

    await expect(resolveInitialOrganizationId(tx, actor)).rejects.toThrow(/db:seed/);
  });

  it('resumes an existing membership in multi mode without creating anything', async () => {
    mocks.transaction.membership.findFirst.mockResolvedValue({ organizationId: orgId });

    await expect(resolveInitialOrganizationId(tx, actor)).resolves.toBe(orgId);
    expect(mocks.transaction.organization.upsert).not.toHaveBeenCalled();
  });

  it('leaves a user with no membership tenant-less', async () => {
    mocks.transaction.membership.findFirst.mockResolvedValue(null);
    await expect(resolveInitialOrganizationId(tx, actor)).resolves.toBeNull();
  });
});

describe('organization creation', () => {
  it('is refused unless tenancy is multi', async () => {
    mocks.tenancyMode = 'single';
    await expect(createOrganization({ name: 'Acme' }, actor, metadata)).rejects.toMatchObject({
      statusCode: 409,
    });
  });

  it('makes the creator an owner so the organization is manageable', async () => {
    mocks.transaction.organization.findFirst.mockResolvedValue(null);
    mocks.transaction.organization.create.mockResolvedValue({ id: orgId, slug: 'acme' });
    mocks.transaction.role.findFirst.mockResolvedValue({ id: roleId });

    await createOrganization({ name: 'Acme Corp' }, actor, metadata);

    const membership = mocks.transaction.membership.create.mock.calls[0]?.[0] as
      { data?: { userId?: string; roleId?: string; status?: string } } | undefined;
    expect(membership?.data).toMatchObject({ userId: actor, roleId, status: 'ACTIVE' });
    expect(mocks.transaction.user.update).toHaveBeenCalled();
  });

  it('rejects a duplicate slug', async () => {
    mocks.transaction.organization.findFirst.mockResolvedValue({ id: otherOrgId });
    await expect(
      createOrganization({ name: 'Acme', slug: 'acme' }, actor, metadata),
    ).rejects.toMatchObject({ statusCode: 409 });
  });
});

describe('switching organizations', () => {
  it('refuses without an active membership', async () => {
    mocks.transaction.membership.findFirst.mockResolvedValue(null);

    await expect(
      switchOrganization(actor, 'session-1', otherOrgId, metadata),
    ).rejects.toMatchObject({ statusCode: 403 });
    expect(mocks.transaction.session.updateMany).not.toHaveBeenCalled();
  });

  it('rewrites the session tenant when membership is proven', async () => {
    mocks.transaction.membership.findFirst.mockResolvedValue({ id: 'membership-1' });
    mocks.transaction.session.updateMany.mockResolvedValue({ count: 1 });
    mocks.transaction.organization.findFirstOrThrow.mockResolvedValue({ id: orgId });

    await switchOrganization(actor, 'session-1', orgId, metadata);

    expect(mocks.transaction.session.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({ data: { activeOrganizationId: orgId } }),
    );
  });
});

describe('member management', () => {
  it('refuses to assign a role belonging to another organization', async () => {
    mocks.transaction.role.findFirst.mockResolvedValue(null);

    await expect(changeMemberRole(orgId, member, roleId, actor, metadata)).rejects.toMatchObject({
      statusCode: 400,
    });
    expect(mocks.transaction.membership.updateMany).not.toHaveBeenCalled();
  });

  it('bumps the affected member epoch on a role change', async () => {
    mocks.transaction.role.findFirst.mockResolvedValue({ id: roleId, name: 'member' });
    mocks.transaction.membership.findFirst.mockResolvedValue({
      id: 'membership-1',
      status: 'ACTIVE',
      role: { name: 'member' },
    });
    mocks.transaction.membership.updateMany.mockResolvedValue({ count: 1 });
    mocks.transaction.membership.findFirstOrThrow.mockResolvedValue({ id: 'membership-1' });

    await changeMemberRole(orgId, member, roleId, actor, metadata);

    expect(mocks.transaction.user.update).toHaveBeenCalledWith({
      where: { id: member },
      data: { permissionEpoch: { increment: 1 } },
    });
  });

  it('refuses to remove the last active owner', async () => {
    mocks.transaction.membership.count.mockResolvedValue(1);
    mocks.transaction.membership.findFirst.mockResolvedValue({
      id: 'm1',
      status: 'ACTIVE',
      role: { name: 'owner' },
    });

    await expect(removeMember(orgId, member, actor, metadata)).rejects.toMatchObject({
      statusCode: 409,
    });
  });

  it('detaches the removed member sessions from the organization', async () => {
    mocks.transaction.membership.count.mockResolvedValue(3);
    mocks.transaction.membership.findFirst.mockResolvedValue({
      id: 'm1',
      status: 'ACTIVE',
      role: { name: 'owner' },
    });

    await removeMember(orgId, member, actor, metadata);

    // Otherwise their existing session keeps resolving this tenant until it expires.
    expect(mocks.transaction.session.updateMany).toHaveBeenCalledWith({
      where: { userId: member, activeOrganizationId: orgId },
      data: { activeOrganizationId: null },
    });
  });
});

describe('invitations', () => {
  it('returns the raw token once and stores only its hash', async () => {
    mocks.transaction.role.findFirst.mockResolvedValue({ id: roleId, name: 'member' });
    mocks.transaction.organization.findFirstOrThrow.mockResolvedValue({ name: 'Acme' });
    mocks.transaction.user.findFirst.mockResolvedValue(null);
    mocks.transaction.invitation.create.mockResolvedValue({
      id: 'invite-1',
      email: 'a@b.com',
      expiresAt: new Date(Date.now() + 60_000),
    });

    const result = await createInvitation(orgId, { email: 'A@B.com', roleId }, actor, metadata);

    expect(result.token).toBe('invitation-secret-token');
    const created = mocks.transaction.invitation.create.mock.calls[0]?.[0] as
      { data?: { tokenHash?: string; email?: string } } | undefined;
    expect(created?.data?.tokenHash).toBe('hash:invitation-secret-token');
    expect(created?.data?.email).toBe('a@b.com');
  });

  it('refuses an invitation whose token does not resolve', async () => {
    mocks.transaction.invitation.findFirst.mockResolvedValue(null);
    await expect(acceptInvitation('bad-token', actor, metadata)).rejects.toMatchObject({
      statusCode: 404,
    });
  });

  it('refuses when the accepting account is not the invited verified email', async () => {
    // A leaked invitation link must not let an arbitrary authenticated account join the tenant.
    mocks.transaction.invitation.findFirst.mockResolvedValue({
      id: 'invite-1',
      organizationId: orgId,
      email: 'invited@example.com',
      roleId,
    });
    mocks.transaction.user.findFirst.mockResolvedValue({
      email: 'someone-else@example.com',
      emailVerifiedAt: new Date(),
    });

    await expect(acceptInvitation('token', actor, metadata)).rejects.toMatchObject({
      statusCode: 403,
    });
    expect(mocks.transaction.membership.upsert).not.toHaveBeenCalled();
  });

  it('refuses when the invited address is not verified', async () => {
    mocks.transaction.invitation.findFirst.mockResolvedValue({
      id: 'invite-1',
      organizationId: orgId,
      email: 'invited@example.com',
      roleId,
    });
    mocks.transaction.user.findFirst.mockResolvedValue({
      email: 'invited@example.com',
      emailVerifiedAt: null,
    });

    await expect(acceptInvitation('token', actor, metadata)).rejects.toMatchObject({
      statusCode: 403,
    });
  });

  it('joins the organization when the verified email matches', async () => {
    mocks.transaction.invitation.findFirst.mockResolvedValue({
      id: 'invite-1',
      organizationId: orgId,
      email: 'invited@example.com',
      roleId,
    });
    mocks.transaction.user.findFirst.mockResolvedValue({
      email: 'Invited@Example.com',
      emailVerifiedAt: new Date(),
    });
    mocks.transaction.organization.findFirstOrThrow.mockResolvedValue({ id: orgId });

    await acceptInvitation('token', actor, metadata);

    expect(mocks.transaction.membership.upsert).toHaveBeenCalled();
    const accepted = mocks.transaction.invitation.update.mock.calls[0]?.[0] as
      { data?: { acceptedAt?: Date } } | undefined;
    expect(accepted?.data?.acceptedAt).toBeInstanceOf(Date);
  });
});
