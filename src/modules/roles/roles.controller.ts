import type { RequestHandler } from 'express';
import { sendSuccess } from '#app/lib/api-response.js';
import { errors } from '#app/lib/errors.js';
import { requestMetadata } from '#app/lib/request-metadata.js';
import { getValidated } from '#app/middleware/request-validation.js';
import {
  assignRoleRequestValidation,
  createRoleRequestValidation,
  revokeRoleRequestValidation,
  updateRolePermissionsRequestValidation,
} from '#app/modules/roles/roles.schemas.js';
import {
  assignRole,
  createRole,
  listRoles,
  revokeRole,
  updateRolePermissions,
} from '#app/modules/roles/roles.service.js';

export const index: RequestHandler = async (request, response) => {
  sendSuccess(request, response, { data: await listRoles() });
};

export const create: RequestHandler = async (request, response) => {
  const { body: input } = getValidated(request, createRoleRequestValidation);
  const role = await createRole(input, request.auth!.userId, requestMetadata(request));
  sendSuccess(request, response, { status: 201, message: 'Role created', data: role });
};

export const assign: RequestHandler = async (request, response) => {
  const { body: input } = getValidated(request, assignRoleRequestValidation);
  const assignment = await assignRole(input, request.auth!.userId, requestMetadata(request));
  sendSuccess(request, response, {
    status: 201,
    message: 'Role assigned',
    data: assignment,
  });
};

export const revoke: RequestHandler = async (request, response) => {
  const { query: input } = getValidated(request, revokeRoleRequestValidation);
  const revoked = await revokeRole(input, request.auth!.userId, requestMetadata(request));
  if (!revoked) throw errors.notFound('Role assignment not found');
  sendSuccess(request, response, { message: 'Role revoked' });
};

export const updatePermissions: RequestHandler = async (request, response) => {
  const { params, body: input } = getValidated(request, updateRolePermissionsRequestValidation);
  const role = await updateRolePermissions(
    params.id,
    input.permissions,
    request.auth!.userId,
    requestMetadata(request),
  );
  sendSuccess(request, response, { message: 'Role permissions updated', data: role });
};
