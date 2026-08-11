import type { Request, RequestHandler } from 'express';
import { sendSuccess } from '#app/lib/api-response.js';
import { errors } from '#app/lib/errors.js';
import { requestMetadata } from '#app/lib/request-metadata.js';
import { getValidated } from '#app/middleware/request-validation.js';
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
import {
  acceptInvitation,
  changeMemberRole,
  createInvitation,
  createOrganization,
  getOrganization,
  listMembers,
  listMyOrganizations,
  removeMember,
  revokeInvitation,
  switchOrganization,
  updateOrganization,
} from '#app/modules/organizations/organizations.service.js';

/**
 * Closes the obvious IDOR: a permission guard proves what the caller may do *in their active
 * organization*, not that the path parameter refers to it. Acting on another organization
 * requires switching into it first, which in turn requires an active membership.
 */
function assertOrganizationScope(request: Request, organizationId: string): void {
  if (request.organizationId !== organizationId) {
    throw errors.forbidden('Switch to this organization before managing it');
  }
}

export const index: RequestHandler = async (request, response) => {
  sendSuccess(request, response, { data: await listMyOrganizations(request.auth!.userId) });
};

export const create: RequestHandler = async (request, response) => {
  const { body: input } = getValidated(request, createOrganizationRequestValidation);
  const organization = await createOrganization(
    input,
    request.auth!.userId,
    requestMetadata(request),
  );
  sendSuccess(request, response, {
    status: 201,
    message: 'Organization created',
    data: organization,
  });
};

export const show: RequestHandler = async (request, response) => {
  const { params } = getValidated(request, organizationIdRequestValidation);
  assertOrganizationScope(request, params.organizationId);
  sendSuccess(request, response, { data: await getOrganization(params.organizationId) });
};

export const update: RequestHandler = async (request, response) => {
  const { params, body: input } = getValidated(request, updateOrganizationRequestValidation);
  assertOrganizationScope(request, params.organizationId);
  const organization = await updateOrganization(
    params.organizationId,
    input,
    request.auth!.userId,
    requestMetadata(request),
  );
  sendSuccess(request, response, { message: 'Organization updated', data: organization });
};

export const switchTo: RequestHandler = async (request, response) => {
  const { params } = getValidated(request, organizationIdRequestValidation);
  const organization = await switchOrganization(
    request.auth!.userId,
    request.auth!.sessionId,
    params.organizationId,
    requestMetadata(request),
  );
  sendSuccess(request, response, { message: 'Active organization changed', data: organization });
};

export const members: RequestHandler = async (request, response) => {
  const { params, query } = getValidated(request, listMembersRequestValidation);
  assertOrganizationScope(request, params.organizationId);
  sendSuccess(request, response, { data: await listMembers(params.organizationId, query) });
};

export const changeRole: RequestHandler = async (request, response) => {
  const { params, body: input } = getValidated(request, changeMemberRoleRequestValidation);
  assertOrganizationScope(request, params.organizationId);
  const membership = await changeMemberRole(
    params.organizationId,
    params.userId,
    input.roleId,
    request.auth!.userId,
    requestMetadata(request),
  );
  sendSuccess(request, response, { message: 'Member role updated', data: membership });
};

export const removeMemberHandler: RequestHandler = async (request, response) => {
  const { params } = getValidated(request, removeMemberRequestValidation);
  assertOrganizationScope(request, params.organizationId);
  await removeMember(
    params.organizationId,
    params.userId,
    request.auth!.userId,
    requestMetadata(request),
  );
  sendSuccess(request, response, { message: 'Member removed' });
};

export const invite: RequestHandler = async (request, response) => {
  const { params, body: input } = getValidated(request, createInvitationRequestValidation);
  assertOrganizationScope(request, params.organizationId);
  const invitation = await createInvitation(
    params.organizationId,
    input,
    request.auth!.userId,
    requestMetadata(request),
  );
  sendSuccess(request, response, {
    status: 201,
    message: 'Invitation created',
    data: invitation,
  });
};

export const revokeInvite: RequestHandler = async (request, response) => {
  const { params } = getValidated(request, revokeInvitationRequestValidation);
  assertOrganizationScope(request, params.organizationId);
  await revokeInvitation(
    params.organizationId,
    params.invitationId,
    request.auth!.userId,
    requestMetadata(request),
  );
  sendSuccess(request, response, { message: 'Invitation revoked' });
};

export const accept: RequestHandler = async (request, response) => {
  const { body: input } = getValidated(request, acceptInvitationRequestValidation);
  const organization = await acceptInvitation(
    input.token,
    request.auth!.userId,
    requestMetadata(request),
  );
  sendSuccess(request, response, { message: 'Invitation accepted', data: organization });
};
