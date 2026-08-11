import type { RequestHandler } from 'express';
import { resolveAccessToken } from '#app/lib/auth-transport.js';
import { errors } from '#app/lib/errors.js';
import { verifyAccessToken } from '#app/lib/jwt.js';
import { prisma } from '#app/lib/prisma.js';
import { appRedis } from '#app/lib/redis.js';
import { setRequestIdentity } from '#app/lib/request-context.js';
import { userIdentityRateLimit } from '#app/middleware/rate-limit.js';

export const authenticate: RequestHandler = async (request, _response, next) => {
  const token = resolveAccessToken(request);
  if (!token) return next(errors.unauthenticated());

  try {
    const claims = await verifyAccessToken(token);
    const session = await prisma.session.findFirst({
      where: {
        id: claims.sessionId,
        userId: claims.userId,
        revokedAt: null,
        deletedAt: null,
        expiresAt: { gt: new Date() },
        user: { status: 'ACTIVE', deletedAt: null },
      },
      select: {
        id: true,
        activeOrganizationId: true,
        user: { select: { permissionEpoch: true } },
        // Nested selects are not reached by the soft-delete extension, so `deletedAt` is
        // checked explicitly below.
        activeOrganization: {
          select: { status: true, deletedAt: true, permissionEpoch: true },
        },
      },
    });
    if (!session) return next(errors.unauthenticated());

    request.auth = claims;
    request.permissionEpoch = session.user.permissionEpoch;

    const organizationId = session.activeOrganizationId ?? undefined;
    if (organizationId) {
      const organization = session.activeOrganization;
      if (!organization || organization.deletedAt || organization.status !== 'ACTIVE') {
        return next(errors.forbidden('Organization is not active'));
      }

      // Re-checked per request: without this, removing a member would leave their existing
      // session reading the organization's data until it expired. Tenant scoping does not go
      // through requirePermission, so a permission-epoch bump alone would not close it.
      const membership = await prisma.membership.findFirst({
        where: { organizationId, userId: claims.userId, status: 'ACTIVE', deletedAt: null },
        select: { id: true },
      });
      if (!membership) return next(errors.forbidden('Organization membership is not active'));

      request.organizationId = organizationId;
      request.organizationPermissionEpoch = organization.permissionEpoch;
    }

    setRequestIdentity({ userId: claims.userId, organizationId });
    next();
  } catch {
    next(errors.unauthenticated());
  }
};

/** Grant held globally via `UserRole`, which satisfies a check in any scope. */
async function hasGlobalGrant(userId: string, code: string): Promise<boolean> {
  const grant = await prisma.userRole.findFirst({
    where: {
      userId,
      deletedAt: null,
      role: {
        // UserRole is the platform-wide grant path. An organization role must never satisfy it,
        // even if malformed legacy data or a direct database write created the assignment.
        organizationId: null,
        deletedAt: null,
        permissions: {
          some: { deletedAt: null, permission: { code, deletedAt: null } },
        },
      },
    },
    select: { id: true },
  });
  return grant !== null;
}

/** Grant held through membership, which satisfies a check only inside that organization. */
async function hasOrganizationGrant(
  userId: string,
  organizationId: string,
  code: string,
): Promise<boolean> {
  const grant = await prisma.membership.findFirst({
    where: {
      userId,
      organizationId,
      status: 'ACTIVE',
      deletedAt: null,
      role: {
        deletedAt: null,
        permissions: {
          some: { deletedAt: null, permission: { code, deletedAt: null } },
        },
      },
    },
    select: { id: true },
  });
  return grant !== null;
}

/**
 * The organization's own epoch is part of the key so that changing an organization role's
 * permissions invalidates every member with one write, instead of an unbounded per-member update.
 */
function permissionCacheKey(
  request: Parameters<RequestHandler>[0],
  code: string,
  scope: 'global' | 'organization' | 'context',
): string {
  const userEpoch = request.permissionEpoch ?? 0;
  const organizationId = request.organizationId ?? 'global';
  const organizationEpoch = request.organizationPermissionEpoch ?? 0;
  return `permission:${scope}:${request.auth!.userId}:${userEpoch}:${organizationId}:${organizationEpoch}:${code}`;
}

function permissionGuard(
  code: string,
  scope: 'global' | 'organization' | 'context',
): RequestHandler {
  return async (request, _response, next) => {
    const userId = request.auth!.userId;
    const organizationId = request.organizationId;

    if (scope === 'organization' && !organizationId) {
      return next(errors.forbidden('An active organization is required'));
    }

    const cacheKey = permissionCacheKey(request, code, scope);
    try {
      const cached = await appRedis.get(cacheKey);
      if (cached === '1') return next();
      if (cached === '0') return next(errors.forbidden());
    } catch {
      // Authorization safely falls back to the database while Redis is unavailable.
    }

    let allowed = scope !== 'organization' && (await hasGlobalGrant(userId, code));
    if (!allowed && scope !== 'global' && organizationId) {
      allowed = await hasOrganizationGrant(userId, organizationId, code);
    }

    void appRedis.set(cacheKey, allowed ? '1' : '0', 'EX', 60).catch(() => undefined);
    if (!allowed) return next(errors.forbidden());
    next();
  };
}

/**
 * Platform permission. Organization membership can never satisfy this guard, even when the
 * session has an active organization. This is the safe default for platform-wide endpoints.
 */
export function requirePermission(code: string): RequestHandler[] {
  return [authenticate, userIdentityRateLimit, permissionGuard(code, 'global')];
}

/**
 * Satisfied only by a role held in the active organization. Use for endpoints that must not be
 * reachable by a platform-wide grant.
 */
export function requireOrgPermission(code: string): RequestHandler[] {
  return [authenticate, userIdentityRateLimit, permissionGuard(code, 'organization')];
}

/**
 * Explicitly permits either a platform grant or a grant in the active organization. Use only
 * when the downstream query/write is itself tenant-scoped (for example feature flags or audit).
 */
export function requireContextPermission(code: string): RequestHandler[] {
  return [authenticate, userIdentityRateLimit, permissionGuard(code, 'context')];
}
