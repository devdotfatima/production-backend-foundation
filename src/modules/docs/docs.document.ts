import { cookieNames } from '#app/lib/cookies.js';
import { openApiSchemaComponents } from '#app/modules/docs/docs.schemas.js';

const jsonResponse = {
  description: 'Universal API response envelope',
  content: {
    'application/json': {
      schema: { $ref: '#/components/schemas/ApiResponse' },
    },
  },
};

const binaryDownloadResponse = {
  description: 'Authenticated file stream',
  headers: {
    'Content-Disposition': { schema: { type: 'string' } },
    'Content-Length': { schema: { type: 'integer' } },
  },
  content: {
    'application/octet-stream': { schema: { type: 'string', format: 'binary' } },
  },
};

const authenticatedOperation = {
  security: [{ cookieAuth: [] }],
};

const csrfOperation = {
  security: [{ csrfToken: [] }],
};

const protectedMutation = {
  security: [{ cookieAuth: [], csrfToken: [] }],
};

const idempotencyParameter = { $ref: '#/components/parameters/IdempotencyKey' };

const cursorParameters = [
  { name: 'cursor', in: 'query', schema: { type: 'string' } },
  {
    name: 'limit',
    in: 'query',
    schema: { type: 'integer', minimum: 1, maximum: 100, default: 25 },
  },
];

const requestBody = (schema: Record<string, unknown>, required = true) => ({
  required,
  content: { 'application/json': { schema } },
});

const objectSchema = (properties: Record<string, unknown>, required: string[] = []) => ({
  type: 'object',
  properties,
  ...(required.length > 0 ? { required } : {}),
});

export const openApiDocument = {
  openapi: '3.1.0',
  info: {
    title: 'Backend Foundation API',
    version: '0.1.0',
    description:
      'Secure cookie-authenticated API with OIDC social login, owner-scoped account management, Stripe billing, and durable webhook processing.',
  },
  servers: [{ url: '/' }],
  tags: [
    { name: 'System' },
    { name: 'Auth' },
    { name: 'Users' },
    { name: 'Roles' },
    { name: 'Organizations' },
    { name: 'Audit' },
    { name: 'Outbox' },
    { name: 'Billing' },
    { name: 'Uploads' },
    { name: 'Webhooks' },
  ],
  paths: {
    '/health': {
      get: { tags: ['System'], summary: 'Health check', responses: { '200': jsonResponse } },
    },
    '/ready': {
      get: {
        tags: ['System'],
        summary: 'Dependency readiness check',
        responses: { '200': jsonResponse },
      },
    },
    '/api/v1/auth/csrf': {
      get: { tags: ['Auth'], summary: 'Issue CSRF token', responses: { '200': jsonResponse } },
    },
    '/api/v1/auth/signup': {
      post: {
        ...csrfOperation,
        tags: ['Auth'],
        summary: 'Start password signup',
        requestBody: requestBody({ $ref: '#/components/schemas/SignupRequest' }),
        responses: { '202': jsonResponse, '400': jsonResponse },
      },
    },
    '/api/v1/auth/login': {
      post: {
        ...csrfOperation,
        tags: ['Auth'],
        summary: 'Login with password',
        requestBody: requestBody({ $ref: '#/components/schemas/LoginRequest' }),
        responses: { '200': jsonResponse, '401': jsonResponse },
      },
    },
    '/api/v1/auth/oauth/{provider}': {
      post: {
        ...csrfOperation,
        tags: ['Auth'],
        summary: 'Login with a verified Google or Apple OIDC ID token',
        parameters: [
          {
            name: 'provider',
            in: 'path',
            required: true,
            schema: { type: 'string', enum: ['google', 'apple'] },
          },
        ],
        requestBody: requestBody({ $ref: '#/components/schemas/SocialLoginRequest' }),
        responses: { '200': jsonResponse, '401': jsonResponse },
      },
    },
    '/api/v1/auth/otp/send': {
      post: {
        ...csrfOperation,
        tags: ['Auth'],
        summary: 'Send a login or verification OTP',
        requestBody: requestBody({ $ref: '#/components/schemas/OtpSendRequest' }),
        responses: { '202': jsonResponse, '400': jsonResponse, '503': jsonResponse },
      },
    },
    '/api/v1/auth/otp/verify': {
      post: {
        ...csrfOperation,
        tags: ['Auth'],
        summary: 'Verify a login, email, or phone OTP',
        requestBody: requestBody({ $ref: '#/components/schemas/OtpVerifyRequest' }),
        responses: { '200': jsonResponse, '401': jsonResponse, '503': jsonResponse },
      },
    },
    '/api/v1/auth/phone/send-verification': {
      post: {
        ...protectedMutation,
        tags: ['Auth'],
        summary: 'Send verification to the authenticated user phone number',
        requestBody: requestBody({ $ref: '#/components/schemas/PhoneVerificationRequest' }),
        responses: { '202': jsonResponse, '400': jsonResponse, '401': jsonResponse },
      },
    },
    '/api/v1/auth/refresh': {
      post: {
        ...csrfOperation,
        tags: ['Auth'],
        summary: 'Rotate refresh cookie',
        responses: { '200': jsonResponse, '401': jsonResponse },
      },
    },
    '/api/v1/auth/password/change': {
      post: {
        ...protectedMutation,
        tags: ['Auth'],
        summary: 'Change password and revoke other sessions',
        requestBody: requestBody({ $ref: '#/components/schemas/ChangePasswordRequest' }),
        responses: { '200': jsonResponse, '401': jsonResponse },
      },
    },
    '/api/v1/auth/password-reset/request': {
      post: {
        ...csrfOperation,
        tags: ['Auth'],
        summary: 'Request a password-reset OTP',
        requestBody: requestBody({ $ref: '#/components/schemas/PasswordResetRequest' }),
        responses: { '202': jsonResponse, '400': jsonResponse },
      },
    },
    '/api/v1/auth/password-reset/verify-otp': {
      post: {
        ...csrfOperation,
        tags: ['Auth'],
        summary: 'Verify a password-reset OTP and issue a short-lived reset credential',
        requestBody: requestBody({ $ref: '#/components/schemas/PasswordResetVerifyOtpRequest' }),
        responses: { '200': jsonResponse, '401': jsonResponse },
      },
    },
    '/api/v1/auth/password-reset/confirm': {
      post: {
        ...csrfOperation,
        tags: ['Auth'],
        summary: 'Consume a reset credential and change the password',
        requestBody: requestBody({ $ref: '#/components/schemas/PasswordResetConfirmRequest' }),
        responses: { '202': jsonResponse, '401': jsonResponse },
      },
    },
    '/api/v1/auth/email-change/request': {
      post: {
        ...protectedMutation,
        tags: ['Auth'],
        summary: 'Reauthenticate and send an OTP to a new email address',
        requestBody: requestBody({ $ref: '#/components/schemas/EmailChangeRequest' }),
        responses: { '202': jsonResponse, '400': jsonResponse, '401': jsonResponse },
      },
    },
    '/api/v1/auth/email-change/verify': {
      post: {
        ...protectedMutation,
        tags: ['Auth'],
        summary: 'Verify an email change and revoke every existing session',
        requestBody: requestBody({ $ref: '#/components/schemas/EmailChangeVerifyRequest' }),
        responses: { '200': jsonResponse, '400': jsonResponse, '401': jsonResponse },
      },
    },
    '/api/v1/auth/logout': {
      post: {
        ...protectedMutation,
        tags: ['Auth'],
        summary: 'Log out the current session',
        responses: { '200': jsonResponse, '401': jsonResponse },
      },
    },
    '/api/v1/auth/logout-all': {
      post: {
        ...protectedMutation,
        tags: ['Auth'],
        summary: 'Revoke every session',
        responses: { '200': jsonResponse, '401': jsonResponse },
      },
    },
    '/api/v1/auth/account': {
      delete: {
        ...protectedMutation,
        tags: ['Auth'],
        summary: 'Delete the authenticated account',
        requestBody: requestBody({ $ref: '#/components/schemas/AccountDeleteRequest' }, false),
        responses: { '200': jsonResponse, '401': jsonResponse },
      },
    },
    '/api/v1/users/me': {
      get: {
        ...authenticatedOperation,
        tags: ['Users'],
        summary: 'Get current profile',
        responses: { '200': jsonResponse, '401': jsonResponse },
      },
      patch: {
        ...protectedMutation,
        tags: ['Users'],
        summary: 'Edit current profile',
        requestBody: requestBody({ $ref: '#/components/schemas/ProfileUpdateRequest' }),
        responses: { '200': jsonResponse, '400': jsonResponse },
      },
      delete: {
        ...protectedMutation,
        tags: ['Users'],
        summary: 'Delete the authenticated account',
        requestBody: requestBody({ $ref: '#/components/schemas/AccountDeleteRequest' }, false),
        responses: { '200': jsonResponse, '401': jsonResponse },
      },
    },
    '/api/v1/users/me/devices': {
      get: {
        ...authenticatedOperation,
        tags: ['Users'],
        summary: 'List registered push devices',
        responses: { '200': jsonResponse, '401': jsonResponse },
      },
      post: {
        ...protectedMutation,
        tags: ['Users'],
        summary: 'Register a push device',
        requestBody: requestBody({ $ref: '#/components/schemas/DeviceRequest' }),
        responses: { '201': jsonResponse },
      },
    },
    '/api/v1/users/me/devices/{deviceId}': {
      delete: {
        ...protectedMutation,
        tags: ['Users'],
        summary: 'Unregister a push device',
        parameters: [{ $ref: '#/components/parameters/DeviceId' }],
        responses: { '200': jsonResponse, '404': jsonResponse },
      },
    },
    '/api/v1/users/me/sessions': {
      get: {
        ...authenticatedOperation,
        tags: ['Users'],
        summary: 'List active login sessions',
        responses: { '200': jsonResponse, '401': jsonResponse },
      },
    },
    '/api/v1/users/me/sessions/{sessionId}': {
      delete: {
        ...protectedMutation,
        tags: ['Users'],
        summary: 'Log out a specific login session',
        parameters: [{ $ref: '#/components/parameters/SessionId' }],
        responses: { '200': jsonResponse, '404': jsonResponse },
      },
    },
    '/api/v1/users': {
      get: {
        ...authenticatedOperation,
        tags: ['Users'],
        summary: 'List users (administrative)',
        parameters: [
          ...cursorParameters,
          { name: 'search', in: 'query', schema: { type: 'string', maxLength: 200 } },
          {
            name: 'status',
            in: 'query',
            schema: { type: 'string', enum: ['PENDING', 'ACTIVE', 'SUSPENDED', 'DISABLED'] },
          },
          {
            name: 'sort',
            in: 'query',
            schema: {
              type: 'string',
              enum: ['createdAt', 'email', 'displayName', 'id'],
              default: 'createdAt',
            },
          },
          {
            name: 'order',
            in: 'query',
            schema: { type: 'string', enum: ['asc', 'desc'], default: 'desc' },
          },
        ],
        responses: { '200': jsonResponse, '403': jsonResponse },
      },
    },
    '/api/v1/users/{id}': {
      patch: {
        ...protectedMutation,
        tags: ['Users'],
        summary: 'Update a user (administrative)',
        parameters: [{ $ref: '#/components/parameters/UserId' }],
        requestBody: requestBody({ $ref: '#/components/schemas/AdminUserUpdateRequest' }),
        responses: { '200': jsonResponse, '403': jsonResponse, '404': jsonResponse },
      },
    },
    '/api/v1/billing/setup-intents': {
      post: {
        ...protectedMutation,
        tags: ['Billing'],
        summary: 'Start saving a card',
        description:
          'Returns a client secret for Stripe Elements. Card data never reaches this server, which is what keeps the deployment in PCI SAQ-A. The SetupIntent is created with usage=off_session so later off-session charges have a mandate to reference.',
        parameters: [idempotencyParameter],
        responses: { '201': jsonResponse, '401': jsonResponse },
      },
    },
    '/api/v1/billing/payment-methods': {
      get: {
        ...authenticatedOperation,
        tags: ['Billing'],
        summary: 'List saved cards',
        description:
          'Returns Stripe identifiers and display metadata only — never a PAN, CVC, or full expiry.',
        responses: { '200': jsonResponse, '401': jsonResponse },
      },
    },
    '/api/v1/billing/payment-methods/{paymentMethodId}': {
      delete: {
        ...protectedMutation,
        tags: ['Billing'],
        summary: 'Remove a saved card',
        description:
          'Refuses to remove the last card while a subscription is active, because the next renewal would fail silently.',
        parameters: [{ $ref: '#/components/parameters/PaymentMethodId' }, idempotencyParameter],
        responses: { '200': jsonResponse, '404': jsonResponse, '409': jsonResponse },
      },
    },
    '/api/v1/billing/payment-methods/{paymentMethodId}/default': {
      post: {
        ...protectedMutation,
        tags: ['Billing'],
        summary: 'Set the default card',
        parameters: [{ $ref: '#/components/parameters/PaymentMethodId' }, idempotencyParameter],
        responses: { '200': jsonResponse, '404': jsonResponse },
      },
    },
    '/api/v1/billing/charges': {
      post: {
        ...protectedMutation,
        tags: ['Billing'],
        summary: 'Charge a dynamic amount',
        description:
          'The body carries a reference, never an amount: the server resolves what that reference costs and rejects anything outside the configured per-currency bounds. Supply paymentMethodId to charge a saved card off-session. A response with requiresAction=true is a 3D Secure challenge, not a decline — complete it with the returned clientSecret.',
        parameters: [idempotencyParameter],
        requestBody: requestBody({ $ref: '#/components/schemas/CreateChargeRequest' }),
        responses: {
          '201': jsonResponse,
          '400': jsonResponse,
          '404': jsonResponse,
          '409': jsonResponse,
        },
      },
    },
    '/api/v1/billing/charges/{paymentIntentId}': {
      get: {
        ...authenticatedOperation,
        tags: ['Billing'],
        summary: 'Get a charge',
        parameters: [{ $ref: '#/components/parameters/PaymentIntentId' }],
        responses: { '200': jsonResponse, '404': jsonResponse },
      },
    },
    '/api/v1/organizations': {
      get: {
        ...authenticatedOperation,
        tags: ['Organizations'],
        summary: "List the caller's organizations",
        responses: { '200': jsonResponse, '401': jsonResponse },
      },
      post: {
        ...protectedMutation,
        tags: ['Organizations'],
        summary: 'Create an organization (TENANCY_MODE=multi only)',
        requestBody: requestBody({ $ref: '#/components/schemas/CreateOrganizationRequest' }),
        responses: { '201': jsonResponse, '401': jsonResponse, '409': jsonResponse },
      },
    },
    '/api/v1/organizations/{organizationId}/switch': {
      post: {
        ...protectedMutation,
        tags: ['Organizations'],
        summary: 'Change the active organization for the current session',
        description:
          'Requires an active membership. The active organization is stored on the session; it is never read from a request header.',
        parameters: [{ $ref: '#/components/parameters/OrganizationId' }],
        responses: { '200': jsonResponse, '401': jsonResponse, '403': jsonResponse },
      },
    },
    '/api/v1/organizations/invitations/accept': {
      post: {
        ...protectedMutation,
        tags: ['Organizations'],
        summary: 'Accept an invitation',
        description:
          "The authenticated account's verified email must match the invited address, so a leaked invitation link cannot be redeemed by another account.",
        requestBody: requestBody({ $ref: '#/components/schemas/AcceptInvitationRequest' }),
        responses: { '200': jsonResponse, '403': jsonResponse, '404': jsonResponse },
      },
    },
    '/api/v1/organizations/{organizationId}': {
      get: {
        ...authenticatedOperation,
        tags: ['Organizations'],
        summary: 'Get an organization',
        description:
          'The path organization must be the active one; switch first. A platform-wide grant is not sufficient.',
        parameters: [{ $ref: '#/components/parameters/OrganizationId' }],
        responses: { '200': jsonResponse, '403': jsonResponse, '404': jsonResponse },
      },
      patch: {
        ...protectedMutation,
        tags: ['Organizations'],
        summary: 'Update an organization',
        parameters: [{ $ref: '#/components/parameters/OrganizationId' }],
        requestBody: requestBody({ $ref: '#/components/schemas/UpdateOrganizationRequest' }),
        responses: { '200': jsonResponse, '403': jsonResponse, '404': jsonResponse },
      },
    },
    '/api/v1/organizations/{organizationId}/members': {
      get: {
        ...authenticatedOperation,
        tags: ['Organizations'],
        summary: 'List organization members',
        parameters: [{ $ref: '#/components/parameters/OrganizationId' }, ...cursorParameters],
        responses: { '200': jsonResponse, '403': jsonResponse },
      },
    },
    '/api/v1/organizations/{organizationId}/members/{userId}': {
      patch: {
        ...protectedMutation,
        tags: ['Organizations'],
        summary: "Change a member's role",
        parameters: [
          { $ref: '#/components/parameters/OrganizationId' },
          { $ref: '#/components/parameters/MemberUserId' },
        ],
        requestBody: requestBody({ $ref: '#/components/schemas/ChangeMemberRoleRequest' }),
        responses: {
          '200': jsonResponse,
          '400': jsonResponse,
          '403': jsonResponse,
          '404': jsonResponse,
        },
      },
      delete: {
        ...protectedMutation,
        tags: ['Organizations'],
        summary: 'Remove a member',
        description:
          'Refuses to remove the last active member. Detaches the removed member’s sessions from the organization immediately.',
        parameters: [
          { $ref: '#/components/parameters/OrganizationId' },
          { $ref: '#/components/parameters/MemberUserId' },
        ],
        responses: {
          '200': jsonResponse,
          '403': jsonResponse,
          '404': jsonResponse,
          '409': jsonResponse,
        },
      },
    },
    '/api/v1/organizations/{organizationId}/invitations': {
      post: {
        ...protectedMutation,
        tags: ['Organizations'],
        summary: 'Invite a member',
        description: 'The invitation token is returned once and only its hash is stored.',
        parameters: [{ $ref: '#/components/parameters/OrganizationId' }],
        requestBody: requestBody({ $ref: '#/components/schemas/CreateInvitationRequest' }),
        responses: { '201': jsonResponse, '400': jsonResponse, '403': jsonResponse },
      },
    },
    '/api/v1/organizations/{organizationId}/invitations/{invitationId}': {
      delete: {
        ...protectedMutation,
        tags: ['Organizations'],
        summary: 'Revoke an invitation',
        parameters: [
          { $ref: '#/components/parameters/OrganizationId' },
          { $ref: '#/components/parameters/InvitationId' },
        ],
        responses: { '200': jsonResponse, '403': jsonResponse, '404': jsonResponse },
      },
    },
    '/api/v1/roles': {
      get: {
        ...authenticatedOperation,
        tags: ['Roles'],
        summary: 'List roles and permissions',
        responses: { '200': jsonResponse, '403': jsonResponse },
      },
      post: {
        ...protectedMutation,
        tags: ['Roles'],
        summary: 'Create a role',
        requestBody: requestBody({ $ref: '#/components/schemas/RoleRequest' }),
        responses: { '201': jsonResponse, '403': jsonResponse },
      },
    },
    '/api/v1/roles/{id}/permissions': {
      patch: {
        ...protectedMutation,
        tags: ['Roles'],
        summary: "Replace a role's permission set",
        parameters: [{ $ref: '#/components/parameters/RoleId' }],
        requestBody: requestBody({ $ref: '#/components/schemas/RolePermissionsUpdateRequest' }),
        responses: {
          '200': jsonResponse,
          '400': jsonResponse,
          '403': jsonResponse,
          '404': jsonResponse,
        },
      },
    },
    '/api/v1/roles/assignments': {
      post: {
        ...protectedMutation,
        tags: ['Roles'],
        summary: 'Assign a role to a user',
        requestBody: requestBody({ $ref: '#/components/schemas/RoleAssignmentRequest' }),
        responses: { '201': jsonResponse, '403': jsonResponse },
      },
      delete: {
        ...protectedMutation,
        tags: ['Roles'],
        summary: 'Revoke a role from a user',
        parameters: [
          {
            name: 'userId',
            in: 'query',
            required: true,
            schema: { type: 'string', format: 'uuid' },
          },
          {
            name: 'roleId',
            in: 'query',
            required: true,
            schema: { type: 'string', format: 'uuid' },
          },
        ],
        responses: { '200': jsonResponse, '403': jsonResponse, '404': jsonResponse },
      },
    },
    '/api/v1/audit-events': {
      get: {
        ...authenticatedOperation,
        tags: ['Audit'],
        summary: 'List audit events',
        parameters: [
          ...cursorParameters,
          { name: 'actorUserId', in: 'query', schema: { type: 'string', format: 'uuid' } },
          { name: 'entityType', in: 'query', schema: { type: 'string', maxLength: 100 } },
        ],
        responses: { '200': jsonResponse, '403': jsonResponse },
      },
    },
    '/api/v1/outbox-events/dead-letter': {
      get: {
        ...authenticatedOperation,
        tags: ['Outbox'],
        summary: 'List dead-lettered outbox events',
        parameters: cursorParameters,
        responses: { '200': jsonResponse, '403': jsonResponse },
      },
    },
    '/api/v1/outbox-events/{id}/redrive': {
      post: {
        ...protectedMutation,
        tags: ['Outbox'],
        summary: 'Redrive a dead-lettered outbox event',
        parameters: [{ $ref: '#/components/parameters/OutboxEventId' }],
        responses: { '200': jsonResponse, '403': jsonResponse, '409': jsonResponse },
      },
    },
    '/api/v1/billing/checkout/sessions': {
      post: {
        ...protectedMutation,
        tags: ['Billing'],
        summary: 'Create a one-time payment or subscription Checkout session',
        parameters: [idempotencyParameter],
        requestBody: requestBody({ $ref: '#/components/schemas/CheckoutRequest' }),
        responses: { '201': jsonResponse, '400': jsonResponse, '503': jsonResponse },
      },
    },
    '/api/v1/billing/checkout/sessions/{sessionId}': {
      get: {
        ...authenticatedOperation,
        tags: ['Billing'],
        summary: 'Retrieve an owned Checkout session',
        parameters: [{ $ref: '#/components/parameters/SessionId' }],
        responses: { '200': jsonResponse, '404': jsonResponse },
      },
    },
    '/api/v1/billing/subscriptions': {
      get: {
        ...authenticatedOperation,
        tags: ['Billing'],
        summary: 'List Stripe subscriptions',
        parameters: cursorParameters,
        responses: { '200': jsonResponse },
      },
    },
    '/api/v1/billing/subscriptions/{subscriptionId}/cancel': {
      post: {
        ...protectedMutation,
        tags: ['Billing'],
        summary: 'Cancel a subscription at period end',
        parameters: [
          { name: 'subscriptionId', in: 'path', required: true, schema: { type: 'string' } },
          idempotencyParameter,
        ],
        responses: { '200': jsonResponse, '404': jsonResponse },
      },
    },
    '/api/v1/billing/subscriptions/{subscriptionId}/resume': {
      post: {
        ...protectedMutation,
        tags: ['Billing'],
        summary: 'Resume a subscription scheduled for cancellation',
        parameters: [
          { name: 'subscriptionId', in: 'path', required: true, schema: { type: 'string' } },
          idempotencyParameter,
        ],
        responses: { '200': jsonResponse, '404': jsonResponse },
      },
    },
    '/api/v1/billing/subscriptions/{subscriptionId}': {
      patch: {
        ...protectedMutation,
        tags: ['Billing'],
        summary: 'Upgrade or downgrade a subscription using a server-owned price key',
        parameters: [
          { name: 'subscriptionId', in: 'path', required: true, schema: { type: 'string' } },
          idempotencyParameter,
        ],
        requestBody: requestBody({ $ref: '#/components/schemas/SubscriptionChangeRequest' }),
        responses: { '200': jsonResponse, '400': jsonResponse, '404': jsonResponse },
      },
    },
    '/api/v1/billing/portal/sessions': {
      post: {
        ...protectedMutation,
        tags: ['Billing'],
        summary: 'Create a short-lived Stripe Billing Portal session',
        parameters: [idempotencyParameter],
        requestBody: requestBody({ $ref: '#/components/schemas/BillingPortalRequest' }),
        responses: { '201': jsonResponse, '400': jsonResponse, '503': jsonResponse },
      },
    },
    '/api/v1/billing/payments': {
      get: {
        ...authenticatedOperation,
        tags: ['Billing'],
        summary: 'List recorded payments',
        parameters: cursorParameters,
        responses: { '200': jsonResponse },
      },
    },
    '/api/v1/billing/refunds': {
      post: {
        ...protectedMutation,
        tags: ['Billing'],
        summary: 'Refund an owned payment or charge',
        parameters: [idempotencyParameter],
        requestBody: requestBody({ $ref: '#/components/schemas/RefundRequest' }),
        responses: { '201': jsonResponse, '403': jsonResponse, '404': jsonResponse },
      },
    },
    '/api/v1/billing/promotion-codes/validate': {
      post: {
        ...protectedMutation,
        tags: ['Billing'],
        summary: 'Validate an active Stripe promotion code',
        requestBody: requestBody({ $ref: '#/components/schemas/PromotionCodeRequest' }),
        responses: { '200': jsonResponse, '400': jsonResponse },
      },
    },
    '/api/v1/uploads': {
      get: {
        ...authenticatedOperation,
        tags: ['Uploads'],
        summary: 'List owned uploads',
        parameters: cursorParameters,
        responses: { '200': jsonResponse },
      },
      post: {
        ...protectedMutation,
        tags: ['Uploads'],
        summary: 'Initialize a direct S3 or Cloudinary upload',
        requestBody: requestBody({ $ref: '#/components/schemas/CreateUploadRequest' }),
        responses: { '201': jsonResponse, '400': jsonResponse, '503': jsonResponse },
      },
    },
    '/api/v1/uploads/{uploadId}/complete': {
      post: {
        ...protectedMutation,
        tags: ['Uploads'],
        summary: 'Verify, quarantine, and enqueue scanning for a direct upload',
        parameters: [{ $ref: '#/components/parameters/UploadId' }],
        responses: { '200': jsonResponse, '400': jsonResponse, '404': jsonResponse },
      },
    },
    '/api/v1/uploads/{uploadId}/download': {
      get: {
        ...authenticatedOperation,
        tags: ['Uploads'],
        summary: 'Stream an authorized upload while accounting for bandwidth',
        parameters: [{ $ref: '#/components/parameters/UploadId' }],
        responses: { '200': binaryDownloadResponse, '404': jsonResponse },
      },
    },
    '/api/v1/uploads/{uploadId}': {
      delete: {
        ...protectedMutation,
        tags: ['Uploads'],
        summary: 'Delete an owned upload',
        parameters: [{ $ref: '#/components/parameters/UploadId' }],
        responses: { '200': jsonResponse, '404': jsonResponse },
      },
    },
    '/api/v1/webhooks/stripe': {
      post: {
        tags: ['Webhooks'],
        summary: 'Receive a signed Stripe webhook',
        parameters: [
          { name: 'Stripe-Signature', in: 'header', required: true, schema: { type: 'string' } },
        ],
        requestBody: {
          required: true,
          content: { 'application/json': { schema: { type: 'object' } } },
        },
        responses: { '200': jsonResponse, '400': jsonResponse },
      },
    },
  },
  components: {
    securitySchemes: {
      cookieAuth: {
        type: 'apiKey',
        in: 'cookie',
        name: cookieNames.access,
        description:
          'HttpOnly access cookie. Secure deployments use __Host-access_token; local HTTP uses access_token.',
      },
      csrfToken: {
        type: 'apiKey',
        in: 'header',
        name: 'x-csrf-token',
        description: 'Required only for POST, PUT, PATCH, and DELETE browser requests.',
      },
    },
    parameters: {
      DeviceId: {
        name: 'deviceId',
        in: 'path',
        required: true,
        schema: { type: 'string', format: 'uuid' },
      },
      SessionId: { name: 'sessionId', in: 'path', required: true, schema: { type: 'string' } },
      UserId: {
        name: 'id',
        in: 'path',
        required: true,
        schema: { type: 'string', format: 'uuid' },
      },
      RoleId: {
        name: 'id',
        in: 'path',
        required: true,
        schema: { type: 'string', format: 'uuid' },
      },
      PaymentMethodId: {
        name: 'paymentMethodId',
        in: 'path',
        required: true,
        schema: { type: 'string', format: 'uuid' },
      },
      PaymentIntentId: {
        name: 'paymentIntentId',
        in: 'path',
        required: true,
        schema: { type: 'string' },
      },
      OrganizationId: {
        name: 'organizationId',
        in: 'path',
        required: true,
        schema: { type: 'string', format: 'uuid' },
      },
      MemberUserId: {
        name: 'userId',
        in: 'path',
        required: true,
        schema: { type: 'string', format: 'uuid' },
      },
      InvitationId: {
        name: 'invitationId',
        in: 'path',
        required: true,
        schema: { type: 'string', format: 'uuid' },
      },
      OutboxEventId: {
        name: 'id',
        in: 'path',
        required: true,
        schema: { type: 'string', format: 'uuid' },
      },
      UploadId: {
        name: 'uploadId',
        in: 'path',
        required: true,
        schema: { type: 'string', format: 'uuid' },
      },
      IdempotencyKey: {
        name: 'Idempotency-Key',
        in: 'header',
        required: true,
        description:
          'Stable business-operation key. Reuse with the same payload replays the encrypted stored response; reuse with another payload returns 409.',
        schema: { type: 'string', minLength: 8, maxLength: 200 },
      },
    },
    schemas: {
      ApiResponse: objectSchema({
        success: { type: 'boolean' },
        message: { type: 'string' },
        data: {},
        error: {},
        meta: {},
      }),
      ...openApiSchemaComponents,
    },
  },
} as const;
