import type Stripe from 'stripe';
import { hashMetadata } from '#app/lib/crypto.js';
import { errors } from '#app/lib/errors.js';
import { prisma } from '#app/lib/prisma.js';
import { requireStripe, type StripeClient } from '#app/modules/stripe/stripe.client.js';
import {
  chargeableItemResolver,
  reserveChargeable,
  type ChargeableResolver,
} from '#app/modules/stripe/stripe.chargeable.js';
import {
  billingOwnerKey,
  billingOwnerMetadata,
  billingOwnerWhere,
  ensureCustomer,
  resolveBillingOwner,
  safeRedirectUrl,
} from '#app/modules/stripe/stripe.shared.js';

export interface CreateChargeInput {
  /** Identifies what is being paid for. The amount is resolved from this, never from the body. */
  reference: string;
  /** Save the card for future off-session use. */
  savePaymentMethod?: boolean;
  /** Charge an already-saved card off-session. Omit for an on-session payment. */
  paymentMethodId?: string;
  returnUrl?: string;
}

export interface ChargeResult {
  id: string;
  status: Stripe.PaymentIntent.Status;
  amount: number;
  currency: string;
  /**
   * Set when the bank demanded 3D Secure. The frontend must complete the challenge with this
   * secret. Treating this as a decline is the classic saved-card bug: every SCA-region customer
   * silently fails.
   */
  requiresAction: boolean;
  clientSecret: string | null;
}

function toChargeResult(intent: Stripe.PaymentIntent): ChargeResult {
  return {
    id: intent.id,
    status: intent.status,
    amount: intent.amount,
    currency: intent.currency,
    requiresAction:
      intent.status === 'requires_action' || intent.status === 'requires_confirmation',
    clientSecret: intent.client_secret,
  };
}

async function assertPaymentMethodOwned(userId: string, paymentMethodId: string): Promise<string> {
  const owner = resolveBillingOwner(userId);
  const method = await prisma.paymentMethod.findFirst({
    where: {
      id: paymentMethodId,
      ...billingOwnerWhere(owner),
      detachedAt: null,
      deletedAt: null,
    },
    select: { stripePaymentMethodId: true },
  });
  // Looked up by our own id and constrained to the caller, so a Stripe identifier belonging to
  // another customer can never be charged.
  if (!method) throw errors.notFound('Payment method not found');
  return method.stripePaymentMethodId;
}

export async function createCharge(
  userId: string,
  input: CreateChargeInput,
  businessIdempotencyKey: string,
  stripeClient: StripeClient | null,
  resolver: ChargeableResolver = chargeableItemResolver,
): Promise<ChargeResult> {
  const client = requireStripe(stripeClient);
  const owner = resolveBillingOwner(userId);
  const customerId = await ensureCustomer(userId, stripeClient);
  const savedPaymentMethod = input.paymentMethodId
    ? await assertPaymentMethodOwned(userId, input.paymentMethodId)
    : undefined;
  const reservationKeyHash = hashMetadata(
    `chargeable-reservation:${billingOwnerKey(owner)}:${businessIdempotencyKey}`,
  );
  const chargeable = await reserveChargeable(resolver, input.reference, {
    userId,
    reservationKeyHash,
  });

  const params: Stripe.PaymentIntentCreateParams = {
    amount: chargeable.amount,
    currency: chargeable.currency,
    customer: customerId,
    description: chargeable.description,
    metadata: {
      ...chargeable.metadata,
      ...billingOwnerMetadata(owner),
      reference: input.reference,
      chargeableReservationKeyHash: chargeable.reservationKeyHash,
    },
  };

  if (input.paymentMethodId) {
    params.payment_method = savedPaymentMethod;
    params.confirm = true;
    // The customer is not in the checkout flow, so Stripe must use the stored mandate and may
    // come back with `requires_action` instead of succeeding.
    params.off_session = true;
  } else {
    params.automatic_payment_methods = { enabled: true };
    if (input.returnUrl) params.return_url = safeRedirectUrl(input.returnUrl, '/billing');
  }

  if (input.savePaymentMethod) params.setup_future_usage = 'off_session';

  const downstreamIdempotencyKey = `charge:${billingOwnerKey(owner)}:${hashMetadata(businessIdempotencyKey)}`;
  const persistIntent = async (intent: Stripe.PaymentIntent) => {
    if (!resolver.recordPaymentIntent) {
      throw errors.serviceUnavailable(
        'The configured chargeable resolver cannot record its provider payment',
      );
    }
    await resolver.recordPaymentIntent(chargeable, intent.id, intent.status === 'succeeded');
  };

  try {
    const intent = await client.paymentIntents.create(params, {
      idempotencyKey: downstreamIdempotencyKey,
    });
    await persistIntent(intent);
    return toChargeResult(intent);
  } catch (error) {
    // Stripe raises rather than returns when an off-session charge needs authentication; the
    // intent is still on the error and the frontend needs its secret to recover.
    const stripeError = error as { code?: string; raw?: { payment_intent?: Stripe.PaymentIntent } };
    const intent = stripeError.raw?.payment_intent;
    if (stripeError.code === 'authentication_required' && intent) {
      await persistIntent(intent);
      return { ...toChargeResult(intent), requiresAction: true };
    }
    // An error carrying a PaymentIntent proves Stripe created provider state. Persist its id even
    // for a decline so a retry with the same business key resumes rather than creating a second
    // payment. Errors without an intent leave the item RESERVED for the same idempotent retry.
    if (intent) await persistIntent(intent);
    throw error;
  }
}

export async function getCharge(
  userId: string,
  paymentIntentId: string,
  stripeClient: StripeClient | null,
): Promise<ChargeResult> {
  const client = requireStripe(stripeClient);
  const owner = resolveBillingOwner(userId);
  const customerId = await ensureCustomer(userId, stripeClient);
  const intent = await client.paymentIntents.retrieve(paymentIntentId);
  const intentCustomerId =
    typeof intent.customer === 'string' ? intent.customer : intent.customer?.id;
  const metadataMatches =
    owner.type === 'organization'
      ? intent.metadata?.organizationId === owner.organizationId
      : intent.metadata?.userId === owner.userId && !intent.metadata?.organizationId;
  if (!metadataMatches && intentCustomerId !== customerId) {
    throw errors.notFound('Payment not found');
  }
  return toChargeResult(intent);
}
