import 'dotenv/config';
import { z } from 'zod';

const booleanFromString = z
  .enum(['true', 'false'])
  .default('false')
  .transform((value) => value === 'true');

const optionalUrl = z.union([z.url(), z.literal('')]).default('');

const commaSeparatedList = z
  .string()
  .default('')
  .transform((value) => [
    ...new Set(
      value
        .split(',')
        .map((item) => item.trim())
        .filter(Boolean),
    ),
  ]);

const corsOrigins = commaSeparatedList.pipe(z.array(z.url()).max(50));

const trustedProxyCidrs = commaSeparatedList.pipe(
  z
    .array(
      z
        .string()
        .refine(
          (value) =>
            value === 'loopback' ||
            value === 'linklocal' ||
            value === 'uniquelocal' ||
            /^(?:\d{1,3}\.){3}\d{1,3}(?:\/\d{1,2})?$/.test(value) ||
            /^[0-9a-f:]+(?:\/\d{1,3})?$/i.test(value),
          'must be an IP address, CIDR, or Express proxy range name',
        ),
    )
    .max(50),
);

const cryptoKeyring = z
  .string()
  .default('')
  .transform((value, context): Record<string, string> => {
    if (!value.trim()) return {};
    let parsed: unknown;
    try {
      parsed = JSON.parse(value);
    } catch {
      context.addIssue({ code: 'custom', message: 'must be a valid JSON object' });
      return {};
    }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      context.addIssue({ code: 'custom', message: 'must be a JSON object' });
      return {};
    }
    const result: Record<string, string> = {};
    for (const [keyId, secret] of Object.entries(parsed)) {
      if (
        !/^[a-zA-Z0-9_-]{1,32}$/.test(keyId) ||
        typeof secret !== 'string' ||
        secret.length < 32
      ) {
        context.addIssue({
          code: 'custom',
          message: 'must map safe key IDs to secrets of at least 32 characters',
        });
        continue;
      }
      result[keyId] = secret;
    }
    return result;
  });

const stripeCatalogKeyPattern = /^[a-z][a-z0-9_-]{0,63}$/;
const stripePriceIdPattern = /^price_[A-Za-z0-9]+$/;

const stripePriceCatalog = z
  .string()
  .default('')
  .transform((value, context): Record<string, string> => {
    if (!value.trim()) return {};

    let parsed: unknown;
    try {
      parsed = JSON.parse(value);
    } catch {
      context.addIssue({ code: 'custom', message: 'must be a valid JSON object' });
      return {};
    }

    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      context.addIssue({ code: 'custom', message: 'must be a JSON object' });
      return {};
    }

    const catalogue: Record<string, string> = {};
    for (const [key, priceId] of Object.entries(parsed)) {
      if (!stripeCatalogKeyPattern.test(key)) {
        context.addIssue({
          code: 'custom',
          message: `contains invalid catalogue key ${JSON.stringify(key)}`,
        });
        continue;
      }
      if (typeof priceId !== 'string' || !stripePriceIdPattern.test(priceId)) {
        context.addIssue({
          code: 'custom',
          message: `catalogue key ${JSON.stringify(key)} must map to a Stripe Price ID`,
        });
        continue;
      }
      catalogue[key] = priceId;
    }
    return catalogue;
  });

const refundAmountLimits = z
  .string()
  .default('')
  .transform((value, context): Record<string, number> => {
    if (!value.trim()) return {};

    let parsed: unknown;
    try {
      parsed = JSON.parse(value);
    } catch {
      context.addIssue({ code: 'custom', message: 'must be a valid JSON object' });
      return {};
    }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      context.addIssue({ code: 'custom', message: 'must be a JSON object' });
      return {};
    }

    const limits: Record<string, number> = {};
    for (const [currency, amount] of Object.entries(parsed)) {
      if (!/^[a-z]{3}$/.test(currency) || !Number.isInteger(amount) || Number(amount) < 1) {
        context.addIssue({
          code: 'custom',
          message: 'must map lowercase ISO currency codes to positive minor-unit integers',
        });
        continue;
      }
      limits[currency] = Number(amount);
    }
    return limits;
  });

const mimeTypeList = z
  .string()
  .default('image/jpeg,image/png,image/webp,application/pdf')
  .transform((value) => [
    ...new Set(
      value
        .split(',')
        .map((item) => item.trim().toLowerCase())
        .filter(Boolean),
    ),
  ])
  .pipe(
    z.array(z.string().regex(/^[a-z0-9][a-z0-9!#$&^_.+-]*\/[a-z0-9][a-z0-9!#$&^_.+-]*$/)).min(1),
  );

const workerChannels = z
  .string()
  .default('EMAIL,SMS,PUSH,INTERNAL')
  .transform((value) => [...new Set(value.split(',').map((item) => item.trim().toUpperCase()))])
  .pipe(z.array(z.enum(['EMAIL', 'SMS', 'PUSH', 'INTERNAL'])).min(1));

const envSchema = z
  .object({
    NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
    HOST: z.string().default('0.0.0.0'),
    PORT: z.coerce.number().int().min(1).max(65_535).default(4000),
    LOG_LEVEL: z
      .enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent'])
      .default('info'),
    APP_ORIGIN: z.url().default('http://localhost:3000'),
    CORS_ALLOWED_ORIGINS: corsOrigins,
    TRUST_PROXY_HOPS: z.coerce.number().int().min(0).max(20).default(0),
    TRUST_PROXY_CIDRS: trustedProxyCidrs,
    DATABASE_URL: z.string().min(1),
    DIRECT_DATABASE_URL: z.string().min(1),
    REDIS_URL: z.url(),
    QUEUE_PREFIX: z.string().min(1).default('backend-foundation'),
    WORKER_CHANNELS: workerChannels,
    EMAIL_WORKER_CONCURRENCY: z.coerce.number().int().min(1).max(100).default(5),
    EMAIL_HOURLY_SEND_LIMIT: z.coerce.number().int().min(1).max(10_000_000).default(10_000),
    SMS_WORKER_CONCURRENCY: z.coerce.number().int().min(1).max(100).default(5),
    SMS_HOURLY_SEND_LIMIT: z.coerce.number().int().min(1).max(10_000_000).default(10_000),
    PUSH_WORKER_CONCURRENCY: z.coerce.number().int().min(1).max(100).default(10),
    INTERNAL_WORKER_CONCURRENCY: z.coerce.number().int().min(1).max(100).default(5),
    RATE_LIMIT_FALLBACK_MAX_KEYS: z.coerce.number().int().min(100).max(100_000).default(10_000),
    JWT_ACCESS_SECRET: z.string().min(32),
    TOKEN_HASH_SECRET: z.string().min(32),
    CRYPTO_ACTIVE_KEY_ID: z
      .string()
      .regex(/^[a-zA-Z0-9_-]{1,32}$/)
      .default('legacy'),
    CRYPTO_KEYRING: cryptoKeyring,
    COOKIE_SECRET: z.string().min(32),
    ACCESS_TOKEN_TTL_MINUTES: z.coerce.number().int().min(5).max(30).default(15),
    REFRESH_TOKEN_TTL_DAYS: z.coerce.number().int().min(1).max(90).default(30),
    PASSWORD_RESET_TOKEN_TTL_MINUTES: z.coerce.number().int().min(5).max(30).default(10),
    COOKIE_SECURE: booleanFromString,
    COOKIE_SAME_SITE: z.enum(['strict', 'lax', 'none']).default('lax'),
    BOOTSTRAP_ADMIN_EMAIL: z.union([z.email(), z.literal('')]).default(''),
    SENTRY_DSN: optionalUrl,
    SENTRY_ENVIRONMENT: z.string().default('development'),
    SENTRY_TRACES_SAMPLE_RATE: z.coerce.number().min(0).max(1).default(0),
    EMAIL_FROM: z.email().default('no-reply@example.com'),
    SMTP_HOST: z.string().default(''),
    SMTP_PORT: z.coerce.number().int().min(1).max(65_535).default(587),
    SMTP_SECURE: booleanFromString,
    SMTP_USER: z.string().default(''),
    SMTP_PASSWORD: z.string().default(''),
    TWILIO_ACCOUNT_SID: z.string().default(''),
    TWILIO_AUTH_TOKEN: z.string().default(''),
    TWILIO_FROM: z.string().default(''),
    FIREBASE_SERVICE_ACCOUNT_JSON: z.string().default(''),
    STRIPE_SECRET_KEY: z.string().default(''),
    STRIPE_WEBHOOK_SECRET: z.string().default(''),
    STRIPE_DEFAULT_PRICE_KEY: z
      .union([z.string().regex(stripeCatalogKeyPattern), z.literal('')])
      .default(''),
    STRIPE_PRICE_CATALOG: stripePriceCatalog,
    REFUND_SELF_SERVICE_ENABLED: booleanFromString,
    REFUND_WINDOW_DAYS: z.coerce.number().int().min(1).max(365).default(30),
    REFUND_MAX_AMOUNT_BY_CURRENCY: refundAmountLimits,
    GOOGLE_CLIENT_ID: z.string().default(''),
    APPLE_CLIENT_ID: z.string().default(''),
    AUDIT_INTEGRITY_SECRET: z.string().default(''),
    DATA_RETENTION_DAYS: z.coerce.number().int().min(1).max(3_650).default(30),
    AUDIT_RETENTION_DAYS: z.coerce.number().int().min(0).max(3_650).default(365),
    RETENTION_BATCH_SIZE: z.coerce.number().int().min(1).max(5_000).default(500),
    UPLOAD_PROVIDER: z.enum(['disabled', 's3', 'cloudinary']).default('disabled'),
    UPLOAD_MAX_BYTES: z.coerce
      .number()
      .int()
      .min(1_024)
      .max(5 * 1_024 * 1_024 * 1_024)
      .default(10 * 1_024 * 1_024),
    UPLOAD_ALLOWED_MIME_TYPES: mimeTypeList,
    UPLOAD_URL_TTL_SECONDS: z.coerce.number().int().min(60).max(3_600).default(600),
    UPLOAD_USER_STORAGE_QUOTA_BYTES: z.coerce
      .number()
      .int()
      .min(1_024)
      .max(Number.MAX_SAFE_INTEGER)
      .default(1024 * 1024 * 1024),
    UPLOAD_USER_MONTHLY_BANDWIDTH_QUOTA_BYTES: z.coerce
      .number()
      .int()
      .min(1_024)
      .max(Number.MAX_SAFE_INTEGER)
      .default(5 * 1024 * 1024 * 1024),
    UPLOAD_SCAN_MODE: z.enum(['disabled', 'webhook']).default('disabled'),
    UPLOAD_SCAN_WEBHOOK_URL: optionalUrl,
    S3_BUCKET: z.string().default(''),
    S3_REGION: z.string().default(''),
    S3_ENDPOINT: optionalUrl,
    S3_PUBLIC_BASE_URL: optionalUrl,
    S3_FORCE_PATH_STYLE: booleanFromString,
    AWS_ACCESS_KEY_ID: z.string().default(''),
    AWS_SECRET_ACCESS_KEY: z.string().default(''),
    AWS_SESSION_TOKEN: z.string().default(''),
    CLOUDINARY_CLOUD_NAME: z.string().default(''),
    CLOUDINARY_API_KEY: z.string().default(''),
    CLOUDINARY_API_SECRET: z.string().default(''),
  })
  .superRefine((config, context) => {
    if (config.TRUST_PROXY_HOPS > 0 && config.TRUST_PROXY_CIDRS.length > 0) {
      context.addIssue({
        code: 'custom',
        path: ['TRUST_PROXY_CIDRS'],
        message: 'cannot be combined with TRUST_PROXY_HOPS; choose one explicit trust model',
      });
    }
    if (
      Object.keys(config.CRYPTO_KEYRING).length > 0 &&
      !Object.hasOwn(config.CRYPTO_KEYRING, config.CRYPTO_ACTIVE_KEY_ID)
    ) {
      context.addIssue({
        code: 'custom',
        path: ['CRYPTO_ACTIVE_KEY_ID'],
        message: 'must identify a key present in CRYPTO_KEYRING',
      });
    }
    if (config.UPLOAD_SCAN_MODE === 'webhook' && !config.UPLOAD_SCAN_WEBHOOK_URL) {
      context.addIssue({
        code: 'custom',
        path: ['UPLOAD_SCAN_WEBHOOK_URL'],
        message: 'is required when UPLOAD_SCAN_MODE=webhook',
      });
    }
    if (config.COOKIE_SAME_SITE === 'none' && !config.COOKIE_SECURE) {
      context.addIssue({
        code: 'custom',
        path: ['COOKIE_SECURE'],
        message: 'must be true when COOKIE_SAME_SITE=none',
      });
    }

    const stripeEnabled = Boolean(config.STRIPE_SECRET_KEY || config.STRIPE_WEBHOOK_SECRET);
    if (stripeEnabled && Object.keys(config.STRIPE_PRICE_CATALOG).length === 0) {
      context.addIssue({
        code: 'custom',
        path: ['STRIPE_PRICE_CATALOG'],
        message: 'must contain at least one server-owned price when Stripe is enabled',
      });
    }
    if (
      config.STRIPE_DEFAULT_PRICE_KEY &&
      !Object.hasOwn(config.STRIPE_PRICE_CATALOG, config.STRIPE_DEFAULT_PRICE_KEY)
    ) {
      context.addIssue({
        code: 'custom',
        path: ['STRIPE_DEFAULT_PRICE_KEY'],
        message: 'must reference a key in STRIPE_PRICE_CATALOG',
      });
    }

    if (
      config.REFUND_SELF_SERVICE_ENABLED &&
      Object.keys(config.REFUND_MAX_AMOUNT_BY_CURRENCY).length === 0
    ) {
      context.addIssue({
        code: 'custom',
        path: ['REFUND_MAX_AMOUNT_BY_CURRENCY'],
        message: 'must define at least one currency limit when self-service refunds are enabled',
      });
    }

    if (config.UPLOAD_PROVIDER === 's3') {
      for (const key of ['S3_BUCKET', 'S3_REGION'] as const) {
        if (!config[key]) {
          context.addIssue({ code: 'custom', path: [key], message: 'is required for S3 uploads' });
        }
      }
      const hasAccessKey = Boolean(config.AWS_ACCESS_KEY_ID);
      const hasSecretKey = Boolean(config.AWS_SECRET_ACCESS_KEY);
      if (hasAccessKey !== hasSecretKey) {
        context.addIssue({
          code: 'custom',
          path: [hasAccessKey ? 'AWS_SECRET_ACCESS_KEY' : 'AWS_ACCESS_KEY_ID'],
          message: 'must be set together with the other AWS credential field',
        });
      }
    }
    if (config.UPLOAD_PROVIDER === 'cloudinary') {
      for (const key of [
        'CLOUDINARY_CLOUD_NAME',
        'CLOUDINARY_API_KEY',
        'CLOUDINARY_API_SECRET',
      ] as const) {
        if (!config[key]) {
          context.addIssue({
            code: 'custom',
            path: [key],
            message: 'is required for Cloudinary uploads',
          });
        }
      }
    }

    if (config.NODE_ENV !== 'production') return;

    if (
      config.UPLOAD_ALLOWED_MIME_TYPES.some((value) =>
        [
          'application/pdf',
          'application/msword',
          'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
        ].includes(value),
      ) &&
      config.UPLOAD_SCAN_MODE !== 'webhook'
    ) {
      context.addIssue({
        code: 'custom',
        path: ['UPLOAD_SCAN_MODE'],
        message:
          'must be webhook in production when PDF or document uploads are allowed (malware/CDR)',
      });
    }

    const productionRequirements: Array<[keyof typeof config, boolean]> = [
      ['COOKIE_SECURE', config.COOKIE_SECURE],
      ['SENTRY_DSN', Boolean(config.SENTRY_DSN)],
      ['SMTP_HOST', Boolean(config.SMTP_HOST)],
      ['SMTP_USER', Boolean(config.SMTP_USER)],
      ['SMTP_PASSWORD', Boolean(config.SMTP_PASSWORD)],
      ['TWILIO_ACCOUNT_SID', Boolean(config.TWILIO_ACCOUNT_SID)],
      ['TWILIO_AUTH_TOKEN', Boolean(config.TWILIO_AUTH_TOKEN)],
      ['TWILIO_FROM', Boolean(config.TWILIO_FROM)],
      ['FIREBASE_SERVICE_ACCOUNT_JSON', Boolean(config.FIREBASE_SERVICE_ACCOUNT_JSON)],
      ['STRIPE_SECRET_KEY', Boolean(config.STRIPE_SECRET_KEY)],
      ['STRIPE_WEBHOOK_SECRET', Boolean(config.STRIPE_WEBHOOK_SECRET)],
      ['AUDIT_INTEGRITY_SECRET', config.AUDIT_INTEGRITY_SECRET.length >= 32],
    ];

    for (const [key, valid] of productionRequirements) {
      if (!valid) {
        context.addIssue({
          code: 'custom',
          path: [key],
          message: 'is required and must be secure in production',
        });
      }
    }
  });

export type Env = z.infer<typeof envSchema>;

export function parseEnv(source: NodeJS.ProcessEnv): Env {
  const result = envSchema.safeParse(source);
  if (!result.success) {
    const details = result.error.issues
      .map((issue) => `${issue.path.join('.') || 'environment'}: ${issue.message}`)
      .join('; ');
    throw new Error(`Invalid environment configuration: ${details}`);
  }
  return result.data;
}

export const env = parseEnv(process.env);
