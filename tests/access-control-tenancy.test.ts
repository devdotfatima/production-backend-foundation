import type { NextFunction, Request, Response } from 'express';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  sessionFindFirst: vi.fn(),
  membershipFindFirst: vi.fn(),
  userRoleFindFirst: vi.fn(),
  verifyAccessToken: vi.fn(),
  resolveAccessToken: vi.fn(),
  setRequestIdentity: vi.fn(),
  redisGet: vi.fn(),
  redisSet: vi.fn(),
}));

vi.mock('#app/lib/prisma.js', () => ({
  prisma: {
    session: { findFirst: mocks.sessionFindFirst },
    membership: { findFirst: mocks.membershipFindFirst },
    userRole: { findFirst: mocks.userRoleFindFirst },
  },
}));
vi.mock('#app/lib/jwt.js', () => ({ verifyAccessToken: mocks.verifyAccessToken }));
vi.mock('#app/lib/auth-transport.js', () => ({ resolveAccessToken: mocks.resolveAccessToken }));
vi.mock('#app/lib/request-context.js', () => ({ setRequestIdentity: mocks.setRequestIdentity }));
vi.mock('#app/lib/redis.js', () => ({
  appRedis: { get: mocks.redisGet, set: mocks.redisSet },
}));
vi.mock('#app/middleware/rate-limit.js', () => ({ userIdentityRateLimit: vi.fn() }));

import {
  authenticate,
  requireContextPermission,
  requireOrgPermission,
  requirePermission,
} from '../dist/src/middleware/access-control.js';

const userId = '00000000-0000-7000-8000-0000000000u1';
const orgId = '00000000-0000-7000-8000-00000000000a';

function activeSession(overrides: Record<string, unknown> = {}) {
  return {
    id: 'session-1',
    activeOrganizationId: null,
    user: { permissionEpoch: 3 },
    activeOrganization: null,
    ...overrides,
  };
}

async function runAuthenticate(request: Partial<Request> = {}) {
  const next = vi.fn();
  await authenticate(request as Request, {} as Response, next as NextFunction);
  return { request: request as Request, next };
}

async function runGuard(handlers: unknown[], request: Partial<Request>) {
  const guard = handlers.at(-1) as (
    request: Request,
    response: Response,
    next: NextFunction,
  ) => Promise<void>;
  const next = vi.fn();
  await guard(request as Request, {} as Response, next as NextFunction);
  return next;
}

describe('authenticate with tenancy', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.resolveAccessToken.mockReturnValue('token');
    mocks.verifyAccessToken.mockResolvedValue({ userId, sessionId: 'session-1' });
    mocks.redisSet.mockResolvedValue('OK');
  });

  it('leaves the organization unresolved when the session has none', async () => {
    mocks.sessionFindFirst.mockResolvedValue(activeSession());

    const { request, next } = await runAuthenticate();

    expect(next).toHaveBeenCalledWith();
    expect(request.organizationId).toBeUndefined();
    expect(mocks.membershipFindFirst).not.toHaveBeenCalled();
    expect(mocks.setRequestIdentity).toHaveBeenCalledWith({ userId, organizationId: undefined });
  });

  it('resolves the organization from the session, not from client input', async () => {
    mocks.sessionFindFirst.mockResolvedValue(
      activeSession({
        activeOrganizationId: orgId,
        activeOrganization: { status: 'ACTIVE', deletedAt: null, permissionEpoch: 9 },
      }),
    );
    mocks.membershipFindFirst.mockResolvedValue({ id: 'membership-1' });

    const { request, next } = await runAuthenticate({
      // A caller-supplied organization header must have no effect whatsoever.
      headers: { 'x-organization-id': 'attacker-controlled' },
    } as Partial<Request>);

    expect(next).toHaveBeenCalledWith();
    expect(request.organizationId).toBe(orgId);
    expect(request.organizationPermissionEpoch).toBe(9);
    expect(mocks.setRequestIdentity).toHaveBeenCalledWith({ userId, organizationId: orgId });
  });

  it('rejects a session whose membership is no longer active', async () => {
    mocks.sessionFindFirst.mockResolvedValue(
      activeSession({
        activeOrganizationId: orgId,
        activeOrganization: { status: 'ACTIVE', deletedAt: null, permissionEpoch: 1 },
      }),
    );
    mocks.membershipFindFirst.mockResolvedValue(null);

    const { request, next } = await runAuthenticate();

    expect(next.mock.calls[0]?.[0]).toMatchObject({ statusCode: 403 });
    expect(request.organizationId).toBeUndefined();
  });

  it('rejects a suspended or soft-deleted organization', async () => {
    for (const organization of [
      { status: 'SUSPENDED', deletedAt: null, permissionEpoch: 1 },
      { status: 'ACTIVE', deletedAt: new Date(), permissionEpoch: 1 },
    ]) {
      vi.clearAllMocks();
      mocks.resolveAccessToken.mockReturnValue('token');
      mocks.verifyAccessToken.mockResolvedValue({ userId, sessionId: 'session-1' });
      mocks.sessionFindFirst.mockResolvedValue(
        activeSession({ activeOrganizationId: orgId, activeOrganization: organization }),
      );
      mocks.membershipFindFirst.mockResolvedValue({ id: 'membership-1' });

      const { next } = await runAuthenticate();
      expect(next.mock.calls[0]?.[0]).toMatchObject({ statusCode: 403 });
    }
  });
});

describe('scope-aware permission checks', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.redisGet.mockResolvedValue(null);
    mocks.redisSet.mockResolvedValue('OK');
  });

  it('accepts a global grant regardless of active organization', async () => {
    mocks.userRoleFindFirst.mockResolvedValue({ id: 'grant-1' });

    const next = await runGuard(requirePermission('users:read'), {
      auth: { userId, sessionId: 'session-1' },
      permissionEpoch: 1,
    });

    expect(next).toHaveBeenCalledWith();
    expect(mocks.membershipFindFirst).not.toHaveBeenCalled();
  });

  it('uses a membership grant only for explicitly tenant-scoped operations', async () => {
    mocks.userRoleFindFirst.mockResolvedValue(null);
    mocks.membershipFindFirst.mockResolvedValue({ id: 'membership-1' });

    const next = await runGuard(requireContextPermission('members:read'), {
      auth: { userId, sessionId: 'session-1' },
      permissionEpoch: 1,
      organizationId: orgId,
      organizationPermissionEpoch: 4,
    });

    expect(next).toHaveBeenCalledWith();
    const membershipQuery = mocks.membershipFindFirst.mock.calls[0]?.[0] as
      { where?: { organizationId?: string } } | undefined;
    expect(membershipQuery?.where?.organizationId).toBe(orgId);
  });

  it('never lets an organization grant authorize a platform-wide operation', async () => {
    mocks.userRoleFindFirst.mockResolvedValue(null);
    mocks.membershipFindFirst.mockResolvedValue({ id: 'membership-1' });

    const next = await runGuard(requirePermission('users:read'), {
      auth: { userId, sessionId: 'session-1' },
      organizationId: orgId,
    });

    expect(mocks.membershipFindFirst).not.toHaveBeenCalled();
    expect(next.mock.calls[0]?.[0]).toMatchObject({ statusCode: 403 });
  });

  it('denies when neither grant exists', async () => {
    mocks.userRoleFindFirst.mockResolvedValue(null);
    mocks.membershipFindFirst.mockResolvedValue(null);

    const next = await runGuard(requirePermission('members:write'), {
      auth: { userId, sessionId: 'session-1' },
      organizationId: orgId,
    });

    expect(next.mock.calls[0]?.[0]).toMatchObject({ statusCode: 403 });
  });

  it('refuses a global grant for an organization-only permission', async () => {
    // The whole point of requireOrgPermission: a platform-wide role must not reach it.
    mocks.userRoleFindFirst.mockResolvedValue({ id: 'grant-1' });
    mocks.membershipFindFirst.mockResolvedValue(null);

    const next = await runGuard(requireOrgPermission('members:write'), {
      auth: { userId, sessionId: 'session-1' },
      organizationId: orgId,
    });

    expect(mocks.userRoleFindFirst).not.toHaveBeenCalled();
    expect(next.mock.calls[0]?.[0]).toMatchObject({ statusCode: 403 });
  });

  it('refuses an organization-only permission with no active organization', async () => {
    const next = await runGuard(requireOrgPermission('members:write'), {
      auth: { userId, sessionId: 'session-1' },
    });

    expect(next.mock.calls[0]?.[0]).toMatchObject({ statusCode: 403 });
    expect(mocks.membershipFindFirst).not.toHaveBeenCalled();
  });

  it('keys the cache on both epochs so either invalidates the decision', async () => {
    mocks.userRoleFindFirst.mockResolvedValue({ id: 'grant-1' });

    await runGuard(requirePermission('users:read'), {
      auth: { userId, sessionId: 'session-1' },
      permissionEpoch: 1,
      organizationId: orgId,
      organizationPermissionEpoch: 7,
    });

    const key = String(mocks.redisGet.mock.calls[0]?.[0]);
    expect(key).toContain(':1:');
    expect(key).toContain(`:${orgId}:7:`);
  });

  it('separates cached decisions across organizations', async () => {
    mocks.userRoleFindFirst.mockResolvedValue(null);
    mocks.membershipFindFirst.mockResolvedValue(null);

    const base = { auth: { userId, sessionId: 'session-1' }, permissionEpoch: 1 };
    await runGuard(requirePermission('members:read'), { ...base, organizationId: orgId });
    await runGuard(requirePermission('members:read'), { ...base, organizationId: 'other-org' });

    expect(mocks.redisGet.mock.calls[0]?.[0]).not.toBe(mocks.redisGet.mock.calls[1]?.[0]);
  });
});
