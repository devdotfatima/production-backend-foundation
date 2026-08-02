import { Router } from 'express';
import { requirePermission } from '#app/middleware/access-control.js';
import { validateRequest } from '#app/middleware/request-validation.js';
import { index } from '#app/modules/audit/audit.controller.js';
import { auditListRequestValidation } from '#app/modules/audit/audit.schemas.js';

export const auditRouter = Router();

auditRouter.get(
  '/',
  ...requirePermission('audit:read'),
  validateRequest(auditListRequestValidation),
  index,
);
