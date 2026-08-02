import type { RequestHandler } from 'express';
import { sendSuccess } from '#app/lib/api-response.js';
import { getValidated } from '#app/middleware/request-validation.js';
import {
  createWebhookEndpointRequestValidation,
  webhookEndpointIdRequestValidation,
} from '#app/modules/customer-webhooks/customer-webhooks.schemas.js';
import {
  createWebhookEndpoint,
  deleteWebhookEndpoint,
  listWebhookEndpoints,
} from '#app/modules/customer-webhooks/customer-webhooks.service.js';

export const index: RequestHandler = async (request, response) => {
  sendSuccess(request, response, { data: await listWebhookEndpoints(request.auth!.userId) });
};
export const create: RequestHandler = async (request, response) => {
  const { body } = getValidated(request, createWebhookEndpointRequestValidation);
  sendSuccess(request, response, {
    status: 201,
    message: 'Webhook endpoint created; signing secret is shown once',
    data: await createWebhookEndpoint(request.auth!.userId, body),
  });
};
export const remove: RequestHandler = async (request, response) => {
  const { params } = getValidated(request, webhookEndpointIdRequestValidation);
  await deleteWebhookEndpoint(request.auth!.userId, params.endpointId);
  sendSuccess(request, response, { message: 'Webhook endpoint deleted' });
};
