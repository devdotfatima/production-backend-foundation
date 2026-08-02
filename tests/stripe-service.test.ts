import { Prisma } from '@prisma/client';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => {
  const transaction = {
    user: { findUnique: vi.fn() },
    stripePayment: { upsert: vi.fn(), updateMany: vi.fn() },
    stripeRefundOperation: { updateMany: vi.fn() },
    stripeSubscription: { upsert: vi.fn(), updateMany: vi.fn() },
    stripeWebhookEvent: { update: vi.fn() },
    auditEvent: { create: vi.fn() },
  };
  const stripeClient = {
    checkout: { sessions: { create: vi.fn(), retrieve: vi.fn() } },
    customers: { create: vi.fn() },
    promotionCodes: { list: vi.fn() },
    paymentIntents: { retrieve: vi.fn() },
    charges: { retrieve: vi.fn() },
    refunds: { create: vi.fn() },
  };
  return {
    transaction,
    stripeClient,
    prisma: {
      user: { findFirst: vi.fn(), update: vi.fn() },
      stripeRefundOperation: {
        findUnique: vi.fn(),
        findUniqueOrThrow: vi.fn(),
        create: vi.fn(),
        update: vi.fn(),
      },
      stripeWebhookEvent: { findUnique: vi.fn() },
      $transaction: vi.fn(),
    },
    hashMetadata: vi.fn((value: string) => `hashed:${value}`),
  };
});

vi.mock('stripe', () => ({
  default: function Stripe() {
    return mocks.stripeClient;
  },
}));
vi.mock('#app/config/env.js', () => ({
  env: {
    APP_ORIGIN: 'https://app.example.com',
    STRIPE_SECRET_KEY: 'sk_test_configured',
    STRIPE_WEBHOOK_SECRET: 'whsec_test',
    STRIPE_DEFAULT_PRICE_KEY: 'starter',
    STRIPE_PRICE_CATALOG: { starter: 'price_starter', pro: 'price_pro' },
    REFUND_SELF_SERVICE_ENABLED: true,
    REFUND_WINDOW_DAYS: 30,
    REFUND_MAX_AMOUNT_BY_CURRENCY: { usd: 5_000 },
    AUDIT_INTEGRITY_SECRET: '',
    COOKIE_SECRET: 'test-cookie-secret-at-least-32-characters',
  },
}));
vi.mock('#app/lib/crypto.js', () => ({ hashMetadata: mocks.hashMetadata }));
vi.mock('#app/lib/prisma.js', () => ({ prisma: mocks.prisma }));
vi.mock('#app/modules/outbox/outbox.service.js', () => ({ addOutboxEvent: vi.fn() }));

import {
  createCheckoutSession,
  createRefund,
  processStoredStripeEvent,
} from '../dist/src/modules/stripe/stripe.service.js';

interface StoredEvent {
  id: string;
  stripeEventId: string;
  stripeCreatedAt: Date;
  type: string;
  payload: { data: { object: Record<string, unknown> } };
}

interface PaymentState {
  id: string;
  stripePaymentIntentId: string;
  checkoutSessionId?: string;
  chargeId?: string;
  status: string;
  amount?: number;
  amountRefunded: number;
  currency?: string;
  lastStripeEventId: string;
  lastStripeEventCreatedAt: Date;
}

interface PaymentUpsertInput {
  update: Partial<PaymentState>;
  create: Omit<PaymentState, 'id'>;
}

interface PaymentUpdateInput {
  data: Partial<PaymentState> & {
    lastStripeEventCreatedAt: Date;
    lastStripeEventId: string;
  };
}

function storedEvent(
  id: string,
  type: string,
  created: number,
  object: Record<string, unknown>,
): StoredEvent {
  return {
    id: `stored-${id}`,
    stripeEventId: id,
    stripeCreatedAt: new Date(created * 1_000),
    type,
    payload: { data: { object } },
  };
}

function paymentEvents(): Record<string, StoredEvent> {
  return {
    checkout: storedEvent('evt_checkout', 'checkout.session.completed', 100, {
      id: 'cs_123',
      metadata: { userId: 'user-1' },
      payment_intent: 'pi_123',
      payment_status: 'unpaid',
      amount_total: 2_000,
      currency: 'usd',
    }),
    intent: storedEvent('evt_intent', 'payment_intent.succeeded', 200, {
      id: 'pi_123',
      metadata: { userId: 'user-1' },
      latest_charge: 'ch_123',
      status: 'succeeded',
      amount_received: 2_000,
      currency: 'usd',
    }),
  };
}

function installPaymentRepository(concurrentCreate = false): () => PaymentState | undefined {
  let state: PaymentState | undefined;
  let initialCalls = 0;
  let releaseSecondArrival: (() => void) | undefined;
  const secondArrival = new Promise<void>((resolve) => {
    releaseSecondArrival = resolve;
  });

  mocks.transaction.stripePayment.upsert.mockImplementation(async (input: PaymentUpsertInput) => {
    const observed = state;
    if (concurrentCreate && initialCalls < 2) {
      initialCalls += 1;
      if (initialCalls === 1) await secondArrival;
      else releaseSecondArrival?.();
    }

    if (!observed) {
      if (state) {
        throw new Prisma.PrismaClientKnownRequestError('Concurrent payment identity', {
          code: 'P2002',
          clientVersion: '6.19.3',
        });
      }
      state = { id: 'payment-1', ...input.create };
    } else {
      Object.assign(observed, input.update);
      state = observed;
    }
    return { id: state.id };
  });
  mocks.transaction.stripePayment.updateMany.mockImplementation(
    async (input: PaymentUpdateInput) => {
      if (!state) return { count: 0 };
      if (state.lastStripeEventCreatedAt < input.data.lastStripeEventCreatedAt) {
        Object.assign(state, input.data);
        return { count: 1 };
      }
      return { count: 0 };
    },
  );
  return () => state;
}

describe('Stripe service hardening', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.prisma.$transaction.mockImplementation(
      (callback: (tx: typeof mocks.transaction) => Promise<unknown>) => callback(mocks.transaction),
    );
    mocks.prisma.user.findFirst.mockResolvedValue({
      id: 'user-1',
      email: 'user@example.com',
      displayName: 'User',
      stripeCustomerId: 'cus_123',
    });
    mocks.transaction.stripeWebhookEvent.update.mockResolvedValue({});
    mocks.transaction.stripeRefundOperation.updateMany.mockResolvedValue({ count: 1 });
    mocks.transaction.auditEvent.create.mockResolvedValue({});
    mocks.stripeClient.checkout.sessions.create.mockResolvedValue({
      id: 'cs_123',
      url: 'https://checkout.stripe.com/session',
      mode: 'payment',
      payment_status: 'unpaid',
    });
  });

  it('resolves a server-owned price key and scopes the caller idempotency key', async () => {
    await createCheckoutSession(
      'user-1',
      { mode: 'payment', priceKey: 'pro', quantity: 2 },
      'order-12345',
      mocks.stripeClient as never,
    );

    expect(mocks.stripeClient.checkout.sessions.create).toHaveBeenCalledWith(
      expect.objectContaining({
        line_items: [{ price: 'price_pro', quantity: 2 }],
        metadata: { userId: 'user-1', priceKey: 'pro' },
      }),
      { idempotencyKey: 'checkout:user-1:hashed:order-12345' },
    );
  });

  it('rejects a price key that is not in the server catalogue', async () => {
    await expect(
      createCheckoutSession(
        'user-1',
        { mode: 'payment', priceKey: 'internal', quantity: 1 },
        'order-12345',
        mocks.stripeClient as never,
      ),
    ).rejects.toMatchObject({ statusCode: 400 });

    expect(mocks.stripeClient.checkout.sessions.create).not.toHaveBeenCalled();
  });

  it('uses a caller operation key so equal partial refunds remain distinct', async () => {
    mocks.stripeClient.paymentIntents.retrieve.mockResolvedValue({
      object: 'payment_intent',
      id: 'pi_123',
      metadata: { userId: 'user-1' },
      customer: 'cus_123',
      created: Math.floor(Date.now() / 1_000),
      currency: 'usd',
      amount_received: 4_000,
      status: 'succeeded',
      latest_charge: { amount_refunded: 0 },
    });
    mocks.prisma.stripeRefundOperation.findUnique.mockResolvedValue(null);
    mocks.prisma.stripeRefundOperation.create
      .mockResolvedValueOnce({
        id: 'operation-1',
        requestHash: 'hashed:refund-request:pi_123::1000',
        stripeRefundId: null,
      })
      .mockResolvedValueOnce({
        id: 'operation-2',
        requestHash: 'hashed:refund-request:pi_123::1000',
        stripeRefundId: null,
      });
    mocks.stripeClient.refunds.create
      .mockResolvedValueOnce({ id: 're_1', status: 'succeeded', amount: 1_000, currency: 'usd' })
      .mockResolvedValueOnce({ id: 're_2', status: 'succeeded', amount: 1_000, currency: 'usd' });

    const metadata = { requestId: 'request-id', ip: '127.0.0.1', userAgent: 'test' };
    await createRefund(
      'user-1',
      { paymentIntentId: 'pi_123', amount: 1_000 },
      'refund-order-1',
      metadata,
      mocks.stripeClient as never,
    );
    await createRefund(
      'user-1',
      { paymentIntentId: 'pi_123', amount: 1_000 },
      'refund-order-2',
      metadata,
      mocks.stripeClient as never,
    );

    const refundCalls = mocks.stripeClient.refunds.create.mock.calls as unknown as Array<
      [unknown, { idempotencyKey: string }]
    >;
    expect(refundCalls[0]?.[1].idempotencyKey).not.toBe(refundCalls[1]?.[1].idempotencyKey);
    expect(mocks.stripeClient.refunds.create).toHaveBeenCalledTimes(2);
  });

  it('enforces the self-service amount policy before calling Stripe refunds', async () => {
    mocks.stripeClient.paymentIntents.retrieve.mockResolvedValue({
      object: 'payment_intent',
      id: 'pi_123',
      metadata: { userId: 'user-1' },
      customer: 'cus_123',
      created: Math.floor(Date.now() / 1_000),
      currency: 'usd',
      amount_received: 8_000,
      status: 'succeeded',
      latest_charge: { amount_refunded: 0 },
    });

    await expect(
      createRefund(
        'user-1',
        { paymentIntentId: 'pi_123', amount: 6_000 },
        'refund-order-3',
        { requestId: 'request-id', ip: '127.0.0.1', userAgent: 'test' },
        mocks.stripeClient as never,
      ),
    ).rejects.toMatchObject({ statusCode: 403 });
    expect(mocks.stripeClient.refunds.create).not.toHaveBeenCalled();
  });

  it('returns a completed refund operation before re-reading changed Stripe balances', async () => {
    mocks.prisma.stripeRefundOperation.findUnique.mockResolvedValue({
      id: 'operation-1',
      requestHash: 'hashed:refund-request:pi_123::1000',
      stripeRefundId: 're_existing',
      status: 'succeeded',
      amount: 1_000,
      currency: 'usd',
    });

    await expect(
      createRefund(
        'user-1',
        { paymentIntentId: 'pi_123', amount: 1_000 },
        'refund-order-existing',
        { requestId: 'request-id', ip: '127.0.0.1', userAgent: 'test' },
        mocks.stripeClient as never,
      ),
    ).resolves.toEqual({
      id: 're_existing',
      status: 'succeeded',
      amount: 1_000,
      currency: 'usd',
    });
    expect(mocks.stripeClient.paymentIntents.retrieve).not.toHaveBeenCalled();
  });

  it.each([
    ['checkout then PaymentIntent', ['checkout', 'intent']],
    ['PaymentIntent then checkout', ['intent', 'checkout']],
  ])('keeps one canonical payment for %s delivery', async (_label, order) => {
    const events = paymentEvents();
    const getState = installPaymentRepository();
    mocks.prisma.stripeWebhookEvent.findUnique.mockImplementation(
      ({ where }: { where: { id: string } }) => {
        const key = where.id.replace('stored-', '');
        return Promise.resolve(events[key]);
      },
    );

    for (const key of order) await processStoredStripeEvent(`stored-${key}`, null);

    expect(getState()).toMatchObject({
      stripePaymentIntentId: 'pi_123',
      checkoutSessionId: 'cs_123',
      chargeId: 'ch_123',
      status: 'succeeded',
      lastStripeEventId: 'evt_intent',
    });
    expect(
      new Set(
        mocks.transaction.stripePayment.upsert.mock.calls.map(
          ([input]) =>
            (input as { where: { stripePaymentIntentId: string } }).where.stripePaymentIntentId,
        ),
      ),
    ).toEqual(new Set(['pi_123']));
  });

  it('converges concurrent Checkout and PaymentIntent processing on one payment', async () => {
    const events = paymentEvents();
    const getState = installPaymentRepository(true);
    mocks.prisma.stripeWebhookEvent.findUnique.mockImplementation(
      ({ where }: { where: { id: string } }) => {
        const key = where.id.replace('stored-', '');
        return Promise.resolve(events[key]);
      },
    );

    await Promise.all([
      processStoredStripeEvent('stored-checkout', null),
      processStoredStripeEvent('stored-intent', null),
    ]);

    expect(getState()).toMatchObject({
      id: 'payment-1',
      stripePaymentIntentId: 'pi_123',
      checkoutSessionId: 'cs_123',
      status: 'succeeded',
      lastStripeEventId: 'evt_intent',
    });
    expect(mocks.transaction.stripePayment.upsert).toHaveBeenCalledTimes(3);
  });

  it('guards subscription projections with Stripe event creation time', async () => {
    let state: { status: string; lastStripeEventCreatedAt: Date } | undefined;
    const events: Record<string, StoredEvent> = {
      newer: storedEvent('evt_newer', 'customer.subscription.deleted', 200, {
        id: 'sub_123',
        metadata: { userId: 'user-1' },
        status: 'canceled',
        items: { data: [] },
      }),
      older: storedEvent('evt_older', 'customer.subscription.updated', 100, {
        id: 'sub_123',
        metadata: { userId: 'user-1' },
        status: 'active',
        items: { data: [] },
      }),
    };
    mocks.prisma.stripeWebhookEvent.findUnique.mockImplementation(
      ({ where }: { where: { id: string } }) => Promise.resolve(events[where.id]),
    );
    mocks.transaction.stripeSubscription.upsert.mockImplementation(
      async (input: { create: { status: string; lastStripeEventCreatedAt: Date } }) => {
        state ??= input.create;
        return { id: 'subscription-1' };
      },
    );
    mocks.transaction.stripeSubscription.updateMany.mockImplementation(
      async (input: { data: { status: string; lastStripeEventCreatedAt: Date } }) => {
        if (state && state.lastStripeEventCreatedAt < input.data.lastStripeEventCreatedAt) {
          state = input.data;
          return { count: 1 };
        }
        return { count: 0 };
      },
    );

    await processStoredStripeEvent('newer', null);
    await processStoredStripeEvent('older', null);

    expect(state?.status).toBe('canceled');
    const staleUpdate = mocks.transaction.stripeSubscription.updateMany.mock.calls.at(-1)?.[0] as {
      where: { OR: Array<Record<string, unknown>> };
    };
    expect(staleUpdate.where.OR).toContainEqual({
      lastStripeEventCreatedAt: { lt: events.older?.stripeCreatedAt },
    });
  });
});
