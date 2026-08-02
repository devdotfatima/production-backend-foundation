import { Router } from 'express';
import { authenticate } from '#app/middleware/access-control.js';
import { refreshUserRateLimit, userIdentityRateLimit } from '#app/middleware/rate-limit.js';
import { validateRequest } from '#app/middleware/request-validation.js';
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
  changePassword,
  confirmReset,
  deleteAccount,
  issueCsrf,
  login,
  logout,
  logoutAll,
  refresh,
  requestOtp,
  requestPhoneVerification,
  requestReset,
  socialLogin,
  verifyPasswordResetOtp,
  signup,
  verifyOtpCode,
  requestEmailChange,
  verifyEmailChange,
} from '#app/modules/auth/auth.controller.js';

export const authRouter = Router();

authRouter.get('/csrf', issueCsrf);
authRouter.post('/signup', validateRequest(signupRequestValidation), signup);
authRouter.post('/login', validateRequest(loginRequestValidation), login);
authRouter.post('/oauth/:provider', validateRequest(socialLoginRequestValidation), socialLogin);
authRouter.post('/otp/send', validateRequest(otpSendRequestValidation), requestOtp);
authRouter.post(
  '/phone/send-verification',
  authenticate,
  userIdentityRateLimit,
  validateRequest(phoneVerificationRequestValidation),
  requestPhoneVerification,
);
authRouter.post('/otp/verify', validateRequest(otpVerifyRequestValidation), verifyOtpCode);
authRouter.post('/refresh', refreshUserRateLimit, refresh);
authRouter.post(
  '/password-reset/request',
  validateRequest(passwordResetRequestValidation),
  requestReset,
);
authRouter.post(
  '/password-reset/verify-otp',
  validateRequest(passwordResetVerifyOtpRequestValidation),
  verifyPasswordResetOtp,
);
authRouter.post(
  '/password-reset/confirm',
  validateRequest(passwordResetConfirmRequestValidation),
  confirmReset,
);
authRouter.post('/logout', authenticate, userIdentityRateLimit, logout);
authRouter.post('/logout-all', authenticate, userIdentityRateLimit, logoutAll);
authRouter.post(
  '/password/change',
  authenticate,
  userIdentityRateLimit,
  validateRequest(changePasswordRequestValidation),
  changePassword,
);
authRouter.post(
  '/email-change/request',
  authenticate,
  userIdentityRateLimit,
  validateRequest(emailChangeRequestValidation),
  requestEmailChange,
);
authRouter.post(
  '/email-change/verify',
  authenticate,
  userIdentityRateLimit,
  validateRequest(emailChangeVerifyRequestValidation),
  verifyEmailChange,
);
authRouter.delete(
  '/account',
  authenticate,
  userIdentityRateLimit,
  validateRequest(accountDeleteRequestValidation),
  deleteAccount,
);
