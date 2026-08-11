import { Router } from 'express';
import { validateRequest } from '#app/middleware/request-validation.js';
import {
  listTemplates,
  preferences,
  previewTemplate,
  unsubscribe,
  updatePreference,
} from '#app/modules/notifications/notifications.controller.js';
import {
  previewRequestValidation,
  unsubscribeRequestValidation,
  updatePreferenceRequestValidation,
} from '#app/modules/notifications/notifications.schemas.js';
import { authenticate } from '#app/middleware/access-control.js';
import { ipRateLimit, userIdentityRateLimit } from '#app/middleware/rate-limit.js';

export const notificationPreviewRouter = Router();

notificationPreviewRouter.get('/templates', listTemplates);
notificationPreviewRouter.get(
  '/templates/:key/preview',
  validateRequest(previewRequestValidation),
  previewTemplate,
);

export const notificationPublicRouter = Router();
notificationPublicRouter.post(
  '/unsubscribe',
  ipRateLimit('notifications:unsubscribe:ip', 30, 60),
  validateRequest(unsubscribeRequestValidation),
  unsubscribe,
);

export const notificationsRouter = Router();
notificationsRouter.get('/preferences', authenticate, userIdentityRateLimit, preferences);
notificationsRouter.put(
  '/preferences',
  authenticate,
  userIdentityRateLimit,
  validateRequest(updatePreferenceRequestValidation),
  updatePreference,
);
