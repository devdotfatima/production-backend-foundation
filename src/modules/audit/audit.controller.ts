import type { RequestHandler } from 'express';
import { sendSuccess } from '#app/lib/api-response.js';
import { getValidated } from '#app/middleware/request-validation.js';
import { auditListRequestValidation } from '#app/modules/audit/audit.schemas.js';
import { listAuditEvents } from '#app/modules/audit/audit.service.js';

export const index: RequestHandler = async (request, response) => {
  const { query } = getValidated(request, auditListRequestValidation);
  const result = await listAuditEvents(query);
  sendSuccess(request, response, {
    data: result.events,
    meta: { nextCursor: result.nextCursor },
  });
};
