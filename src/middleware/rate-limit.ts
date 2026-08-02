import type { RequestHandler } from 'express';
import { getRefreshToken } from '#app/lib/cookies.js';
import { candidateOpaqueTokenHashes } from '#app/lib/crypto.js';
import { enforceRateLimit } from '#app/lib/rate-limit.js';
import { prisma } from '#app/lib/prisma.js';

function userRateLimit(scope: string, limit: number, windowSeconds: number): RequestHandler {
  return async (request, _response, next) => {
    try {
      const userId = request.auth?.userId;
      if (!userId) return next();
      await enforceRateLimit(scope, `user:${userId}`, limit, windowSeconds);
      next();
    } catch (error) {
      next(error);
    }
  };
}

export const userIdentityRateLimit = userRateLimit('global:user', 300, 60);

export const refreshUserRateLimit: RequestHandler = async (request, _response, next) => {
  try {
    const refreshToken = getRefreshToken(request);
    if (!refreshToken) return next();

    const current = await prisma.refreshToken.findFirst({
      where: { tokenHash: { in: candidateOpaqueTokenHashes(refreshToken) } },
      select: { userId: true },
    });
    if (!current) return next();

    await enforceRateLimit('auth:refresh:user', `user:${current.userId}`, 20, 15 * 60);
    next();
  } catch (error) {
    next(error);
  }
};
