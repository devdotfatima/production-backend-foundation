export const genericAuthMessage = {
  message: 'If the supplied information is eligible, the requested action will be completed.',
} as const;

export {
  deleteAccount,
  requestEmailChange,
  verifyEmailChange,
} from '#app/modules/auth/auth.account.service.js';
export { sendOtp, sendPhoneVerification, verifyOtp } from '#app/modules/auth/auth.otp.service.js';
export {
  confirmPasswordReset,
  requestPasswordReset,
  verifyPasswordResetOtp,
} from '#app/modules/auth/auth.password-reset.service.js';
export {
  revokeAllSessions,
  revokeSession,
  rotateRefreshToken,
} from '#app/modules/auth/auth.sessions.service.js';
export {
  changePassword,
  loginWithPassword,
  signupWithPassword,
} from '#app/modules/auth/auth.passwords.service.js';
export { loginWithSocial } from '#app/modules/auth/auth.social-login.service.js';
