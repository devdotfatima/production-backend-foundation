import type { RequestHandler } from 'express';
import { sendSuccess } from '#app/lib/api-response.js';
import { env } from '#app/config/env.js';
import { randomToken } from '#app/lib/crypto.js';
import { cookieNames } from '#app/lib/cookies.js';
import { clearAuthCookies, getRefreshToken, setAuthCookies } from '#app/lib/cookies.js';
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
  changePassword as changePasswordService,
  confirmPasswordReset,
  deleteAccount as deleteAccountService,
  genericAuthMessage,
  loginWithSocial,
  loginWithPassword,
  requestPasswordReset,
  verifyPasswordResetOtp as verifyPasswordResetOtpService,
  revokeAllSessions,
  revokeSession,
  rotateRefreshToken,
  sendOtp,
  sendPhoneVerification,
  signupWithPassword,
  verifyOtp,
  requestEmailChange as requestEmailChangeService,
  verifyEmailChange as verifyEmailChangeService,
} from '#app/modules/auth/auth.service.js';
import { createStripeClient } from '#app/modules/stripe/stripe.service.js';

const strictRateLimit = { redisFailureMode: 'deny' } as const;

export const issueCsrf: RequestHandler = (request, response) => {
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

export const signup: RequestHandler = async (request, response) => {
  const { body: input } = getValidated(request, signupRequestValidation);
  await enforceRateLimit('signup:account', input.email, 3, 60 * 60, strictRateLimit);
  const metadata = requestMetadata(request);
  await enforceAuthBackstops('signup', metadata, 'email');
  await signupWithPassword(input, metadata);
  sendSuccess(request, response, { status: 202, message: genericAuthMessage.message });
};

export const login: RequestHandler = async (request, response) => {
  const { body: input } = getValidated(request, loginRequestValidation);
  await enforceRateLimit('login:account', input.email, 5, 15 * 60);
  const metadata = requestMetadata(request);
  await enforceAuthBackstops('login', metadata);
  const tokens = await loginWithPassword(input, metadata);
  if (!tokens) throw errors.unauthenticated('Invalid credentials');
  setAuthCookies(response, tokens.accessToken, tokens.refreshToken);
  sendSuccess(request, response, { message: 'Authenticated' });
};

export const socialLogin: RequestHandler = async (request, response) => {
  const { params, body: input } = getValidated(request, socialLoginRequestValidation);
  const metadata = requestMetadata(request);
  await enforceRateLimit(
    'social-login:ip-provider',
    `${params.provider}:${metadata.ip}`,
    10,
    15 * 60,
  );
  await enforceRateLimit('social-login:provider-global', params.provider, 10_000, 15 * 60);
  const tokens = await loginWithSocial(params.provider, input.idToken, input.displayName, metadata);
  if (!tokens) throw errors.unauthenticated('Social account is not eligible to sign in');
  setAuthCookies(response, tokens.accessToken, tokens.refreshToken);
  sendSuccess(request, response, { message: 'Authenticated' });
};

export const changePassword: RequestHandler = async (request, response) => {
  const { body: input } = getValidated(request, changePasswordRequestValidation);
  const changed = await changePasswordService(
    request.auth!.userId,
    request.auth!.sessionId,
    input.currentPassword,
    input.newPassword,
    requestMetadata(request),
  );
  if (!changed) throw errors.unauthenticated('Current password is incorrect');
  sendSuccess(request, response, { message: 'Password changed' });
};

export const deleteAccount: RequestHandler = async (request, response) => {
  const { body: input } = getValidated(request, accountDeleteRequestValidation);
  const deleted = await deleteAccountService(
    request.auth!.userId,
    input,
    requestMetadata(request),
    createStripeClient(),
  );
  if (!deleted) throw errors.unauthenticated('Password confirmation is required');
  clearAuthCookies(response);
  sendSuccess(request, response, { message: 'Account deleted' });
};

export const requestEmailChange: RequestHandler = async (request, response) => {
  const { body: input } = getValidated(request, emailChangeRequestValidation);
  const accepted = await requestEmailChangeService(
    request.auth!.userId,
    input,
    requestMetadata(request),
  );
  if (!accepted) throw errors.unauthenticated('Recent reauthentication is required');
  sendSuccess(request, response, { status: 202, message: genericAuthMessage.message });
};

export const verifyEmailChange: RequestHandler = async (request, response) => {
  const { body: input } = getValidated(request, emailChangeVerifyRequestValidation);
  const changed = await verifyEmailChangeService(
    request.auth!.userId,
    input.newEmail,
    input.code,
    requestMetadata(request),
  );
  if (!changed) throw errors.unauthenticated('Invalid or expired code');
  clearAuthCookies(response);
  sendSuccess(request, response, { message: 'Email changed; sign in again' });
};

export const requestOtp: RequestHandler = async (request, response) => {
  const { body: input } = getValidated(request, otpSendRequestValidation);
  await enforceRateLimit('otp:send', input.destination, 3, 10 * 60, strictRateLimit);
  const metadata = requestMetadata(request);
  await enforceAuthBackstops('otp-send', metadata, input.channel === 'EMAIL' ? 'email' : 'sms');
  await sendOtp(input, metadata);
  sendSuccess(request, response, { status: 202, message: genericAuthMessage.message });
};

export const requestPhoneVerification: RequestHandler = async (request, response) => {
  const { body: input } = getValidated(request, phoneVerificationRequestValidation);
  await enforceRateLimit('otp:send', input.phone, 3, 10 * 60, strictRateLimit);
  await sendPhoneVerification(request.auth!.userId, input.phone, requestMetadata(request));
  sendSuccess(request, response, { status: 202, message: genericAuthMessage.message });
};

export const verifyOtpCode: RequestHandler = async (request, response) => {
  const { body: input } = getValidated(request, otpVerifyRequestValidation);
  await enforceRateLimit('otp:verify', input.destination, 5, 10 * 60, strictRateLimit);
  const metadata = requestMetadata(request);
  await enforceAuthBackstops('otp-verify', metadata);
  const result = await verifyOtp(input, metadata);
  if (!result) throw errors.unauthenticated('Invalid or expired code');
  if (result !== 'VERIFIED') setAuthCookies(response, result.accessToken, result.refreshToken);
  sendSuccess(request, response, {
    message: result === 'VERIFIED' ? 'Verified' : 'Authenticated',
  });
};

export const refresh: RequestHandler = async (request, response) => {
  const token = getRefreshToken(request);
  if (!token) throw errors.unauthenticated();
  const tokens = await rotateRefreshToken(token, requestMetadata(request));
  if (!tokens) {
    clearAuthCookies(response);
    throw errors.unauthenticated();
  }
  setAuthCookies(response, tokens.accessToken, tokens.refreshToken);
  sendSuccess(request, response, { message: 'Authenticated' });
};

export const requestReset: RequestHandler = async (request, response) => {
  const { body: input } = getValidated(request, passwordResetRequestValidation);
  await enforceRateLimit('password-reset:account', input.email, 3, 60 * 60, strictRateLimit);
  const metadata = requestMetadata(request);
  await enforceAuthBackstops('password-reset-request', metadata, 'email');
  await requestPasswordReset(input.email, metadata);
  sendSuccess(request, response, { status: 202, message: genericAuthMessage.message });
};

export const verifyPasswordResetOtp: RequestHandler = async (request, response) => {
  const { body: input } = getValidated(request, passwordResetVerifyOtpRequestValidation);
  await enforceRateLimit('password-reset:verify', input.email, 5, 10 * 60, strictRateLimit);
  const metadata = requestMetadata(request);
  await enforceAuthBackstops('password-reset-verify', metadata);
  const credential = await verifyPasswordResetOtpService(input.email, input.otp, metadata);
  if (!credential) throw errors.unauthenticated('Invalid or expired code');
  response.setHeader('Cache-Control', 'no-store');
  sendSuccess(request, response, { message: 'OTP verified', data: credential });
};

export const confirmReset: RequestHandler = async (request, response) => {
  const { body: input } = getValidated(request, passwordResetConfirmRequestValidation);
  const metadata = requestMetadata(request);
  await enforceRateLimit('password-reset:confirm', metadata.ip, 5, 10 * 60, strictRateLimit);
  await enforceAuthBackstops('password-reset-confirm', metadata);
  const confirmed = await confirmPasswordReset(input.resetToken, input.newPassword, metadata);
  if (!confirmed) throw errors.unauthenticated('OTP verification required or expired');
  clearAuthCookies(response);
  sendSuccess(request, response, { status: 202, message: genericAuthMessage.message });
};

export const logout: RequestHandler = async (request, response) => {
  await revokeSession(request.auth!.sessionId, request.auth!.userId, requestMetadata(request));
  clearAuthCookies(response);
  sendSuccess(request, response, { message: 'Logged out' });
};

export const logoutAll: RequestHandler = async (request, response) => {
  await revokeAllSessions(request.auth!.userId, requestMetadata(request));
  clearAuthCookies(response);
  sendSuccess(request, response, { message: 'All sessions revoked' });
};
