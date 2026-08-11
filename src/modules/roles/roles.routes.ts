import { Router } from 'express';
import { requirePermission } from '#app/middleware/access-control.js';
import { validateRequest } from '#app/middleware/request-validation.js';
import {
  assign,
  create,
  index,
  revoke,
  updatePermissions,
} from '#app/modules/roles/roles.controller.js';
import {
  assignRoleRequestValidation,
  createRoleRequestValidation,
  revokeRoleRequestValidation,
  updateRolePermissionsRequestValidation,
} from '#app/modules/roles/roles.schemas.js';

export const rolesRouter = Router();

rolesRouter.get('/', ...requirePermission('roles:read'), index);
rolesRouter.post(
  '/',
  ...requirePermission('roles:write'),
  validateRequest(createRoleRequestValidation),
  create,
);
rolesRouter.patch(
  '/:id/permissions',
  ...requirePermission('roles:write'),
  validateRequest(updateRolePermissionsRequestValidation),
  updatePermissions,
);
rolesRouter.post(
  '/assignments',
  ...requirePermission('roles:write'),
  validateRequest(assignRoleRequestValidation),
  assign,
);
rolesRouter.delete(
  '/assignments',
  ...requirePermission('roles:write'),
  validateRequest(revokeRoleRequestValidation),
  revoke,
);
