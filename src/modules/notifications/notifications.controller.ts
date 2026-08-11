import type { RequestHandler } from 'express';
import { getValidated } from '#app/middleware/request-validation.js';
import { sendSuccess } from '#app/lib/api-response.js';
import { previewRequestValidation } from '#app/modules/notifications/notifications.schemas.js';
import {
  emailTemplates,
  listEmailTemplateKeys,
  renderEmailTemplate,
  type EmailTemplateKey,
} from '#app/modules/notifications/templates/index.js';
import {
  listNotificationPreferences,
  setNotificationPreference,
} from '#app/modules/notifications/notification-preferences.service.js';
import {
  unsubscribeRequestValidation,
  updatePreferenceRequestValidation,
} from '#app/modules/notifications/notifications.schemas.js';
import { unsubscribeWithToken } from '#app/modules/notifications/unsubscribe.js';
import { errors } from '#app/lib/errors.js';

/** Dev-only tooling (see app.ts): never mounted when NODE_ENV=production. */
export const listTemplates: RequestHandler = (request, response) => {
  sendSuccess(request, response, { data: listEmailTemplateKeys() });
};

export const previewTemplate: RequestHandler = (request, response) => {
  const { params, query } = getValidated(request, previewRequestValidation);
  const key = params.key as EmailTemplateKey;
  const rendered = renderEmailTemplate(key, emailTemplates[key].example, query.locale);

  if (query.format === 'text') {
    response.type('text/plain').send(`Subject: ${rendered.subject}\n\n${rendered.text}`);
    return;
  }
  response.type('text/html').send(rendered.html);
};

export const preferences: RequestHandler = async (request, response) => {
  sendSuccess(request, response, {
    data: await listNotificationPreferences(request.auth!.userId),
  });
};

export const updatePreference: RequestHandler = async (request, response) => {
  const { body } = getValidated(request, updatePreferenceRequestValidation);
  sendSuccess(request, response, {
    message: 'Notification preference updated',
    data: await setNotificationPreference(request.auth!.userId, body),
  });
};

export const unsubscribe: RequestHandler = async (request, response) => {
  const { query } = getValidated(request, unsubscribeRequestValidation);
  if (!(await unsubscribeWithToken(query.token))) {
    throw errors.badRequest('Unsubscribe link is invalid or expired');
  }
  sendSuccess(request, response, { message: 'Unsubscribed' });
};
