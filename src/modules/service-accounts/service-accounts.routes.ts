import { Router } from 'express';
import { requirePermission } from '#app/middleware/access-control.js';
import { validateRequest } from '#app/middleware/request-validation.js';
import {
  addApiKey,
  addServiceAccount,
  removeApiKey,
} from '#app/modules/service-accounts/service-accounts.controller.js';
import {
  apiKeyIdRequestValidation,
  createApiKeyRequestValidation,
  createServiceAccountRequestValidation,
} from '#app/modules/service-accounts/service-accounts.schemas.js';

export const serviceAccountsRouter = Router();
serviceAccountsRouter.post(
  '/',
  ...requirePermission('service-accounts:write'),
  validateRequest(createServiceAccountRequestValidation),
  addServiceAccount,
);
serviceAccountsRouter.post(
  '/:serviceAccountId/api-keys',
  ...requirePermission('service-accounts:write'),
  validateRequest(createApiKeyRequestValidation),
  addApiKey,
);
serviceAccountsRouter.delete(
  '/:serviceAccountId/api-keys/:apiKeyId',
  ...requirePermission('service-accounts:write'),
  validateRequest(apiKeyIdRequestValidation),
  removeApiKey,
);
