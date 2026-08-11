import { createStripeClient, type StripeClient } from '#app/modules/stripe/stripe.client.js';
import {
  createCheckoutSession,
  getCheckoutSession,
  validatePromotionCode,
} from '#app/modules/stripe/stripe.checkout.service.js';
import {
  cancelAllUserSubscriptions,
  cancelSubscription,
  changeSubscriptionPrice,
  createBillingPortalSession,
  listSubscriptions,
  resumeSubscription,
} from '#app/modules/stripe/stripe.subscriptions.service.js';
import { createRefund, listPayments } from '#app/modules/stripe/stripe.refunds.service.js';
import { createCharge, getCharge } from '#app/modules/stripe/stripe.charges.service.js';
import {
  createSetupIntent,
  detachPaymentMethod,
  listPaymentMethods,
  setDefaultPaymentMethod,
} from '#app/modules/stripe/stripe.payment-methods.service.js';
import {
  processStoredStripeEvent,
  verifyAndStoreStripeEvent,
} from '#app/modules/stripe/stripe.webhooks.service.js';

export const defaultStripeService = {
  createCheckoutSession,
  getCheckoutSession,
  validatePromotionCode,
  cancelAllUserSubscriptions,
  cancelSubscription,
  changeSubscriptionPrice,
  createBillingPortalSession,
  listSubscriptions,
  resumeSubscription,
  createRefund,
  listPayments,
  createCharge,
  getCharge,
  createSetupIntent,
  listPaymentMethods,
  setDefaultPaymentMethod,
  detachPaymentMethod,
  processStoredStripeEvent,
  verifyAndStoreStripeEvent,
};

export type StripeService = typeof defaultStripeService;

export function createStripeService(overrides: Partial<StripeService> = {}): StripeService {
  return { ...defaultStripeService, ...overrides };
}

export { createStripeClient };
export type { StripeClient };
export {
  cancelAllUserSubscriptions,
  cancelSubscription,
  changeSubscriptionPrice,
  createBillingPortalSession,
  createCharge,
  createCheckoutSession,
  createRefund,
  createSetupIntent,
  detachPaymentMethod,
  getCharge,
  getCheckoutSession,
  listPaymentMethods,
  listPayments,
  setDefaultPaymentMethod,
  listSubscriptions,
  processStoredStripeEvent,
  resumeSubscription,
  validatePromotionCode,
  verifyAndStoreStripeEvent,
};
