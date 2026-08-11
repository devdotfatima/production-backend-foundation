import express, { Router } from 'express';
import { env } from '#app/config/env.js';
import { authenticate, requireOrgPermission } from '#app/middleware/access-control.js';
import { userIdentityRateLimit } from '#app/middleware/rate-limit.js';
import { validateRequest } from '#app/middleware/request-validation.js';
import { createStripeController } from '#app/modules/stripe/stripe.controller.js';
import {
  checkoutRequestValidation,
  billingPortalRequestValidation,
  checkoutSessionRequestValidation,
  createChargeRequestValidation,
  paymentIntentIdRequestValidation,
  paymentMethodIdRequestValidation,
  setupIntentRequestValidation,
  paymentListRequestValidation,
  promotionCodeRequestValidation,
  refundHeadersRequestValidation,
  subscriptionListRequestValidation,
  subscriptionChangeRequestValidation,
  subscriptionIdRequestValidation,
} from '#app/modules/stripe/stripe.schemas.js';
import type { StripeClient } from '#app/modules/stripe/stripe.client.js';
import type { StripeService } from '#app/modules/stripe/stripe.service.js';

export function createStripeRouters(stripeClient: StripeClient | null, service?: StripeService) {
  const controller = createStripeController(stripeClient, service);
  const stripeRouter = Router();
  stripeRouter.post(
    '/',
    express.raw({ type: 'application/json', limit: '1mb' }),
    controller.receive,
  );

  const billingRouter = Router();
  const billingRead =
    env.BILLING_OWNER === 'organization'
      ? requireOrgPermission('billing:read')
      : [authenticate, userIdentityRateLimit];
  const billingWrite =
    env.BILLING_OWNER === 'organization'
      ? requireOrgPermission('billing:write')
      : [authenticate, userIdentityRateLimit];
  billingRouter.post(
    '/checkout/sessions',
    ...billingWrite,
    validateRequest(checkoutRequestValidation),
    controller.checkout,
  );
  billingRouter.post(
    '/subscriptions/:subscriptionId/resume',
    ...billingWrite,
    validateRequest(subscriptionIdRequestValidation),
    controller.resume,
  );
  billingRouter.patch(
    '/subscriptions/:subscriptionId',
    ...billingWrite,
    validateRequest(subscriptionChangeRequestValidation),
    controller.changePlan,
  );
  billingRouter.post(
    '/portal/sessions',
    ...billingWrite,
    validateRequest(billingPortalRequestValidation),
    controller.portal,
  );
  billingRouter.get(
    '/checkout/sessions/:sessionId',
    ...billingRead,
    validateRequest(checkoutSessionRequestValidation),
    controller.checkoutStatus,
  );
  billingRouter.get(
    '/subscriptions',
    ...billingRead,
    validateRequest(subscriptionListRequestValidation),
    controller.subscriptions,
  );
  billingRouter.post(
    '/subscriptions/:subscriptionId/cancel',
    ...billingWrite,
    validateRequest(subscriptionIdRequestValidation),
    controller.cancel,
  );
  billingRouter.get(
    '/payments',
    ...billingRead,
    validateRequest(paymentListRequestValidation),
    controller.payments,
  );
  billingRouter.post(
    '/refunds',
    ...billingWrite,
    validateRequest(refundHeadersRequestValidation),
    controller.refund,
  );
  billingRouter.post(
    '/setup-intents',
    ...billingWrite,
    validateRequest(setupIntentRequestValidation),
    controller.setupIntent,
  );
  billingRouter.get('/payment-methods', ...billingRead, controller.paymentMethods);
  billingRouter.post(
    '/payment-methods/:paymentMethodId/default',
    ...billingWrite,
    validateRequest(paymentMethodIdRequestValidation),
    controller.setDefaultPaymentMethod,
  );
  billingRouter.delete(
    '/payment-methods/:paymentMethodId',
    ...billingWrite,
    validateRequest(paymentMethodIdRequestValidation),
    controller.detachPaymentMethod,
  );
  billingRouter.post(
    '/charges',
    ...billingWrite,
    validateRequest(createChargeRequestValidation),
    controller.charge,
  );
  billingRouter.get(
    '/charges/:paymentIntentId',
    ...billingRead,
    validateRequest(paymentIntentIdRequestValidation),
    controller.chargeStatus,
  );
  billingRouter.post(
    '/promotion-codes/validate',
    ...billingRead,
    validateRequest(promotionCodeRequestValidation),
    controller.promotionCode,
  );

  return { stripeRouter, billingRouter };
}
