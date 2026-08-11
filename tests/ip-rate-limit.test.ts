import type { NextFunction, Request, Response } from 'express';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  enforceRateLimit: vi.fn(),
}));

vi.mock('#app/lib/rate-limit.js', () => ({ enforceRateLimit: mocks.enforceRateLimit }));
vi.mock('#app/lib/prisma.js', () => ({ prisma: {} }));
vi.mock('#app/lib/crypto.js', () => ({ candidateOpaqueTokenHashes: vi.fn(() => []) }));
vi.mock('#app/config/env.js', () => ({
  env: {
    RATE_LIMIT_ALLOWLIST_CIDRS: ['10.0.0.0/8', '2001:db8::/32'],
    RATE_LIMIT_IP_PER_MINUTE: 600,
  },
}));

import { ipRateLimit, isRateLimitAllowlisted } from '../dist/src/middleware/rate-limit.js';

function invoke(ip: string | undefined) {
  const next = vi.fn();
  const handler = ipRateLimit('test:scope', 5, 60);
  return {
    next,
    settled: handler({ ip } as Request, {} as Response, next as NextFunction),
  };
}

describe('per-IP rate limit middleware', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.enforceRateLimit.mockResolvedValue({ count: 1, limit: 5, retryAfterSeconds: 60 });
  });

  it('limits on the canonical bucket rather than the raw address', async () => {
    const { next, settled } = invoke('2001:dbf:1:2:3:4:5:6');
    await settled;

    expect(mocks.enforceRateLimit).toHaveBeenCalledWith(
      'test:scope',
      'ip6:2001:dbf:1:2',
      5,
      60,
      undefined,
    );
    expect(next).toHaveBeenCalledWith();
  });

  it('gives every address in one IPv6 allocation the same bucket', async () => {
    await invoke('2001:dbf:1:2::1').settled;
    await invoke('2001:dbf:1:2:ffff:ffff:ffff:ffff').settled;

    const [first, second] = mocks.enforceRateLimit.mock.calls;
    expect(first?.[1]).toBe(second?.[1]);
  });

  it('bypasses the limiter for allowlisted addresses', async () => {
    const { next, settled } = invoke('10.1.2.3');
    await settled;

    expect(mocks.enforceRateLimit).not.toHaveBeenCalled();
    expect(next).toHaveBeenCalledWith();
  });

  it('still limits addresses outside the allowlist', async () => {
    await invoke('203.0.113.7').settled;
    expect(mocks.enforceRateLimit).toHaveBeenCalledWith(
      'test:scope',
      'ip4:203.0.113.7',
      5,
      60,
      undefined,
    );
  });

  it('buckets an unresolvable address separately instead of throwing', async () => {
    const { next, settled } = invoke(undefined);
    await settled;

    expect(mocks.enforceRateLimit).toHaveBeenCalledWith(
      'test:scope',
      'ip:unresolved',
      5,
      60,
      undefined,
    );
    expect(next).toHaveBeenCalledWith();
  });

  it('forwards a rejection to the error handler', async () => {
    const rejection = new Error('rate limited');
    mocks.enforceRateLimit.mockRejectedValue(rejection);

    const { next, settled } = invoke('203.0.113.7');
    await settled;

    expect(next).toHaveBeenCalledWith(rejection);
  });

  it('exposes allowlist membership across both families', () => {
    expect(isRateLimitAllowlisted('10.255.255.254')).toBe(true);
    expect(isRateLimitAllowlisted('2001:db8:1::9')).toBe(true);
    expect(isRateLimitAllowlisted('203.0.113.7')).toBe(false);
    expect(isRateLimitAllowlisted(undefined)).toBe(false);
  });
});
