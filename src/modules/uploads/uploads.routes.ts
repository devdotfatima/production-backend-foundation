import { Router } from 'express';
import { authenticate } from '#app/middleware/access-control.js';
import { userIdentityRateLimit } from '#app/middleware/rate-limit.js';
import { validateRequest } from '#app/middleware/request-validation.js';
import { createUploadsController } from '#app/modules/uploads/uploads.controller.js';
import type { UploadProviderAdapter } from '#app/modules/uploads/uploads.provider.js';
import {
  createUploadRequestValidation,
  uploadIdRequestValidation,
  uploadsListRequestValidation,
} from '#app/modules/uploads/uploads.schemas.js';

export function createUploadsRouter(provider: UploadProviderAdapter | null) {
  const router = Router();
  const controller = createUploadsController(provider);

  router.post(
    '/',
    authenticate,
    userIdentityRateLimit,
    validateRequest(createUploadRequestValidation),
    controller.create,
  );
  router.get(
    '/',
    authenticate,
    userIdentityRateLimit,
    validateRequest(uploadsListRequestValidation),
    controller.index,
  );
  router.post(
    '/:uploadId/complete',
    authenticate,
    userIdentityRateLimit,
    validateRequest(uploadIdRequestValidation),
    controller.complete,
  );
  router.get(
    '/:uploadId/download',
    authenticate,
    userIdentityRateLimit,
    validateRequest(uploadIdRequestValidation),
    controller.download,
  );
  router.delete(
    '/:uploadId',
    authenticate,
    userIdentityRateLimit,
    validateRequest(uploadIdRequestValidation),
    controller.remove,
  );
  return router;
}
