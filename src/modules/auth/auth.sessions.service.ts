import { Prisma, UserStatus } from '@prisma/client';
import { env } from '#app/config/env.js';
import { withAuditedTransaction } from '#app/lib/audited-transaction.js';
import {
  candidateOpaqueTokenHashes,
  constantTimeEqual,
  hashMetadata,
  hashOpaqueToken,
  randomToken,
} from '#app/lib/crypto.js';
import { signAccessToken } from '#app/lib/jwt.js';
import {
  auditMetadata,
  expiresIn,
  type RequestMetadata,
  type TokenPair,
} from '#app/modules/auth/auth.shared.js';

export async function createSession(userId: string, metadata: RequestMetadata): Promise<TokenPair> {
  const refreshToken = randomToken();
  const expiresAt = expiresIn(env.REFRESH_TOKEN_TTL_DAYS, 24 * 60 * 60 * 1000);

  const session = await withAuditedTransaction(async (tx, audit) => {
    const created = await tx.session.create({
      data: {
        userId,
        ipHash: hashMetadata(metadata.ip),
        userAgent: metadata.userAgent?.slice(0, 500),
        expiresAt,
      },
    });
    await tx.refreshToken.create({
      data: {
        userId,
        sessionId: created.id,
        tokenHash: hashOpaqueToken(refreshToken),
        expiresAt,
      },
    });
    await tx.user.update({ where: { id: userId }, data: { lastLoginAt: new Date() } });
    await audit({
      actorUserId: userId,
      action: 'auth.session.created',
      entityType: 'session',
      entityId: created.id,
      ...auditMetadata(metadata),
    });
    return created;
  });

  return {
    accessToken: await signAccessToken({ userId, sessionId: session.id }),
    refreshToken,
  };
}

export async function rotateRefreshToken(
  rawToken: string,
  metadata: RequestMetadata,
): Promise<TokenPair | null> {
  const tokenHashes = candidateOpaqueTokenHashes(rawToken);
  const now = new Date();
  const nextRawToken = randomToken();
  const nextHash = hashOpaqueToken(nextRawToken);

  const result = await withAuditedTransaction(
    async (tx, audit) => {
      const current = await tx.refreshToken.findFirst({
        where: { tokenHash: { in: tokenHashes } },
        include: { session: true, user: true },
      });
      if (
        !current ||
        !tokenHashes.some((candidate) => constantTimeEqual(current.tokenHash, candidate))
      )
        return { status: 'INVALID' } as const;

      const unusable =
        current.consumedAt ||
        current.replacedByTokenId ||
        current.revokedAt ||
        current.expiresAt <= now ||
        current.session.revokedAt ||
        current.session.expiresAt <= now ||
        current.user.status !== UserStatus.ACTIVE ||
        current.user.deletedAt;

      if (unusable) {
        await tx.session.updateMany({
          where: { id: current.sessionId, revokedAt: null },
          data: { revokedAt: now, revokeReason: 'refresh_token_reuse' },
        });
        await tx.refreshToken.updateMany({
          where: { sessionId: current.sessionId, revokedAt: null },
          data: { revokedAt: now },
        });
        await audit({
          actorUserId: current.userId,
          action: 'auth.refresh.reuse_detected',
          entityType: 'session',
          entityId: current.sessionId,
          ...auditMetadata(metadata),
        });
        return { status: 'REUSE' } as const;
      }

      const next = await tx.refreshToken.create({
        data: {
          userId: current.userId,
          sessionId: current.sessionId,
          tokenHash: nextHash,
          expiresAt: current.session.expiresAt,
        },
      });
      const consumed = await tx.refreshToken.updateMany({
        where: { id: current.id, consumedAt: null, revokedAt: null, replacedByTokenId: null },
        data: { consumedAt: now, replacedByTokenId: next.id },
      });
      if (consumed.count !== 1) {
        await tx.session.update({
          where: { id: current.sessionId },
          data: { revokedAt: now, revokeReason: 'refresh_token_race' },
        });
        await tx.refreshToken.updateMany({
          where: { sessionId: current.sessionId, revokedAt: null },
          data: { revokedAt: now },
        });
        return { status: 'REUSE' } as const;
      }
      await tx.session.update({ where: { id: current.sessionId }, data: { lastSeenAt: now } });
      return { status: 'ROTATED', userId: current.userId, sessionId: current.sessionId } as const;
    },
    { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
  );

  if (result.status !== 'ROTATED') return null;
  return {
    accessToken: await signAccessToken({ userId: result.userId, sessionId: result.sessionId }),
    refreshToken: nextRawToken,
  };
}

export async function revokeSession(
  sessionId: string,
  userId: string,
  metadata: RequestMetadata,
): Promise<void> {
  await withAuditedTransaction(async (tx, audit) => {
    await tx.session.updateMany({
      where: { id: sessionId, userId, revokedAt: null },
      data: { revokedAt: new Date(), revokeReason: 'user_logout' },
    });
    await tx.refreshToken.updateMany({
      where: { sessionId, userId, revokedAt: null },
      data: { revokedAt: new Date() },
    });
    await audit({
      actorUserId: userId,
      action: 'auth.session.revoked',
      entityType: 'session',
      entityId: sessionId,
      ...auditMetadata(metadata),
    });
  });
}

export async function revokeAllSessions(userId: string, metadata: RequestMetadata): Promise<void> {
  await withAuditedTransaction(async (tx, audit) => {
    await tx.session.updateMany({
      where: { userId, revokedAt: null },
      data: { revokedAt: new Date(), revokeReason: 'user_logout_all' },
    });
    await tx.refreshToken.updateMany({
      where: { userId, revokedAt: null },
      data: { revokedAt: new Date() },
    });
    await audit({
      actorUserId: userId,
      action: 'auth.sessions.revoked_all',
      entityType: 'user',
      entityId: userId,
      ...auditMetadata(metadata),
    });
  });
}
