import { Prisma } from '@prisma/client';
import { env } from '#app/config/env.js';
import { errors } from '#app/lib/errors.js';
import { prisma } from '#app/lib/prisma.js';
import { getRequestContext } from '#app/lib/request-context.js';
import { requireStripe, type StripeClient } from '#app/modules/stripe/stripe.client.js';

export function resolvePrice(input?: string): { priceId: string; priceKey: string } {
  const priceKey = input ?? env.STRIPE_DEFAULT_PRICE_KEY;
  if (!priceKey) throw errors.badRequest('A Stripe priceKey is required');
  const priceId = env.STRIPE_PRICE_CATALOG[priceKey];
  if (!priceId) throw errors.badRequest('The requested Stripe price is not available');
  return { priceId, priceKey };
}

export function safeRedirectUrl(input: string | undefined, fallbackPath: string): string {
  const value = input ?? new URL(fallbackPath, env.APP_ORIGIN).toString();
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw errors.badRequest('Invalid redirect URL');
  }
  if (parsed.origin !== new URL(env.APP_ORIGIN).origin) {
    throw errors.badRequest('Redirect URL must belong to APP_ORIGIN');
  }
  return parsed.toString();
}

export async function getBillingUser(userId: string) {
  const user = await prisma.user.findFirst({
    where: { id: userId, status: 'ACTIVE', deletedAt: null },
    select: { id: true, email: true, displayName: true, stripeCustomerId: true },
  });
  if (!user) throw errors.notFound('User not found');
  return user;
}

export type BillingOwner =
  | { type: 'user'; userId: string }
  | { type: 'organization'; organizationId: string; userId: string };

/**
 * Which entity holds the Stripe customer.
 *
 * Read from the ambient request context rather than threaded through every Stripe signature, so
 * switching a client project from user-pays to organization-pays is a configuration change
 * instead of a refactor. Records still carry `userId` — this decides who is billed, not who acted.
 */
export function resolveBillingOwner(userId: string): BillingOwner {
  if (env.BILLING_OWNER !== 'organization') return { type: 'user', userId };

  const context = getRequestContext();
  const organizationId = context?.kind === 'request' ? context.organizationId : undefined;
  if (!organizationId) {
    throw errors.conflict('An active organization is required while BILLING_OWNER=organization');
  }
  return { type: 'organization', organizationId, userId };
}

export function billingOwnerKey(owner: BillingOwner): string {
  return owner.type === 'organization'
    ? `organization:${owner.organizationId}`
    : `user:${owner.userId}`;
}

/** Metadata copied to every Stripe object that can later arrive through a webhook. */
export function billingOwnerMetadata(owner: BillingOwner): Record<string, string> {
  return {
    // Kept for backwards-compatible attribution and audit of the initiating actor.
    userId: owner.userId,
    actorUserId: owner.userId,
    ...(owner.type === 'organization' ? { organizationId: owner.organizationId } : {}),
  };
}

/** Ownership columns for local projections. `userId` remains the initiating actor. */
export function billingOwnerData(owner: BillingOwner): {
  userId: string;
  organizationId: string | null;
} {
  return {
    userId: owner.userId,
    organizationId: owner.type === 'organization' ? owner.organizationId : null,
  };
}

/** Query filter that makes organization-owned records visible to authorized organization users. */
export function billingOwnerWhere(
  owner: BillingOwner,
): { organizationId: string } | { userId: string; organizationId: null } {
  return owner.type === 'organization'
    ? { organizationId: owner.organizationId }
    : { userId: owner.userId, organizationId: null };
}

async function getBillingOrganization(organizationId: string) {
  const organization = await prisma.organization.findFirst({
    where: { id: organizationId, status: 'ACTIVE', deletedAt: null },
    select: { id: true, name: true, stripeCustomerId: true },
  });
  if (!organization) throw errors.notFound('Organization not found');
  return organization;
}

/** The owner's existing Stripe customer, or null when one has never been created. */
export async function getBillingCustomerId(userId: string): Promise<string | null> {
  const owner = resolveBillingOwner(userId);
  if (owner.type === 'user') return (await getBillingUser(userId)).stripeCustomerId;
  return (await getBillingOrganization(owner.organizationId)).stripeCustomerId;
}

export async function ensureCustomer(
  userId: string,
  stripeClient: StripeClient | null,
): Promise<string> {
  const client = requireStripe(stripeClient);
  const owner = resolveBillingOwner(userId);

  if (owner.type === 'organization') {
    const organization = await getBillingOrganization(owner.organizationId);
    if (organization.stripeCustomerId) return organization.stripeCustomerId;

    const customer = await client.customers.create(
      { name: organization.name, metadata: billingOwnerMetadata(owner) },
      { idempotencyKey: `customer:org:${organization.id}` },
    );
    try {
      await prisma.organization.update({
        where: { id: organization.id },
        data: { stripeCustomerId: customer.id },
      });
    } catch (error) {
      if (!(error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002')) {
        throw error;
      }
      const refreshed = await getBillingOrganization(owner.organizationId);
      if (!refreshed.stripeCustomerId) throw error;
      return refreshed.stripeCustomerId;
    }
    return customer.id;
  }

  const user = await getBillingUser(userId);
  if (user.stripeCustomerId) return user.stripeCustomerId;

  const customer = await client.customers.create(
    {
      ...(user.email ? { email: user.email } : {}),
      ...(user.displayName ? { name: user.displayName } : {}),
      metadata: billingOwnerMetadata(owner),
    },
    { idempotencyKey: `customer:${userId}` },
  );
  try {
    await prisma.user.update({ where: { id: userId }, data: { stripeCustomerId: customer.id } });
  } catch (error) {
    if (!(error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002')) {
      throw error;
    }
    const refreshed = await getBillingUser(userId);
    if (!refreshed.stripeCustomerId) throw error;
    return refreshed.stripeCustomerId;
  }
  return customer.id;
}
