import { describe, expect, it } from 'vitest';
import {
  billingListQuerySchema,
  checkoutIdempotencyHeadersSchema,
  checkoutSessionSchema,
} from '../dist/src/modules/stripe/stripe.schemas.js';

describe('Stripe request validation', () => {
  it('accepts a catalogue key and rejects client-supplied Stripe Price IDs', () => {
    expect(checkoutSessionSchema.parse({ priceKey: 'starter' })).toMatchObject({
      mode: 'payment',
      priceKey: 'starter',
      quantity: 1,
    });
    expect(() => checkoutSessionSchema.parse({ priceId: 'price_internal' })).toThrow();
  });

  it('requires a meaningful caller idempotency key', () => {
    expect(
      checkoutIdempotencyHeadersSchema.parse({
        host: 'api.example.com',
        'idempotency-key': 'order-12345',
      }),
    ).toEqual({ 'idempotency-key': 'order-12345' });
    expect(() => checkoutIdempotencyHeadersSchema.parse({})).toThrow();
  });

  it('bounds billing pages and accepts provider cursors', () => {
    expect(billingListQuerySchema.parse({ cursor: 'sub_123', limit: '50' })).toEqual({
      cursor: 'sub_123',
      limit: 50,
    });
    expect(() => billingListQuerySchema.parse({ limit: 101 })).toThrow();
  });
});
