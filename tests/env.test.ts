import { describe, expect, it } from 'vitest';
import { parseEnv } from '../dist/src/config/env.js';

const validDevelopmentEnv: NodeJS.ProcessEnv = {
  NODE_ENV: 'development',
  DATABASE_URL: 'postgresql://localhost/app?connection_limit=10',
  DIRECT_DATABASE_URL: 'postgresql://localhost/app',
  REDIS_URL: 'redis://localhost:6379',
  JWT_ACCESS_SECRET: 'a'.repeat(32),
  TOKEN_HASH_SECRET: 'b'.repeat(32),
  COOKIE_SECRET: 'c'.repeat(32),
};

describe('environment validation', () => {
  it('applies safe development defaults', () => {
    const result = parseEnv(validDevelopmentEnv);
    expect(result.ACCESS_TOKEN_TTL_MINUTES).toBe(15);
    expect(result.REFRESH_TOKEN_TTL_DAYS).toBe(30);
    expect(result.COOKIE_SECURE).toBe(false);
    expect(result.RATE_LIMIT_FALLBACK_MAX_KEYS).toBe(10_000);
    expect(result.DATA_RETENTION_DAYS).toBe(30);
    expect(result.AUDIT_RETENTION_DAYS).toBe(365);
    expect(result.RETENTION_BATCH_SIZE).toBe(500);
    expect(result.WORKER_CHANNELS).toEqual(['EMAIL', 'SMS', 'PUSH', 'INTERNAL']);
    expect(result.REFUND_SELF_SERVICE_ENABLED).toBe(false);
    expect(result.UPLOAD_PROVIDER).toBe('disabled');
  });

  it('defaults tenancy to the current single-tenant behavior', () => {
    expect(parseEnv(validDevelopmentEnv).TENANCY_MODE).toBe('disabled');
    expect(parseEnv({ ...validDevelopmentEnv, TENANCY_MODE: 'multi' }).TENANCY_MODE).toBe('multi');
    expect(() => parseEnv({ ...validDevelopmentEnv, TENANCY_MODE: 'sometimes' })).toThrow(
      /TENANCY_MODE/,
    );
  });

  it('defaults the per-IP ceiling and validates the allowlist', () => {
    expect(parseEnv(validDevelopmentEnv).RATE_LIMIT_IP_PER_MINUTE).toBe(600);
    expect(parseEnv(validDevelopmentEnv).RATE_LIMIT_ALLOWLIST_CIDRS).toEqual([]);
    expect(
      parseEnv({
        ...validDevelopmentEnv,
        RATE_LIMIT_ALLOWLIST_CIDRS: '10.0.0.0/8, 2001:db8::/32',
      }).RATE_LIMIT_ALLOWLIST_CIDRS,
    ).toEqual(['10.0.0.0/8', '2001:db8::/32']);
    expect(() =>
      parseEnv({ ...validDevelopmentEnv, RATE_LIMIT_ALLOWLIST_CIDRS: 'not-an-ip' }),
    ).toThrow(/RATE_LIMIT_ALLOWLIST_CIDRS/);
  });

  it('rejects short secrets', () => {
    expect(() => parseEnv({ ...validDevelopmentEnv, JWT_ACCESS_SECRET: 'short' })).toThrow(
      /JWT_ACCESS_SECRET/,
    );
  });

  it('fails closed when production providers are missing', () => {
    expect(() => parseEnv({ ...validDevelopmentEnv, NODE_ENV: 'production' })).toThrow(
      /UPLOAD_SCAN_MODE|COOKIE_SECURE|AUDIT_INTEGRITY_SECRET|EMAIL_PROVIDER/,
    );
  });

  it('requires a server-owned price catalogue whenever Stripe is enabled', () => {
    expect(() =>
      parseEnv({
        ...validDevelopmentEnv,
        BILLING_ENABLED: 'true',
        STRIPE_SECRET_KEY: 'sk_test_configured',
      }),
    ).toThrow(/STRIPE_PRICE_CATALOG/);
  });

  it('parses catalogue keys and requires the default key to exist', () => {
    const result = parseEnv({
      ...validDevelopmentEnv,
      BILLING_ENABLED: 'true',
      STRIPE_SECRET_KEY: 'sk_test_configured',
      STRIPE_WEBHOOK_SECRET: 'whsec_configured',
      STRIPE_PRICE_CATALOG: '{"starter":"price_123","pro":"price_456"}',
      STRIPE_DEFAULT_PRICE_KEY: 'starter',
    });

    expect(result.STRIPE_PRICE_CATALOG).toEqual({ starter: 'price_123', pro: 'price_456' });
    expect(() =>
      parseEnv({
        ...validDevelopmentEnv,
        BILLING_ENABLED: 'true',
        STRIPE_SECRET_KEY: 'sk_test_configured',
        STRIPE_WEBHOOK_SECRET: 'whsec_configured',
        STRIPE_PRICE_CATALOG: '{"starter":"price_123"}',
        STRIPE_DEFAULT_PRICE_KEY: 'missing',
      }),
    ).toThrow(/STRIPE_DEFAULT_PRICE_KEY/);
  });

  it('requires per-currency limits for self-service refunds', () => {
    expect(() => parseEnv({ ...validDevelopmentEnv, REFUND_SELF_SERVICE_ENABLED: 'true' })).toThrow(
      /REFUND_MAX_AMOUNT_BY_CURRENCY/,
    );

    expect(
      parseEnv({
        ...validDevelopmentEnv,
        REFUND_SELF_SERVICE_ENABLED: 'true',
        REFUND_MAX_AMOUNT_BY_CURRENCY: '{"usd":5000}',
      }).REFUND_MAX_AMOUNT_BY_CURRENCY,
    ).toEqual({ usd: 5_000 });
  });

  it('validates the selected upload provider configuration', () => {
    expect(() => parseEnv({ ...validDevelopmentEnv, UPLOAD_PROVIDER: 's3' })).toThrow(/S3_BUCKET/);
    expect(
      parseEnv({
        ...validDevelopmentEnv,
        UPLOAD_PROVIDER: 's3',
        S3_BUCKET: 'uploads',
        S3_REGION: 'us-east-1',
      }).UPLOAD_PROVIDER,
    ).toBe('s3');
  });
});
