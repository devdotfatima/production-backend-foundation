import { z } from 'zod';

const password = z.string().min(12).max(128);
const email = z.string().trim().toLowerCase().pipe(z.email().max(320));
const phone = z.string().regex(/^\+[1-9]\d{7,14}$/, 'Phone must be in E.164 format');

export const signupSchema = z.object({
  email,
  password,
  displayName: z.string().trim().min(1).max(100).optional(),
});

export const loginSchema = z.object({ email, password: z.string().max(128) });

export const socialLoginSchema = z.object({
  idToken: z.string().min(100).max(16_384),
  displayName: z.string().trim().min(1).max(100).optional(),
});

export const socialProviderParams = z.object({ provider: z.enum(['google', 'apple']) });

export const changePasswordSchema = z.object({
  currentPassword: z.string().max(128),
  newPassword: password,
});

const socialReauthentication = z.object({
  provider: z.enum(['google', 'apple']),
  idToken: z.string().min(100).max(16_384),
});

export const accountDeleteSchema = z.object({
  password: z.string().max(128).optional(),
  socialReauth: socialReauthentication.optional(),
});

export const emailChangeRequestSchema = z.object({
  newEmail: email,
  password: z.string().max(128).optional(),
  socialReauth: socialReauthentication.optional(),
});

export const emailChangeVerifySchema = z.object({
  newEmail: email,
  code: z.string().regex(/^\d{6}$/),
});

export const otpSendSchema = z.discriminatedUnion('channel', [
  z.object({
    channel: z.literal('EMAIL'),
    destination: email,
    purpose: z.enum(['LOGIN', 'VERIFY_EMAIL']),
  }),
  z.object({
    channel: z.literal('SMS'),
    destination: phone,
    purpose: z.enum(['LOGIN', 'VERIFY_PHONE']),
  }),
]);

export const otpVerifySchema = z.discriminatedUnion('channel', [
  z.object({
    channel: z.literal('EMAIL'),
    destination: email,
    purpose: z.enum(['LOGIN', 'VERIFY_EMAIL']),
    code: z.string().regex(/^\d{6}$/),
  }),
  z.object({
    channel: z.literal('SMS'),
    destination: phone,
    purpose: z.enum(['LOGIN', 'VERIFY_PHONE']),
    code: z.string().regex(/^\d{6}$/),
  }),
]);

export const passwordResetRequestSchema = z.object({ email });

export const passwordResetVerifyOtpSchema = z.object({
  email,
  otp: z.string().regex(/^\d{6}$/),
});

export const passwordResetConfirmSchema = z.object({
  resetToken: z.string().min(43).max(512),
  newPassword: password,
});

export const deviceSchema = z.object({
  token: z.string().min(20).max(4096),
  platform: z.enum(['ios', 'android', 'web']).optional(),
});

export const phoneVerificationSchema = z.object({ phone });

export const signupRequestValidation = { body: signupSchema } as const;
export const loginRequestValidation = { body: loginSchema } as const;
export const otpSendRequestValidation = { body: otpSendSchema } as const;
export const otpVerifyRequestValidation = { body: otpVerifySchema } as const;
export const passwordResetRequestValidation = { body: passwordResetRequestSchema } as const;
export const passwordResetVerifyOtpRequestValidation = {
  body: passwordResetVerifyOtpSchema,
} as const;
export const passwordResetConfirmRequestValidation = {
  body: passwordResetConfirmSchema,
} as const;
export const deviceRequestValidation = { body: deviceSchema } as const;
export const phoneVerificationRequestValidation = { body: phoneVerificationSchema } as const;
export const socialLoginRequestValidation = {
  params: socialProviderParams,
  body: socialLoginSchema,
} as const;
export const changePasswordRequestValidation = { body: changePasswordSchema } as const;
export const accountDeleteRequestValidation = { body: accountDeleteSchema } as const;
export const emailChangeRequestValidation = { body: emailChangeRequestSchema } as const;
export const emailChangeVerifyRequestValidation = { body: emailChangeVerifySchema } as const;
export const refreshRequestValidation = {
  body: z.object({ refreshToken: z.string().min(1).optional() }),
} as const;
