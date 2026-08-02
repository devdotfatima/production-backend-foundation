import { NotificationChannel, Prisma, UserStatus } from '@prisma/client';
import { prisma } from '#app/lib/prisma.js';
import {
  constantTimeEqual,
  candidateOpaqueTokenHashes,
  encryptSecret,
  hashMetadata,
  hashOpaqueToken,
  hashSecret,
  normalizeEmail,
  randomOtp,
  randomToken,
  verifySecret,
} from '#app/lib/crypto.js';
import { signAccessToken } from '#app/lib/jwt.js';
import { withAuditedTransaction } from '#app/lib/audited-transaction.js';
import { env } from '#app/config/env.js';
import { requiredOtpUserStatus, verificationTransition } from '#app/modules/auth/auth.policy.js';
import { verifySocialIdentity } from '#app/modules/auth/social.service.js';
import { addOutboxEvent } from '#app/modules/outbox/outbox.service.js';
import type { AuditInput } from '#app/modules/audit/audit.service.js';
import { cancelAllUserSubscriptions } from '#app/modules/stripe/stripe.subscriptions.service.js';
import type { StripeClient } from '#app/modules/stripe/stripe.client.js';

export const genericAuthMessage = {
  message: 'If the supplied information is eligible, the requested action will be completed.',
} as const;

interface RequestMetadata {
  ip: string;
  userAgent?: string;
  requestId: string;
}

interface TokenPair {
  accessToken: string;
  refreshToken: string;
}

const dummyPasswordHash = hashSecret(randomToken());

function expiresIn(amount: number, unitMilliseconds: number): Date {
  return new Date(Date.now() + amount * unitMilliseconds);
}

async function recordInvalidOtpAttempt(challengeId: string): Promise<void> {
  await prisma.$executeRaw(Prisma.sql`
    UPDATE "otp_challenges"
    SET
      "attempts" = "attempts" + 1,
      "lockedAt" = CASE
        WHEN "attempts" + 1 >= "maxAttempts" THEN CURRENT_TIMESTAMP
        ELSE "lockedAt"
      END,
      "updatedAt" = CURRENT_TIMESTAMP
    WHERE "id" = CAST(${challengeId} AS UUID)
      AND "attempts" < "maxAttempts"
      AND "consumedAt" IS NULL
      AND "verifiedAt" IS NULL
      AND "lockedAt" IS NULL
      AND "deletedAt" IS NULL
      AND "expiresAt" > CURRENT_TIMESTAMP
  `);
}

function auditMetadata(
  metadata: RequestMetadata,
): Pick<AuditInput, 'requestId' | 'ip' | 'userAgent'> {
  return {
    requestId: metadata.requestId,
    ip: metadata.ip,
    userAgent: metadata.userAgent,
  };
}

async function createSession(userId: string, metadata: RequestMetadata): Promise<TokenPair> {
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
      data: {
        email,
        passwordHash,
        displayName: input.displayName,
        status: UserStatus.PENDING,
      },
    });
    const challenge = await tx.otpChallenge.create({
      data: {
        userId: user.id,
        normalizedDestination: email,
        channel: 'EMAIL',
        purpose: 'VERIFY_EMAIL',
        codeHash,
        expiresAt: expiresIn(5, 60 * 1000),
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
    await withAuditedTransaction(async (tx, audit) => {
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

export async function loginWithSocial(
  provider: 'google' | 'apple',
  idToken: string,
  displayName: string | undefined,
  metadata: RequestMetadata,
): Promise<TokenPair | null> {
  const identity = await verifySocialIdentity(provider, idToken);
  const userId = await withAuditedTransaction(async (tx, audit) => {
    const linked = await tx.socialAccount.findFirst({
      where: {
        provider: identity.provider,
        providerAccountId: identity.providerAccountId,
        deletedAt: null,
      },
      select: { userId: true, user: { select: { id: true, status: true, deletedAt: true } } },
    });

    if (linked) {
      if (linked.user.deletedAt || linked.user.status !== UserStatus.ACTIVE) return null;
      await tx.socialAccount.updateMany({
        where: { userId: linked.userId, provider: identity.provider, deletedAt: null },
        data: { email: identity.email },
      });
      return linked.userId;
    }

    const existing = identity.email
      ? await tx.user.findUnique({
          where: { email: identity.email },
          select: { id: true, status: true, deletedAt: true },
        })
      : null;
    if (
      existing?.deletedAt ||
      existing?.status === UserStatus.SUSPENDED ||
      existing?.status === UserStatus.DISABLED
    ) {
      return null;
    }

    let userIdForAccount: string;
    if (existing) {
      const activated = await tx.user.update({
        where: { id: existing.id },
        data: {
          status: UserStatus.ACTIVE,
          ...(identity.emailVerified ? { emailVerifiedAt: new Date() } : {}),
          ...(displayName || identity.displayName
            ? { displayName: displayName ?? identity.displayName }
            : {}),
        },
        select: { id: true },
      });
      userIdForAccount = activated.id;
    } else {
      const created = await tx.user.create({
        data: {
          email: identity.email,
          displayName: displayName ?? identity.displayName,
          status: UserStatus.ACTIVE,
          ...(identity.emailVerified ? { emailVerifiedAt: new Date() } : {}),
        },
        select: { id: true },
      });
      userIdForAccount = created.id;
    }

    await tx.socialAccount.create({
      data: {
        userId: userIdForAccount,
        provider: identity.provider,
        providerAccountId: identity.providerAccountId,
        email: identity.email,
      },
    });
    await audit({
      actorUserId: userIdForAccount,
      action: 'auth.social_account.linked',
      entityType: 'social_account',
      metadata: { provider: identity.provider },
      ...auditMetadata(metadata),
    });
    return userIdForAccount;
  });

  if (!userId) return null;
  return createSession(userId, metadata);
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
    await tx.session.updateMany({
      where: { userId, id: { not: sessionId }, revokedAt: null },
      data: { revokedAt: new Date(), revokeReason: 'password_changed' },
    });
    await tx.refreshToken.updateMany({
      where: { userId, sessionId: { not: sessionId }, revokedAt: null },
      data: { revokedAt: new Date() },
    });
    await audit({
      actorUserId: userId,
      action: 'auth.password.changed',
      entityType: 'user',
      entityId: userId,
      ...auditMetadata(metadata),
    });
  });
  return true;
}

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
  const requiredStatus = requiredOtpUserStatus(input.purpose);
  const user = await prisma.user.findFirst({
    where: {
      ...(input.channel === 'EMAIL' ? { email: destination } : { phone: destination }),
      status: requiredStatus,
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
        expiresAt: expiresIn(5, 60_000),
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
  const eligibleUser = await prisma.user.findFirst({
    where: { id: userId, status: UserStatus.ACTIVE, deletedAt: null },
    select: { id: true },
  });
  if (!eligibleUser) return;

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
        expiresAt: expiresIn(5, 60_000),
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

  const valid = await verifySecret(challenge.codeHash, input.code);
  if (!valid) {
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
      const activeUser = await tx.user.findFirst({
        where: { id: challenge.userId!, status: UserStatus.ACTIVE, deletedAt: null },
        select: { id: true },
      });
      allowed = Boolean(activeUser);
    } else {
      const currentUser = await tx.user.findFirst({
        where: { id: challenge.userId!, deletedAt: null },
        select: { status: true },
      });
      priorStatus = currentUser?.status;
      const transition = currentUser ? verificationTransition(currentUser.status) : 'BLOCKED';

      if (!currentUser || transition === 'BLOCKED') {
        allowed = false;
      } else {
        const verificationData =
          input.purpose === 'VERIFY_EMAIL'
            ? { emailVerifiedAt: new Date() }
            : {
                phone: challenge.normalizedDestination,
                phoneVerifiedAt: new Date(),
              };
        const updated = await tx.user.updateMany({
          where: {
            id: challenge.userId!,
            status: currentUser.status,
            deletedAt: null,
          },
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
      metadata: {
        purpose: input.purpose,
        ...(priorStatus ? { priorStatus } : {}),
      },
      ...auditMetadata(metadata),
    });
    return allowed;
  });

  if (!verified) return null;
  if (input.purpose === 'LOGIN') return createSession(challenge.user.id, metadata);
  return 'VERIFIED';
}

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
  ) {
    return null;
  }

  const valid = await verifySecret(challenge.codeHash, otp);
  if (!valid) {
    await recordInvalidOtpAttempt(challenge.id);
    return null;
  }

  const resetToken = randomToken();
  const tokenHash = hashOpaqueToken(resetToken);
  const expiresAt = expiresIn(env.PASSWORD_RESET_TOKEN_TTL_MINUTES, 60 * 1_000);
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
      data: {
        userId: challenge.userId!,
        otpChallengeId: challenge.id,
        tokenHash,
        expiresAt,
      },
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
  if (
    !reset ||
    !reset.userId ||
    !reset.user ||
    reset.user.status !== UserStatus.ACTIVE ||
    reset.user.deletedAt
  ) {
    await hashSecret(newPassword);
    return false;
  }

  const userId = reset.userId;
  const tokenHash = reset.tokenHash;
  const passwordHash = await hashSecret(newPassword);
  return withAuditedTransaction(async (tx, audit) => {
    const usedAt = new Date();
    const used = await tx.passwordResetToken.updateMany({
      where: {
        id: reset.id,
        tokenHash,
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
      where: { id: userId, status: UserStatus.ACTIVE, deletedAt: null },
      data: { passwordHash },
    });
    if (updated.count !== 1) throw new Error('Password reset user is no longer eligible');
    await tx.session.updateMany({
      where: { userId, revokedAt: null },
      data: { revokedAt: new Date(), revokeReason: 'password_reset' },
    });
    await tx.refreshToken.updateMany({
      where: { userId, revokedAt: null },
      data: { revokedAt: new Date() },
    });
    await tx.passwordResetToken.updateMany({
      where: { userId, id: { not: reset.id }, usedAt: null, deletedAt: null },
      data: { deletedAt: usedAt },
    });
    await audit({
      actorUserId: userId,
      action: 'auth.password_reset.completed',
      entityType: 'user',
      entityId: userId,
      ...auditMetadata(metadata),
    });
    return true;
  });
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
