import { Router, type RequestHandler } from 'express';
import { z } from 'zod';
import { env } from '#app/config/env.js';
import { sendSuccess } from '#app/lib/api-response.js';
import { withAuditedTransaction } from '#app/lib/audited-transaction.js';
import { errors } from '#app/lib/errors.js';
import { requestMetadata } from '#app/lib/request-metadata.js';
import { requirePermission } from '#app/middleware/access-control.js';
import { getValidated, validateRequest } from '#app/middleware/request-validation.js';
import { findScheduledJob } from '#app/scheduler/scheduler.registry.js';
import { enqueueScheduledJob, listJobStates } from '#app/scheduler/scheduler.js';

const jobNameParams = z.object({ name: z.string().trim().min(1).max(100) });
const runJobRequestValidation = { params: jobNameParams } as const;

const index: RequestHandler = async (request, response) => {
  sendSuccess(request, response, { data: await listJobStates() });
};

/** Manual trigger for on-call. Audited, because an out-of-band run is worth being able to explain. */
const run: RequestHandler = async (request, response) => {
  const { params } = getValidated(request, runJobRequestValidation);
  const job = findScheduledJob(params.name);
  if (!job) throw errors.notFound('Scheduled job not found');
  if (!env.SCHEDULER_ENABLED) {
    throw errors.serviceUnavailable('The scheduler worker is disabled');
  }

  const queued = await enqueueScheduledJob(job.name);

  await withAuditedTransaction(async (_tx, audit) => {
    await audit({
      actorUserId: request.auth!.userId,
      action: 'scheduler.job.triggered',
      entityType: 'scheduled_job',
      entityId: job.name,
      metadata: { jobId: queued.jobId },
      ...requestMetadata(request),
    });
  });

  sendSuccess(request, response, {
    status: 202,
    message: 'Scheduled job queued',
    data: queued,
  });
};

export const schedulerRouter = Router();

schedulerRouter.get('/', ...requirePermission('scheduler:read'), index);
schedulerRouter.post(
  '/:name/run',
  ...requirePermission('scheduler:write'),
  validateRequest(runJobRequestValidation),
  run,
);
