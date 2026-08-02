import { z } from 'zod';

export const webhookEndpointSchema = z.object({
  url: z.url().max(2_048),
  description: z.string().trim().max(200).optional(),
  events: z
    .array(z.string().regex(/^[a-z][a-z0-9_.-]{1,99}$/))
    .min(1)
    .max(100),
});
export const webhookEndpointIdParams = z.object({ endpointId: z.uuid() });
export const createWebhookEndpointRequestValidation = { body: webhookEndpointSchema } as const;
export const webhookEndpointIdRequestValidation = { params: webhookEndpointIdParams } as const;
