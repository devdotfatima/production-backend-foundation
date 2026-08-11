import type Stripe from 'stripe';
import { hashMetadata } from '#app/lib/crypto.js';
import { withAuditedTransaction } from '#app/lib/audited-transaction.js';
import { errors } from '#app/lib/errors.js';
import { prisma } from '#app/lib/prisma.js';
import type { RequestMetadata } from '#app/lib/request-metadata.js';
import { requireStripe, type StripeClient } from '#app/modules/stripe/stripe.client.js';
import {
  billingOwnerKey,
  billingOwnerMetadata,
  billingOwnerWhere,
  ensureCustomer,
  resolveBillingOwner,
} from '#app/modules/stripe/stripe.shared.js';

const paymentMethodSelect = {
  id: true,
  stripePaymentMethodId: true,
  type: true,
  brand: true,
  last4: true,
  expMonth: true,
  expYear: true,
  isDefault: true,
  createdAt: true,
} as const;

/**
 * Starts the save-card flow. The client confirms the returned secret with Stripe Elements, so
 * card data never reaches this server — that is what keeps the deployment in PCI SAQ-A.
 *
 * `usage: 'off_session'` records the mandate that later off-session charges depend on; without
 * it, saved cards work in test mode and then fail for real European customers.
 */
export async function createSetupIntent(
  userId: string,
  stripeClient: StripeClient | null,
  businessIdempotencyKey: string,
) {
  const client = requireStripe(stripeClient);
  const owner = resolveBillingOwner(userId);
  const customerId = await ensureCustomer(userId, stripeClient);

  const setupIntent = await client.setupIntents.create(
    {
      customer: customerId,
      usage: 'off_session',
      metadata: billingOwnerMetadata(owner),
    },
    {
      idempotencyKey: `setup-intent:${billingOwnerKey(owner)}:${hashMetadata(businessIdempotencyKey)}`,
    },
  );

  return {
    id: setupIntent.id,
    clientSecret: setupIntent.client_secret,
    status: setupIntent.status,
  };
}

export async function listPaymentMethods(userId: string) {
  const owner = resolveBillingOwner(userId);
  return prisma.paymentMethod.findMany({
    where: { ...billingOwnerWhere(owner), detachedAt: null, deletedAt: null },
    orderBy: [{ isDefault: 'desc' }, { createdAt: 'desc' }],
    select: paymentMethodSelect,
  });
}

async function findOwnedPaymentMethod(id: string, userId: string) {
  const owner = resolveBillingOwner(userId);
  const method = await prisma.paymentMethod.findFirst({
    where: { id, ...billingOwnerWhere(owner), detachedAt: null, deletedAt: null },
    select: { id: true, stripePaymentMethodId: true },
  });
  if (!method) throw errors.notFound('Payment method not found');
  return method;
}

export async function setDefaultPaymentMethod(
  userId: string,
  paymentMethodId: string,
  stripeClient: StripeClient | null,
  metadata: RequestMetadata,
  businessIdempotencyKey: string,
) {
  const client = requireStripe(stripeClient);
  const owner = resolveBillingOwner(userId);
  const method = await findOwnedPaymentMethod(paymentMethodId, userId);
  const customerId = await ensureCustomer(userId, stripeClient);

  await client.customers.update(
    customerId,
    { invoice_settings: { default_payment_method: method.stripePaymentMethodId } },
    {
      idempotencyKey: `payment-method-default:${billingOwnerKey(owner)}:${hashMetadata(businessIdempotencyKey)}`,
    },
  );

  return withAuditedTransaction(async (tx, audit) => {
    await tx.paymentMethod.updateMany({
      where: { ...billingOwnerWhere(owner), isDefault: true, deletedAt: null },
      data: { isDefault: false },
    });
    await tx.paymentMethod.update({
      where: { id: method.id, ...billingOwnerWhere(owner) },
      data: { isDefault: true },
    });
    await audit({
      actorUserId: userId,
      action: 'billing.payment_method.default_changed',
      entityType: 'payment_method',
      entityId: method.id,
      ...metadata,
    });
    return tx.paymentMethod.findFirstOrThrow({
      where: { id: method.id, ...billingOwnerWhere(owner) },
      select: paymentMethodSelect,
    });
  });
}

export async function detachPaymentMethod(
  userId: string,
  paymentMethodId: string,
  stripeClient: StripeClient | null,
  metadata: RequestMetadata,
  businessIdempotencyKey: string,
): Promise<void> {
  const client = requireStripe(stripeClient);
  const owner = resolveBillingOwner(userId);
  const method = await findOwnedPaymentMethod(paymentMethodId, userId);

  // Detaching the card behind a live subscription makes the next renewal fail silently, which
  // surfaces as involuntary churn rather than as an error anyone sees.
  const activeSubscriptions = await prisma.stripeSubscription.count({
    where: {
      ...billingOwnerWhere(owner),
      deletedAt: null,
      status: { in: ['active', 'trialing', 'past_due'] },
    },
  });
  const remaining = await prisma.paymentMethod.count({
    where: { ...billingOwnerWhere(owner), detachedAt: null, deletedAt: null },
  });
  if (activeSubscriptions > 0 && remaining <= 1) {
    throw errors.conflict(
      'Add another payment method before removing the last one while a subscription is active',
    );
  }

  await client.paymentMethods.detach(
    method.stripePaymentMethodId,
    {},
    {
      idempotencyKey: `payment-method-detach:${billingOwnerKey(owner)}:${hashMetadata(businessIdempotencyKey)}`,
    },
  );

  await withAuditedTransaction(async (tx, audit) => {
    await tx.paymentMethod.update({
      where: { id: method.id, ...billingOwnerWhere(owner) },
      data: { detachedAt: new Date(), deletedAt: new Date(), isDefault: false },
    });
    await audit({
      actorUserId: userId,
      action: 'billing.payment_method.detached',
      entityType: 'payment_method',
      entityId: method.id,
      ...metadata,
    });
  });
}

function cardDetails(paymentMethod: Stripe.PaymentMethod) {
  const card = paymentMethod.card;
  return {
    type: paymentMethod.type,
    brand: card?.brand ?? null,
    last4: card?.last4 ?? null,
    expMonth: card?.exp_month ?? null,
    expYear: card?.exp_year ?? null,
    fingerprint: card?.fingerprint ?? null,
  };
}

/**
 * Records a card from the `payment_method.attached` webhook.
 *
 * Deliberately webhook-driven: accepting a client-supplied payment-method id would let a caller
 * attach an identifier belonging to somebody else's customer.
 */
export async function recordAttachedPaymentMethod(
  paymentMethod: Stripe.PaymentMethod,
  ownerUserId: string,
  organizationId: string | null,
): Promise<void> {
  const details = cardDetails(paymentMethod);
  await prisma.paymentMethod.upsert({
    where: { stripePaymentMethodId: paymentMethod.id },
    create: {
      stripePaymentMethodId: paymentMethod.id,
      userId: ownerUserId,
      organizationId,
      ...details,
    },
    update: { ...details, detachedAt: null, deletedAt: null },
  });
}

export async function recordDetachedPaymentMethod(stripePaymentMethodId: string): Promise<void> {
  await prisma.paymentMethod.updateMany({
    where: { stripePaymentMethodId, detachedAt: null },
    data: { detachedAt: new Date(), deletedAt: new Date(), isDefault: false },
  });
}
