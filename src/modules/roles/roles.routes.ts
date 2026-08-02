import { Router } from 'express';
import { requirePermission } from '#app/middleware/access-control.js';
import { validateRequest } from '#app/middleware/request-validation.js';
import { assign, create, index } from '#app/modules/roles/roles.controller.js';
import {
  assignRoleRequestValidation,
  createRoleRequestValidation,
} from '#app/modules/roles/roles.schemas.js';

export const rolesRouter = Router();

rolesRouter.get('/', ...requirePermission('roles:read'), index);
rolesRouter.post(
  '/',
  ...requirePermission('roles:write'),
  validateRequest(createRoleRequestValidation),
  create,
);
rolesRouter.post(
  '/assignments',
  ...requirePermission('roles:write'),
  validateRequest(assignRoleRequestValidation),
  assign,
);
