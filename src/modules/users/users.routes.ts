import { Router } from 'express';
import { authenticate, requirePermission } from '#app/middleware/access-control.js';
import { userIdentityRateLimit } from '#app/middleware/rate-limit.js';
import { validateRequest } from '#app/middleware/request-validation.js';
import { deviceRequestValidation } from '#app/modules/auth/auth.schemas.js';
import { accountDeleteRequestValidation } from '#app/modules/auth/auth.schemas.js';
import { deleteAccount } from '#app/modules/auth/auth.controller.js';
import {
  addDevice,
  devices,
  index,
  logoutSession,
  me,
  removeDevice,
  sessions,
  update,
  updateMe,
} from '#app/modules/users/users.controller.js';
import {
  deviceIdRequestValidation,
  sessionIdRequestValidation,
  updateOwnProfileRequestValidation,
  updateUserRequestValidation,
  usersListRequestValidation,
} from '#app/modules/users/users.schemas.js';

export const usersRouter = Router();

usersRouter.get('/me', authenticate, userIdentityRateLimit, me);
usersRouter.patch(
  '/me',
  authenticate,
  userIdentityRateLimit,
  validateRequest(updateOwnProfileRequestValidation),
  updateMe,
);
usersRouter.delete(
  '/me',
  authenticate,
  userIdentityRateLimit,
  validateRequest(accountDeleteRequestValidation),
  deleteAccount,
);
usersRouter.post(
  '/me/devices',
  authenticate,
  userIdentityRateLimit,
  validateRequest(deviceRequestValidation),
  addDevice,
);
usersRouter.get('/me/devices', authenticate, userIdentityRateLimit, devices);
usersRouter.delete(
  '/me/devices/:deviceId',
  authenticate,
  userIdentityRateLimit,
  validateRequest(deviceIdRequestValidation),
  removeDevice,
);
usersRouter.get('/me/sessions', authenticate, userIdentityRateLimit, sessions);
usersRouter.delete(
  '/me/sessions/:sessionId',
  authenticate,
  userIdentityRateLimit,
  validateRequest(sessionIdRequestValidation),
  logoutSession,
);
usersRouter.get(
  '/',
  ...requirePermission('users:read'),
  validateRequest(usersListRequestValidation),
  index,
);
usersRouter.patch(
  '/:id',
  ...requirePermission('users:write'),
  validateRequest(updateUserRequestValidation),
  update,
);
