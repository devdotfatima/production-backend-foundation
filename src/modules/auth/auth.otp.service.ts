import { NotificationChannel, Prisma, UserStatus } from '@prisma/client';
import { withAuditedTransaction } from '#app/lib/audited-transaction.js';
import {
  encryptSecret,
  hashSecret,
  normalizeEmail,
  randomOtp,
  verifySecret,
} from '#app/lib/crypto.js';
import { prisma } from '#app/lib/prisma.js';
import { requiredOtpUserStatus, verificationTransition } from '#app/modules/auth/auth.policy.js';
import {
  auditMetadata,
  type RequestMetadata,
  type TokenPair,
} from '#app/modules/auth/auth.shared.js';
import { createSession } from '#app/modules/auth/auth.sessions.service.js';
import { addOutboxEvent } from '#app/modules/outbox/outbox.service.js';

export async function recordInvalidOtpAttempt(challengeId: string): Promise<void> {
  await prisma.$executeRaw(Prisma.sql`
    UPDATE "otp_challenges"
    SET "attempts" = "attempts" + 1,
        "lockedAt" = CASE WHEN "attempts" + 1 >= "maxAttempts" THEN CURRENT_TIMESTAMP ELSE "lockedAt" END,
        "updatedAt" = CURRENT_TIMESTAMP
    WHERE "id" = CAST(${challengeId} AS UUID)
      AND "attempts" < "maxAttempts"
      AND "consumedAt" IS NULL AND "verifiedAt" IS NULL AND "lockedAt" IS NULL
      AND "deletedAt" IS NULL AND "expiresAt" > CURRENT_TIMESTAMP
  `);
}

export async function sendOtp(
  input: {
    destination: string;
    channel: 'EMAIL' | 'SMS';
    purpose: 'LOGIN' | 'VERIFY_EMAIL' | 'VERIFY_PHONE';
  },
  metadata: RequestMetadata,
): Promise<void> {
  const destination =
    input.channel === 'EMAIL' ? normalizeEmail(input.destination) : input.destination;
  const user = await prisma.user.findFirst({
    where: {
      ...(input.channel === 'EMAIL' ? { email: destination } : { phone: destination }),
      status: requiredOtpUserStatus(input.purpose),
      deletedAt: null,
    },
  });
  if (!user) return;
  const recentlySent = await prisma.otpChallenge.findFirst({
    where: {
      normalizedDestination: destination,
      purpose: input.purpose,
      channel: input.channel,
      sentAt: { gte: new Date(Date.now() - 60_000) },
      consumedAt: null,
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
        normalizedDestination: destination,
        channel: input.channel,
        purpose: input.purpose,
        codeHash,
        expiresAt: new Date(Date.now() + 5 * 60_000),
      },
    });
    await addOutboxEvent(tx, {
      aggregateType: 'otp_challenge',
      aggregateId: challenge.id,
      eventType: 'auth.otp',
      channel: input.channel,
      payload: {
        challengeId: challenge.id,
        destination,
        encryptedCode: encryptSecret(code),
        purpose: input.purpose,
      },
      dedupeKey: `otp:${challenge.id}:${input.channel.toLowerCase()}`,
      expiresAt: challenge.expiresAt,
    });
    await audit({
      actorUserId: user.id,
      action: 'auth.otp.sent',
      entityType: 'otp_challenge',
      entityId: challenge.id,
      metadata: { channel: input.channel, purpose: input.purpose },
      ...auditMetadata(metadata),
    });
  });
}

export async function sendPhoneVerification(
  userId: string,
  destination: string,
  metadata: RequestMetadata,
): Promise<void> {
  const eligible = await prisma.user.findFirst({
    where: { id: userId, status: UserStatus.ACTIVE, deletedAt: null },
    select: { id: true },
  });
  if (!eligible) return;
  const recent = await prisma.otpChallenge.findFirst({
    where: {
      userId,
      normalizedDestination: destination,
      channel: 'SMS',
      purpose: 'VERIFY_PHONE',
      sentAt: { gte: new Date(Date.now() - 60_000) },
      consumedAt: null,
      lockedAt: null,
    },
    select: { id: true },
  });
  if (recent) return;
  const code = randomOtp();
  const codeHash = await hashSecret(code);
  await withAuditedTransaction(async (tx, audit) => {
    const challenge = await tx.otpChallenge.create({
      data: {
        userId,
        normalizedDestination: destination,
        channel: 'SMS',
        purpose: 'VERIFY_PHONE',
        codeHash,
        expiresAt: new Date(Date.now() + 5 * 60_000),
      },
    });
    await addOutboxEvent(tx, {
      aggregateType: 'otp_challenge',
      aggregateId: challenge.id,
      eventType: 'auth.otp',
      channel: NotificationChannel.SMS,
      payload: {
        challengeId: challenge.id,
        destination,
        encryptedCode: encryptSecret(code),
        purpose: 'VERIFY_PHONE',
      },
      dedupeKey: `otp:${challenge.id}:sms`,
      expiresAt: challenge.expiresAt,
    });
    await audit({
      actorUserId: userId,
      action: 'auth.phone_verification.sent',
      entityType: 'user',
      entityId: userId,
      ...auditMetadata(metadata),
    });
  });
}

export async function verifyOtp(
  input: {
    destination: string;
    channel: 'EMAIL' | 'SMS';
    purpose: 'LOGIN' | 'VERIFY_EMAIL' | 'VERIFY_PHONE';
    code: string;
  },
  metadata: RequestMetadata,
): Promise<TokenPair | 'VERIFIED' | null> {
  const destination =
    input.channel === 'EMAIL' ? normalizeEmail(input.destination) : input.destination;
  const challenge = await prisma.otpChallenge.findFirst({
    where: {
      normalizedDestination: destination,
      channel: input.channel,
      purpose: input.purpose,
      consumedAt: null,
      lockedAt: null,
      deletedAt: null,
    },
    orderBy: { createdAt: 'desc' },
    include: { user: true },
  });
  if (!challenge || challenge.expiresAt <= new Date() || !challenge.user) return null;
  if (!(await verifySecret(challenge.codeHash, input.code))) {
    await recordInvalidOtpAttempt(challenge.id);
    return null;
  }
  const verified = await withAuditedTransaction(async (tx, audit) => {
    const consumed = await tx.otpChallenge.updateMany({
      where: { id: challenge.id, consumedAt: null, lockedAt: null },
      data: { consumedAt: new Date() },
    });
    if (consumed.count !== 1) throw new Error('OTP was already consumed');
    let allowed: boolean;
    let priorStatus: UserStatus | undefined;
    if (input.purpose === 'LOGIN') {
      allowed = Boolean(
        await tx.user.findFirst({
          where: { id: challenge.userId!, status: UserStatus.ACTIVE, deletedAt: null },
          select: { id: true },
        }),
      );
    } else {
      const currentUser = await tx.user.findFirst({
        where: { id: challenge.userId!, deletedAt: null },
        select: { status: true },
      });
      priorStatus = currentUser?.status;
      const transition = currentUser ? verificationTransition(currentUser.status) : 'BLOCKED';
      if (!currentUser || transition === 'BLOCKED') allowed = false;
      else {
        const verificationData =
          input.purpose === 'VERIFY_EMAIL'
            ? { emailVerifiedAt: new Date() }
            : { phone: challenge.normalizedDestination, phoneVerifiedAt: new Date() };
        const updated = await tx.user.updateMany({
          where: { id: challenge.userId!, status: currentUser.status, deletedAt: null },
          data: {
            ...verificationData,
            ...(transition === 'ACTIVATE' ? { status: UserStatus.ACTIVE } : {}),
          },
        });
        allowed = updated.count === 1;
      }
    }
    await audit({
      actorUserId: challenge.userId ?? undefined,
      action: allowed ? 'auth.otp.verified' : 'auth.otp.verification_blocked',
      entityType: 'otp_challenge',
      entityId: challenge.id,
      metadata: { purpose: input.purpose, ...(priorStatus ? { priorStatus } : {}) },
      ...auditMetadata(metadata),
    });
    return allowed;
  });
  if (!verified) return null;
  return input.purpose === 'LOGIN' ? createSession(challenge.user.id, metadata) : 'VERIFIED';
}
