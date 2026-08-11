import type { Request, RequestHandler, Response } from 'express';
import { sendSuccess } from '#app/lib/api-response.js';
import { env } from '#app/config/env.js';
import { randomToken } from '#app/lib/crypto.js';
import { cookieNames } from '#app/lib/cookies.js';
import { clearAuthCookies, setAuthCookies } from '#app/lib/cookies.js';
import { isMobileClient, resolveRefreshToken } from '#app/lib/auth-transport.js';
import { clientIpKey } from '#app/lib/client-ip.js';
import { errors } from '#app/lib/errors.js';
import { enforceRateLimit } from '#app/lib/rate-limit.js';
import { requestMetadata } from '#app/lib/request-metadata.js';
import { enforceAuthBackstops } from '#app/modules/auth/auth.abuse.js';
import { getValidated } from '#app/middleware/request-validation.js';
import {
  loginRequestValidation,
  otpSendRequestValidation,
  otpVerifyRequestValidation,
  passwordResetConfirmRequestValidation,
  passwordResetRequestValidation,
  passwordResetVerifyOtpRequestValidation,
  phoneVerificationRequestValidation,
  signupRequestValidation,
  socialLoginRequestValidation,
  changePasswordRequestValidation,
  accountDeleteRequestValidation,
  emailChangeRequestValidation,
  emailChangeVerifyRequestValidation,
} from '#app/modules/auth/auth.schemas.js';
import {
  createAuthService,
  genericAuthMessage,
  type AuthService,
} from '#app/modules/auth/auth.service.js';
import type { TokenPair } from '#app/modules/auth/auth.shared.js';
import { createStripeClient } from '#app/modules/stripe/stripe.service.js';
import type { StripeClient } from '#app/modules/stripe/stripe.client.js';
import {
  createUploadProvider,
  type UploadProviderAdapter,
} from '#app/modules/uploads/uploads.provider.js';

const strictRateLimit = { redisFailureMode: 'deny' } as const;

/** Web sessions ride in httpOnly cookies; mobile clients get tokens in the body. */
function issueTokens(request: Request, response: Response, tokens: TokenPair, message: string) {
  if (isMobileClient(request)) {
    sendSuccess(request, response, { message, data: tokens });
  } else {
    setAuthCookies(response, tokens.accessToken, tokens.refreshToken);
    sendSuccess(request, response, { message });
  }
}

export interface AuthControllerDependencies {
  service?: AuthService;
  getStripeClient?: () => StripeClient | null;
  getUploadProvider?: () => UploadProviderAdapter | null;
}

export function createAuthController(dependencies: AuthControllerDependencies = {}) {
  const authService = dependencies.service ?? createAuthService();
  const getStripeClient = dependencies.getStripeClient ?? createStripeClient;
  const getUploadProvider = dependencies.getUploadProvider ?? (() => createUploadProvider(env));

  const issueCsrf: RequestHandler = (request, response) => {
    const token = randomToken(32);
    response.cookie(cookieNames.csrf, token, {
      path: '/',
      httpOnly: false,
      secure: env.COOKIE_SECURE,
      sameSite: env.COOKIE_SAME_SITE,
      signed: true,
      maxAge: 60 * 60 * 1000,
    });
    sendSuccess(request, response, { message: 'CSRF token issued', data: { csrfToken: token } });
  };

  const signup: RequestHandler = async (request, response) => {
    const { body: input } = getValidated(request, signupRequestValidation);
    await enforceRateLimit('signup:account', input.email, 3, 60 * 60, strictRateLimit);
    const metadata = requestMetadata(request);
    await enforceAuthBackstops('signup', metadata, 'email');
    await authService.signupWithPassword(input, metadata);
    sendSuccess(request, response, { status: 202, message: genericAuthMessage.message });
  };

  const login: RequestHandler = async (request, response) => {
    const { body: input } = getValidated(request, loginRequestValidation);
    await enforceRateLimit('login:account', input.email, 5, 15 * 60);
    const metadata = requestMetadata(request);
    await enforceAuthBackstops('login', metadata);
    const tokens = await authService.loginWithPassword(input, metadata);
    if (!tokens) throw errors.unauthenticated('Invalid credentials');
    issueTokens(request, response, tokens, 'Authenticated');
  };

  const socialLogin: RequestHandler = async (request, response) => {
    const { params, body: input } = getValidated(request, socialLoginRequestValidation);
    const metadata = requestMetadata(request);
    await enforceRateLimit(
      'social-login:ip-provider',
      `${params.provider}:${metadata.ip}`,
      10,
      15 * 60,
    );
    await enforceRateLimit('social-login:provider-global', params.provider, 10_000, 15 * 60);
    const tokens = await authService.loginWithSocial(
      params.provider,
      input.idToken,
      input.displayName,
      metadata,
    );
    if (!tokens) throw errors.unauthenticated('Social account is not eligible to sign in');
    issueTokens(request, response, tokens, 'Authenticated');
  };

  const changePassword: RequestHandler = async (request, response) => {
    const { body: input } = getValidated(request, changePasswordRequestValidation);
    const changed = await authService.changePassword(
      request.auth!.userId,
      request.auth!.sessionId,
      input.currentPassword,
      input.newPassword,
      requestMetadata(request),
    );
    if (!changed) throw errors.unauthenticated('Current password is incorrect');
    sendSuccess(request, response, { message: 'Password changed' });
  };

  const deleteAccount: RequestHandler = async (request, response) => {
    const { body: input } = getValidated(request, accountDeleteRequestValidation);
    const deleted = await authService.deleteAccount(
      request.auth!.userId,
      input,
      requestMetadata(request),
      getStripeClient(),
      getUploadProvider(),
    );
    if (!deleted)
      throw errors.unauthenticated('Recent password or social reauthentication is required');
    clearAuthCookies(response);
    sendSuccess(request, response, { message: 'Account deleted' });
  };

  const requestEmailChange: RequestHandler = async (request, response) => {
    const { body: input } = getValidated(request, emailChangeRequestValidation);
    await enforceRateLimit('email-change:destination', input.newEmail, 3, 60 * 60, strictRateLimit);
    const metadata = requestMetadata(request);
    await enforceAuthBackstops('otp-send', metadata, 'email');
    const accepted = await authService.requestEmailChange(request.auth!.userId, input, metadata);
    if (!accepted) throw errors.unauthenticated('Recent reauthentication is required');
    sendSuccess(request, response, { status: 202, message: genericAuthMessage.message });
  };

  const verifyEmailChange: RequestHandler = async (request, response) => {
    const { body: input } = getValidated(request, emailChangeVerifyRequestValidation);
    await enforceRateLimit('email-change:verify', input.newEmail, 5, 10 * 60, strictRateLimit);
    const metadata = requestMetadata(request);
    await enforceAuthBackstops('otp-verify', metadata);
    const changed = await authService.verifyEmailChange(
      request.auth!.userId,
      input.newEmail,
      input.code,
      metadata,
    );
    if (!changed) throw errors.unauthenticated('Invalid or expired code');
    clearAuthCookies(response);
    sendSuccess(request, response, { message: 'Email changed; sign in again' });
  };

  const requestOtp: RequestHandler = async (request, response) => {
    const { body: input } = getValidated(request, otpSendRequestValidation);
    await enforceRateLimit('otp:send', input.destination, 3, 10 * 60, strictRateLimit);
    const metadata = requestMetadata(request);
    await enforceAuthBackstops('otp-send', metadata, input.channel === 'EMAIL' ? 'email' : 'sms');
    await authService.sendOtp(input, metadata);
    sendSuccess(request, response, { status: 202, message: genericAuthMessage.message });
  };

  const requestPhoneVerification: RequestHandler = async (request, response) => {
    const { body: input } = getValidated(request, phoneVerificationRequestValidation);
    await enforceRateLimit('otp:send', input.phone, 3, 10 * 60, strictRateLimit);
    const metadata = requestMetadata(request);
    await enforceAuthBackstops('otp-send', metadata, 'sms');
    await authService.sendPhoneVerification(request.auth!.userId, input.phone, metadata);
    sendSuccess(request, response, { status: 202, message: genericAuthMessage.message });
  };

  const verifyOtpCode: RequestHandler = async (request, response) => {
    const { body: input } = getValidated(request, otpVerifyRequestValidation);
    await enforceRateLimit('otp:verify', input.destination, 5, 10 * 60, strictRateLimit);
    const metadata = requestMetadata(request);
    await enforceAuthBackstops('otp-verify', metadata);
    const result = await authService.verifyOtp(input, metadata);
    if (!result) throw errors.unauthenticated('Invalid or expired code');
    if (result === 'VERIFIED') {
      sendSuccess(request, response, { message: 'Verified' });
    } else {
      issueTokens(request, response, result, 'Authenticated');
    }
  };

  const refresh: RequestHandler = async (request, response) => {
    const token = resolveRefreshToken(request);
    if (!token) throw errors.unauthenticated();
    const tokens = await authService.rotateRefreshToken(token, requestMetadata(request));
    if (!tokens) {
      clearAuthCookies(response);
      throw errors.unauthenticated();
    }
    issueTokens(request, response, tokens, 'Authenticated');
  };

  const requestReset: RequestHandler = async (request, response) => {
    const { body: input } = getValidated(request, passwordResetRequestValidation);
    await enforceRateLimit('password-reset:account', input.email, 3, 60 * 60, strictRateLimit);
    const metadata = requestMetadata(request);
    await enforceAuthBackstops('password-reset-request', metadata, 'email');
    await authService.requestPasswordReset(input.email, metadata);
    sendSuccess(request, response, { status: 202, message: genericAuthMessage.message });
  };

  const verifyPasswordResetOtp: RequestHandler = async (request, response) => {
    const { body: input } = getValidated(request, passwordResetVerifyOtpRequestValidation);
    await enforceRateLimit('password-reset:verify', input.email, 5, 10 * 60, strictRateLimit);
    const metadata = requestMetadata(request);
    await enforceAuthBackstops('password-reset-verify', metadata);
    const credential = await authService.verifyPasswordResetOtp(input.email, input.otp, metadata);
    if (!credential) throw errors.unauthenticated('Invalid or expired code');
    response.setHeader('Cache-Control', 'no-store');
    sendSuccess(request, response, { message: 'OTP verified', data: credential });
  };

  const confirmReset: RequestHandler = async (request, response) => {
    const { body: input } = getValidated(request, passwordResetConfirmRequestValidation);
    const metadata = requestMetadata(request);
    await enforceRateLimit(
      'password-reset:confirm',
      clientIpKey(metadata.ip),
      5,
      10 * 60,
      strictRateLimit,
    );
    await enforceAuthBackstops('password-reset-confirm', metadata);
    const confirmed = await authService.confirmPasswordReset(
      input.resetToken,
      input.newPassword,
      metadata,
    );
    if (!confirmed) throw errors.unauthenticated('OTP verification required or expired');
    clearAuthCookies(response);
    sendSuccess(request, response, { status: 202, message: genericAuthMessage.message });
  };

  const logout: RequestHandler = async (request, response) => {
    await authService.revokeSession(
      request.auth!.sessionId,
      request.auth!.userId,
      requestMetadata(request),
    );
    clearAuthCookies(response);
    sendSuccess(request, response, { message: 'Logged out' });
  };

  const logoutAll: RequestHandler = async (request, response) => {
    await authService.revokeAllSessions(request.auth!.userId, requestMetadata(request));
    clearAuthCookies(response);
    sendSuccess(request, response, { message: 'All sessions revoked' });
  };

  return {
    issueCsrf,
    signup,
    login,
    socialLogin,
    changePassword,
    deleteAccount,
    requestEmailChange,
    verifyEmailChange,
    requestOtp,
    requestPhoneVerification,
    verifyOtpCode,
    refresh,
    requestReset,
    verifyPasswordResetOtp,
    confirmReset,
    logout,
    logoutAll,
  };
}

export const {
  issueCsrf,
  signup,
  login,
  socialLogin,
  changePassword,
  deleteAccount,
  requestEmailChange,
  verifyEmailChange,
  requestOtp,
  requestPhoneVerification,
  verifyOtpCode,
  refresh,
  requestReset,
  verifyPasswordResetOtp,
  confirmReset,
  logout,
  logoutAll,
} = createAuthController();
