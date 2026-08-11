import { env } from '#app/config/env.js';
import { errors } from '#app/lib/errors.js';
import { prisma } from '#app/lib/prisma.js';

export interface ChargeableAmount {
  /** Minor units. Computed server-side; never taken from a request body. */
  amount: number;
  currency: string;
  description: string;
  metadata: Record<string, string>;
}

export interface ReservedChargeable extends ChargeableAmount {
  reservationId: string;
  reservationKeyHash: string;
}

type ChargeableContext = { userId: string };
type ReservationContext = ChargeableContext & { reservationKeyHash: string };

/**
 * Resolves what a `reference` costs.
 *
 * This is the seam each client project implements against its own domain — an order, a booking,
 * a quote, an invoice. The template ships a table-backed default for projects that have no such
 * entity yet. The charge API deliberately accepts only a reference: if a request body could
 * influence the amount, the endpoint is a free-money endpoint.
 */
export interface ChargeableResolver {
  resolve(reference: string, context: ChargeableContext): Promise<ChargeableAmount>;
  /**
   * Atomically claims the domain object before provider I/O. Custom resolvers used by the charge
   * endpoint must implement this against their own order/invoice state machine.
   */
  reserve?(reference: string, context: ReservationContext): Promise<ReservedChargeable>;
  recordPaymentIntent?(
    reservation: ReservedChargeable,
    paymentIntentId: string,
    succeeded: boolean,
  ): Promise<void>;
}

/**
 * Rejects an amount that a pricing bug (or a compromised resolver) could otherwise turn into a
 * catastrophic charge. Deliberately applied to *every* resolver, including custom ones.
 */
export function assertChargeableWithinBounds(chargeable: ChargeableAmount): void {
  const currency = chargeable.currency.toLowerCase();

  if (!Number.isInteger(chargeable.amount) || chargeable.amount < 1) {
    throw errors.badRequest('Chargeable amount must be a positive integer in minor units');
  }
  if (!env.CHARGE_ALLOWED_CURRENCIES.includes(currency)) {
    throw errors.badRequest(`Currency ${currency} is not enabled for charges`);
  }

  const maximum = env.CHARGE_MAX_AMOUNT_BY_CURRENCY[currency];
  if (maximum === undefined) {
    throw errors.badRequest(`No maximum charge amount is configured for ${currency}`);
  }
  if (chargeable.amount > maximum) {
    throw errors.badRequest(`Charge amount exceeds the configured maximum for ${currency}`);
  }

  const minimum = env.CHARGE_MIN_AMOUNT_BY_CURRENCY[currency];
  if (minimum !== undefined && chargeable.amount < minimum) {
    throw errors.badRequest(`Charge amount is below the configured minimum for ${currency}`);
  }
}

/** Default resolver: the amount is whatever the server previously recorded for this reference. */
const chargeableItemSelect = {
  id: true,
  amount: true,
  currency: true,
  description: true,
  userId: true,
  status: true,
  reservationKeyHash: true,
  expiresAt: true,
} as const;

function assertItemOwnerAndExpiry(
  item: { userId: string | null; expiresAt: Date | null },
  userId: string,
): void {
  if (item.expiresAt && item.expiresAt <= new Date()) {
    throw errors.conflict('That chargeable item has expired');
  }
  if (item.userId && item.userId !== userId) {
    throw errors.notFound('No chargeable item for that reference');
  }
}

function itemAmount(item: {
  amount: number;
  currency: string;
  description: string;
  id?: string;
}): ChargeableAmount {
  return {
    amount: item.amount,
    currency: item.currency.toLowerCase(),
    description: item.description,
    metadata: {
      ...(item.id ? { chargeableItemId: item.id } : {}),
    },
  };
}

export const chargeableItemResolver: ChargeableResolver = {
  async resolve(reference, context) {
    const item = await prisma.chargeableItem.findFirst({
      where: { reference, status: 'OPEN', deletedAt: null },
      select: chargeableItemSelect,
    });
    if (!item) throw errors.notFound('No open chargeable item for that reference');
    assertItemOwnerAndExpiry(item, context.userId);
    return { ...itemAmount(item), metadata: { reference, chargeableItemId: item.id } };
  },

  async reserve(reference, context) {
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const item = await prisma.chargeableItem.findFirst({
        where: { reference, deletedAt: null },
        select: chargeableItemSelect,
      });
      if (!item) throw errors.notFound('No chargeable item for that reference');
      assertItemOwnerAndExpiry(item, context.userId);

      if (item.status === 'RESERVED') {
        if (item.reservationKeyHash !== context.reservationKeyHash) {
          throw errors.conflict('That chargeable item is already reserved for another payment');
        }
        return {
          ...itemAmount(item),
          metadata: { reference, chargeableItemId: item.id },
          reservationId: item.id,
          reservationKeyHash: context.reservationKeyHash,
        };
      }
      if (item.status !== 'OPEN') {
        throw errors.conflict(`That chargeable item is ${item.status.toLowerCase()}`);
      }

      const reserved = await prisma.chargeableItem.updateMany({
        where: { id: item.id, status: 'OPEN', deletedAt: null },
        data: {
          status: 'RESERVED',
          reservationKeyHash: context.reservationKeyHash,
          reservedAt: new Date(),
        },
      });
      if (reserved.count !== 1) continue;

      return {
        ...itemAmount(item),
        metadata: { reference, chargeableItemId: item.id },
        reservationId: item.id,
        reservationKeyHash: context.reservationKeyHash,
      };
    }
    throw errors.conflict('That chargeable item changed while it was being reserved');
  },

  async recordPaymentIntent(reservation, paymentIntentId, succeeded) {
    const updated = await prisma.chargeableItem.updateMany({
      where: {
        id: reservation.reservationId,
        status: 'RESERVED',
        reservationKeyHash: reservation.reservationKeyHash,
        OR: [{ paymentIntentId: null }, { paymentIntentId }],
      },
      data: {
        paymentIntentId,
        ...(succeeded ? { status: 'CONSUMED', consumedAt: new Date() } : {}),
      },
    });
    if (updated.count !== 1) {
      throw errors.conflict('Chargeable item reservation no longer belongs to this payment');
    }
  },
};

export function requireDynamicPricing(): void {
  if (!env.DYNAMIC_PRICING_ENABLED) {
    throw errors.conflict('Dynamic pricing is disabled; set DYNAMIC_PRICING_ENABLED=true');
  }
}

/** Resolves and validates in one step so no caller can skip the bounds check. */
export async function resolveChargeable(
  resolver: ChargeableResolver,
  reference: string,
  context: { userId: string },
): Promise<ChargeableAmount> {
  requireDynamicPricing();
  const chargeable = await resolver.resolve(reference, context);
  const normalised = { ...chargeable, currency: chargeable.currency.toLowerCase() };
  assertChargeableWithinBounds(normalised);
  return normalised;
}

/** The charge endpoint requires a reservation-capable resolver; a read-only resolver is unsafe. */
export async function reserveChargeable(
  resolver: ChargeableResolver,
  reference: string,
  context: ReservationContext,
): Promise<ReservedChargeable> {
  requireDynamicPricing();
  if (!resolver.reserve) {
    throw errors.serviceUnavailable(
      'The configured chargeable resolver does not implement atomic reservation',
    );
  }
  const chargeable = await resolver.reserve(reference, context);
  const normalised = { ...chargeable, currency: chargeable.currency.toLowerCase() };
  assertChargeableWithinBounds(normalised);
  return normalised;
}
