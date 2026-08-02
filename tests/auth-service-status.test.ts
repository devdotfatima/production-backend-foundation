import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => {
  const transaction = {
    otpChallenge: { updateMany: vi.fn() },
    user: { findFirst: vi.fn(), updateMany: vi.fn() },
    auditEvent: { create: vi.fn() },
  };
  return {
    transaction,
    prisma: {
      user: { findFirst: vi.fn() },
      otpChallenge: { findFirst: vi.fn() },
      $executeRaw: vi.fn(),
      $transaction: vi.fn(),
    },
    verifySecret: vi.fn(),
  };
});

vi.mock('#app/lib/prisma.js', () => ({ prisma: mocks.prisma }));
vi.mock('#app/lib/crypto.js', () => ({
  constantTimeEqual: vi.fn(() => true),
  encryptSecret: vi.fn((value: string) => `encrypted:${value}`),
  hashMetadata: vi.fn((value: string) => `metadata:${value}`),
  hashOpaqueToken: vi.fn((value: string) => `opaque:${value}`),
  hashSecret: vi.fn(async (value: string) => `hashed:${value}`),
  normalizeEmail: vi.fn((value: string) => value.trim().toLowerCase()),
  randomOtp: vi.fn(() => '123456'),
  randomToken: vi.fn(() => 'random-token'),
  verifySecret: mocks.verifySecret,
}));

import { sendOtp, verifyOtp } from '../dist/src/modules/auth/auth.service.js';

const metadata = { ip: '127.0.0.1', requestId: 'request-id', userAgent: 'test' };

function emailChallenge() {
  return {
    id: 'challenge-id',
    userId: 'user-id',
    normalizedDestination: 'user@example.com',
    channel: 'EMAIL',
    purpose: 'VERIFY_EMAIL',
    codeHash: 'hashed:123456',
    attempts: 0,
    maxAttempts: 5,
    sentAt: new Date(),
    expiresAt: new Date(Date.now() + 60_000),
    consumedAt: null,
    lockedAt: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    deletedAt: null,
    user: { id: 'user-id' },
  };
}

function phoneChallenge() {
  return {
    ...emailChallenge(),
    normalizedDestination: '+15551234567',
    channel: 'SMS',
    purpose: 'VERIFY_PHONE',
  };
}

describe('OTP service account-status enforcement', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.prisma.$transaction.mockImplementation(
      (callback: (tx: typeof mocks.transaction) => Promise<unknown>) => callback(mocks.transaction),
    );
    mocks.verifySecret.mockResolvedValue(true);
    mocks.transaction.otpChallenge.updateMany.mockResolvedValue({ count: 1 });
    mocks.transaction.auditEvent.create.mockResolvedValue({});
    mocks.prisma.$executeRaw.mockResolvedValue(1);
  });

  it('uses the atomic attempt statement for invalid general-purpose OTPs', async () => {
    mocks.prisma.otpChallenge.findFirst.mockResolvedValue(emailChallenge());
    mocks.verifySecret.mockResolvedValue(false);

    await expect(
      verifyOtp(
        {
          destination: 'user@example.com',
          channel: 'EMAIL',
          purpose: 'VERIFY_EMAIL',
          code: '000000',
        },
        metadata,
      ),
    ).resolves.toBeNull();

    expect(mocks.prisma.$executeRaw).toHaveBeenCalledTimes(1);
    expect(mocks.transaction.otpChallenge.updateMany).not.toHaveBeenCalled();
  });

  it('includes PENDING in the public verification-OTP user lookup', async () => {
    mocks.prisma.user.findFirst.mockResolvedValue(null);

    await sendOtp(
      {
        destination: 'user@example.com',
        channel: 'EMAIL',
        purpose: 'VERIFY_EMAIL',
      },
      metadata,
    );

    const lookup = mocks.prisma.user.findFirst.mock.calls[0]?.[0] as {
      where?: Record<string, unknown>;
    };
    expect(lookup.where).toMatchObject({
      email: 'user@example.com',
      status: 'PENDING',
      deletedAt: null,
    });
  });

  it('consumes but cannot reactivate a suspended account', async () => {
    mocks.prisma.otpChallenge.findFirst.mockResolvedValue(emailChallenge());
    mocks.transaction.user.findFirst.mockResolvedValue({ status: 'SUSPENDED' });

    const result = await verifyOtp(
      {
        destination: 'user@example.com',
        channel: 'EMAIL',
        purpose: 'VERIFY_EMAIL',
        code: '123456',
      },
      metadata,
    );

    expect(result).toBeNull();
    const consume = mocks.transaction.otpChallenge.updateMany.mock.calls[0]?.[0] as {
      data?: { consumedAt?: unknown };
    };
    expect(consume.data?.consumedAt).toBeInstanceOf(Date);
    expect(mocks.transaction.user.updateMany).not.toHaveBeenCalled();
    const audit = mocks.transaction.auditEvent.create.mock.calls[0]?.[0] as {
      data?: { action?: unknown };
    };
    expect(audit.data?.action).toBe('auth.otp.verification_blocked');
  });

  it('activates only when the conditional current status is PENDING', async () => {
    mocks.prisma.otpChallenge.findFirst.mockResolvedValue(emailChallenge());
    mocks.transaction.user.findFirst.mockResolvedValue({ status: 'PENDING' });
    mocks.transaction.user.updateMany.mockResolvedValue({ count: 1 });

    const result = await verifyOtp(
      {
        destination: 'user@example.com',
        channel: 'EMAIL',
        purpose: 'VERIFY_EMAIL',
        code: '123456',
      },
      metadata,
    );

    expect(result).toBe('VERIFIED');
    const update = mocks.transaction.user.updateMany.mock.calls[0]?.[0] as {
      where?: Record<string, unknown>;
      data?: Record<string, unknown>;
    };
    expect(update.where).toEqual({
      id: 'user-id',
      status: 'PENDING',
      deletedAt: null,
    });
    expect(update.data).toMatchObject({
      status: 'ACTIVE',
    });
    expect(update.data?.emailVerifiedAt).toBeInstanceOf(Date);
  });

  it('updates profile verification fields without rewriting ACTIVE account status', async () => {
    mocks.prisma.otpChallenge.findFirst.mockResolvedValue(phoneChallenge());
    mocks.transaction.user.findFirst.mockResolvedValue({ status: 'ACTIVE' });
    mocks.transaction.user.updateMany.mockResolvedValue({ count: 1 });

    const result = await verifyOtp(
      {
        destination: '+15551234567',
        channel: 'SMS',
        purpose: 'VERIFY_PHONE',
        code: '123456',
      },
      metadata,
    );

    expect(result).toBe('VERIFIED');
    const update = mocks.transaction.user.updateMany.mock.calls[0]?.[0] as {
      where?: Record<string, unknown>;
      data?: Record<string, unknown>;
    };
    expect(update.where).toEqual({
      id: 'user-id',
      status: 'ACTIVE',
      deletedAt: null,
    });
    expect(update.data).toMatchObject({ phone: '+15551234567' });
    expect(update.data?.phoneVerifiedAt).toBeInstanceOf(Date);
    expect(Object.hasOwn(update.data ?? {}, 'status')).toBe(false);
  });

  it('records active-user email verification without rewriting account status', async () => {
    mocks.prisma.otpChallenge.findFirst.mockResolvedValue(emailChallenge());
    mocks.transaction.user.findFirst.mockResolvedValue({ status: 'ACTIVE' });
    mocks.transaction.user.updateMany.mockResolvedValue({ count: 1 });

    const result = await verifyOtp(
      {
        destination: 'user@example.com',
        channel: 'EMAIL',
        purpose: 'VERIFY_EMAIL',
        code: '123456',
      },
      metadata,
    );

    expect(result).toBe('VERIFIED');
    const update = mocks.transaction.user.updateMany.mock.calls[0]?.[0] as {
      data?: Record<string, unknown>;
    };
    expect(update.data?.emailVerifiedAt).toBeInstanceOf(Date);
    expect(Object.hasOwn(update.data ?? {}, 'status')).toBe(false);
  });
});
