import { Router } from 'express';
import { authenticate } from '#app/middleware/access-control.js';
import { userIdentityRateLimit } from '#app/middleware/rate-limit.js';
import { validateRequest } from '#app/middleware/request-validation.js';
import {
  create,
  index,
  remove,
} from '#app/modules/customer-webhooks/customer-webhooks.controller.js';
import {
  createWebhookEndpointRequestValidation,
  webhookEndpointIdRequestValidation,
} from '#app/modules/customer-webhooks/customer-webhooks.schemas.js';

export const customerWebhooksRouter = Router();
customerWebhooksRouter.get('/', authenticate, userIdentityRateLimit, index);
customerWebhooksRouter.post(
  '/',
  authenticate,
  userIdentityRateLimit,
  validateRequest(createWebhookEndpointRequestValidation),
  create,
);
customerWebhooksRouter.delete(
  '/:endpointId',
  authenticate,
  userIdentityRateLimit,
  validateRequest(webhookEndpointIdRequestValidation),
  remove,
);
