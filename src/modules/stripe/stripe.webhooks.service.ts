import { Prisma } from '@prisma/client';
import type Stripe from 'stripe';
import { env } from '#app/config/env.js';
import { errors } from '#app/lib/errors.js';
import { prisma } from '#app/lib/prisma.js';
import { addOutboxEvent } from '#app/modules/outbox/outbox.service.js';
import { createStripeClient, type StripeClient } from '#app/modules/stripe/stripe.client.js';

export async function verifyAndStoreStripeEvent(
  rawBody: Buffer,
  signature: string,
  stripeClient: StripeClient | null,
): Promise<{ duplicate: boolean }> {
  if (!stripeClient || !env.STRIPE_WEBHOOK_SECRET) {
    throw new Error('Stripe webhook configuration is unavailable');
  }

  let event: Stripe.Event;
  try {
    event = stripeClient.webhooks.constructEvent(rawBody, signature, env.STRIPE_WEBHOOK_SECRET);
  } catch {
    throw errors.badRequest('Invalid Stripe webhook signature');
  }

  try {
    await prisma.$transaction(async (tx) => {
      const stored = await tx.stripeWebhookEvent.create({
        data: {
          stripeEventId: event.id,
          stripeCreatedAt: new Date(event.created * 1_000),
          type: event.type,
          apiVersion: event.api_version,
          livemode: event.livemode,
          payload: JSON.parse(rawBody.toString('utf8')) as Prisma.InputJsonValue,
        },
      });
      await addOutboxEvent(tx, {
        aggregateType: 'stripe_webhook_event',
        aggregateId: stored.id,
        eventType: 'stripe.event_received',
        channel: 'INTERNAL',
        payload: { stripeWebhookEventId: stored.id, type: event.type },
        dedupeKey: `stripe:${event.id}`,
      });
    });
    return { duplicate: false };
  } catch (error) {
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
      return { duplicate: true };
    }
    throw error;
  }
}

function objectFromEvent(payload: unknown): Record<string, unknown> | null {
  if (!payload || typeof payload !== 'object') return null;
  const data = (payload as { data?: unknown }).data;
  if (!data || typeof data !== 'object') return null;
  const object = (data as { object?: unknown }).object;
  return object && typeof object === 'object' ? (object as Record<string, unknown>) : null;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function numberValue(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function dateFromUnix(value: unknown): Date | undefined {
  const number = numberValue(value);
  return number === undefined ? undefined : new Date(number * 1_000);
}

function nestedString(value: unknown, key: string): string | undefined {
  if (!value || typeof value !== 'object') return undefined;
  return stringValue((value as Record<string, unknown>)[key]);
}

function referenceId(value: unknown): string | undefined {
  return stringValue(value) ?? nestedString(value, 'id');
}

interface StripeProjectionCursor {
  eventId: string;
  createdAt: Date;
  authoritative?: boolean;
}

interface StripeAttribution {
  userId: string;
  organizationId: string | null;
}

async function attributionForStripeObject(
  tx: Prisma.TransactionClient,
  object: Record<string, unknown>,
): Promise<StripeAttribution | undefined> {
  const metadata = object.metadata;
  const values =
    metadata && typeof metadata === 'object' ? (metadata as Record<string, unknown>) : {};
  const metadataUserId = stringValue(values.userId) ?? stringValue(values.actorUserId);
  const metadataOrganizationId = stringValue(values.organizationId);
  if (metadataUserId) {
    return { userId: metadataUserId, organizationId: metadataOrganizationId ?? null };
  }
  const customerId = referenceId(object.customer);
  if (!customerId) return undefined;
  const organization = await tx.organization.findUnique({
    where: { stripeCustomerId: customerId },
    select: {
      id: true,
      memberships: {
        where: { status: 'ACTIVE', deletedAt: null },
        orderBy: { createdAt: 'asc' },
        take: 1,
        select: { userId: true },
      },
    },
  });
  const organizationActor = organization?.memberships[0]?.userId;
  if (organization && organizationActor) {
    return { userId: organizationActor, organizationId: organization.id };
  }
  const user = await tx.user.findUnique({
    where: { stripeCustomerId: customerId },
    select: { id: true },
  });
  return user ? { userId: user.id, organizationId: null } : undefined;
}

async function upsertPayment(
  tx: Prisma.TransactionClient,
  attribution: StripeAttribution,
  input: {
    paymentIntentId: string;
    checkoutSessionId?: string;
    chargeId?: string;
    status: string;
    amount?: number;
    amountRefunded?: number;
    currency?: string;
  },
  cursor: StripeProjectionCursor,
) {
  const payment = await tx.stripePayment.upsert({
    where: { stripePaymentIntentId: input.paymentIntentId },
    update: {
      ...(input.checkoutSessionId ? { checkoutSessionId: input.checkoutSessionId } : {}),
      userId: attribution.userId,
      organizationId: attribution.organizationId,
    },
    create: {
      userId: attribution.userId,
      organizationId: attribution.organizationId,
      stripePaymentIntentId: input.paymentIntentId,
      checkoutSessionId: input.checkoutSessionId,
      chargeId: input.chargeId,
      status: input.status,
      amount: input.amount,
      amountRefunded: input.amountRefunded ?? 0,
      currency: input.currency,
      lastStripeEventId: cursor.eventId,
      lastStripeEventCreatedAt: cursor.createdAt,
    },
    select: { id: true },
  });

  return tx.stripePayment.updateMany({
    where: {
      id: payment.id,
      ...(cursor.authoritative
        ? {}
        : {
            OR: [
              { lastStripeEventCreatedAt: null },
              { lastStripeEventCreatedAt: { lt: cursor.createdAt } },
              {
                lastStripeEventCreatedAt: cursor.createdAt,
                lastStripeEventId: { lt: cursor.eventId },
              },
            ],
          }),
    },
    data: {
      ...(input.chargeId ? { chargeId: input.chargeId } : {}),
      status: input.status,
      ...(input.amount !== undefined ? { amount: input.amount } : {}),
      ...(input.amountRefunded !== undefined ? { amountRefunded: input.amountRefunded } : {}),
      ...(input.currency ? { currency: input.currency } : {}),
      lastStripeEventId: cursor.eventId,
      lastStripeEventCreatedAt: cursor.createdAt,
    },
  });
}

/** Reconciles the local business item even if the API process crashed after Stripe created it. */
async function projectChargeableItem(
  tx: Prisma.TransactionClient,
  object: Record<string, unknown>,
): Promise<void> {
  const paymentIntentId = stringValue(object.id);
  const metadata =
    object.metadata && typeof object.metadata === 'object'
      ? (object.metadata as Record<string, unknown>)
      : {};
  const chargeableItemId = stringValue(metadata.chargeableItemId);
  const reservationKeyHash = stringValue(metadata.chargeableReservationKeyHash);
  const status = stringValue(object.status);
  if (!paymentIntentId || !chargeableItemId || !reservationKeyHash || !status) return;

  if (status === 'succeeded') {
    await tx.chargeableItem.updateMany({
      where: {
        id: chargeableItemId,
        reservationKeyHash,
        status: { in: ['RESERVED', 'CONSUMED'] },
        OR: [{ paymentIntentId: null }, { paymentIntentId }],
      },
      data: { paymentIntentId, status: 'CONSUMED', consumedAt: new Date() },
    });
    return;
  }

  if (status === 'canceled') {
    await tx.chargeableItem.updateMany({
      where: {
        id: chargeableItemId,
        reservationKeyHash,
        status: 'RESERVED',
        OR: [{ paymentIntentId: null }, { paymentIntentId }],
      },
      data: {
        status: 'OPEN',
        reservationKeyHash: null,
        reservedAt: null,
        paymentIntentId: null,
      },
    });
    return;
  }

  await tx.chargeableItem.updateMany({
    where: {
      id: chargeableItemId,
      reservationKeyHash,
      status: 'RESERVED',
      OR: [{ paymentIntentId: null }, { paymentIntentId }],
    },
    data: { paymentIntentId },
  });
}

async function projectSubscription(
  tx: Prisma.TransactionClient,
  attribution: StripeAttribution,
  object: Record<string, unknown>,
  cursor: StripeProjectionCursor,
) {
  const subscriptionId = stringValue(object.id);
  if (!subscriptionId) return;
  const items = object.items;
  const itemData =
    items && typeof items === 'object' ? (items as Record<string, unknown>).data : undefined;
  const firstItem = Array.isArray(itemData) ? (itemData as unknown[])[0] : undefined;
  const price =
    firstItem && typeof firstItem === 'object'
      ? (firstItem as Record<string, unknown>).price
      : undefined;
  const data = {
    status: stringValue(object.status) ?? 'unknown',
    priceId: nestedString(price, 'id'),
    currency: nestedString(price, 'currency'),
    currentPeriodStart: dateFromUnix(object.current_period_start),
    currentPeriodEnd: dateFromUnix(object.current_period_end),
    cancelAtPeriodEnd: object.cancel_at_period_end === true,
    canceledAt: dateFromUnix(object.canceled_at),
    deletedAt: object.status === 'canceled' ? cursor.createdAt : null,
    lastStripeEventId: cursor.eventId,
    lastStripeEventCreatedAt: cursor.createdAt,
  };
  const subscription = await tx.stripeSubscription.upsert({
    where: { stripeSubscriptionId: subscriptionId },
    update: {
      userId: attribution.userId,
      organizationId: attribution.organizationId,
    },
    create: {
      userId: attribution.userId,
      organizationId: attribution.organizationId,
      stripeSubscriptionId: subscriptionId,
      ...data,
    },
    select: { id: true },
  });

  return tx.stripeSubscription.updateMany({
    where: {
      id: subscription.id,
      ...(cursor.authoritative
        ? {}
        : {
            OR: [
              { lastStripeEventCreatedAt: null },
              { lastStripeEventCreatedAt: { lt: cursor.createdAt } },
              {
                lastStripeEventCreatedAt: cursor.createdAt,
                lastStripeEventId: { lt: cursor.eventId },
              },
            ],
          }),
    },
    data,
  });
}

async function retrieveCurrentStripeObject(
  eventType: string,
  object: Record<string, unknown>,
  stripeClient: StripeClient | null,
): Promise<{ object: Record<string, unknown>; authoritative: boolean }> {
  if (!stripeClient) return { object, authoritative: false };
  const id = stringValue(object.id);
  if (!id) return { object, authoritative: false };
  if (eventType.startsWith('customer.subscription.')) {
    return {
      object: (await stripeClient.subscriptions.retrieve(id)) as unknown as Record<string, unknown>,
      authoritative: true,
    };
  }
  if (eventType.startsWith('payment_intent.')) {
    return {
      object: (await stripeClient.paymentIntents.retrieve(id, {
        expand: ['latest_charge'],
      })) as unknown as Record<string, unknown>,
      authoritative: true,
    };
  }
  if (eventType === 'charge.refunded') {
    return {
      object: (await stripeClient.charges.retrieve(id)) as unknown as Record<string, unknown>,
      authoritative: true,
    };
  }
  if (eventType === 'checkout.session.completed') {
    return {
      object: (await stripeClient.checkout.sessions.retrieve(id, {
        expand: ['payment_intent', 'subscription'],
      })) as unknown as Record<string, unknown>,
      authoritative: true,
    };
  }
  if (eventType.startsWith('setup_intent.')) {
    return {
      object: (await stripeClient.setupIntents.retrieve(id)) as unknown as Record<string, unknown>,
      authoritative: true,
    };
  }
  if (eventType.startsWith('payment_method.')) {
    return {
      object: (await stripeClient.paymentMethods.retrieve(id)) as unknown as Record<
        string,
        unknown
      >,
      authoritative: true,
    };
  }
  if (eventType === 'customer.updated') {
    return {
      object: (await stripeClient.customers.retrieve(id)) as unknown as Record<string, unknown>,
      authoritative: true,
    };
  }
  return { object, authoritative: false };
}

/**
 * Records a saved card.
 *
 * Driven from a successful SetupIntent or a successful PaymentIntent with setup_future_usage,
 * rather than `payment_method.attached`: those intents carry the attribution metadata this
 * service sets, while a payment method alone does not.
 */
async function projectAttachedPaymentMethod(
  tx: Prisma.TransactionClient,
  attribution: StripeAttribution,
  paymentMethod: Record<string, unknown>,
): Promise<void> {
  const stripePaymentMethodId = stringValue(paymentMethod.id);
  if (!stripePaymentMethodId) return;

  const card = (paymentMethod.card ?? {}) as Record<string, unknown>;
  const details = {
    type: stringValue(paymentMethod.type) ?? 'card',
    brand: stringValue(card.brand) ?? null,
    last4: stringValue(card.last4) ?? null,
    expMonth: numberValue(card.exp_month) ?? null,
    expYear: numberValue(card.exp_year) ?? null,
    fingerprint: stringValue(card.fingerprint) ?? null,
  };

  await tx.paymentMethod.upsert({
    where: { stripePaymentMethodId },
    create: {
      stripePaymentMethodId,
      userId: attribution.userId,
      organizationId: attribution.organizationId,
      ...details,
    },
    update: {
      userId: attribution.userId,
      organizationId: attribution.organizationId,
      ...details,
      detachedAt: null,
      deletedAt: null,
    },
  });
}

export async function processStoredStripeEvent(
  webhookEventId: string,
  stripeClient: StripeClient | null = createStripeClient(),
): Promise<void> {
  const stored = await prisma.stripeWebhookEvent.findUnique({ where: { id: webhookEventId } });
  if (!stored) throw new Error('Stripe webhook event not found');
  const payload = stored.payload as unknown;
  const eventObject = objectFromEvent(payload);
  if (!eventObject) throw new Error('Stripe webhook payload is malformed');
  const current = await retrieveCurrentStripeObject(stored.type, eventObject, stripeClient);
  const object = current.object;
  const savedPaymentMethodId =
    stored.type === 'setup_intent.succeeded' ||
    (stored.type === 'payment_intent.succeeded' && object.setup_future_usage === 'off_session')
      ? referenceId(object.payment_method)
      : undefined;
  // Provider I/O stays outside the database transaction so row/advisory locks are held only for
  // local projection writes.
  const savedPaymentMethod =
    savedPaymentMethodId && stripeClient
      ? ((await stripeClient.paymentMethods.retrieve(savedPaymentMethodId)) as unknown as Record<
          string,
          unknown
        >)
      : undefined;

  const cursor = {
    eventId: stored.stripeEventId,
    createdAt: stored.stripeCreatedAt,
    authoritative: current.authoritative,
  };

  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      await prisma.$transaction(async (tx) => {
        const eventType = stored.type;
        const objectId = stringValue(object.id);
        const executeRaw = (
          tx as unknown as { $executeRaw?: (query: Prisma.Sql) => Promise<number> }
        ).$executeRaw;
        if (objectId && executeRaw) {
          await executeRaw.call(
            tx,
            Prisma.sql`SELECT pg_advisory_xact_lock(hashtextextended(${objectId}, 0))`,
          );
        }
        const attribution = await attributionForStripeObject(tx, object);
        if (eventType.startsWith('payment_intent.')) {
          await projectChargeableItem(tx, object);
        }
        if (
          attribution &&
          (eventType.startsWith('payment_intent.') || eventType === 'checkout.session.completed')
        ) {
          const paymentIntentId = eventType.startsWith('payment_intent.')
            ? stringValue(object.id)
            : referenceId(object.payment_intent);
          if (paymentIntentId) {
            await upsertPayment(
              tx,
              attribution,
              {
                paymentIntentId,
                checkoutSessionId: eventType.startsWith('checkout.session.')
                  ? stringValue(object.id)
                  : undefined,
                chargeId: referenceId(object.latest_charge),
                status:
                  stringValue(object.payment_status) ?? stringValue(object.status) ?? 'unknown',
                amount:
                  numberValue(object.amount_received) ??
                  numberValue(object.amount_total) ??
                  numberValue(object.amount),
                currency: stringValue(object.currency),
              },
              cursor,
            );
          }
        }
        if (attribution && savedPaymentMethod) {
          await projectAttachedPaymentMethod(tx, attribution, savedPaymentMethod);
        }
        if (eventType === 'payment_method.detached') {
          const stripePaymentMethodId = stringValue(object.id);
          if (stripePaymentMethodId) {
            await tx.paymentMethod.updateMany({
              where: { stripePaymentMethodId, detachedAt: null },
              data: { detachedAt: new Date(), deletedAt: new Date(), isDefault: false },
            });
          }
        }
        if (
          eventType === 'payment_method.updated' ||
          eventType === 'payment_method.automatically_updated'
        ) {
          // Card networks push new expiry dates through the updater; keep display metadata fresh
          // so the UI does not warn about a card that is no longer expiring.
          const stripePaymentMethodId = stringValue(object.id);
          const card = (object.card ?? {}) as Record<string, unknown>;
          if (stripePaymentMethodId) {
            await tx.paymentMethod.updateMany({
              where: { stripePaymentMethodId, deletedAt: null },
              data: {
                brand: stringValue(card.brand) ?? null,
                last4: stringValue(card.last4) ?? null,
                expMonth: numberValue(card.exp_month) ?? null,
                expYear: numberValue(card.exp_year) ?? null,
              },
            });
          }
        }
        if (attribution && eventType === 'customer.updated') {
          const invoiceSettings =
            object.invoice_settings && typeof object.invoice_settings === 'object'
              ? (object.invoice_settings as Record<string, unknown>)
              : {};
          const defaultPaymentMethodId = referenceId(invoiceSettings.default_payment_method);
          const ownerWhere = attribution.organizationId
            ? { organizationId: attribution.organizationId }
            : { userId: attribution.userId, organizationId: null };
          await tx.paymentMethod.updateMany({
            where: { ...ownerWhere, isDefault: true, deletedAt: null },
            data: { isDefault: false },
          });
          if (defaultPaymentMethodId) {
            await tx.paymentMethod.updateMany({
              where: {
                ...ownerWhere,
                stripePaymentMethodId: defaultPaymentMethodId,
                detachedAt: null,
                deletedAt: null,
              },
              data: { isDefault: true },
            });
          }
        }
        if (attribution && eventType.startsWith('customer.subscription.')) {
          await projectSubscription(tx, attribution, object, cursor);
        }
        if (attribution && eventType === 'charge.refunded') {
          const paymentIntentId = referenceId(object.payment_intent);
          if (paymentIntentId) {
            await upsertPayment(
              tx,
              attribution,
              {
                chargeId: stringValue(object.id),
                paymentIntentId,
                status: 'refunded',
                amountRefunded: numberValue(object.amount_refunded),
                amount: numberValue(object.amount),
                currency: stringValue(object.currency),
              },
              cursor,
            );
          }
        }
        await tx.stripeWebhookEvent.update({
          where: { id: webhookEventId },
          data: { status: 'PROCESSED', processedAt: new Date(), lastError: null },
        });
      });
      return;
    } catch (error) {
      const concurrentIdentityCollision =
        error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002';
      if (!concurrentIdentityCollision || attempt === 1) throw error;
    }
  }
}
