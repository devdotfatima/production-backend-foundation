import type { RequestHandler } from 'express';
import { sendSuccess } from '#app/lib/api-response.js';
import { requestMetadata } from '#app/lib/request-metadata.js';
import { getValidated } from '#app/middleware/request-validation.js';
import {
  deadLetterListRequestValidation,
  redriveOutboxRequestValidation,
} from '#app/modules/outbox/outbox.schemas.js';
import {
  listDeadLetterEvents,
  redriveDeadLetterEvent,
} from '#app/modules/outbox/outbox.service.js';

export const indexDeadLetters: RequestHandler = async (request, response) => {
  const { query } = getValidated(request, deadLetterListRequestValidation);
  const result = await listDeadLetterEvents(query);
  sendSuccess(request, response, {
    data: result.events,
    meta: { nextCursor: result.nextCursor },
  });
};

export const redrive: RequestHandler = async (request, response) => {
  const { params } = getValidated(request, redriveOutboxRequestValidation);
  const event = await redriveDeadLetterEvent(
    params.id,
    request.auth!.userId,
    requestMetadata(request),
  );
  sendSuccess(request, response, { message: 'Outbox event queued for redelivery', data: event });
};
