import { describe, expect, it, vi } from 'vitest';
import { createAuthService } from '../dist/src/modules/auth/auth.service.js';
import { createStripeService } from '../dist/src/modules/stripe/stripe.service.js';

describe('module dependency factories', () => {
  it('selectively replaces an auth use case without mutating the defaults', () => {
    const replacement = vi.fn();
    const service = createAuthService({ loginWithPassword: replacement });

    expect(service.loginWithPassword).toBe(replacement);
    expect(createAuthService().loginWithPassword).not.toBe(replacement);
    expect(service.rotateRefreshToken).toBeTypeOf('function');
  });

  it('selectively replaces a billing use case without module-level mocks', () => {
    const replacement = vi.fn();
    const service = createStripeService({ createCheckoutSession: replacement });

    expect(service.createCheckoutSession).toBe(replacement);
    expect(createStripeService().createCheckoutSession).not.toBe(replacement);
    expect(service.verifyAndStoreStripeEvent).toBeTypeOf('function');
  });
});
