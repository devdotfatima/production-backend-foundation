import { NotificationChannel, UserStatus } from '@prisma/client';
import { withAuditedTransaction } from '#app/lib/audited-transaction.js';
import {
  encryptSecret,
  hashSecret,
  normalizeEmail,
  randomOtp,
  randomToken,
  verifySecret,
} from '#app/lib/crypto.js';
import { prisma } from '#app/lib/prisma.js';
import {
  auditMetadata,
  type RequestMetadata,
  type TokenPair,
} from '#app/modules/auth/auth.shared.js';
import { createSession } from '#app/modules/auth/auth.sessions.service.js';
import { publishChatRevocation } from '#app/modules/chat/chat.revocations.js';
import { addOutboxEvent } from '#app/modules/outbox/outbox.service.js';

const dummyPasswordHash = hashSecret(randomToken());

export async function signupWithPassword(
  input: { email: string; password: string; displayName?: string },
  metadata: RequestMetadata,
): Promise<void> {
  const email = normalizeEmail(input.email);
  const passwordHash = await hashSecret(input.password);
  const existing = await prisma.user.findUnique({ where: { email }, select: { id: true } });
  if (existing) {
    await withAuditedTransaction(async (tx, audit) => {
      await addOutboxEvent(tx, {
        aggregateType: 'user',
        aggregateId: existing.id,
        eventType: 'auth.signup_existing',
        channel: NotificationChannel.EMAIL,
        payload: { destination: email },
        dedupeKey: `signup-existing:${existing.id}:${Math.floor(Date.now() / 3_600_000)}`,
      });
      await audit({
        action: 'auth.signup.existing_requested',
        entityType: 'user',
        entityId: existing.id,
        ...auditMetadata(metadata),
      });
    });
    return;
  }
  const code = randomOtp();
  const codeHash = await hashSecret(code);
  await withAuditedTransaction(async (tx, audit) => {
    const user = await tx.user.create({
      data: { email, passwordHash, displayName: input.displayName, status: UserStatus.PENDING },
    });
    const challenge = await tx.otpChallenge.create({
      data: {
        userId: user.id,
        normalizedDestination: email,
        channel: 'EMAIL',
        purpose: 'VERIFY_EMAIL',
        codeHash,
        expiresAt: new Date(Date.now() + 5 * 60_000),
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
        purpose: 'VERIFY_EMAIL',
      },
      dedupeKey: `otp:${challenge.id}:email`,
      expiresAt: challenge.expiresAt,
    });
    await audit({
      actorUserId: user.id,
      action: 'auth.signup.created',
      entityType: 'user',
      entityId: user.id,
      ...auditMetadata(metadata),
    });
  });
}

export async function loginWithPassword(
  input: { email: string; password: string },
  metadata: RequestMetadata,
): Promise<TokenPair | null> {
  const email = normalizeEmail(input.email);
  const user = await prisma.user.findUnique({ where: { email } });
  const passwordHash = user?.passwordHash ?? (await dummyPasswordHash);
  const valid = await verifySecret(passwordHash, input.password);
  if (!valid || !user || user.status !== UserStatus.ACTIVE || user.deletedAt) {
    await withAuditedTransaction(async (_tx, audit) => {
      await audit({
        action: 'auth.login.failed',
        entityType: 'user',
        entityId: user?.id,
        ...auditMetadata(metadata),
      });
    });
    return null;
  }
  return createSession(user.id, metadata);
}

export async function changePassword(
  userId: string,
  sessionId: string,
  currentPassword: string,
  newPassword: string,
  metadata: RequestMetadata,
): Promise<boolean> {
  const user = await prisma.user.findFirst({
    where: { id: userId, status: UserStatus.ACTIVE, deletedAt: null },
    select: { passwordHash: true },
  });
  const passwordHash = user?.passwordHash ?? (await dummyPasswordHash);
  const valid = await verifySecret(passwordHash, currentPassword);
  if (!valid || !user?.passwordHash) return false;
  const nextPasswordHash = await hashSecret(newPassword);
  await withAuditedTransaction(async (tx, audit) => {
    await tx.user.update({ where: { id: userId }, data: { passwordHash: nextPasswordHash } });
    const revokedAt = new Date();
    await tx.session.updateMany({
      where: { userId, id: { not: sessionId }, revokedAt: null },
      data: { revokedAt, revokeReason: 'password_changed' },
    });
    await tx.refreshToken.updateMany({
      where: { userId, sessionId: { not: sessionId }, revokedAt: null },
      data: { revokedAt },
    });
    await audit({
      actorUserId: userId,
      action: 'auth.password.changed',
      entityType: 'user',
      entityId: userId,
      ...auditMetadata(metadata),
    });
  });
  await publishChatRevocation(userId);
  return true;
}
