import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  dynamicPricingEnabled: true,
  allowedCurrencies: ['usd', 'eur'],
  maxByCurrency: { usd: 500_000, eur: 400_000 },
  minByCurrency: { usd: 50 },
  chargeableFindFirst: vi.fn(),
  chargeableUpdateMany: vi.fn(),
  paymentMethodFindFirst: vi.fn(),
  paymentIntentsCreate: vi.fn(),
  paymentIntentsRetrieve: vi.fn(),
  ensureCustomer: vi.fn(async () => 'cus_123'),
  resolveBillingOwner: vi.fn((userId: string) => ({ type: 'user' as const, userId })),
  hashMetadata: vi.fn((value: string) => `h:${value}`),
}));

vi.mock('#app/config/env.js', () => ({
  env: {
    get DYNAMIC_PRICING_ENABLED() {
      return mocks.dynamicPricingEnabled;
    },
    get CHARGE_ALLOWED_CURRENCIES() {
      return mocks.allowedCurrencies;
    },
    get CHARGE_MAX_AMOUNT_BY_CURRENCY() {
      return mocks.maxByCurrency;
    },
    get CHARGE_MIN_AMOUNT_BY_CURRENCY() {
      return mocks.minByCurrency;
    },
  },
}));
vi.mock('#app/lib/prisma.js', () => ({
  prisma: {
    chargeableItem: {
      findFirst: mocks.chargeableFindFirst,
      updateMany: mocks.chargeableUpdateMany,
    },
    paymentMethod: { findFirst: mocks.paymentMethodFindFirst },
  },
}));
vi.mock('#app/lib/crypto.js', () => ({ hashMetadata: mocks.hashMetadata }));
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
  assertChargeableWithinBounds,
  chargeableItemResolver,
  resolveChargeable,
} from '../dist/src/modules/stripe/stripe.chargeable.js';
import { createCharge } from '../dist/src/modules/stripe/stripe.charges.service.js';

const userId = '00000000-0000-7000-8000-0000000000a1';
const methodId = '00000000-0000-7000-8000-0000000000m1';
const stripeClient = {
  paymentIntents: { create: mocks.paymentIntentsCreate, retrieve: mocks.paymentIntentsRetrieve },
};

const openItem = {
  id: '00000000-0000-7000-8000-0000000000c1',
  amount: 2500,
  currency: 'USD',
  description: 'Booking #12',
  userId: null,
  status: 'OPEN' as const,
  reservationKeyHash: null,
  expiresAt: null,
};

beforeEach(() => {
  vi.clearAllMocks();
  mocks.dynamicPricingEnabled = true;
  mocks.allowedCurrencies = ['usd', 'eur'];
  mocks.maxByCurrency = { usd: 500_000, eur: 400_000 };
  mocks.minByCurrency = { usd: 50 };
  mocks.ensureCustomer.mockResolvedValue('cus_123');
  mocks.chargeableUpdateMany.mockResolvedValue({ count: 1 });
});

describe('amount bounds', () => {
  it('rejects a non-positive or fractional amount', () => {
    for (const amount of [0, -1, 12.5]) {
      expect(() =>
        assertChargeableWithinBounds({ amount, currency: 'usd', description: 'd', metadata: {} }),
      ).toThrow(/positive integer/);
    }
  });

  it('rejects a currency that is not enabled', () => {
    expect(() =>
      assertChargeableWithinBounds({
        amount: 100,
        currency: 'gbp',
        description: 'd',
        metadata: {},
      }),
    ).toThrow(/not enabled/);
  });

  it('rejects an amount above the configured maximum', () => {
    // A pricing bug should produce a rejected request, not a five-figure charge.
    expect(() =>
      assertChargeableWithinBounds({
        amount: 500_001,
        currency: 'usd',
        description: 'd',
        metadata: {},
      }),
    ).toThrow(/exceeds the configured maximum/);
  });

  it('rejects an amount below the configured minimum', () => {
    expect(() =>
      assertChargeableWithinBounds({ amount: 49, currency: 'usd', description: 'd', metadata: {} }),
    ).toThrow(/below the configured minimum/);
  });

  it('rejects a currency with no configured maximum even if allowlisted', () => {
    mocks.allowedCurrencies = ['usd', 'jpy'];
    expect(() =>
      assertChargeableWithinBounds({
        amount: 100,
        currency: 'jpy',
        description: 'd',
        metadata: {},
      }),
    ).toThrow(/No maximum charge amount/);
  });
});

describe('chargeable resolution', () => {
  it('refuses to resolve while dynamic pricing is disabled', async () => {
    mocks.dynamicPricingEnabled = false;
    await expect(
      resolveChargeable(chargeableItemResolver, 'ref-1', { userId }),
    ).rejects.toMatchObject({ statusCode: 409 });
  });

  it('applies the bounds check to every resolver, including custom ones', async () => {
    // The bound is enforced by resolveChargeable, so a client project cannot bypass it by
    // supplying its own resolver.
    const rogue = {
      resolve: async () => ({
        amount: 900_000,
        currency: 'usd',
        description: 'oops',
        metadata: {},
      }),
    };
    await expect(resolveChargeable(rogue, 'ref-1', { userId })).rejects.toThrow(/exceeds/);
  });

  it('normalises currency case before checking bounds', async () => {
    mocks.chargeableFindFirst.mockResolvedValue(openItem);
    await expect(resolveChargeable(chargeableItemResolver, 'ref-1', { userId })).resolves.toEqual({
      amount: 2500,
      currency: 'usd',
      description: 'Booking #12',
      metadata: {
        reference: 'ref-1',
        chargeableItemId: '00000000-0000-7000-8000-0000000000c1',
      },
    });
  });

  it('refuses an item bound to another user', async () => {
    mocks.chargeableFindFirst.mockResolvedValue({ ...openItem, userId: 'someone-else' });
    await expect(
      resolveChargeable(chargeableItemResolver, 'ref-1', { userId }),
    ).rejects.toMatchObject({ statusCode: 404 });
  });

  it('refuses an expired item', async () => {
    mocks.chargeableFindFirst.mockResolvedValue({
      ...openItem,
      expiresAt: new Date(Date.now() - 1000),
    });
    await expect(
      resolveChargeable(chargeableItemResolver, 'ref-1', { userId }),
    ).rejects.toMatchObject({ statusCode: 409 });
  });

  it('refuses an unknown reference', async () => {
    mocks.chargeableFindFirst.mockResolvedValue(null);
    await expect(
      resolveChargeable(chargeableItemResolver, 'nope', { userId }),
    ).rejects.toMatchObject({ statusCode: 404 });
  });
});

describe('creating a charge', () => {
  beforeEach(() => {
    mocks.chargeableFindFirst.mockResolvedValue(openItem);
    mocks.paymentIntentsCreate.mockResolvedValue({
      id: 'pi_1',
      status: 'succeeded',
      amount: 2500,
      currency: 'usd',
      client_secret: 'secret',
    });
  });

  it('never lets the request body influence the amount', async () => {
    await createCharge(
      userId,
      { reference: 'ref-1', amount: 1, currency: 'gbp' } as never,
      'key-1',
      stripeClient as never,
    );

    const params = mocks.paymentIntentsCreate.mock.calls[0]?.[0] as {
      amount: number;
      currency: string;
    };
    expect(params.amount).toBe(2500);
    expect(params.currency).toBe('usd');
  });

  it('does not save the card unless asked', async () => {
    await createCharge(userId, { reference: 'ref-1' }, 'key-1', stripeClient as never);
    const params = mocks.paymentIntentsCreate.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(params.setup_future_usage).toBeUndefined();
  });

  it('sets up future usage when saving is requested', async () => {
    await createCharge(
      userId,
      { reference: 'ref-1', savePaymentMethod: true },
      'key-1',
      stripeClient as never,
    );
    const params = mocks.paymentIntentsCreate.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(params.setup_future_usage).toBe('off_session');
  });

  it('charges a saved card off-session after proving ownership', async () => {
    mocks.paymentMethodFindFirst.mockResolvedValue({ stripePaymentMethodId: 'pm_saved' });

    await createCharge(
      userId,
      { reference: 'ref-1', paymentMethodId: methodId },
      'key-1',
      stripeClient as never,
    );

    const where = mocks.paymentMethodFindFirst.mock.calls[0]?.[0] as { where: { userId: string } };
    expect(where.where.userId).toBe(userId);
    const params = mocks.paymentIntentsCreate.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(params).toMatchObject({
      payment_method: 'pm_saved',
      off_session: true,
      confirm: true,
    });
  });

  it("refuses a payment method that is not the caller's", async () => {
    mocks.paymentMethodFindFirst.mockResolvedValue(null);

    await expect(
      createCharge(
        userId,
        { reference: 'ref-1', paymentMethodId: methodId },
        'key-1',
        stripeClient as never,
      ),
    ).rejects.toMatchObject({ statusCode: 404 });
    expect(mocks.paymentIntentsCreate).not.toHaveBeenCalled();
  });

  it('passes a per-user idempotency key to Stripe', async () => {
    await createCharge(userId, { reference: 'ref-1' }, 'key-1', stripeClient as never);
    const options = mocks.paymentIntentsCreate.mock.calls[0]?.[1] as { idempotencyKey: string };
    expect(options.idempotencyKey).toBe(`charge:user:${userId}:h:key-1`);
  });

  it('returns the 3DS challenge instead of treating it as a decline', async () => {
    // Stripe throws rather than returns when an off-session charge needs authentication. Losing
    // the client secret here is what makes saved cards silently fail for SCA-region customers.
    mocks.paymentMethodFindFirst.mockResolvedValue({ stripePaymentMethodId: 'pm_saved' });
    mocks.paymentIntentsCreate.mockRejectedValue(
      Object.assign(new Error('authentication required'), {
        code: 'authentication_required',
        raw: {
          payment_intent: {
            id: 'pi_2',
            status: 'requires_action',
            amount: 2500,
            currency: 'usd',
            client_secret: 'secret_2',
          },
        },
      }),
    );

    const result = await createCharge(
      userId,
      { reference: 'ref-1', paymentMethodId: methodId },
      'key-1',
      stripeClient as never,
    );

    expect(result).toMatchObject({
      id: 'pi_2',
      requiresAction: true,
      clientSecret: 'secret_2',
    });
  });

  it('rethrows genuine card errors', async () => {
    mocks.paymentIntentsCreate.mockRejectedValue(
      Object.assign(new Error('card declined'), { code: 'card_declined' }),
    );
    await expect(
      createCharge(userId, { reference: 'ref-1' }, 'key-1', stripeClient as never),
    ).rejects.toThrow(/card declined/);
  });
});
