import { enforceRateLimit } from '#app/lib/rate-limit.js';
import type { RequestMetadata } from '#app/lib/request-metadata.js';

const failClosed = { redisFailureMode: 'deny' as const };

type PublicAuthEndpoint =
  | 'signup'
  | 'login'
  | 'otp-send'
  | 'otp-verify'
  | 'password-reset-request'
  | 'password-reset-verify'
  | 'password-reset-confirm';

const policy: Record<PublicAuthEndpoint, { ipLimit: number; globalLimit: number; window: number }> =
  {
    signup: { ipLimit: 100, globalLimit: 20_000, window: 60 * 60 },
    login: { ipLimit: 300, globalLimit: 100_000, window: 15 * 60 },
    'otp-send': { ipLimit: 300, globalLimit: 20_000, window: 10 * 60 },
    'otp-verify': { ipLimit: 600, globalLimit: 50_000, window: 10 * 60 },
    'password-reset-request': { ipLimit: 100, globalLimit: 20_000, window: 60 * 60 },
    'password-reset-verify': { ipLimit: 300, globalLimit: 50_000, window: 10 * 60 },
    'password-reset-confirm': { ipLimit: 100, globalLimit: 20_000, window: 10 * 60 },
  };

/**
 * High shared-IP ceilings protect finite CPU/provider capacity without treating an office NAT
 * as one account. Tight destination buckets stay in the controller and are always independent.
 */
export async function enforceAuthBackstops(
  endpoint: PublicAuthEndpoint,
  metadata: RequestMetadata,
  provider?: 'email' | 'sms',
): Promise<void> {
  const value = policy[endpoint];
  await Promise.all([
    enforceRateLimit(`auth:${endpoint}:ip`, metadata.ip, value.ipLimit, value.window, failClosed),
    enforceRateLimit(`auth:${endpoint}:global`, 'all', value.globalLimit, value.window, {
      ...failClosed,
      alertAtRatio: 0.8,
    }),
    ...(provider
      ? [
          enforceRateLimit(`provider-spend:${provider}`, 'all', 10_000, 60 * 60, {
            ...failClosed,
            alertAtRatio: 0.8,
          }),
        ]
      : []),
  ]);
}
