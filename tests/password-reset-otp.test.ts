import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => {
  const transaction = {
    otpChallenge: { create: vi.fn(), updateMany: vi.fn() },
    passwordResetToken: { create: vi.fn(), updateMany: vi.fn() },
    outboxEvent: { create: vi.fn() },
    user: { updateMany: vi.fn() },
    session: { updateMany: vi.fn() },
    refreshToken: { updateMany: vi.fn() },
    auditEvent: { create: vi.fn() },
  };
  return {
    transaction,
    prisma: {
      user: { findFirst: vi.fn() },
      otpChallenge: { findFirst: vi.fn(), updateMany: vi.fn() },
      passwordResetToken: { findFirst: vi.fn() },
      $executeRaw: vi.fn(),
      $transaction: vi.fn(),
    },
    encryptSecret: vi.fn((value: string) => `encrypted:${value}`),
    hashMetadata: vi.fn((value: string) => `metadata:${value}`),
    hashOpaqueToken: vi.fn((value: string) => `opaque:${value}`),
    hashSecret: vi.fn(async (value: string) => `hashed:${value}`),
    normalizeEmail: vi.fn((value: string) => value.trim().toLowerCase()),
    randomOtp: vi.fn(() => '123456'),
    randomToken: vi.fn(() => 'random-token'),
    verifySecret: vi.fn(),
  };
});

vi.mock('#app/lib/prisma.js', () => ({ prisma: mocks.prisma }));
vi.mock('#app/lib/crypto.js', () => ({
  candidateOpaqueTokenHashes: vi.fn((value: string) => [`opaque:${value}`]),
  constantTimeEqual: vi.fn(() => true),
  encryptSecret: mocks.encryptSecret,
  hashMetadata: mocks.hashMetadata,
  hashOpaqueToken: mocks.hashOpaqueToken,
  hashSecret: mocks.hashSecret,
  normalizeEmail: mocks.normalizeEmail,
  randomOtp: mocks.randomOtp,
  randomToken: mocks.randomToken,
  verifySecret: mocks.verifySecret,
}));

import {
  confirmPasswordReset,
  requestPasswordReset,
  verifyPasswordResetOtp,
} from '../dist/src/modules/auth/auth.service.js';

const metadata = { ip: '127.0.0.1', requestId: 'request-id', userAgent: 'test' };
const activeUser = {
  id: 'user-id',
  status: 'ACTIVE',
  deletedAt: null,
};

function resetChallenge() {
  return {
    id: 'challenge-id',
    userId: 'user-id',
    normalizedDestination: 'user@example.com',
    channel: 'EMAIL',
    purpose: 'PASSWORD_RESET',
    codeHash: 'hashed:123456',
    attempts: 0,
    maxAttempts: 5,
    sentAt: new Date(),
    expiresAt: new Date(Date.now() + 60_000),
    verifiedAt: null,
    consumedAt: null,
    lockedAt: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    deletedAt: null,
    user: activeUser,
  };
}

function resetCredential() {
  return {
    id: 'reset-token-id',
    userId: 'user-id',
    otpChallengeId: 'challenge-id',
    tokenHash: 'opaque:random-token',
    expiresAt: new Date(Date.now() + 60_000),
    usedAt: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    deletedAt: null,
    user: activeUser,
  };
}

describe('password reset OTP flow', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.prisma.$transaction.mockImplementation(
      (callback: (tx: typeof mocks.transaction) => Promise<unknown>) => callback(mocks.transaction),
    );
    mocks.transaction.otpChallenge.create.mockResolvedValue({ id: 'challenge-id' });
    mocks.transaction.otpChallenge.updateMany.mockResolvedValue({ count: 1 });
    mocks.transaction.passwordResetToken.create.mockResolvedValue({ id: 'reset-token-id' });
    mocks.transaction.passwordResetToken.updateMany.mockResolvedValue({ count: 1 });
    mocks.transaction.user.updateMany.mockResolvedValue({ count: 1 });
    mocks.transaction.session.updateMany.mockResolvedValue({ count: 1 });
    mocks.transaction.refreshToken.updateMany.mockResolvedValue({ count: 1 });
    mocks.transaction.auditEvent.create.mockResolvedValue({});
    mocks.verifySecret.mockResolvedValue(true);
    mocks.prisma.$executeRaw.mockResolvedValue(1);
  });

  it('creates an email OTP challenge instead of a reset token', async () => {
    mocks.prisma.user.findFirst.mockResolvedValue({ id: 'user-id' });
    mocks.prisma.otpChallenge.findFirst.mockResolvedValue(null);

    await requestPasswordReset(' User@Example.COM ', metadata);

    const challengeCreate = mocks.transaction.otpChallenge.create.mock.calls[0]?.[0] as {
      data: Record<string, unknown>;
    };
    expect(challengeCreate.data).toMatchObject({
      userId: 'user-id',
      normalizedDestination: 'user@example.com',
      channel: 'EMAIL',
      purpose: 'PASSWORD_RESET',
      codeHash: 'hashed:123456',
    });
    const outboxCreate = mocks.transaction.outboxEvent.create.mock.calls[0]?.[0] as {
      data: { eventType: string; payload: Record<string, unknown> };
    };
    expect(outboxCreate.data.eventType).toBe('auth.otp');
    expect(outboxCreate.data.payload).toMatchObject({
      purpose: 'PASSWORD_RESET',
    });
  });

  it('verifies the password-reset OTP and returns a separately hashed reset credential', async () => {
    mocks.prisma.otpChallenge.findFirst.mockResolvedValue(resetChallenge());

    const credential = await verifyPasswordResetOtp('user@example.com', '123456', metadata);
    expect(credential?.resetToken).toBe('random-token');
    expect(credential?.expiresAt).toBeInstanceOf(Date);

    const challengeUpdate = mocks.transaction.otpChallenge.updateMany.mock.calls[0]?.[0] as {
      where: Record<string, unknown>;
      data: { verifiedAt: Date };
    };
    expect(challengeUpdate.where).toMatchObject({
      id: 'challenge-id',
      consumedAt: null,
      verifiedAt: null,
    });
    expect(challengeUpdate.data.verifiedAt).toBeInstanceOf(Date);
    const tokenCreate = mocks.transaction.passwordResetToken.create.mock.calls[0]?.[0] as {
      data: {
        userId: string;
        otpChallengeId: string;
        tokenHash: string;
        expiresAt: Date;
      };
    };
    expect(tokenCreate.data).toMatchObject({
      userId: 'user-id',
      otpChallengeId: 'challenge-id',
      tokenHash: 'opaque:random-token',
    });
    expect(tokenCreate.data.expiresAt).toBeInstanceOf(Date);
    expect(mocks.transaction.user.updateMany).not.toHaveBeenCalled();
  });

  it('increments and locks invalid OTP attempts in one database statement', async () => {
    mocks.prisma.otpChallenge.findFirst.mockResolvedValue(resetChallenge());
    mocks.verifySecret.mockResolvedValue(false);

    await expect(
      verifyPasswordResetOtp('user@example.com', '000000', metadata),
    ).resolves.toBeNull();

    const statement = mocks.prisma.$executeRaw.mock.calls[0]?.[0] as { strings?: string[] };
    const sql = statement.strings?.join('?') ?? '';
    expect(sql).toContain('"attempts" = "attempts" + 1');
    expect(sql).toContain('"attempts" + 1 >= "maxAttempts"');
    expect(mocks.prisma.otpChallenge.updateMany).not.toHaveBeenCalled();
  });

  it('consumes the verified OTP when changing the password and revokes sessions', async () => {
    mocks.prisma.passwordResetToken.findFirst.mockResolvedValue(resetCredential());

    await expect(
      confirmPasswordReset('random-token', 'a-strong-password-123', metadata),
    ).resolves.toBe(true);

    const tokenConsume = mocks.transaction.passwordResetToken.updateMany.mock.calls[0]?.[0] as {
      where: Record<string, unknown>;
      data: { usedAt: Date };
    };
    expect(tokenConsume.where).toMatchObject({
      id: 'reset-token-id',
      tokenHash: 'opaque:random-token',
      usedAt: null,
    });
    expect(tokenConsume.data.usedAt).toBeInstanceOf(Date);
    const challengeConsume = mocks.transaction.otpChallenge.updateMany.mock.calls[0]?.[0] as {
      where: Record<string, unknown>;
      data: { consumedAt: Date };
    };
    expect(challengeConsume.where).toMatchObject({ id: 'challenge-id', consumedAt: null });
    expect(challengeConsume.data.consumedAt).toBeInstanceOf(Date);
    expect(mocks.transaction.user.updateMany).toHaveBeenCalledWith({
      where: { id: 'user-id', status: 'ACTIVE', deletedAt: null },
      data: { passwordHash: 'hashed:a-strong-password-123' },
    });
    expect(mocks.transaction.session.updateMany).toHaveBeenCalled();
    expect(mocks.transaction.refreshToken.updateMany).toHaveBeenCalled();
  });

  it('does not reuse an already consumed reset credential', async () => {
    mocks.prisma.passwordResetToken.findFirst.mockResolvedValue(resetCredential());
    mocks.transaction.passwordResetToken.updateMany.mockResolvedValueOnce({ count: 0 });

    await expect(
      confirmPasswordReset('random-token', 'a-strong-password-123', metadata),
    ).resolves.toBe(false);

    expect(mocks.transaction.user.updateMany).not.toHaveBeenCalled();
  });
});
