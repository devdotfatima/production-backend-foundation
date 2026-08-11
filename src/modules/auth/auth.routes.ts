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
  refreshRequestValidation,
} from '#app/modules/auth/auth.schemas.js';
import { createAuthController } from '#app/modules/auth/auth.controller.js';

export type AuthController = ReturnType<typeof createAuthController>;

export function createAuthRouter(controller: AuthController = createAuthController()) {
  const router = Router();

  router.get('/csrf', controller.issueCsrf);
  router.post('/signup', validateRequest(signupRequestValidation), controller.signup);
  router.post('/login', validateRequest(loginRequestValidation), controller.login);
  router.post(
    '/oauth/:provider',
    validateRequest(socialLoginRequestValidation),
    controller.socialLogin,
  );
  router.post('/otp/send', validateRequest(otpSendRequestValidation), controller.requestOtp);
  router.post(
    '/phone/send-verification',
    authenticate,
    userIdentityRateLimit,
    validateRequest(phoneVerificationRequestValidation),
    controller.requestPhoneVerification,
  );
  router.post('/otp/verify', validateRequest(otpVerifyRequestValidation), controller.verifyOtpCode);
  router.post(
    '/refresh',
    refreshUserRateLimit,
    validateRequest(refreshRequestValidation),
    controller.refresh,
  );
  router.post(
    '/password-reset/request',
    validateRequest(passwordResetRequestValidation),
    controller.requestReset,
  );
  router.post(
    '/password-reset/verify-otp',
    validateRequest(passwordResetVerifyOtpRequestValidation),
    controller.verifyPasswordResetOtp,
  );
  router.post(
    '/password-reset/confirm',
    validateRequest(passwordResetConfirmRequestValidation),
    controller.confirmReset,
  );
  router.post('/logout', authenticate, userIdentityRateLimit, controller.logout);
  router.post('/logout-all', authenticate, userIdentityRateLimit, controller.logoutAll);
  router.post(
    '/password/change',
    authenticate,
    userIdentityRateLimit,
    validateRequest(changePasswordRequestValidation),
    controller.changePassword,
  );
  router.post(
    '/email-change/request',
    authenticate,
    userIdentityRateLimit,
    validateRequest(emailChangeRequestValidation),
    controller.requestEmailChange,
  );
  router.post(
    '/email-change/verify',
    authenticate,
    userIdentityRateLimit,
    validateRequest(emailChangeVerifyRequestValidation),
    controller.verifyEmailChange,
  );
  router.delete(
    '/account',
    authenticate,
    userIdentityRateLimit,
    validateRequest(accountDeleteRequestValidation),
    controller.deleteAccount,
  );

  return router;
}

export const authRouter = createAuthRouter();
