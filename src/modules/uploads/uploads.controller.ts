import type { RequestHandler } from 'express';
import { pipeline } from 'node:stream/promises';
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
    const result = await createUploadDownload(request.auth!.userId, params.uploadId, provider);
    response.setHeader('Cache-Control', 'private, no-store');
    if (result.delivery === 'redirect') {
      response.redirect(307, result.url);
      return;
    }
    response.status(200);
    response.setHeader('Content-Type', result.contentType);
    response.setHeader('Content-Length', String(result.contentLength));
    response.setHeader(
      'Content-Disposition',
      `attachment; filename*=UTF-8''${encodeURIComponent(result.filename)}`,
    );
    await pipeline(result.body, response);
  };

  const remove: RequestHandler = async (request, response) => {
    const { params } = getValidated(request, uploadIdRequestValidation);
    await deleteUpload(request.auth!.userId, params.uploadId, requestMetadata(request), provider);
    sendSuccess(request, response, { message: 'Upload deleted' });
  };

  return { create, complete, index, download, remove };
}
