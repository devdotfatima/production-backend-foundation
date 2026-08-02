import { z } from 'zod';

const redirectUrl = z.url().max(2_048);
const priceKey = z
  .string()
  .trim()
  .regex(/^[a-z][a-z0-9_-]{0,63}$/);

export const checkoutSessionSchema = z
  .object({
    mode: z.enum(['payment', 'subscription']).default('payment'),
    priceKey: priceKey.optional(),
    quantity: z.coerce.number().int().min(1).max(100).default(1),
    successUrl: redirectUrl.optional(),
    cancelUrl: redirectUrl.optional(),
    promotionCode: z.string().trim().min(1).max(100).optional(),
  })
  .strict();

export const checkoutIdempotencyHeadersSchema = z.object({
  'idempotency-key': z.string().trim().min(8).max(200),
});

export const billingListQuerySchema = z.object({
  cursor: z.string().trim().min(1).max(255).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(25),
});

export const paymentListQuerySchema = billingListQuerySchema.extend({
  cursor: z.uuid().optional(),
});

export const subscriptionIdParams = z.object({ subscriptionId: z.string().min(1).max(255) });
export const subscriptionChangeSchema = z.object({
  priceKey,
  prorationBehavior: z
    .enum(['always_invoice', 'create_prorations', 'none'])
    .default('create_prorations'),
});
export const billingPortalSchema = z.object({ returnUrl: redirectUrl.optional() });
export const checkoutSessionParams = z.object({ sessionId: z.string().min(1).max(255) });

export const refundSchema = z
  .object({
    paymentIntentId: z.string().min(1).max(255).optional(),
    chargeId: z.string().min(1).max(255).optional(),
    amount: z.coerce.number().int().positive().optional(),
  })
  .refine((value) => Boolean(value.paymentIntentId) !== Boolean(value.chargeId), {
    message: 'Provide exactly one paymentIntentId or chargeId',
  });

export const promotionCodeSchema = z.object({
  code: z.string().trim().min(1).max(100),
});

export const checkoutRequestValidation = {
  body: checkoutSessionSchema,
  headers: checkoutIdempotencyHeadersSchema,
} as const;
export const subscriptionIdRequestValidation = { params: subscriptionIdParams } as const;
export const subscriptionChangeRequestValidation = {
  params: subscriptionIdParams,
  body: subscriptionChangeSchema,
} as const;
export const billingPortalRequestValidation = { body: billingPortalSchema } as const;
export const checkoutSessionRequestValidation = { params: checkoutSessionParams } as const;
export const refundRequestValidation = { body: refundSchema } as const;
export const refundHeadersRequestValidation = {
  body: refundSchema,
  headers: checkoutIdempotencyHeadersSchema,
} as const;
export const subscriptionListRequestValidation = { query: billingListQuerySchema } as const;
export const paymentListRequestValidation = { query: paymentListQuerySchema } as const;
export const promotionCodeRequestValidation = { body: promotionCodeSchema } as const;
