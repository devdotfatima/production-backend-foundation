import { z, type ZodType } from 'zod';
import {
  accountDeleteSchema,
  changePasswordSchema,
  deviceSchema,
  emailChangeRequestSchema,
  emailChangeVerifySchema,
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
import {
  assignmentSchema,
  roleSchema,
  updateRolePermissionsSchema,
} from '#app/modules/roles/roles.schemas.js';
import {
  acceptInvitationSchema,
  changeMemberRoleSchema,
  createInvitationSchema,
  createOrganizationSchema,
  updateOrganizationSchema,
} from '#app/modules/organizations/organizations.schemas.js';
import {
  billingPortalSchema,
  checkoutSessionSchema,
  createChargeSchema,
  promotionCodeSchema,
  refundSchema,
  subscriptionChangeSchema,
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
  EmailChangeRequest: toOpenApiSchema(emailChangeRequestSchema),
  EmailChangeVerifyRequest: toOpenApiSchema(emailChangeVerifySchema),
  PasswordResetRequest: toOpenApiSchema(passwordResetRequestSchema),
  PasswordResetVerifyOtpRequest: toOpenApiSchema(passwordResetVerifyOtpSchema),
  PasswordResetConfirmRequest: toOpenApiSchema(passwordResetConfirmSchema),
  ProfileUpdateRequest: toOpenApiSchema(updateOwnProfileSchema),
  AdminUserUpdateRequest: toOpenApiSchema(updateUserSchema),
  CreateOrganizationRequest: toOpenApiSchema(createOrganizationSchema),
  UpdateOrganizationRequest: toOpenApiSchema(updateOrganizationSchema),
  ChangeMemberRoleRequest: toOpenApiSchema(changeMemberRoleSchema),
  CreateInvitationRequest: toOpenApiSchema(createInvitationSchema),
  AcceptInvitationRequest: toOpenApiSchema(acceptInvitationSchema),
  RoleRequest: toOpenApiSchema(roleSchema),
  RoleAssignmentRequest: toOpenApiSchema(assignmentSchema),
  RolePermissionsUpdateRequest: toOpenApiSchema(updateRolePermissionsSchema),
  DeviceRequest: toOpenApiSchema(deviceSchema),
  CheckoutRequest: toOpenApiSchema(checkoutSessionSchema),
  CreateChargeRequest: toOpenApiSchema(createChargeSchema),
  RefundRequest: toOpenApiSchema(refundSchema),
  PromotionCodeRequest: toOpenApiSchema(promotionCodeSchema),
  SubscriptionChangeRequest: toOpenApiSchema(subscriptionChangeSchema),
  BillingPortalRequest: toOpenApiSchema(billingPortalSchema),
  CreateUploadRequest: toOpenApiSchema(createUploadSchema),
} as const;
