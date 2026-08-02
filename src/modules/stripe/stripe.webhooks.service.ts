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

async function userIdForStripeObject(
  tx: Prisma.TransactionClient,
  object: Record<string, unknown>,
): Promise<string | undefined> {
  const metadata = object.metadata;
  const metadataUserId =
    metadata && typeof metadata === 'object'
      ? stringValue((metadata as Record<string, unknown>).userId)
      : undefined;
  if (metadataUserId) return metadataUserId;
  const customerId = referenceId(object.customer);
  if (!customerId) return undefined;
  const user = await tx.user.findUnique({
    where: { stripeCustomerId: customerId },
    select: { id: true },
  });
  return user?.id;
}

async function upsertPayment(
  tx: Prisma.TransactionClient,
  userId: string,
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
    },
    create: {
      userId,
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

async function projectSubscription(
  tx: Prisma.TransactionClient,
  userId: string,
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
    update: {},
    create: {
      userId,
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
  return { object, authoritative: false };
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
        const userId = await userIdForStripeObject(tx, object);
        if (
          userId &&
          (eventType.startsWith('payment_intent.') || eventType === 'checkout.session.completed')
        ) {
          const paymentIntentId = eventType.startsWith('payment_intent.')
            ? stringValue(object.id)
            : referenceId(object.payment_intent);
          if (paymentIntentId) {
            await upsertPayment(
              tx,
              userId,
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
        if (userId && eventType.startsWith('customer.subscription.')) {
          await projectSubscription(tx, userId, object, cursor);
        }
        if (userId && eventType === 'charge.refunded') {
          const paymentIntentId = referenceId(object.payment_intent);
          if (paymentIntentId) {
            await upsertPayment(
              tx,
              userId,
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
