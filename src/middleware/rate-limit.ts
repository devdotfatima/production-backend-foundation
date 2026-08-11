import type { RequestHandler } from 'express';
import { env } from '#app/config/env.js';
import { resolveRefreshToken } from '#app/lib/auth-transport.js';
import { clientIpKey, matchesAnyCidr, parseCidr, type ParsedCidr } from '#app/lib/client-ip.js';
import { candidateOpaqueTokenHashes } from '#app/lib/crypto.js';
import { enforceRateLimit, type RateLimitOptions } from '#app/lib/rate-limit.js';
import { prisma } from '#app/lib/prisma.js';

// Parsed once at boot; env validation has already rejected malformed entries.
const allowlist: ParsedCidr[] = env.RATE_LIMIT_ALLOWLIST_CIDRS.flatMap((entry) => {
  const parsed = parseCidr(entry);
  return parsed ? [parsed] : [];
});

export function isRateLimitAllowlisted(ip: string | undefined): boolean {
  return matchesAnyCidr(ip, allowlist);
}

/**
 * Limits by client address rather than identity, so an attacker cannot buy budget by rotating
 * accounts. Buckets by IPv6 /64 — see `clientIpKey`.
 */
export function ipRateLimit(
  scope: string,
  limit: number,
  windowSeconds: number,
  options?: RateLimitOptions,
): RequestHandler {
  // Named so the mount order stays assertable from the Express layer stack.
  return async function ipRateLimitHandler(request, _response, next) {
    try {
      if (isRateLimitAllowlisted(request.ip)) return next();
      await enforceRateLimit(scope, clientIpKey(request.ip), limit, windowSeconds, options);
      next();
    } catch (error) {
      next(error);
    }
  };
}

/**
 * App-wide ceiling. Deliberately falls back to the bounded local counter rather than denying
 * during a Redis outage: a coarse guard must not become a single point of failure.
 */
export const globalIpRateLimit = ipRateLimit('global:ip', env.RATE_LIMIT_IP_PER_MINUTE, 60);

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
    const refreshToken = resolveRefreshToken(request);
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
