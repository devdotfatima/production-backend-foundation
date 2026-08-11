import {
  deleteAccount,
  requestEmailChange,
  verifyEmailChange,
} from '#app/modules/auth/auth.account.service.js';
import { sendOtp, sendPhoneVerification, verifyOtp } from '#app/modules/auth/auth.otp.service.js';
import {
  confirmPasswordReset,
  requestPasswordReset,
  verifyPasswordResetOtp,
} from '#app/modules/auth/auth.password-reset.service.js';
import {
  revokeAllSessions,
  revokeSession,
  rotateRefreshToken,
} from '#app/modules/auth/auth.sessions.service.js';
import {
  changePassword,
  loginWithPassword,
  signupWithPassword,
} from '#app/modules/auth/auth.passwords.service.js';
import { loginWithSocial } from '#app/modules/auth/auth.social-login.service.js';

export const genericAuthMessage = {
  message: 'If the supplied information is eligible, the requested action will be completed.',
} as const;

/** Narrow use-case contract consumed by the HTTP adapter. */
export const defaultAuthService = {
  deleteAccount,
  requestEmailChange,
  verifyEmailChange,
  sendOtp,
  sendPhoneVerification,
  verifyOtp,
  confirmPasswordReset,
  requestPasswordReset,
  verifyPasswordResetOtp,
  revokeAllSessions,
  revokeSession,
  rotateRefreshToken,
  changePassword,
  loginWithPassword,
  signupWithPassword,
  loginWithSocial,
};

export type AuthService = typeof defaultAuthService;

/**
 * Creates an auth use-case registry with selective overrides. Client applications and integration
 * tests can replace one boundary without mocking module globals.
 */
export function createAuthService(overrides: Partial<AuthService> = {}): AuthService {
  return { ...defaultAuthService, ...overrides };
}

export {
  changePassword,
  confirmPasswordReset,
  deleteAccount,
  loginWithPassword,
  loginWithSocial,
  requestEmailChange,
  requestPasswordReset,
  revokeAllSessions,
  revokeSession,
  rotateRefreshToken,
  sendOtp,
  sendPhoneVerification,
  signupWithPassword,
  verifyEmailChange,
  verifyOtp,
  verifyPasswordResetOtp,
};
