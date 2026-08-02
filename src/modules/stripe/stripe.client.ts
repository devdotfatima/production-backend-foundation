import Stripe from 'stripe';
import { env } from '#app/config/env.js';
import { errors } from '#app/lib/errors.js';

export type StripeClient = Stripe;

export function createStripeClient(secretKey = env.STRIPE_SECRET_KEY): StripeClient | null {
  return secretKey ? new Stripe(secretKey) : null;
}

export function requireStripe(client: StripeClient | null): StripeClient {
  if (!client) throw errors.serviceUnavailable('Stripe is not configured');
  return client;
}
