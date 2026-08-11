import { z } from 'zod';
import { emailTemplates } from '#app/modules/notifications/templates/index.js';
import { notificationTopics } from '#app/modules/notifications/notification-preferences.service.js';

const templateKeys = Object.keys(emailTemplates) as [string, ...string[]];

export const templateKeyParams = z.object({ key: z.enum(templateKeys) });
export const previewQuery = z.object({
  locale: z.string().min(2).max(10).optional(),
  format: z.enum(['html', 'text']).optional(),
});

export const previewRequestValidation = {
  params: templateKeyParams,
  query: previewQuery,
} as const;

export const updatePreferenceRequestValidation = {
  body: z.object({
    channel: z.literal('EMAIL'),
    topic: z.enum(notificationTopics),
    enabled: z.boolean(),
  }),
} as const;

export const unsubscribeRequestValidation = {
  query: z.object({ token: z.string().min(20).max(2_000) }),
} as const;
