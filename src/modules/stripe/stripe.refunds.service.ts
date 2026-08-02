import { Prisma } from '@prisma/client';
import type Stripe from 'stripe';
import { env } from '#app/config/env.js';
import { withAuditedTransaction } from '#app/lib/audited-transaction.js';
import { hashMetadata } from '#app/lib/crypto.js';
import { errors } from '#app/lib/errors.js';
import { prisma } from '#app/lib/prisma.js';
import type { RequestMetadata } from '#app/lib/request-metadata.js';
import { requireStripe, type StripeClient } from '#app/modules/stripe/stripe.client.js';
import { ensureCustomer, getBillingUser } from '#app/modules/stripe/stripe.shared.js';

type RefundInput = { paymentIntentId?: string; chargeId?: string; amount?: number };

function refundTargetDetails(target: Stripe.PaymentIntent | Stripe.Charge) {
  if (target.object === 'payment_intent') {
    const charge =
      target.latest_charge && typeof target.latest_charge !== 'string'
        ? target.latest_charge
        : undefined;
    return {
      created: target.created,
      currency: target.currency.toLowerCase(),
      refundableAmount: Math.max(0, target.amount_received - (charge?.amount_refunded ?? 0)),
      refundable: target.status === 'succeeded',
    };
  }
  return {
    created: target.created,
    currency: target.currency.toLowerCase(),
    refundableAmount: Math.max(0, target.amount - target.amount_refunded),
    refundable: target.paid && target.captured,
  };
}

function enforceSelfServiceRefundPolicy(
  target: Stripe.PaymentIntent | Stripe.Charge,
  requestedAmount?: number,
): number {
  if (!env.REFUND_SELF_SERVICE_ENABLED) {
    throw errors.forbidden('Self-service refunds are disabled');
  }
  const details = refundTargetDetails(target);
  if (!details.refundable || details.refundableAmount < 1) {
    throw errors.conflict('The payment has no refundable balance');
  }
  const ageMs = Date.now() - details.created * 1_000;
  if (ageMs > env.REFUND_WINDOW_DAYS * 24 * 60 * 60 * 1_000) {
    throw errors.forbidden('The self-service refund window has expired');
  }
  const policyLimit = env.REFUND_MAX_AMOUNT_BY_CURRENCY[details.currency];
  if (!policyLimit) {
    throw errors.forbidden(`Self-service refunds are unavailable for ${details.currency}`);
  }
  const amount = requestedAmount ?? details.refundableAmount;
  if (amount > details.refundableAmount) {
    throw errors.badRequest('Refund amount exceeds the remaining refundable balance');
  }
  if (amount > policyLimit) {
    throw errors.forbidden('Refund amount requires administrative approval');
  }
  return amount;
}

export async function createRefund(
  userId: string,
  input: RefundInput,
  businessIdempotencyKey: string,
  metadata: RequestMetadata,
  stripeClient: StripeClient | null,
) {
  const client = requireStripe(stripeClient);
  const idempotencyKeyHash = hashMetadata(`refund-operation:${businessIdempotencyKey}`);
  const requestHash = hashMetadata(
    `refund-request:${input.paymentIntentId ?? ''}:${input.chargeId ?? ''}:${input.amount ?? 'full'}`,
  );
  let operation = await prisma.stripeRefundOperation.findUnique({
    where: { userId_idempotencyKeyHash: { userId, idempotencyKeyHash } },
  });
  if (operation && operation.requestHash !== requestHash) {
    throw errors.conflict('Idempotency-Key was already used for a different refund request');
  }
  if (operation?.stripeRefundId) {
    return {
      id: operation.stripeRefundId,
      status: operation.status,
      amount: operation.amount,
      currency: operation.currency,
    };
  }

  const customerId = await ensureCustomer(userId, stripeClient);
  let target: Stripe.PaymentIntent | Stripe.Charge;
  if (input.paymentIntentId) {
    target = await client.paymentIntents.retrieve(input.paymentIntentId, {
      expand: ['latest_charge'],
    });
  } else target = await client.charges.retrieve(input.chargeId!);

  const targetUserId = target.metadata?.userId;
  const targetCustomerId =
    'customer' in target
      ? typeof target.customer === 'string'
        ? target.customer
        : target.customer?.id
      : undefined;
  if (targetUserId !== userId && targetCustomerId !== customerId) {
    throw errors.notFound('Payment not found');
  }

  const amount = operation?.requestedAmount ?? enforceSelfServiceRefundPolicy(target, input.amount);
  if (!operation) {
    try {
      operation = await prisma.stripeRefundOperation.create({
        data: {
          userId,
          idempotencyKeyHash,
          requestHash,
          paymentIntentId: input.paymentIntentId,
          chargeId: input.chargeId,
          requestedAmount: amount,
        },
      });
    } catch (error) {
      if (!(error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002')) {
        throw error;
      }
      operation = await prisma.stripeRefundOperation.findUniqueOrThrow({
        where: { userId_idempotencyKeyHash: { userId, idempotencyKeyHash } },
      });
    }
  }
  if (operation.requestHash !== requestHash) {
    throw errors.conflict('Idempotency-Key was already used for a different refund request');
  }
  if (operation.stripeRefundId) {
    return {
      id: operation.stripeRefundId,
      status: operation.status,
      amount: operation.amount,
      currency: operation.currency,
    };
  }
  let refund: Stripe.Refund;
  try {
    refund = await client.refunds.create(
      {
        ...(input.paymentIntentId
          ? { payment_intent: input.paymentIntentId }
          : { charge: input.chargeId }),
        amount,
        reason: 'requested_by_customer',
        metadata: { userId, refundOperationId: operation.id },
      },
      { idempotencyKey: `refund:${userId}:${idempotencyKeyHash}` },
    );
  } catch (error) {
    const message = error instanceof Error ? error.message.slice(0, 2_000) : 'Stripe refund failed';
    await prisma.stripeRefundOperation.update({
      where: { id: operation.id },
      data: { status: 'FAILED', lastError: message },
    });
    throw error;
  }

  await withAuditedTransaction(async (tx, audit) => {
    const completed = await tx.stripeRefundOperation.updateMany({
      where: { id: operation.id, stripeRefundId: null },
      data: {
        stripeRefundId: refund.id,
        status: refund.status ?? 'pending',
        amount: refund.amount,
        currency: refund.currency,
        completedAt: new Date(),
        lastError: null,
      },
    });
    if (completed.count === 1) {
      await audit({
        actorUserId: userId,
        action: 'billing.refund_created',
        entityType: 'stripe_refund',
        entityId: refund.id,
        metadata: {
          refundOperationId: operation.id,
          paymentIntentId: input.paymentIntentId,
          chargeId: input.chargeId,
          amount: refund.amount,
          currency: refund.currency,
        },
        ...metadata,
      });
    }
  });
  return {
    id: refund.id,
    status: refund.status,
    amount: refund.amount,
    currency: refund.currency,
  };
}

export async function listPayments(userId: string, input: { cursor?: string; limit: number }) {
  await getBillingUser(userId);
  const payments = await prisma.stripePayment.findMany({
    where: { userId, deletedAt: null },
    orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    take: input.limit + 1,
    ...(input.cursor ? { cursor: { id: input.cursor }, skip: 1 } : {}),
    select: {
      id: true,
      stripePaymentIntentId: true,
      checkoutSessionId: true,
      chargeId: true,
      status: true,
      amount: true,
      amountRefunded: true,
      currency: true,
      createdAt: true,
      updatedAt: true,
    },
  });
  const hasMore = payments.length > input.limit;
  if (hasMore) payments.pop();
  return { payments, nextCursor: hasMore ? (payments.at(-1)?.id ?? null) : null };
}
