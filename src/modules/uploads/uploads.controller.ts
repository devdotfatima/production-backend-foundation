import type { RequestHandler } from 'express';
import { sendSuccess } from '#app/lib/api-response.js';
import { requestMetadata } from '#app/lib/request-metadata.js';
import { getValidated } from '#app/middleware/request-validation.js';
import {
  createUploadRequestValidation,
  uploadIdRequestValidation,
  uploadsListRequestValidation,
} from '#app/modules/uploads/uploads.schemas.js';
import {
  completeUpload,
  createUploadDownload,
  deleteUpload,
  initiateUpload,
  listUploads,
} from '#app/modules/uploads/uploads.service.js';
import type { UploadProviderAdapter } from '#app/modules/uploads/uploads.provider.js';

export function createUploadsController(provider: UploadProviderAdapter | null) {
  const create: RequestHandler = async (request, response) => {
    const { body } = getValidated(request, createUploadRequestValidation);
    const result = await initiateUpload(request.auth!.userId, body, provider);
    sendSuccess(request, response, {
      status: 201,
      message: 'Upload initialized',
      data: result,
    });
  };

  const complete: RequestHandler = async (request, response) => {
    const { params } = getValidated(request, uploadIdRequestValidation);
    sendSuccess(request, response, {
      message: 'Upload completed',
      data: await completeUpload(
        request.auth!.userId,
        params.uploadId,
        requestMetadata(request),
        provider,
      ),
    });
  };

  const index: RequestHandler = async (request, response) => {
    const { query } = getValidated(request, uploadsListRequestValidation);
    const result = await listUploads(request.auth!.userId, query);
    sendSuccess(request, response, {
      data: result.uploads,
      meta: { nextCursor: result.nextCursor },
    });
  };

  const download: RequestHandler = async (request, response) => {
    const { params } = getValidated(request, uploadIdRequestValidation);
    sendSuccess(request, response, {
      data: await createUploadDownload(request.auth!.userId, params.uploadId, provider),
    });
  };

  const remove: RequestHandler = async (request, response) => {
    const { params } = getValidated(request, uploadIdRequestValidation);
    await deleteUpload(request.auth!.userId, params.uploadId, requestMetadata(request), provider);
    sendSuccess(request, response, { message: 'Upload deleted' });
  };

  return { create, complete, index, download, remove };
}
