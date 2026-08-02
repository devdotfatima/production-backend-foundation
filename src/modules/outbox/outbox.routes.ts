import { Router } from 'express';
import { requirePermission } from '#app/middleware/access-control.js';
import { validateRequest } from '#app/middleware/request-validation.js';
import { indexDeadLetters, redrive } from '#app/modules/outbox/outbox.controller.js';
import {
  deadLetterListRequestValidation,
  redriveOutboxRequestValidation,
} from '#app/modules/outbox/outbox.schemas.js';

export const outboxRouter = Router();

outboxRouter.get(
  '/dead-letter',
  ...requirePermission('outbox:read'),
  validateRequest(deadLetterListRequestValidation),
  indexDeadLetters,
);

outboxRouter.post(
  '/:id/redrive',
  ...requirePermission('outbox:write'),
  validateRequest(redriveOutboxRequestValidation),
  redrive,
);
