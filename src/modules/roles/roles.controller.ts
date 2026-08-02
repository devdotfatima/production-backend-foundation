import type { RequestHandler } from 'express';
import { sendSuccess } from '#app/lib/api-response.js';
import { requestMetadata } from '#app/lib/request-metadata.js';
import { getValidated } from '#app/middleware/request-validation.js';
import {
  assignRoleRequestValidation,
  createRoleRequestValidation,
} from '#app/modules/roles/roles.schemas.js';
import { assignRole, createRole, listRoles } from '#app/modules/roles/roles.service.js';

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
