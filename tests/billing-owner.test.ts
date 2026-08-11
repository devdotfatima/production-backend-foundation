import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  billingOwner: 'user',
  organizationId: undefined as string | undefined,
  userFindFirst: vi.fn(),
  userUpdate: vi.fn(),
  organizationFindFirst: vi.fn(),
  organizationUpdate: vi.fn(),
  customersCreate: vi.fn(),
}));

vi.mock('#app/config/env.js', () => ({
  env: {
    get BILLING_OWNER() {
      return mocks.billingOwner;
    },
    APP_ORIGIN: 'http://localhost:3000',
    STRIPE_PRICE_CATALOG: {},
    STRIPE_DEFAULT_PRICE_KEY: '',
  },
}));
vi.mock('#app/lib/prisma.js', () => ({
  prisma: {
    user: { findFirst: mocks.userFindFirst, update: mocks.userUpdate },
    organization: { findFirst: mocks.organizationFindFirst, update: mocks.organizationUpdate },
  },
}));
vi.mock('#app/lib/request-context.js', () => ({
  getRequestContext: () => ({
    kind: 'request',
    requestId: 'req-1',
    organizationId: mocks.organizationId,
  }),
}));

import {
  ensureCustomer,
  getBillingCustomerId,
  resolveBillingOwner,
} from '../dist/src/modules/stripe/stripe.shared.js';

const userId = '00000000-0000-7000-8000-0000000000a1';
const orgId = '00000000-0000-7000-8000-00000000000a';
const stripeClient = { customers: { create: mocks.customersCreate } };

beforeEach(() => {
  vi.clearAllMocks();
  mocks.billingOwner = 'user';
  mocks.organizationId = undefined;
});

describe('billing owner resolution', () => {
  it('defaults to the user', () => {
    expect(resolveBillingOwner(userId)).toEqual({ type: 'user', userId });
  });

  it('ignores the active organization while the user owns billing', () => {
    mocks.organizationId = orgId;
    expect(resolveBillingOwner(userId)).toEqual({ type: 'user', userId });
  });

  it('resolves the active organization when it owns billing', () => {
    mocks.billingOwner = 'organization';
    mocks.organizationId = orgId;
    expect(resolveBillingOwner(userId)).toEqual({
      type: 'organization',
      organizationId: orgId,
      userId,
    });
  });

  it('refuses organization billing with no active organization', () => {
    // Falling back to the user here would silently bill the wrong entity.
    mocks.billingOwner = 'organization';
    expect(() => resolveBillingOwner(userId)).toThrow(/active organization is required/);
  });
});

describe('customer creation follows the owner', () => {
  it('creates and stores a user customer', async () => {
    mocks.userFindFirst.mockResolvedValue({
      id: userId,
      email: 'a@b.com',
      displayName: 'A',
      stripeCustomerId: null,
    });
    mocks.customersCreate.mockResolvedValue({ id: 'cus_user' });

    await expect(ensureCustomer(userId, stripeClient as never)).resolves.toBe('cus_user');

    expect(mocks.userUpdate).toHaveBeenCalled();
    expect(mocks.organizationUpdate).not.toHaveBeenCalled();
    const created = mocks.customersCreate.mock.calls[0]?.[0] as { metadata?: { userId?: string } };
    expect(created.metadata?.userId).toBe(userId);
  });

  it('creates and stores an organization customer', async () => {
    mocks.billingOwner = 'organization';
    mocks.organizationId = orgId;
    mocks.organizationFindFirst.mockResolvedValue({
      id: orgId,
      name: 'Acme',
      stripeCustomerId: null,
    });
    mocks.customersCreate.mockResolvedValue({ id: 'cus_org' });

    await expect(ensureCustomer(userId, stripeClient as never)).resolves.toBe('cus_org');

    expect(mocks.organizationUpdate).toHaveBeenCalled();
    expect(mocks.userUpdate).not.toHaveBeenCalled();
    const created = mocks.customersCreate.mock.calls[0]?.[0] as {
      metadata?: { organizationId?: string };
    };
    expect(created.metadata?.organizationId).toBe(orgId);
  });

  it('reuses an existing organization customer instead of creating a second one', async () => {
    mocks.billingOwner = 'organization';
    mocks.organizationId = orgId;
    mocks.organizationFindFirst.mockResolvedValue({
      id: orgId,
      name: 'Acme',
      stripeCustomerId: 'cus_existing',
    });

    await expect(ensureCustomer(userId, stripeClient as never)).resolves.toBe('cus_existing');
    expect(mocks.customersCreate).not.toHaveBeenCalled();
  });

  it('keys the idempotent create per owner so the two namespaces cannot collide', async () => {
    mocks.billingOwner = 'organization';
    mocks.organizationId = orgId;
    mocks.organizationFindFirst.mockResolvedValue({ id: orgId, name: 'A', stripeCustomerId: null });
    mocks.customersCreate.mockResolvedValue({ id: 'cus_org' });

    await ensureCustomer(userId, stripeClient as never);

    const options = mocks.customersCreate.mock.calls[0]?.[1] as { idempotencyKey?: string };
    expect(options.idempotencyKey).toBe(`customer:org:${orgId}`);
  });
});

describe('resolved owner customer lookup', () => {
  it('reads the organization customer when the organization pays', async () => {
    mocks.billingOwner = 'organization';
    mocks.organizationId = orgId;
    mocks.organizationFindFirst.mockResolvedValue({
      id: orgId,
      name: 'Acme',
      stripeCustomerId: 'cus_org',
    });

    await expect(getBillingCustomerId(userId)).resolves.toBe('cus_org');
    expect(mocks.userFindFirst).not.toHaveBeenCalled();
  });

  it('reads the user customer otherwise', async () => {
    mocks.userFindFirst.mockResolvedValue({ id: userId, stripeCustomerId: 'cus_user' });
    await expect(getBillingCustomerId(userId)).resolves.toBe('cus_user');
  });
});
