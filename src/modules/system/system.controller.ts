import type { RequestHandler } from 'express';
import { sendSuccess } from '#app/lib/api-response.js';
import { checkReadiness } from '#app/modules/system/system.service.js';

export const health: RequestHandler = (request, response) => {
  sendSuccess(request, response, { message: 'Service is healthy', data: { status: 'ok' } });
};

export const readiness: RequestHandler = async (request, response) => {
  await checkReadiness();
  sendSuccess(request, response, { message: 'Service is ready', data: { status: 'ready' } });
};
