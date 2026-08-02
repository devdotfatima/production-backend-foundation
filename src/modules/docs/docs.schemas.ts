import { z, type ZodType } from 'zod';
import {
  accountDeleteSchema,
  changePasswordSchema,
  deviceSchema,
  loginSchema,
  otpSendSchema,
  otpVerifySchema,
  passwordResetConfirmSchema,
  passwordResetRequestSchema,
  passwordResetVerifyOtpSchema,
  phoneVerificationSchema,
  signupSchema,
  socialLoginSchema,
} from '#app/modules/auth/auth.schemas.js';
import { assignmentSchema, roleSchema } from '#app/modules/roles/roles.schemas.js';
import {
  checkoutSessionSchema,
  promotionCodeSchema,
  refundSchema,
} from '#app/modules/stripe/stripe.schemas.js';
import { createUploadSchema } from '#app/modules/uploads/uploads.schemas.js';
import { updateOwnProfileSchema, updateUserSchema } from '#app/modules/users/users.schemas.js';

function toOpenApiSchema(schema: ZodType): Record<string, unknown> {
  const component = z.toJSONSchema(schema, {
    target: 'draft-2020-12',
    unrepresentable: 'any',
  });
  Reflect.deleteProperty(component, '$schema');
  return component;
}

/** Request components generated directly from the schemas used by route validation. */
export const openApiSchemaComponents = {
  SignupRequest: toOpenApiSchema(signupSchema),
  LoginRequest: toOpenApiSchema(loginSchema),
  SocialLoginRequest: toOpenApiSchema(socialLoginSchema),
  OtpSendRequest: toOpenApiSchema(otpSendSchema),
  OtpVerifyRequest: toOpenApiSchema(otpVerifySchema),
  PhoneVerificationRequest: toOpenApiSchema(phoneVerificationSchema),
  ChangePasswordRequest: toOpenApiSchema(changePasswordSchema),
  AccountDeleteRequest: toOpenApiSchema(accountDeleteSchema),
  PasswordResetRequest: toOpenApiSchema(passwordResetRequestSchema),
  PasswordResetVerifyOtpRequest: toOpenApiSchema(passwordResetVerifyOtpSchema),
  PasswordResetConfirmRequest: toOpenApiSchema(passwordResetConfirmSchema),
  ProfileUpdateRequest: toOpenApiSchema(updateOwnProfileSchema),
  AdminUserUpdateRequest: toOpenApiSchema(updateUserSchema),
  RoleRequest: toOpenApiSchema(roleSchema),
  RoleAssignmentRequest: toOpenApiSchema(assignmentSchema),
  DeviceRequest: toOpenApiSchema(deviceSchema),
  CheckoutRequest: toOpenApiSchema(checkoutSessionSchema),
  RefundRequest: toOpenApiSchema(refundSchema),
  PromotionCodeRequest: toOpenApiSchema(promotionCodeSchema),
  CreateUploadRequest: toOpenApiSchema(createUploadSchema),
} as const;
