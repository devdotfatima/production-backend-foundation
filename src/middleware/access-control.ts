import type { RequestHandler } from 'express';
import { cookieNames } from '#app/lib/cookies.js';
import { errors } from '#app/lib/errors.js';
import { verifyAccessToken } from '#app/lib/jwt.js';
import { prisma } from '#app/lib/prisma.js';
import { appRedis } from '#app/lib/redis.js';
import { userIdentityRateLimit } from '#app/middleware/rate-limit.js';

export const authenticate: RequestHandler = async (request, _response, next) => {
  const cookies = request.cookies as Record<string, unknown> | undefined;
  const token = cookies?.[cookieNames.access];
  if (typeof token !== 'string') return next(errors.unauthenticated());

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
      select: { id: true, user: { select: { permissionEpoch: true } } },
    });
    if (!session) return next(errors.unauthenticated());
    request.auth = claims;
    request.permissionEpoch = session.user.permissionEpoch;
    next();
  } catch {
    next(errors.unauthenticated());
  }
};

export function requirePermission(code: string): RequestHandler[] {
  const permissionGuard: RequestHandler = async (request, _response, next) => {
    const cacheKey = `permission:${request.auth!.userId}:${request.permissionEpoch ?? 0}:${code}`;
    try {
      const cached = await appRedis.get(cacheKey);
      if (cached === '1') return next();
      if (cached === '0') return next(errors.forbidden());
    } catch {
      // Authorization safely falls back to the database while Redis is unavailable.
    }
    const allowed = await prisma.userRole.findFirst({
      where: {
        userId: request.auth!.userId,
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
    void appRedis.set(cacheKey, allowed ? '1' : '0', 'EX', 60).catch(() => undefined);
    if (!allowed) return next(errors.forbidden());
    next();
  };
  return [authenticate, userIdentityRateLimit, permissionGuard];
}
