import { Prisma, UserStatus } from '@prisma/client';
import { prisma } from '#app/lib/prisma.js';
import { errors } from '#app/lib/errors.js';
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
import type { StripeClient } from '#app/modules/stripe/stripe.client.js';
import type { UploadProviderAdapter } from '#app/modules/uploads/uploads.provider.js';
import { withoutTenantScope } from '#app/lib/request-context.js';
import { publishChatRevocation } from '#app/modules/chat/chat.revocations.js';

export async function deleteAccount(
  userId: string,
  confirmation: {
    password?: string;
    socialReauth?: { provider: 'google' | 'apple'; idToken: string };
  },
  metadata: RequestMetadata,
  stripeClient: StripeClient | null,
  uploadProvider: UploadProviderAdapter | null,
): Promise<boolean> {
  // Account erasure is global to the human, not to whichever organization their current session
  // happens to hold. Provider dependencies are retained in the public signature for backwards
  // compatibility; external deletion is now performed durably by the worker after commit.
  void stripeClient;
  void uploadProvider;
  const deleted = await withoutTenantScope('account-deletion', () =>
    deleteAccountUnscoped(userId, confirmation, metadata),
  );
  if (deleted) await publishChatRevocation(userId);
  return deleted;
}

async function deleteAccountUnscoped(
  userId: string,
  confirmation: {
    password?: string;
    socialReauth?: { provider: 'google' | 'apple'; idToken: string };
  },
  metadata: RequestMetadata,
): Promise<boolean> {
  const user = await prisma.user.findFirst({
    where: { id: userId, status: UserStatus.ACTIVE, deletedAt: null },
    select: { passwordHash: true, stripeCustomerId: true },
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

  const uploads = await prisma.upload.findMany({
    where: {
      userId,
      status: { in: ['PENDING', 'QUARANTINED', 'SCANNING', 'READY'] },
      deletedAt: null,
    },
    select: { id: true, objectKey: true, contentType: true, visibility: true, provider: true },
  });
  const otpChallenges = await prisma.otpChallenge.findMany({
    where: { userId, deletedAt: null },
    select: { id: true },
  });
  const deletedAt = new Date();
  await withAuditedTransaction(async (tx, audit) => {
    const ownerMemberships = await tx.membership.findMany({
      where: {
        userId,
        status: 'ACTIVE',
        deletedAt: null,
        role: { name: 'owner', deletedAt: null },
      },
      select: { organizationId: true },
    });
    // Consistent ordering prevents deadlocks when two owners delete accounts concurrently.
    for (const organizationId of ownerMemberships
      .map((membership) => membership.organizationId)
      .sort()) {
      await tx.$executeRaw(
        Prisma.sql`SELECT pg_advisory_xact_lock(hashtextextended(${`organization-owners:${organizationId}`}, 0))`,
      );
      const owners = await tx.membership.count({
        where: {
          organizationId,
          status: 'ACTIVE',
          deletedAt: null,
          role: { name: 'owner', deletedAt: null },
        },
      });
      if (owners <= 1) {
        throw errors.conflict(
          'Transfer ownership or add another owner before deleting this account',
        );
      }
    }

    await tx.user.update({
      where: { id: userId },
      data: {
        email: null,
        phone: null,
        passwordHash: null,
        displayName: null,
        locale: 'en',
        pendingEmail: null,
        stripeCustomerId: null,
        emailVerifiedAt: null,
        phoneVerifiedAt: null,
        lastLoginAt: null,
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
    await tx.session.updateMany({
      where: { userId, deletedAt: null },
      data: { ipHash: null, userAgent: null },
    });
    await tx.device.deleteMany({ where: { userId, deletedAt: null } });
    await tx.socialAccount.deleteMany({ where: { userId, deletedAt: null } });
    await tx.passwordResetToken.deleteMany({ where: { userId, deletedAt: null } });
    await tx.otpChallenge.deleteMany({ where: { userId, deletedAt: null } });
    await tx.userRole.deleteMany({ where: { userId, deletedAt: null } });
    await tx.notificationPreference.deleteMany({ where: { userId, deletedAt: null } });
    await tx.notificationDelivery.updateMany({
      where: { userId, deletedAt: null },
      data: { userId: null },
    });
    await tx.membership.updateMany({
      where: { userId, deletedAt: null },
      data: { status: 'SUSPENDED', deletedAt },
    });
    await tx.uploadBandwidthUsage.deleteMany({ where: { userId } });
    for (const upload of uploads) {
      await tx.upload.update({
        where: { id: upload.id },
        data: {
          status: 'DELETED',
          originalName: 'erased',
          checksum: null,
          scanReference: null,
          url: null,
          deletedAt,
        },
      });
    }
    const challengeIds = otpChallenges.map((challenge) => challenge.id);
    const erasedOutboxWhere = {
      OR: [
        ...(challengeIds.length > 0
          ? [{ aggregateType: 'otp_challenge', aggregateId: { in: challengeIds } }]
          : []),
        { aggregateType: 'user', aggregateId: userId },
      ],
      deletedAt: null,
    };
    await tx.outboxEvent.updateMany({
      where: erasedOutboxWhere,
      data: { payload: { erased: true }, expiresAt: deletedAt },
    });
    await tx.outboxEvent.updateMany({
      where: {
        ...erasedOutboxWhere,
        status: { in: ['PENDING', 'CLAIMED', 'ENQUEUED', 'PROCESSING', 'FAILED'] },
      },
      data: {
        status: 'DEAD_LETTER',
        lastError: 'Account deleted before delivery',
        claimToken: null,
        claimedAt: null,
        claimExpiresAt: null,
      },
    });
    // Actor keys are tenant-prefixed (`org:<id>:user:<id>`), so match on the stable suffix or a
    // deleted account would leave its stored responses behind in every organization it joined.
    await tx.idempotencyRecord.deleteMany({
      where: { actorKey: { endsWith: `user:${userId}` }, deletedAt: null },
    });
    await tx.stripeSubscription.updateMany({
      // Organization-owned subscriptions survive a member deleting their personal account.
      where: { userId, organizationId: null, deletedAt: null },
      data: { status: 'canceled', canceledAt: deletedAt, deletedAt },
    });
    await addOutboxEvent(tx, {
      aggregateType: 'account_erasure',
      aggregateId: userId,
      eventType: 'account.erasure.requested',
      channel: 'INTERNAL',
      payload: {
        userId,
        ...(user.stripeCustomerId ? { stripeCustomerId: user.stripeCustomerId } : {}),
      },
      dedupeKey: `account-erasure:${userId}`,
    });
    await audit({
      actorUserId: userId,
      action: 'user.account_deleted',
      entityType: 'user',
      entityId: userId,
      metadata: { queuedUploadObjects: uploads.length, externalCleanupQueued: true },
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
  const changed = await withAuditedTransaction(async (tx, audit) => {
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
  if (changed) await publishChatRevocation(userId);
  return changed;
}
