import { Prisma } from '@prisma/client';
import { env } from '#app/config/env.js';
import { errors } from '#app/lib/errors.js';
import { prisma } from '#app/lib/prisma.js';
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

export async function ensureCustomer(
  userId: string,
  stripeClient: StripeClient | null,
): Promise<string> {
  const client = requireStripe(stripeClient);
  const user = await getBillingUser(userId);
  if (user.stripeCustomerId) return user.stripeCustomerId;

  const customer = await client.customers.create(
    {
      ...(user.email ? { email: user.email } : {}),
      ...(user.displayName ? { name: user.displayName } : {}),
      metadata: { userId },
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
