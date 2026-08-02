import type { Request, Response } from 'express';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  enforceRateLimit: vi.fn(),
  getValidated: vi.fn(),
  loginWithSocial: vi.fn(),
  requestMetadata: vi.fn(),
  sendSuccess: vi.fn(),
  setAuthCookies: vi.fn(),
}));

vi.mock('#app/config/env.js', () => ({ env: {} }));
vi.mock('#app/lib/api-response.js', () => ({ sendSuccess: mocks.sendSuccess }));
vi.mock('#app/lib/crypto.js', () => ({ randomToken: vi.fn() }));
vi.mock('#app/lib/cookies.js', () => ({
  cookieNames: { csrf: 'csrf' },
  clearAuthCookies: vi.fn(),
  getRefreshToken: vi.fn(),
  setAuthCookies: mocks.setAuthCookies,
}));
vi.mock('#app/lib/rate-limit.js', () => ({ enforceRateLimit: mocks.enforceRateLimit }));
vi.mock('#app/lib/request-metadata.js', () => ({ requestMetadata: mocks.requestMetadata }));
vi.mock('#app/middleware/request-validation.js', () => ({ getValidated: mocks.getValidated }));
vi.mock('#app/modules/auth/auth.service.js', () => ({
  changePassword: vi.fn(),
  confirmPasswordReset: vi.fn(),
  deleteAccount: vi.fn(),
  genericAuthMessage: { message: 'generic' },
  loginWithSocial: mocks.loginWithSocial,
  loginWithPassword: vi.fn(),
  requestPasswordReset: vi.fn(),
  verifyPasswordResetOtp: vi.fn(),
  revokeAllSessions: vi.fn(),
  revokeSession: vi.fn(),
  rotateRefreshToken: vi.fn(),
  sendOtp: vi.fn(),
  sendPhoneVerification: vi.fn(),
  signupWithPassword: vi.fn(),
  verifyOtp: vi.fn(),
}));

import {
  requestOtp,
  requestReset,
  signup,
  socialLogin,
} from '../dist/src/modules/auth/auth.controller.js';

describe('social login throttling', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getValidated.mockReturnValue({
      params: { provider: 'google' },
      body: { idToken: 'provider-token', displayName: 'User' },
    });
    mocks.requestMetadata.mockReturnValue({
      ip: '203.0.113.10',
      requestId: 'request-1',
      userAgent: 'test',
    });
    mocks.loginWithSocial.mockResolvedValue({
      accessToken: 'access-token',
      refreshToken: 'refresh-token',
    });
  });

  it('uses an IP/provider key plus a much higher provider-wide backstop', async () => {
    await socialLogin({} as Request, {} as Response, vi.fn());

    expect(mocks.enforceRateLimit).toHaveBeenNthCalledWith(
      1,
      'social-login:ip-provider',
      'google:203.0.113.10',
      10,
      15 * 60,
    );
    expect(mocks.enforceRateLimit).toHaveBeenNthCalledWith(
      2,
      'social-login:provider-global',
      'google',
      10_000,
      15 * 60,
    );
    expect(mocks.loginWithSocial).toHaveBeenCalledWith(
      'google',
      'provider-token',
      'User',
      expect.objectContaining({ ip: '203.0.113.10' }),
    );
  });
});

describe('sensitive authentication throttling', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.requestMetadata.mockReturnValue({
      ip: '203.0.113.10',
      requestId: 'request-1',
      userAgent: 'test',
    });
  });

  it.each([
    {
      name: 'signup',
      handler: signup,
      body: { email: 'user@example.com', password: 'password' },
      expected: ['signup:account', 'user@example.com', 3, 60 * 60],
    },
    {
      name: 'OTP send',
      handler: requestOtp,
      body: { destination: 'user@example.com', purpose: 'LOGIN', channel: 'EMAIL' },
      expected: ['otp:send', 'user@example.com', 3, 10 * 60],
    },
    {
      name: 'password reset',
      handler: requestReset,
      body: { email: 'user@example.com' },
      expected: ['password-reset:account', 'user@example.com', 3, 60 * 60],
    },
  ])('fails closed for $name when Redis protection is unavailable', async (testCase) => {
    const unavailable = new Error('rate-limit store unavailable');
    mocks.getValidated.mockReturnValue({ body: testCase.body });
    mocks.enforceRateLimit.mockRejectedValueOnce(unavailable);

    await expect(
      Promise.resolve(testCase.handler({} as Request, {} as Response, vi.fn())),
    ).rejects.toBe(unavailable);
    expect(mocks.enforceRateLimit).toHaveBeenCalledWith(...testCase.expected, {
      redisFailureMode: 'deny',
    });
  });
});
