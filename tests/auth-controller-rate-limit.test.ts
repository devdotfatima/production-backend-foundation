import type { Request, Response } from 'express';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  enforceRateLimit: vi.fn(),
  getValidated: vi.fn(),
  isMobileClient: vi.fn(),
  loginWithSocial: vi.fn(),
  loginWithPassword: vi.fn(),
  requestMetadata: vi.fn(),
  resolveRefreshToken: vi.fn(),
  rotateRefreshToken: vi.fn(),
  sendSuccess: vi.fn(),
  setAuthCookies: vi.fn(),
}));

vi.mock('#app/config/env.js', () => ({ env: {} }));
vi.mock('#app/lib/api-response.js', () => ({ sendSuccess: mocks.sendSuccess }));
vi.mock('#app/lib/crypto.js', () => ({ randomToken: vi.fn() }));
vi.mock('#app/lib/cookies.js', () => ({
  cookieNames: { csrf: 'csrf' },
  clearAuthCookies: vi.fn(),
  setAuthCookies: mocks.setAuthCookies,
}));
vi.mock('#app/lib/auth-transport.js', () => ({
  isMobileClient: mocks.isMobileClient,
  resolveRefreshToken: mocks.resolveRefreshToken,
}));
vi.mock('#app/lib/rate-limit.js', () => ({ enforceRateLimit: mocks.enforceRateLimit }));
vi.mock('#app/lib/request-metadata.js', () => ({ requestMetadata: mocks.requestMetadata }));
vi.mock('#app/middleware/request-validation.js', () => ({ getValidated: mocks.getValidated }));
vi.mock('#app/modules/auth/auth.service.js', () => {
  const service = {
    changePassword: vi.fn(),
    confirmPasswordReset: vi.fn(),
    deleteAccount: vi.fn(),
    loginWithSocial: mocks.loginWithSocial,
    loginWithPassword: mocks.loginWithPassword,
    requestEmailChange: vi.fn(),
    requestPasswordReset: vi.fn(),
    verifyEmailChange: vi.fn(),
    verifyPasswordResetOtp: vi.fn(),
    revokeAllSessions: vi.fn(),
    revokeSession: vi.fn(),
    rotateRefreshToken: mocks.rotateRefreshToken,
    sendOtp: vi.fn(),
    sendPhoneVerification: vi.fn(),
    signupWithPassword: vi.fn(),
    verifyOtp: vi.fn(),
  };
  return {
    ...service,
    createAuthService: () => service,
    genericAuthMessage: { message: 'generic' },
  };
});

import {
  login,
  refresh,
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

describe('mobile bearer-token transport', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.requestMetadata.mockReturnValue({
      ip: '203.0.113.10',
      requestId: 'request-1',
      userAgent: 'test',
    });
  });

  it('returns tokens in the response body instead of cookies when the client is mobile', async () => {
    mocks.isMobileClient.mockReturnValue(true);
    mocks.getValidated.mockReturnValue({
      body: { email: 'user@example.com', password: 'password' },
    });
    mocks.loginWithPassword.mockResolvedValue({
      accessToken: 'access-token',
      refreshToken: 'refresh-token',
    });

    await login({} as Request, {} as Response, vi.fn());

    expect(mocks.setAuthCookies).not.toHaveBeenCalled();
    expect(mocks.sendSuccess).toHaveBeenCalledWith(
      {},
      {},
      expect.objectContaining({
        data: { accessToken: 'access-token', refreshToken: 'refresh-token' },
      }),
    );
  });

  it('sets cookies instead of returning tokens in the body for web clients', async () => {
    mocks.isMobileClient.mockReturnValue(false);
    mocks.getValidated.mockReturnValue({
      body: { email: 'user@example.com', password: 'password' },
    });
    mocks.loginWithPassword.mockResolvedValue({
      accessToken: 'access-token',
      refreshToken: 'refresh-token',
    });

    await login({} as Request, {} as Response, vi.fn());

    expect(mocks.setAuthCookies).toHaveBeenCalledWith({}, 'access-token', 'refresh-token');
    expect(mocks.sendSuccess).toHaveBeenCalledWith({}, {}, { message: 'Authenticated' });
  });

  it('resolves the refresh token via the shared transport helper and honors the mobile flag on success', async () => {
    mocks.isMobileClient.mockReturnValue(true);
    mocks.resolveRefreshToken.mockReturnValue('mobile-refresh-token');
    mocks.rotateRefreshToken.mockResolvedValue({
      accessToken: 'new-access-token',
      refreshToken: 'new-refresh-token',
    });

    await refresh({} as Request, {} as Response, vi.fn());

    expect(mocks.rotateRefreshToken).toHaveBeenCalledWith(
      'mobile-refresh-token',
      expect.objectContaining({ ip: '203.0.113.10' }),
    );
    expect(mocks.setAuthCookies).not.toHaveBeenCalled();
    expect(mocks.sendSuccess).toHaveBeenCalledWith(
      {},
      {},
      expect.objectContaining({
        data: { accessToken: 'new-access-token', refreshToken: 'new-refresh-token' },
      }),
    );
  });

  it('rejects the refresh request when no refresh token can be resolved', async () => {
    mocks.resolveRefreshToken.mockReturnValue(undefined);

    await expect(refresh({} as Request, {} as Response, vi.fn())).rejects.toMatchObject({
      statusCode: 401,
    });
    expect(mocks.rotateRefreshToken).not.toHaveBeenCalled();
  });
});
