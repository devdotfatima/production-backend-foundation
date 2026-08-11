import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => {
  const transaction = {
    $executeRaw: vi.fn(),
    membership: { findMany: vi.fn(), count: vi.fn(), updateMany: vi.fn() },
    user: { update: vi.fn() },
    session: { updateMany: vi.fn() },
    refreshToken: { updateMany: vi.fn() },
    device: { deleteMany: vi.fn() },
    socialAccount: { deleteMany: vi.fn() },
    passwordResetToken: { deleteMany: vi.fn() },
    otpChallenge: { deleteMany: vi.fn() },
    userRole: { deleteMany: vi.fn() },
    notificationPreference: { deleteMany: vi.fn() },
    notificationDelivery: { updateMany: vi.fn() },
    uploadBandwidthUsage: { deleteMany: vi.fn() },
    upload: { update: vi.fn() },
    outboxEvent: { updateMany: vi.fn() },
    idempotencyRecord: { deleteMany: vi.fn() },
    stripeSubscription: { updateMany: vi.fn() },
  };
  return {
    transaction,
    audit: vi.fn(),
    userFindFirst: vi.fn(),
    socialAccountFindFirst: vi.fn(),
    uploadFindMany: vi.fn(),
    uploadUpdate: vi.fn(),
    otpChallengeFindMany: vi.fn(),
    verifySecret: vi.fn(),
    addOutboxEvent: vi.fn(),
    publishChatRevocation: vi.fn(),
    cancelCustomerSubscriptions: vi.fn(),
  };
});

vi.mock('#app/lib/prisma.js', () => ({
  prisma: {
    user: { findFirst: mocks.userFindFirst },
    socialAccount: { findFirst: mocks.socialAccountFindFirst },
    upload: { findMany: mocks.uploadFindMany, update: mocks.uploadUpdate },
    otpChallenge: { findMany: mocks.otpChallengeFindMany },
  },
}));
vi.mock('#app/lib/audited-transaction.js', () => ({
  withAuditedTransaction: (operation: (tx: unknown, audit: unknown) => Promise<unknown>) =>
    operation(mocks.transaction, mocks.audit),
}));
vi.mock('#app/lib/request-context.js', () => ({
  withoutTenantScope: (_reason: string, operation: () => unknown) => operation(),
}));
vi.mock('#app/lib/crypto.js', () => ({
  encryptSecret: (value: string) => `encrypted:${value}`,
  hashSecret: vi.fn(),
  normalizeEmail: (value: string) => value.trim().toLowerCase(),
  randomOtp: () => '123456',
  randomToken: () => 'random-token',
  verifySecret: mocks.verifySecret,
}));
vi.mock('#app/modules/auth/auth.otp.service.js', () => ({ recordInvalidOtpAttempt: vi.fn() }));
vi.mock('#app/modules/auth/social.service.js', () => ({ verifySocialIdentity: vi.fn() }));
vi.mock('#app/modules/outbox/outbox.service.js', () => ({
  addOutboxEvent: mocks.addOutboxEvent,
}));
vi.mock('#app/modules/chat/chat.revocations.js', () => ({
  publishChatRevocation: mocks.publishChatRevocation,
}));
vi.mock('#app/modules/stripe/stripe.subscriptions.service.js', () => ({
  cancelCustomerSubscriptions: mocks.cancelCustomerSubscriptions,
}));

import { processAccountErasure } from '#app/modules/auth/account-erasure.service.js';
import { deleteAccount } from '#app/modules/auth/auth.account.service.js';

const userId = '00000000-0000-7000-8000-0000000000a1';
const metadata = { requestId: 'request-1', ip: '203.0.113.7', userAgent: 'test' };

beforeEach(() => {
  vi.clearAllMocks();
  mocks.userFindFirst.mockResolvedValue({
    passwordHash: 'password-hash',
    stripeCustomerId: 'cus_1',
  });
  mocks.verifySecret.mockResolvedValue(true);
  mocks.uploadFindMany.mockResolvedValue([]);
  mocks.otpChallengeFindMany.mockResolvedValue([]);
  mocks.transaction.membership.findMany.mockResolvedValue([]);
  mocks.transaction.membership.count.mockResolvedValue(2);
});

describe('transactional account deletion', () => {
  it('commits anonymization and durable cleanup work without calling providers in-request', async () => {
    const stripeCancel = vi.fn(() => Promise.reject(new Error('must not run in request')));
    const deleteObject = vi.fn(() => Promise.reject(new Error('must not run in request')));

    await expect(
      deleteAccount(
        userId,
        { password: 'correct' },
        metadata,
        { subscriptions: { cancel: stripeCancel } } as never,
        { kind: 'S3', deleteObject } as never,
      ),
    ).resolves.toBe(true);

    expect(stripeCancel).not.toHaveBeenCalled();
    expect(deleteObject).not.toHaveBeenCalled();
    expect(mocks.addOutboxEvent).toHaveBeenCalledWith(
      mocks.transaction,
      expect.objectContaining({
        eventType: 'account.erasure.requested',
        channel: 'INTERNAL',
        payload: { userId, stripeCustomerId: 'cus_1' },
      }),
    );
    expect(mocks.publishChatRevocation).toHaveBeenCalledWith(userId);
  });

  it('refuses deletion when the user is an organization sole owner', async () => {
    mocks.transaction.membership.findMany.mockResolvedValue([
      { organizationId: '00000000-0000-7000-8000-0000000000b2' },
    ]);
    mocks.transaction.membership.count.mockResolvedValue(1);

    await expect(
      deleteAccount(userId, { password: 'correct' }, metadata, null, null),
    ).rejects.toMatchObject({ statusCode: 409 });

    expect(mocks.transaction.user.update).not.toHaveBeenCalled();
    expect(mocks.addOutboxEvent).not.toHaveBeenCalled();
  });
});

describe('resumable account-erasure worker', () => {
  it('cancels Stripe and scrubs each object key only after provider deletion succeeds', async () => {
    const upload = {
      id: '00000000-0000-7000-8000-0000000000c3',
      provider: 'S3',
      objectKey: 'users/a/private.pdf',
      contentType: 'application/pdf',
      visibility: 'PRIVATE',
    };
    mocks.uploadFindMany.mockResolvedValueOnce([upload]).mockResolvedValueOnce([]);
    const deleteObject = vi.fn().mockResolvedValue(undefined);

    await processAccountErasure(
      { userId, stripeCustomerId: 'cus_1' },
      {
        stripeClient: {} as never,
        uploadProvider: { kind: 'S3', deleteObject } as never,
      },
    );

    expect(mocks.cancelCustomerSubscriptions).toHaveBeenCalledWith('cus_1', {});
    expect(deleteObject).toHaveBeenCalledWith({
      objectKey: upload.objectKey,
      contentType: upload.contentType,
      visibility: upload.visibility,
    });
    const update = mocks.uploadUpdate.mock.calls[0]?.[0] as
      | {
          where?: { id?: string; deletedAt?: { not?: null } };
          data?: { objectKey?: string; storageDeletedAt?: unknown };
        }
      | undefined;
    expect(update?.where).toEqual({ id: upload.id, deletedAt: { not: null } });
    expect(update?.data?.objectKey).toBe(`erased/${upload.id}`);
    expect(update?.data?.storageDeletedAt).toBeInstanceOf(Date);
  });

  it('keeps the object key retryable when storage deletion fails', async () => {
    mocks.uploadFindMany.mockResolvedValue([
      {
        id: '00000000-0000-7000-8000-0000000000c3',
        provider: 'S3',
        objectKey: 'users/a/private.pdf',
        contentType: 'application/pdf',
        visibility: 'PRIVATE',
      },
    ]);
    const deleteObject = vi.fn().mockRejectedValue(new Error('storage unavailable'));

    await expect(
      processAccountErasure(
        { userId },
        { stripeClient: null, uploadProvider: { kind: 'S3', deleteObject } as never },
      ),
    ).rejects.toThrow('storage unavailable');

    expect(mocks.uploadUpdate).not.toHaveBeenCalled();
  });
});
