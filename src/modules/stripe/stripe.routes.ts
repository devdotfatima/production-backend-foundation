import express, { Router } from 'express';
import { authenticate } from '#app/middleware/access-control.js';
import { validateRequest } from '#app/middleware/request-validation.js';
import { createStripeController } from '#app/modules/stripe/stripe.controller.js';
import {
  checkoutRequestValidation,
  billingPortalRequestValidation,
  checkoutSessionRequestValidation,
  paymentListRequestValidation,
  promotionCodeRequestValidation,
  refundHeadersRequestValidation,
  subscriptionListRequestValidation,
  subscriptionChangeRequestValidation,
  subscriptionIdRequestValidation,
} from '#app/modules/stripe/stripe.schemas.js';
import type { StripeClient } from '#app/modules/stripe/stripe.client.js';

export function createStripeRouters(stripeClient: StripeClient | null) {
  const controller = createStripeController(stripeClient);
  const stripeRouter = Router();
  stripeRouter.post(
    '/',
    express.raw({ type: 'application/json', limit: '1mb' }),
    controller.receive,
  );

  const billingRouter = Router();
  billingRouter.post(
    '/checkout/sessions',
    authenticate,
    validateRequest(checkoutRequestValidation),
    controller.checkout,
  );
  billingRouter.post(
    '/subscriptions/:subscriptionId/resume',
    authenticate,
    validateRequest(subscriptionIdRequestValidation),
    controller.resume,
  );
  billingRouter.patch(
    '/subscriptions/:subscriptionId',
    authenticate,
    validateRequest(subscriptionChangeRequestValidation),
    controller.changePlan,
  );
  billingRouter.post(
    '/portal/sessions',
    authenticate,
    validateRequest(billingPortalRequestValidation),
    controller.portal,
  );
  billingRouter.get(
    '/checkout/sessions/:sessionId',
    authenticate,
    validateRequest(checkoutSessionRequestValidation),
    controller.checkoutStatus,
  );
  billingRouter.get(
    '/subscriptions',
    authenticate,
    validateRequest(subscriptionListRequestValidation),
    controller.subscriptions,
  );
  billingRouter.post(
    '/subscriptions/:subscriptionId/cancel',
    authenticate,
    validateRequest(subscriptionIdRequestValidation),
    controller.cancel,
  );
  billingRouter.get(
    '/payments',
    authenticate,
    validateRequest(paymentListRequestValidation),
    controller.payments,
  );
  billingRouter.post(
    '/refunds',
    authenticate,
    validateRequest(refundHeadersRequestValidation),
    controller.refund,
  );
  billingRouter.post(
    '/promotion-codes/validate',
    authenticate,
    validateRequest(promotionCodeRequestValidation),
    controller.promotionCode,
  );

  return { stripeRouter, billingRouter };
}
