import type { RequestHandler } from 'express';
import { sendSuccess } from '#app/lib/api-response.js';
import { errors } from '#app/lib/errors.js';
import { requestMetadata } from '#app/lib/request-metadata.js';
import { getValidated } from '#app/middleware/request-validation.js';
import { deviceRequestValidation } from '#app/modules/auth/auth.schemas.js';
import {
  updateUserRequestValidation,
  usersListRequestValidation,
  updateOwnProfileRequestValidation,
  deviceIdRequestValidation,
  sessionIdRequestValidation,
} from '#app/modules/users/users.schemas.js';
import { revokeSession } from '#app/modules/auth/auth.service.js';
import {
  getCurrentUser,
  listDevices,
  listSessions,
  listUsers,
  registerDevice,
  unregisterDevice,
  updateOwnProfile,
  updateUser,
} from '#app/modules/users/users.service.js';

export const me: RequestHandler = async (request, response) => {
  const user = await getCurrentUser(request.auth!.userId);
  if (!user) throw errors.notFound();
  sendSuccess(request, response, { data: user });
};

export const addDevice: RequestHandler = async (request, response) => {
  const { body: input } = getValidated(request, deviceRequestValidation);
  const device = await registerDevice(request.auth!.userId, input);
  sendSuccess(request, response, { status: 201, message: 'Device registered', data: device });
};

export const devices: RequestHandler = async (request, response) => {
  sendSuccess(request, response, { data: await listDevices(request.auth!.userId) });
};

export const removeDevice: RequestHandler = async (request, response) => {
  const { params } = getValidated(request, deviceIdRequestValidation);
  const removed = await unregisterDevice(
    request.auth!.userId,
    params.deviceId,
    requestMetadata(request),
  );
  if (!removed) throw errors.notFound('Device not found');
  sendSuccess(request, response, { message: 'Device unregistered' });
};

export const updateMe: RequestHandler = async (request, response) => {
  const { body: input } = getValidated(request, updateOwnProfileRequestValidation);
  const user = await updateOwnProfile(request.auth!.userId, input, requestMetadata(request));
  if (!user) throw errors.notFound();
  sendSuccess(request, response, { message: 'Profile updated', data: user });
};

export const sessions: RequestHandler = async (request, response) => {
  sendSuccess(request, response, {
    data: await listSessions(request.auth!.userId, request.auth!.sessionId),
  });
};

export const logoutSession: RequestHandler = async (request, response) => {
  const { params } = getValidated(request, sessionIdRequestValidation);
  await revokeSession(params.sessionId, request.auth!.userId, requestMetadata(request));
  sendSuccess(request, response, { message: 'Session revoked' });
};

export const index: RequestHandler = async (request, response) => {
  const { query } = getValidated(request, usersListRequestValidation);
  const result = await listUsers(query);
  sendSuccess(request, response, {
    data: result.users,
    meta: { nextCursor: result.nextCursor },
  });
};

export const update: RequestHandler = async (request, response) => {
  const { params, body: input } = getValidated(request, updateUserRequestValidation);
  const { id } = params;
  const user = await updateUser(id, input, request.auth!.userId, requestMetadata(request));
  sendSuccess(request, response, { message: 'User updated', data: user });
};
