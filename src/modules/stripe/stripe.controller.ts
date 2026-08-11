import type { RequestHandler } from 'express';
import { sendSuccess } from '#app/lib/api-response.js';
import { errors } from '#app/lib/errors.js';
import { idempotencyActorKey, runIdempotent } from '#app/lib/idempotency.js';
import { requestMetadata } from '#app/lib/request-metadata.js';
import { getValidated } from '#app/middleware/request-validation.js';
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
import { createStripeService, type StripeService } from '#app/modules/stripe/stripe.service.js';

export function createStripeController(
  stripeClient: StripeClient | null,
  service: StripeService = createStripeService(),
) {
  const receive: RequestHandler = async (request, response) => {
    const rawBody: unknown = request.body;
    if (!Buffer.isBuffer(rawBody)) throw errors.badRequest('Expected raw webhook body');
    const signature = request.header('stripe-signature');
    if (!signature) throw errors.badRequest('Missing Stripe-Signature header');
    const result = await service.verifyAndStoreStripeEvent(rawBody, signature, stripeClient);
    sendSuccess(request, response, {
      message: result.duplicate ? 'Webhook already received' : 'Webhook received',
      data: { received: true, duplicate: result.duplicate },
    });
  };

  const checkout: RequestHandler = async (request, response) => {
    const { body: input, headers } = getValidated(request, checkoutRequestValidation);
    const result = await runIdempotent({
      actorKey: idempotencyActorKey(request),
      scope: 'stripe.checkout-session.create',
      key: headers['idempotency-key'],
      request: input,
      operation: async () => ({
        statusCode: 201,
        response: await service.createCheckoutSession(
          request.auth!.userId,
          input,
          headers['idempotency-key'],
          stripeClient,
        ),
      }),
    });
    response.setHeader('Idempotency-Replayed', String(result.replayed));
    sendSuccess(request, response, {
      status: result.statusCode,
      message: 'Checkout session created',
      data: result.response,
    });
  };

  const checkoutStatus: RequestHandler = async (request, response) => {
    const { params } = getValidated(request, checkoutSessionRequestValidation);
    sendSuccess(request, response, {
      data: await service.getCheckoutSession(request.auth!.userId, params.sessionId, stripeClient),
    });
  };

  const subscriptions: RequestHandler = async (request, response) => {
    const { query } = getValidated(request, subscriptionListRequestValidation);
    const result = await service.listSubscriptions(request.auth!.userId, query, stripeClient);
    sendSuccess(request, response, {
      data: result.subscriptions,
      meta: { nextCursor: result.nextCursor },
    });
  };

  const cancel: RequestHandler = async (request, response) => {
    const { params, headers } = getValidated(request, subscriptionIdRequestValidation);
    const result = await runIdempotent({
      actorKey: idempotencyActorKey(request),
      scope: 'stripe.subscription.cancel',
      key: headers['idempotency-key'],
      request: params,
      operation: async () => ({
        statusCode: 200,
        response: await service.cancelSubscription(
          request.auth!.userId,
          params.subscriptionId,
          stripeClient,
          headers['idempotency-key'],
        ),
      }),
    });
    response.setHeader('Idempotency-Replayed', String(result.replayed));
    sendSuccess(request, response, {
      message: 'Subscription cancellation scheduled',
      data: result.response,
    });
  };

  const resume: RequestHandler = async (request, response) => {
    const { params, headers } = getValidated(request, subscriptionIdRequestValidation);
    const result = await runIdempotent({
      actorKey: idempotencyActorKey(request),
      scope: 'stripe.subscription.resume',
      key: headers['idempotency-key'],
      request: params,
      operation: async () => ({
        statusCode: 200,
        response: await service.resumeSubscription(
          request.auth!.userId,
          params.subscriptionId,
          stripeClient,
          headers['idempotency-key'],
        ),
      }),
    });
    response.setHeader('Idempotency-Replayed', String(result.replayed));
    sendSuccess(request, response, {
      message: 'Subscription cancellation removed',
      data: result.response,
    });
  };

  const changePlan: RequestHandler = async (request, response) => {
    const { params, body, headers } = getValidated(request, subscriptionChangeRequestValidation);
    const result = await runIdempotent({
      actorKey: idempotencyActorKey(request),
      scope: 'stripe.subscription.change',
      key: headers['idempotency-key'],
      request: { ...params, ...body },
      operation: async () => ({
        statusCode: 200,
        response: await service.changeSubscriptionPrice(
          request.auth!.userId,
          params.subscriptionId,
          body,
          stripeClient,
          headers['idempotency-key'],
        ),
      }),
    });
    response.setHeader('Idempotency-Replayed', String(result.replayed));
    sendSuccess(request, response, {
      message: 'Subscription plan changed',
      data: result.response,
    });
  };

  const portal: RequestHandler = async (request, response) => {
    const { body, headers } = getValidated(request, billingPortalRequestValidation);
    const result = await runIdempotent({
      actorKey: idempotencyActorKey(request),
      scope: 'stripe.billing-portal.create',
      key: headers['idempotency-key'],
      request: body,
      operation: async () => ({
        statusCode: 201,
        response: await service.createBillingPortalSession(
          request.auth!.userId,
          body.returnUrl,
          stripeClient,
          headers['idempotency-key'],
        ),
      }),
    });
    response.setHeader('Idempotency-Replayed', String(result.replayed));
    sendSuccess(request, response, {
      status: 201,
      message: 'Billing portal session created',
      data: result.response,
    });
  };

  const refund: RequestHandler = async (request, response) => {
    const { body: input, headers } = getValidated(request, refundHeadersRequestValidation);
    sendSuccess(request, response, {
      status: 201,
      message: 'Refund created',
      data: await service.createRefund(
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
      data: await service.validatePromotionCode(request.auth!.userId, input.code, stripeClient),
    });
  };

  const payments: RequestHandler = async (request, response) => {
    const { query } = getValidated(request, paymentListRequestValidation);
    const result = await service.listPayments(request.auth!.userId, query);
    sendSuccess(request, response, {
      data: result.payments,
      meta: { nextCursor: result.nextCursor },
    });
  };

  const setupIntent: RequestHandler = async (request, response) => {
    const { headers } = getValidated(request, setupIntentRequestValidation);
    const result = await runIdempotent({
      actorKey: idempotencyActorKey(request),
      scope: 'stripe.setup-intent.create',
      key: headers['idempotency-key'],
      request: {},
      operation: async () => ({
        statusCode: 201,
        response: await service.createSetupIntent(
          request.auth!.userId,
          stripeClient,
          headers['idempotency-key'],
        ),
      }),
    });
    response.setHeader('Idempotency-Replayed', String(result.replayed));
    sendSuccess(request, response, {
      status: 201,
      message: 'Setup intent created',
      data: result.response,
    });
  };

  const paymentMethods: RequestHandler = async (request, response) => {
    sendSuccess(request, response, {
      data: await service.listPaymentMethods(request.auth!.userId),
    });
  };

  const setDefaultPaymentMethod: RequestHandler = async (request, response) => {
    const { params, headers } = getValidated(request, paymentMethodIdRequestValidation);
    const result = await runIdempotent({
      actorKey: idempotencyActorKey(request),
      scope: 'stripe.payment-method.default',
      key: headers['idempotency-key'],
      request: params,
      operation: async () => ({
        statusCode: 200,
        response: await service.setDefaultPaymentMethod(
          request.auth!.userId,
          params.paymentMethodId,
          stripeClient,
          requestMetadata(request),
          headers['idempotency-key'],
        ),
      }),
    });
    response.setHeader('Idempotency-Replayed', String(result.replayed));
    sendSuccess(request, response, {
      message: 'Default payment method updated',
      data: result.response,
    });
  };

  const detachPaymentMethod: RequestHandler = async (request, response) => {
    const { params, headers } = getValidated(request, paymentMethodIdRequestValidation);
    const result = await runIdempotent({
      actorKey: idempotencyActorKey(request),
      scope: 'stripe.payment-method.detach',
      key: headers['idempotency-key'],
      request: params,
      operation: async () => {
        await service.detachPaymentMethod(
          request.auth!.userId,
          params.paymentMethodId,
          stripeClient,
          requestMetadata(request),
          headers['idempotency-key'],
        );
        return { statusCode: 200, response: { detached: true } };
      },
    });
    response.setHeader('Idempotency-Replayed', String(result.replayed));
    sendSuccess(request, response, { message: 'Payment method removed' });
  };

  const charge: RequestHandler = async (request, response) => {
    const { body: input, headers } = getValidated(request, createChargeRequestValidation);
    const result = await runIdempotent({
      actorKey: idempotencyActorKey(request),
      scope: 'stripe.charge.create',
      key: headers['idempotency-key'],
      request: input,
      operation: async () => ({
        statusCode: 201,
        response: await service.createCharge(
          request.auth!.userId,
          input,
          headers['idempotency-key'],
          stripeClient,
        ),
      }),
    });
    response.setHeader('Idempotency-Replayed', String(result.replayed));
    sendSuccess(request, response, {
      status: result.statusCode,
      message: 'Charge created',
      data: result.response,
    });
  };

  const chargeStatus: RequestHandler = async (request, response) => {
    const { params } = getValidated(request, paymentIntentIdRequestValidation);
    sendSuccess(request, response, {
      data: await service.getCharge(request.auth!.userId, params.paymentIntentId, stripeClient),
    });
  };

  return {
    receive,
    checkout,
    checkoutStatus,
    setupIntent,
    paymentMethods,
    setDefaultPaymentMethod,
    detachPaymentMethod,
    charge,
    chargeStatus,
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
