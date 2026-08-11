import type { RequestHandler } from 'express';
import { errors } from '#app/lib/errors.js';
import { sendSuccess } from '#app/lib/api-response.js';
import { processEmailProviderEvent } from '#app/modules/notifications/email-events.service.js';

export const receiveEmailEvent: RequestHandler = async (request, response) => {
  if (!Buffer.isBuffer(request.body)) throw errors.badRequest('Expected raw webhook body');
  const signature = request.header('x-email-signature');
  if (!signature) throw errors.badRequest('Missing X-Email-Signature header');
  await processEmailProviderEvent(request.body, signature);
  sendSuccess(request, response, { message: 'Email event received', data: { received: true } });
};
