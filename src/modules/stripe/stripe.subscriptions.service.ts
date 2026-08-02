import { errors } from '#app/lib/errors.js';
import { prisma } from '#app/lib/prisma.js';
import { requireStripe, type StripeClient } from '#app/modules/stripe/stripe.client.js';
import {
  ensureCustomer,
  resolvePrice,
  safeRedirectUrl,
} from '#app/modules/stripe/stripe.shared.js';

export async function listSubscriptions(
  userId: string,
  input: { cursor?: string; limit: number },
  stripeClient: StripeClient | null,
): Promise<{
  subscriptions: Array<{
    id: string;
    status: string;
    cancelAtPeriodEnd: boolean;
    currentPeriodStart: Date | null;
    currentPeriodEnd: Date | null;
    priceId: string | null;
  }>;
  nextCursor: string | null;
}> {
  const client = requireStripe(stripeClient);
  const customerId = await ensureCustomer(userId, stripeClient);
  const subscriptions = await client.subscriptions.list({
    customer: customerId,
    status: 'all',
    limit: input.limit,
    ...(input.cursor ? { starting_after: input.cursor } : {}),
  });
  const result = subscriptions.data.map((subscription) => ({
    id: subscription.id,
    status: subscription.status,
    cancelAtPeriodEnd: subscription.cancel_at_period_end,
    currentPeriodStart: subscription.items.data[0]?.current_period_start
      ? new Date(subscription.items.data[0].current_period_start * 1_000)
      : null,
    currentPeriodEnd: subscription.items.data[0]?.current_period_end
      ? new Date(subscription.items.data[0].current_period_end * 1_000)
      : null,
    priceId: subscription.items.data[0]?.price.id ?? null,
  }));
  return {
    subscriptions: result,
    nextCursor: subscriptions.has_more ? (subscriptions.data.at(-1)?.id ?? null) : null,
  };
}

export async function cancelSubscription(
  userId: string,
  subscriptionId: string,
  stripeClient: StripeClient | null,
): Promise<{
  id: string;
  status: string;
  cancelAtPeriodEnd: boolean;
  canceledAt: Date | null;
}> {
  const client = requireStripe(stripeClient);
  const customerId = await ensureCustomer(userId, stripeClient);
  const subscription = await client.subscriptions.retrieve(subscriptionId);
  const subscriptionCustomerId =
    typeof subscription.customer === 'string' ? subscription.customer : subscription.customer.id;
  if (subscriptionCustomerId !== customerId) throw errors.notFound('Subscription not found');
  const updated = await client.subscriptions.update(subscriptionId, { cancel_at_period_end: true });
  return {
    id: updated.id,
    status: updated.status,
    cancelAtPeriodEnd: updated.cancel_at_period_end,
    canceledAt: updated.canceled_at ? new Date(updated.canceled_at * 1_000) : null,
  };
}

export async function resumeSubscription(
  userId: string,
  subscriptionId: string,
  stripeClient: StripeClient | null,
): Promise<{ id: string; status: string; cancelAtPeriodEnd: boolean }> {
  const client = requireStripe(stripeClient);
  const customerId = await ensureCustomer(userId, stripeClient);
  const subscription = await client.subscriptions.retrieve(subscriptionId);
  const owner =
    typeof subscription.customer === 'string' ? subscription.customer : subscription.customer.id;
  if (owner !== customerId) throw errors.notFound('Subscription not found');
  const updated = await client.subscriptions.update(subscriptionId, {
    cancel_at_period_end: false,
  });
  return {
    id: updated.id,
    status: updated.status,
    cancelAtPeriodEnd: updated.cancel_at_period_end,
  };
}

export async function changeSubscriptionPrice(
  userId: string,
  subscriptionId: string,
  input: { priceKey: string; prorationBehavior: 'always_invoice' | 'create_prorations' | 'none' },
  stripeClient: StripeClient | null,
): Promise<{ id: string; status: string; priceId: string | null; cancelAtPeriodEnd: boolean }> {
  const client = requireStripe(stripeClient);
  const customerId = await ensureCustomer(userId, stripeClient);
  const subscription = await client.subscriptions.retrieve(subscriptionId);
  const owner =
    typeof subscription.customer === 'string' ? subscription.customer : subscription.customer.id;
  if (owner !== customerId) throw errors.notFound('Subscription not found');
  const item = subscription.items.data[0];
  if (!item) throw errors.conflict('Subscription has no changeable item');
  const { priceId, priceKey } = resolvePrice(input.priceKey);
  const updated = await client.subscriptions.update(subscriptionId, {
    items: [{ id: item.id, price: priceId }],
    proration_behavior: input.prorationBehavior,
    cancel_at_period_end: false,
    metadata: { ...subscription.metadata, userId, priceKey },
  });
  return {
    id: updated.id,
    status: updated.status,
    priceId: updated.items.data[0]?.price.id ?? null,
    cancelAtPeriodEnd: updated.cancel_at_period_end,
  };
}

export async function createBillingPortalSession(
  userId: string,
  returnUrl: string | undefined,
  stripeClient: StripeClient | null,
) {
  const client = requireStripe(stripeClient);
  const customer = await ensureCustomer(userId, stripeClient);
  const session = await client.billingPortal.sessions.create({
    customer,
    return_url: safeRedirectUrl(returnUrl, '/billing'),
  });
  return { id: session.id, url: session.url };
}

/** Immediately terminates every non-terminal subscription before account erasure. */
export async function cancelAllUserSubscriptions(
  userId: string,
  stripeClient: StripeClient | null,
): Promise<number> {
  if (!stripeClient) return 0;
  const user = await prisma.user.findFirst({
    where: { id: userId, deletedAt: null },
    select: { stripeCustomerId: true },
  });
  if (!user?.stripeCustomerId) return 0;
  let startingAfter: string | undefined;
  let canceled = 0;
  do {
    const page = await stripeClient.subscriptions.list({
      customer: user.stripeCustomerId,
      status: 'all',
      limit: 100,
      ...(startingAfter ? { starting_after: startingAfter } : {}),
    });
    for (const subscription of page.data) {
      if (!['canceled', 'incomplete_expired'].includes(subscription.status)) {
        await stripeClient.subscriptions.cancel(subscription.id, {
          invoice_now: false,
          prorate: false,
        });
        canceled += 1;
      }
    }
    startingAfter = page.has_more ? page.data.at(-1)?.id : undefined;
  } while (startingAfter);
  return canceled;
}
