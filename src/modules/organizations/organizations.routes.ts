import { Router } from 'express';
import { authenticate, requireOrgPermission } from '#app/middleware/access-control.js';
import { userIdentityRateLimit } from '#app/middleware/rate-limit.js';
import { validateRequest } from '#app/middleware/request-validation.js';
import {
  accept,
  changeRole,
  create,
  index,
  invite,
  members,
  removeMemberHandler,
  revokeInvite,
  show,
  switchTo,
  update,
} from '#app/modules/organizations/organizations.controller.js';
import {
  acceptInvitationRequestValidation,
  changeMemberRoleRequestValidation,
  createInvitationRequestValidation,
  createOrganizationRequestValidation,
  listMembersRequestValidation,
  organizationIdRequestValidation,
  removeMemberRequestValidation,
  revokeInvitationRequestValidation,
  updateOrganizationRequestValidation,
} from '#app/modules/organizations/organizations.schemas.js';

export const organizationsRouter = Router();

// Membership-scoped rather than permission-scoped: these are how a user discovers and enters an
// organization, so they cannot require a permission that is only resolvable once inside one.
organizationsRouter.get('/', authenticate, userIdentityRateLimit, index);
organizationsRouter.post(
  '/',
  authenticate,
  userIdentityRateLimit,
  validateRequest(createOrganizationRequestValidation),
  create,
);
organizationsRouter.post(
  '/:organizationId/switch',
  authenticate,
  userIdentityRateLimit,
  validateRequest(organizationIdRequestValidation),
  switchTo,
);
organizationsRouter.post(
  '/invitations/accept',
  authenticate,
  userIdentityRateLimit,
  validateRequest(acceptInvitationRequestValidation),
  accept,
);

// Everything below acts on an existing tenant, so a platform-wide grant must not be sufficient:
// the caller has to hold the permission through membership in the organization they switched to.
organizationsRouter.get(
  '/:organizationId',
  ...requireOrgPermission('organizations:read'),
  validateRequest(organizationIdRequestValidation),
  show,
);
organizationsRouter.patch(
  '/:organizationId',
  ...requireOrgPermission('organizations:write'),
  validateRequest(updateOrganizationRequestValidation),
  update,
);
organizationsRouter.get(
  '/:organizationId/members',
  ...requireOrgPermission('members:read'),
  validateRequest(listMembersRequestValidation),
  members,
);
organizationsRouter.patch(
  '/:organizationId/members/:userId',
  ...requireOrgPermission('members:write'),
  validateRequest(changeMemberRoleRequestValidation),
  changeRole,
);
organizationsRouter.delete(
  '/:organizationId/members/:userId',
  ...requireOrgPermission('members:write'),
  validateRequest(removeMemberRequestValidation),
  removeMemberHandler,
);
organizationsRouter.post(
  '/:organizationId/invitations',
  ...requireOrgPermission('invitations:write'),
  validateRequest(createInvitationRequestValidation),
  invite,
);
organizationsRouter.delete(
  '/:organizationId/invitations/:invitationId',
  ...requireOrgPermission('invitations:write'),
  validateRequest(revokeInvitationRequestValidation),
  revokeInvite,
);
