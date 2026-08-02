import { UserStatus } from '@prisma/client';
import { prisma } from '#app/lib/prisma.js';
import {
  encryptSecret,
  hashSecret,
  normalizeEmail,
  randomOtp,
  verifySecret,
} from '#app/lib/crypto.js';
import { withAuditedTransaction } from '#app/lib/audited-transaction.js';
import { auditMetadata, expiresIn, type RequestMetadata } from '#app/modules/auth/auth.shared.js';
import { recordInvalidOtpAttempt } from '#app/modules/auth/auth.otp.service.js';
import { verifySocialIdentity } from '#app/modules/auth/social.service.js';
import { addOutboxEvent } from '#app/modules/outbox/outbox.service.js';
import { cancelAllUserSubscriptions } from '#app/modules/stripe/stripe.subscriptions.service.js';
import type { StripeClient } from '#app/modules/stripe/stripe.client.js';
export async function deleteAccount(
  userId: string,
  confirmation: {
    password?: string;
    socialReauth?: { provider: 'google' | 'apple'; idToken: string };
  },
  metadata: RequestMetadata,
  stripeClient: StripeClient | null,
): Promise<boolean> {
  const user = await prisma.user.findFirst({
    where: { id: userId, status: UserStatus.ACTIVE, deletedAt: null },
    select: { passwordHash: true },
  });
  if (!user) return false;
  if (user.passwordHash) {
    const valid = confirmation.password
      ? await verifySecret(user.passwordHash, confirmation.password)
      : false;
    if (!valid) return false;
  } else {
    if (!confirmation.socialReauth) return false;
    const identity = await verifySocialIdentity(
      confirmation.socialReauth.provider,
      confirmation.socialReauth.idToken,
    );
    const linked = await prisma.socialAccount.findFirst({
      where: {
        userId,
        provider: identity.provider,
        providerAccountId: identity.providerAccountId,
        deletedAt: null,
      },
      select: { id: true },
    });
    if (!linked) return false;
  }

  const canceledSubscriptions = await cancelAllUserSubscriptions(userId, stripeClient);
  const deletedAt = new Date();
  await withAuditedTransaction(async (tx, audit) => {
    await tx.user.update({
      where: { id: userId },
      data: {
        email: null,
        phone: null,
        passwordHash: null,
        displayName: null,
        pendingEmail: null,
        stripeCustomerId: null,
        status: UserStatus.DISABLED,
        deletedAt,
      },
    });
    await tx.session.updateMany({
      where: { userId, revokedAt: null },
      data: { revokedAt: deletedAt, revokeReason: 'account_deleted' },
    });
    await tx.refreshToken.updateMany({
      where: { userId, revokedAt: null },
      data: { revokedAt: deletedAt },
    });
    await tx.device.updateMany({ where: { userId, deletedAt: null }, data: { deletedAt } });
    await tx.socialAccount.updateMany({ where: { userId, deletedAt: null }, data: { deletedAt } });
    await tx.otpChallenge.updateMany({ where: { userId, deletedAt: null }, data: { deletedAt } });
    await tx.passwordResetToken.updateMany({
      where: { userId, deletedAt: null },
      data: { deletedAt },
    });
    await tx.upload.updateMany({
      where: { userId, deletedAt: null },
      data: { status: 'DELETED', url: null, deletedAt },
    });
    await tx.stripeSubscription.updateMany({
      where: { userId, deletedAt: null },
      data: { status: 'canceled', canceledAt: deletedAt, deletedAt },
    });
    await audit({
      actorUserId: userId,
      action: 'user.account_deleted',
      entityType: 'user',
      entityId: userId,
      metadata: { canceledSubscriptions },
      ...auditMetadata(metadata),
    });
  });
  return true;
}

async function confirmRecentCredential(
  userId: string,
  confirmation: {
    password?: string;
    socialReauth?: { provider: 'google' | 'apple'; idToken: string };
  },
): Promise<boolean> {
  const user = await prisma.user.findFirst({
    where: { id: userId, status: UserStatus.ACTIVE, deletedAt: null },
    select: { passwordHash: true },
  });
  if (!user) return false;
  if (user.passwordHash) {
    return confirmation.password ? verifySecret(user.passwordHash, confirmation.password) : false;
  }
  if (!confirmation.socialReauth) return false;
  const identity = await verifySocialIdentity(
    confirmation.socialReauth.provider,
    confirmation.socialReauth.idToken,
  );
  const linked = await prisma.socialAccount.findFirst({
    where: {
      userId,
      provider: identity.provider,
      providerAccountId: identity.providerAccountId,
      deletedAt: null,
    },
    select: { id: true },
  });
  return Boolean(linked);
}

export async function requestEmailChange(
  userId: string,
  input: {
    newEmail: string;
    password?: string;
    socialReauth?: { provider: 'google' | 'apple'; idToken: string };
  },
  metadata: RequestMetadata,
): Promise<boolean> {
  if (!(await confirmRecentCredential(userId, input))) return false;
  const newEmail = normalizeEmail(input.newEmail);
  const conflict = await prisma.user.findFirst({
    where: { OR: [{ email: newEmail }, { pendingEmail: newEmail }], deletedAt: null },
    select: { id: true },
  });
  if (conflict) return false;
  const code = randomOtp();
  const codeHash = await hashSecret(code);
  await withAuditedTransaction(async (tx, audit) => {
    await tx.user.update({ where: { id: userId }, data: { pendingEmail: newEmail } });
    const challenge = await tx.otpChallenge.create({
      data: {
        userId,
        normalizedDestination: newEmail,
        channel: 'EMAIL',
        purpose: 'EMAIL_CHANGE',
        codeHash,
        expiresAt: expiresIn(5, 60_000),
      },
    });
    await addOutboxEvent(tx, {
      aggregateType: 'otp_challenge',
      aggregateId: challenge.id,
      eventType: 'auth.otp',
      channel: 'EMAIL',
      payload: {
        challengeId: challenge.id,
        destination: newEmail,
        encryptedCode: encryptSecret(code),
        purpose: 'EMAIL_CHANGE',
      },
      dedupeKey: `otp:${challenge.id}:email-change`,
      expiresAt: challenge.expiresAt,
    });
    await audit({
      actorUserId: userId,
      action: 'auth.email_change.requested',
      entityType: 'user',
      entityId: userId,
      ...auditMetadata(metadata),
    });
  });
  return true;
}

export async function verifyEmailChange(
  userId: string,
  newEmailInput: string,
  code: string,
  metadata: RequestMetadata,
): Promise<boolean> {
  const newEmail = normalizeEmail(newEmailInput);
  const challenge = await prisma.otpChallenge.findFirst({
    where: {
      userId,
      normalizedDestination: newEmail,
      purpose: 'EMAIL_CHANGE',
      consumedAt: null,
      lockedAt: null,
      expiresAt: { gt: new Date() },
      deletedAt: null,
    },
    orderBy: { createdAt: 'desc' },
  });
  if (!challenge || !(await verifySecret(challenge.codeHash, code))) {
    if (challenge) await recordInvalidOtpAttempt(challenge.id);
    return false;
  }
  return withAuditedTransaction(async (tx, audit) => {
    const consumed = await tx.otpChallenge.updateMany({
      where: { id: challenge.id, consumedAt: null, lockedAt: null, expiresAt: { gt: new Date() } },
      data: { consumedAt: new Date() },
    });
    if (consumed.count !== 1) return false;
    const updated = await tx.user.updateMany({
      where: { id: userId, pendingEmail: newEmail, status: UserStatus.ACTIVE, deletedAt: null },
      data: { email: newEmail, pendingEmail: null, emailVerifiedAt: new Date() },
    });
    if (updated.count !== 1) return false;
    await tx.session.updateMany({
      where: { userId, revokedAt: null },
      data: { revokedAt: new Date(), revokeReason: 'email_changed' },
    });
    await tx.refreshToken.updateMany({
      where: { userId, revokedAt: null },
      data: { revokedAt: new Date() },
    });
    await audit({
      actorUserId: userId,
      action: 'auth.email_change.completed',
      entityType: 'user',
      entityId: userId,
      ...auditMetadata(metadata),
    });
    return true;
  });
}
