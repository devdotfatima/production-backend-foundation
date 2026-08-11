import type Stripe from 'stripe';
import { hashMetadata } from '#app/lib/crypto.js';
import { errors } from '#app/lib/errors.js';
import { requireStripe, type StripeClient } from '#app/modules/stripe/stripe.client.js';
import {
  ensureCustomer,
  billingOwnerKey,
  billingOwnerMetadata,
  getBillingCustomerId,
  getBillingUser,
  resolveBillingOwner,
  resolvePrice,
  safeRedirectUrl,
} from '#app/modules/stripe/stripe.shared.js';

async function findPromotionCode(
  code: string,
  stripeClient: StripeClient | null,
): Promise<Stripe.PromotionCode> {
  const client = requireStripe(stripeClient);
  const result = await client.promotionCodes.list({ code, active: true, limit: 1 });
  const promotion = result.data[0];
  if (!promotion) throw errors.badRequest('Invalid or inactive promotion code');
  return promotion;
}

export async function createCheckoutSession(
  userId: string,
  input: {
    mode: 'payment' | 'subscription';
    priceKey?: string;
    quantity: number;
    successUrl?: string;
    cancelUrl?: string;
    promotionCode?: string;
  },
  businessIdempotencyKey: string,
  stripeClient: StripeClient | null,
) {
  const client = requireStripe(stripeClient);
  const owner = resolveBillingOwner(userId);
  const customerId = await ensureCustomer(userId, stripeClient);
  const { priceId, priceKey } = resolvePrice(input.priceKey);
  const params: Stripe.Checkout.SessionCreateParams = {
    mode: input.mode,
    customer: customerId,
    line_items: [{ price: priceId, quantity: input.quantity }],
    success_url: safeRedirectUrl(input.successUrl, '/billing/success'),
    cancel_url: safeRedirectUrl(input.cancelUrl, '/billing/cancel'),
    metadata: { ...billingOwnerMetadata(owner), priceKey },
  };

  if (input.promotionCode) {
    const promotion = await findPromotionCode(input.promotionCode, stripeClient);
    params.discounts = [{ promotion_code: promotion.id }];
  } else {
    params.allow_promotion_codes = true;
  }
  if (input.mode === 'payment') {
    params.payment_intent_data = { metadata: billingOwnerMetadata(owner) };
  } else {
    params.subscription_data = { metadata: billingOwnerMetadata(owner) };
  }

  const session = await client.checkout.sessions.create(params, {
    idempotencyKey: `checkout:${billingOwnerKey(owner)}:${hashMetadata(businessIdempotencyKey)}`,
  });
  return {
    id: session.id,
    url: session.url,
    mode: session.mode,
    paymentStatus: session.payment_status,
  };
}

export async function getCheckoutSession(
  userId: string,
  sessionId: string,
  stripeClient: StripeClient | null,
) {
  const client = requireStripe(stripeClient);
  const ownerCustomerId = await getBillingCustomerId(userId);
  const session = await client.checkout.sessions.retrieve(sessionId, {
    expand: ['line_items.data.price', 'payment_intent', 'subscription'],
  });
  const metadataUserId = session.metadata?.userId;
  const customerId = typeof session.customer === 'string' ? session.customer : session.customer?.id;
  // Comparing against the resolved owner's customer keeps organization-paid sessions visible to
  // every member, without widening access when the user owns billing.
  if (metadataUserId !== userId && (!ownerCustomerId || customerId !== ownerCustomerId)) {
    throw errors.notFound('Checkout session not found');
  }
  return {
    id: session.id,
    status: session.status,
    paymentStatus: session.payment_status,
    mode: session.mode,
    amountTotal: session.amount_total,
    currency: session.currency,
    url: session.url,
  };
}

export async function validatePromotionCode(
  userId: string,
  code: string,
  stripeClient: StripeClient | null,
) {
  await getBillingUser(userId);
  const client = requireStripe(stripeClient);
  const promotion = await findPromotionCode(code, stripeClient);
  const couponReference = promotion.promotion.coupon;
  const coupon =
    typeof couponReference === 'string'
      ? await client.coupons.retrieve(couponReference)
      : couponReference;
  const couponData = coupon && 'deleted' in coupon && coupon.deleted ? null : coupon;
  return {
    id: promotion.id,
    code: promotion.code,
    active: promotion.active,
    expiresAt: promotion.expires_at ? new Date(promotion.expires_at * 1_000) : null,
    percentOff: couponData?.percent_off ?? null,
    amountOff: couponData?.amount_off ?? null,
    currency: couponData?.currency ?? null,
  };
}
