import { NotificationChannel, UserStatus } from '@prisma/client';
import { env } from '#app/config/env.js';
import { withAuditedTransaction } from '#app/lib/audited-transaction.js';
import {
  candidateOpaqueTokenHashes,
  encryptSecret,
  hashOpaqueToken,
  hashSecret,
  normalizeEmail,
  randomOtp,
  randomToken,
  verifySecret,
} from '#app/lib/crypto.js';
import { prisma } from '#app/lib/prisma.js';
import { recordInvalidOtpAttempt } from '#app/modules/auth/auth.otp.service.js';
import { auditMetadata, expiresIn, type RequestMetadata } from '#app/modules/auth/auth.shared.js';
import { publishChatRevocation } from '#app/modules/chat/chat.revocations.js';
import { addOutboxEvent } from '#app/modules/outbox/outbox.service.js';

export async function requestPasswordReset(
  emailInput: string,
  metadata: RequestMetadata,
): Promise<void> {
  const email = normalizeEmail(emailInput);
  const user = await prisma.user.findFirst({
    where: { email, status: UserStatus.ACTIVE, deletedAt: null },
    select: { id: true },
  });
  if (!user) return;
  const recentlySent = await prisma.otpChallenge.findFirst({
    where: {
      userId: user.id,
      normalizedDestination: email,
      channel: 'EMAIL',
      purpose: 'PASSWORD_RESET',
      sentAt: { gte: new Date(Date.now() - 60_000) },
      consumedAt: null,
      verifiedAt: null,
      lockedAt: null,
    },
    select: { id: true },
  });
  if (recentlySent) return;
  const code = randomOtp();
  const codeHash = await hashSecret(code);
  await withAuditedTransaction(async (tx, audit) => {
    const challenge = await tx.otpChallenge.create({
      data: {
        userId: user.id,
        normalizedDestination: email,
        channel: 'EMAIL',
        purpose: 'PASSWORD_RESET',
        codeHash,
        expiresAt: expiresIn(5, 60_000),
      },
    });
    await addOutboxEvent(tx, {
      aggregateType: 'otp_challenge',
      aggregateId: challenge.id,
      eventType: 'auth.otp',
      channel: NotificationChannel.EMAIL,
      payload: {
        challengeId: challenge.id,
        destination: email,
        encryptedCode: encryptSecret(code),
        purpose: 'PASSWORD_RESET',
      },
      dedupeKey: `otp:${challenge.id}:password-reset`,
      expiresAt: challenge.expiresAt,
    });
    await audit({
      actorUserId: user.id,
      action: 'auth.password_reset.requested',
      entityType: 'otp_challenge',
      entityId: challenge.id,
      ...auditMetadata(metadata),
    });
  });
}

export async function verifyPasswordResetOtp(
  emailInput: string,
  otp: string,
  metadata: RequestMetadata,
): Promise<{ resetToken: string; expiresAt: Date } | null> {
  const email = normalizeEmail(emailInput);
  const challenge = await prisma.otpChallenge.findFirst({
    where: {
      normalizedDestination: email,
      channel: 'EMAIL',
      purpose: 'PASSWORD_RESET',
      consumedAt: null,
      verifiedAt: null,
      lockedAt: null,
      deletedAt: null,
    },
    orderBy: { createdAt: 'desc' },
    include: { user: true },
  });
  if (
    !challenge ||
    challenge.expiresAt <= new Date() ||
    !challenge.user ||
    challenge.user.status !== UserStatus.ACTIVE ||
    challenge.user.deletedAt
  )
    return null;
  if (!(await verifySecret(challenge.codeHash, otp))) {
    await recordInvalidOtpAttempt(challenge.id);
    return null;
  }
  const resetToken = randomToken();
  const tokenHash = hashOpaqueToken(resetToken);
  const expiresAt = expiresIn(env.PASSWORD_RESET_TOKEN_TTL_MINUTES, 60_000);
  const issued = await withAuditedTransaction(async (tx, audit) => {
    const verifiedAt = new Date();
    const verified = await tx.otpChallenge.updateMany({
      where: {
        id: challenge.id,
        consumedAt: null,
        verifiedAt: null,
        lockedAt: null,
        expiresAt: { gt: verifiedAt },
      },
      data: { verifiedAt },
    });
    if (verified.count !== 1) return false;
    await tx.passwordResetToken.updateMany({
      where: { userId: challenge.userId!, usedAt: null, deletedAt: null },
      data: { deletedAt: verifiedAt },
    });
    await tx.passwordResetToken.create({
      data: { userId: challenge.userId!, otpChallengeId: challenge.id, tokenHash, expiresAt },
    });
    await audit({
      actorUserId: challenge.userId ?? undefined,
      action: 'auth.password_reset.otp_verified',
      entityType: 'otp_challenge',
      entityId: challenge.id,
      ...auditMetadata(metadata),
    });
    return true;
  });
  return issued ? { resetToken, expiresAt } : null;
}

export async function confirmPasswordReset(
  resetToken: string,
  newPassword: string,
  metadata: RequestMetadata,
): Promise<boolean> {
  const tokenHashes = candidateOpaqueTokenHashes(resetToken);
  const reset = await prisma.passwordResetToken.findFirst({
    where: {
      tokenHash: { in: tokenHashes },
      usedAt: null,
      deletedAt: null,
      expiresAt: { gt: new Date() },
    },
    include: { user: true },
  });
  if (!reset || !reset.user || reset.user.status !== UserStatus.ACTIVE || reset.user.deletedAt) {
    await hashSecret(newPassword);
    return false;
  }
  const passwordHash = await hashSecret(newPassword);
  const changed = await withAuditedTransaction(async (tx, audit) => {
    const usedAt = new Date();
    const used = await tx.passwordResetToken.updateMany({
      where: {
        id: reset.id,
        tokenHash: reset.tokenHash,
        usedAt: null,
        deletedAt: null,
        expiresAt: { gt: usedAt },
      },
      data: { usedAt },
    });
    if (used.count !== 1) return false;
    const consumed = await tx.otpChallenge.updateMany({
      where: { id: reset.otpChallengeId, consumedAt: null, lockedAt: null, deletedAt: null },
      data: { consumedAt: usedAt },
    });
    if (consumed.count !== 1) throw new Error('Password reset OTP was already consumed');
    const updated = await tx.user.updateMany({
      where: { id: reset.userId, status: UserStatus.ACTIVE, deletedAt: null },
      data: { passwordHash },
    });
    if (updated.count !== 1) throw new Error('Password reset user is no longer eligible');
    await tx.session.updateMany({
      where: { userId: reset.userId, revokedAt: null },
      data: { revokedAt: usedAt, revokeReason: 'password_reset' },
    });
    await tx.refreshToken.updateMany({
      where: { userId: reset.userId, revokedAt: null },
      data: { revokedAt: usedAt },
    });
    await tx.passwordResetToken.updateMany({
      where: { userId: reset.userId, id: { not: reset.id }, usedAt: null, deletedAt: null },
      data: { deletedAt: usedAt },
    });
    await audit({
      actorUserId: reset.userId,
      action: 'auth.password_reset.completed',
      entityType: 'user',
      entityId: reset.userId,
      ...auditMetadata(metadata),
    });
    return true;
  });
  if (changed) await publishChatRevocation(reset.userId);
  return changed;
}
