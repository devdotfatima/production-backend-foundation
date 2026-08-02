import type { RequestHandler } from 'express';
import { sendSuccess } from '#app/lib/api-response.js';
import { getValidated } from '#app/middleware/request-validation.js';
import {
  apiKeyIdRequestValidation,
  createApiKeyRequestValidation,
  createServiceAccountRequestValidation,
} from '#app/modules/service-accounts/service-accounts.schemas.js';
import {
  createApiKey,
  createServiceAccount,
  revokeApiKey,
} from '#app/modules/service-accounts/service-accounts.service.js';

export const addServiceAccount: RequestHandler = async (request, response) => {
  const { body } = getValidated(request, createServiceAccountRequestValidation);
  sendSuccess(request, response, { status: 201, data: await createServiceAccount(body) });
};
export const addApiKey: RequestHandler = async (request, response) => {
  const { params, body } = getValidated(request, createApiKeyRequestValidation);
  sendSuccess(request, response, {
    status: 201,
    message: 'API key created; the secret is shown once',
    data: await createApiKey(params.serviceAccountId, body),
  });
};
export const removeApiKey: RequestHandler = async (request, response) => {
  const { params } = getValidated(request, apiKeyIdRequestValidation);
  await revokeApiKey(params.serviceAccountId, params.apiKeyId);
  sendSuccess(request, response, { message: 'API key revoked' });
};
