import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => {
  const paymentMethodFindFirst = vi.fn();
  const paymentMethodFindMany = vi.fn();
  const paymentMethodCount = vi.fn();
  const paymentMethodUpdate = vi.fn();
  const paymentMethodUpdateMany = vi.fn();
  const paymentMethodFindFirstOrThrow = vi.fn();
  const subscriptionCount = vi.fn();

  return {
    paymentMethodFindFirst,
    paymentMethodFindMany,
    paymentMethodCount,
    paymentMethodUpdate,
    paymentMethodUpdateMany,
    paymentMethodFindFirstOrThrow,
    subscriptionCount,
    setupIntentsCreate: vi.fn(),
    customersUpdate: vi.fn(),
    detach: vi.fn(),
    ensureCustomer: vi.fn(async () => 'cus_123'),
    resolveBillingOwner: vi.fn((userId: string) => ({ type: 'user' as const, userId })),
    audit: vi.fn(),
    database: {
      paymentMethod: {
        findFirst: paymentMethodFindFirst,
        findMany: paymentMethodFindMany,
        count: paymentMethodCount,
        update: paymentMethodUpdate,
        updateMany: paymentMethodUpdateMany,
        findFirstOrThrow: paymentMethodFindFirstOrThrow,
      },
      stripeSubscription: { count: subscriptionCount },
    },
  };
});

vi.mock('#app/lib/prisma.js', () => ({ prisma: mocks.database }));
vi.mock('#app/lib/audited-transaction.js', () => ({
  withAuditedTransaction: (operation: (tx: unknown, audit: unknown) => Promise<unknown>) =>
    operation(mocks.database, mocks.audit),
}));
vi.mock('#app/modules/stripe/stripe.shared.js', () => ({
  ensureCustomer: mocks.ensureCustomer,
  resolveBillingOwner: mocks.resolveBillingOwner,
  billingOwnerKey: (owner: { userId: string }) => `user:${owner.userId}`,
  billingOwnerMetadata: (owner: { userId: string }) => ({
    userId: owner.userId,
    actorUserId: owner.userId,
  }),
  billingOwnerWhere: (owner: { userId: string }) => ({
    userId: owner.userId,
    organizationId: null,
  }),
}));

import {
  createSetupIntent,
  detachPaymentMethod,
  setDefaultPaymentMethod,
} from '../dist/src/modules/stripe/stripe.payment-methods.service.js';

const userId = '00000000-0000-7000-8000-0000000000a1';
const methodId = '00000000-0000-7000-8000-0000000000m1';
const metadata = { ip: '203.0.113.7', userAgent: 'test', requestId: 'req-1' };

const stripeClient = {
  setupIntents: { create: mocks.setupIntentsCreate },
  customers: { update: mocks.customersUpdate },
  paymentMethods: { detach: mocks.detach },
};

beforeEach(() => {
  vi.clearAllMocks();
  mocks.ensureCustomer.mockResolvedValue('cus_123');
});

describe('saving a card', () => {
  it('records the off-session mandate the later charges depend on', async () => {
    mocks.setupIntentsCreate.mockResolvedValue({
      id: 'seti_1',
      client_secret: 'secret',
      status: 'requires_payment_method',
    });

    await createSetupIntent(userId, stripeClient as never, 'key-1');

    const params = mocks.setupIntentsCreate.mock.calls[0]?.[0] as Record<string, unknown>;
    // Without usage: 'off_session' the card saves fine and then fails on the first real
    // off-session charge in an SCA region.
    expect(params.usage).toBe('off_session');
    expect(params.customer).toBe('cus_123');
  });

  it('returns only the client secret, never card data', async () => {
    mocks.setupIntentsCreate.mockResolvedValue({
      id: 'seti_1',
      client_secret: 'secret',
      status: 'requires_payment_method',
    });

    const result = await createSetupIntent(userId, stripeClient as never, 'key-1');
    expect(Object.keys(result).sort()).toEqual(['clientSecret', 'id', 'status']);
  });
});

describe('default payment method', () => {
  it("refuses a payment method that is not the caller's", async () => {
    mocks.paymentMethodFindFirst.mockResolvedValue(null);

    await expect(
      setDefaultPaymentMethod(userId, methodId, stripeClient as never, metadata, 'key-1'),
    ).rejects.toMatchObject({ statusCode: 404 });
    expect(mocks.customersUpdate).not.toHaveBeenCalled();
  });

  it('updates Stripe and clears the previous local default', async () => {
    mocks.paymentMethodFindFirst.mockResolvedValue({
      id: methodId,
      stripePaymentMethodId: 'pm_1',
    });
    mocks.paymentMethodFindFirstOrThrow.mockResolvedValue({ id: methodId, isDefault: true });

    await setDefaultPaymentMethod(userId, methodId, stripeClient as never, metadata, 'key-1');

    const updateCall = mocks.customersUpdate.mock.calls[0] as unknown as [
      string,
      { invoice_settings: { default_payment_method: string } },
      { idempotencyKey: string },
    ];
    expect(updateCall[0]).toBe('cus_123');
    expect(updateCall[1]).toEqual({ invoice_settings: { default_payment_method: 'pm_1' } });
    expect(updateCall[2].idempotencyKey).toContain('payment-method-default');
    expect(mocks.paymentMethodUpdateMany).toHaveBeenCalledWith({
      where: { userId, organizationId: null, isDefault: true, deletedAt: null },
      data: { isDefault: false },
    });
  });
});

describe('detaching a card', () => {
  beforeEach(() => {
    mocks.paymentMethodFindFirst.mockResolvedValue({
      id: methodId,
      stripePaymentMethodId: 'pm_1',
    });
  });

  it('refuses to remove the last card while a subscription is active', async () => {
    // Otherwise the next renewal fails silently and shows up as involuntary churn.
    mocks.subscriptionCount.mockResolvedValue(1);
    mocks.paymentMethodCount.mockResolvedValue(1);

    await expect(
      detachPaymentMethod(userId, methodId, stripeClient as never, metadata, 'key-1'),
    ).rejects.toMatchObject({ statusCode: 409 });
    expect(mocks.detach).not.toHaveBeenCalled();
  });

  it('allows removal when another card remains', async () => {
    mocks.subscriptionCount.mockResolvedValue(1);
    mocks.paymentMethodCount.mockResolvedValue(2);

    await detachPaymentMethod(userId, methodId, stripeClient as never, metadata, 'key-1');

    const detachCall = mocks.detach.mock.calls[0] as unknown as [
      string,
      Record<string, never>,
      { idempotencyKey: string },
    ];
    expect(detachCall[0]).toBe('pm_1');
    expect(detachCall[2].idempotencyKey).toContain('payment-method-detach');
    expect(mocks.paymentMethodUpdate).toHaveBeenCalled();
  });

  it('allows removing the last card when no subscription is active', async () => {
    mocks.subscriptionCount.mockResolvedValue(0);
    mocks.paymentMethodCount.mockResolvedValue(1);

    await detachPaymentMethod(userId, methodId, stripeClient as never, metadata, 'key-1');
    const detachCall = mocks.detach.mock.calls[0] as unknown as [
      string,
      Record<string, never>,
      { idempotencyKey: string },
    ];
    expect(detachCall[0]).toBe('pm_1');
    expect(detachCall[2].idempotencyKey).toContain('payment-method-detach');
  });

  it('detaches at Stripe before soft-deleting locally', async () => {
    mocks.subscriptionCount.mockResolvedValue(0);
    mocks.paymentMethodCount.mockResolvedValue(1);
    const order: string[] = [];
    mocks.detach.mockImplementation(() => {
      order.push('stripe');
      return Promise.resolve({});
    });
    mocks.paymentMethodUpdate.mockImplementation(() => {
      order.push('local');
      return Promise.resolve({});
    });

    await detachPaymentMethod(userId, methodId, stripeClient as never, metadata, 'key-1');

    // Local-first would leave the card charged-but-invisible if the Stripe call failed.
    expect(order).toEqual(['stripe', 'local']);
  });
});
