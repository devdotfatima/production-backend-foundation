import type { RequestHandler } from 'express';
import { sendSuccess } from '#app/lib/api-response.js';
import { errors } from '#app/lib/errors.js';
import { requestMetadata } from '#app/lib/request-metadata.js';
import { getValidated } from '#app/middleware/request-validation.js';
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
import {
  createCheckoutSession,
  getCheckoutSession,
  validatePromotionCode,
} from '#app/modules/stripe/stripe.checkout.service.js';
import { createRefund, listPayments } from '#app/modules/stripe/stripe.refunds.service.js';
import {
  cancelSubscription,
  changeSubscriptionPrice,
  createBillingPortalSession,
  listSubscriptions,
  resumeSubscription,
} from '#app/modules/stripe/stripe.subscriptions.service.js';
import { verifyAndStoreStripeEvent } from '#app/modules/stripe/stripe.webhooks.service.js';

export function createStripeController(stripeClient: StripeClient | null) {
  const receive: RequestHandler = async (request, response) => {
    const rawBody: unknown = request.body;
    if (!Buffer.isBuffer(rawBody)) throw errors.badRequest('Expected raw webhook body');
    const signature = request.header('stripe-signature');
    if (!signature) throw errors.badRequest('Missing Stripe-Signature header');
    const result = await verifyAndStoreStripeEvent(rawBody, signature, stripeClient);
    sendSuccess(request, response, {
      message: result.duplicate ? 'Webhook already received' : 'Webhook received',
      data: { received: true, duplicate: result.duplicate },
    });
  };

  const checkout: RequestHandler = async (request, response) => {
    const { body: input, headers } = getValidated(request, checkoutRequestValidation);
    const session = await createCheckoutSession(
      request.auth!.userId,
      input,
      headers['idempotency-key'],
      stripeClient,
    );
    sendSuccess(request, response, {
      status: 201,
      message: 'Checkout session created',
      data: session,
    });
  };

  const checkoutStatus: RequestHandler = async (request, response) => {
    const { params } = getValidated(request, checkoutSessionRequestValidation);
    sendSuccess(request, response, {
      data: await getCheckoutSession(request.auth!.userId, params.sessionId, stripeClient),
    });
  };

  const subscriptions: RequestHandler = async (request, response) => {
    const { query } = getValidated(request, subscriptionListRequestValidation);
    const result = await listSubscriptions(request.auth!.userId, query, stripeClient);
    sendSuccess(request, response, {
      data: result.subscriptions,
      meta: { nextCursor: result.nextCursor },
    });
  };

  const cancel: RequestHandler = async (request, response) => {
    const { params } = getValidated(request, subscriptionIdRequestValidation);
    sendSuccess(request, response, {
      message: 'Subscription cancellation scheduled',
      data: await cancelSubscription(request.auth!.userId, params.subscriptionId, stripeClient),
    });
  };

  const resume: RequestHandler = async (request, response) => {
    const { params } = getValidated(request, subscriptionIdRequestValidation);
    sendSuccess(request, response, {
      message: 'Subscription cancellation removed',
      data: await resumeSubscription(request.auth!.userId, params.subscriptionId, stripeClient),
    });
  };

  const changePlan: RequestHandler = async (request, response) => {
    const { params, body } = getValidated(request, subscriptionChangeRequestValidation);
    sendSuccess(request, response, {
      message: 'Subscription plan changed',
      data: await changeSubscriptionPrice(
        request.auth!.userId,
        params.subscriptionId,
        body,
        stripeClient,
      ),
    });
  };

  const portal: RequestHandler = async (request, response) => {
    const { body } = getValidated(request, billingPortalRequestValidation);
    sendSuccess(request, response, {
      status: 201,
      message: 'Billing portal session created',
      data: await createBillingPortalSession(request.auth!.userId, body.returnUrl, stripeClient),
    });
  };

  const refund: RequestHandler = async (request, response) => {
    const { body: input, headers } = getValidated(request, refundHeadersRequestValidation);
    sendSuccess(request, response, {
      status: 201,
      message: 'Refund created',
      data: await createRefund(
        request.auth!.userId,
        input,
        headers['idempotency-key'],
        requestMetadata(request),
        stripeClient,
      ),
    });
  };

  const promotionCode: RequestHandler = async (request, response) => {
    const { body: input } = getValidated(request, promotionCodeRequestValidation);
    sendSuccess(request, response, {
      data: await validatePromotionCode(request.auth!.userId, input.code, stripeClient),
    });
  };

  const payments: RequestHandler = async (request, response) => {
    const { query } = getValidated(request, paymentListRequestValidation);
    const result = await listPayments(request.auth!.userId, query);
    sendSuccess(request, response, {
      data: result.payments,
      meta: { nextCursor: result.nextCursor },
    });
  };

  return {
    receive,
    checkout,
    checkoutStatus,
    subscriptions,
    cancel,
    resume,
    changePlan,
    portal,
    refund,
    promotionCode,
    payments,
  };
}
