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

const authenticatedOperation = {
  security: [{ cookieAuth: [] }],
};

const csrfOperation = {
  security: [{ csrfToken: [] }],
};

const protectedMutation = {
  security: [{ cookieAuth: [], csrfToken: [] }],
};

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
        parameters: cursorParameters,
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
    '/api/v1/roles/assignments': {
      post: {
        ...protectedMutation,
        tags: ['Roles'],
        summary: 'Assign a role to a user',
        requestBody: requestBody({ $ref: '#/components/schemas/RoleAssignmentRequest' }),
        responses: { '201': jsonResponse, '403': jsonResponse },
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
        parameters: [
          {
            name: 'Idempotency-Key',
            in: 'header',
            required: true,
            schema: { type: 'string', minLength: 8, maxLength: 200 },
          },
        ],
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
        ],
        responses: { '200': jsonResponse, '404': jsonResponse },
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
        parameters: [
          {
            name: 'Idempotency-Key',
            in: 'header',
            required: true,
            description: 'Use a new business operation ID for each intended refund.',
            schema: { type: 'string', minLength: 8, maxLength: 200 },
          },
        ],
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
        summary: 'Verify and complete a direct upload',
        parameters: [{ $ref: '#/components/parameters/UploadId' }],
        responses: { '200': jsonResponse, '400': jsonResponse, '404': jsonResponse },
      },
    },
    '/api/v1/uploads/{uploadId}/download': {
      get: {
        ...authenticatedOperation,
        tags: ['Uploads'],
        summary: 'Create an owned download URL',
        parameters: [{ $ref: '#/components/parameters/UploadId' }],
        responses: { '200': jsonResponse, '404': jsonResponse },
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
