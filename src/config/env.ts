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

const rateLimitAllowlist = commaSeparatedList.pipe(
  z
    .array(
      z
        .string()
        .refine(
          (value) =>
            /^(?:\d{1,3}\.){3}\d{1,3}(?:\/\d{1,2})?$/.test(value) ||
            /^[0-9a-f:]+(?:\/\d{1,3})?$/i.test(value),
          'must be an IP address or CIDR block',
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
    // disabled: no organization tables or scoping (current behavior).
    // single:   one implicit organization; scoping is enforced so a later switch is a migration.
    // multi:    full organization lifecycle.
    TENANCY_MODE: z.enum(['disabled', 'single', 'multi']).default('disabled'),
    // Which entity owns the Stripe customer. `organization` is only meaningful once tenancy is
    // enabled; the superRefine below rejects the incoherent combination.
    BILLING_OWNER: z.enum(['user', 'organization']).default('user'),
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
    SCHEDULER_ENABLED: booleanFromString,
    // IANA zone. Daily jobs shift with DST in a named zone; use UTC when that matters more than
    // local wall-clock time.
    SCHEDULER_TIMEZONE: z.string().min(1).max(64).default('UTC'),
    SCHEDULER_STALE_AFTER_HOURS: z.coerce.number().int().min(1).max(720).default(36),
    CHAT_ENABLED: booleanFromString,
    CHAT_SOCKET_PATH: z.string().startsWith('/').default('/socket.io'),
    // Keep the ping interval comfortably below the load balancer idle timeout, or connections
    // are reaped mid-conversation. This is the most common "works locally" failure.
    CHAT_PING_INTERVAL_MS: z.coerce.number().int().min(1_000).max(120_000).default(25_000),
    CHAT_PING_TIMEOUT_MS: z.coerce.number().int().min(1_000).max(120_000).default(20_000),
    CHAT_SESSION_REVALIDATE_MS: z.coerce.number().int().min(10_000).max(900_000).default(60_000),
    CHAT_MAX_FRAME_BYTES: z.coerce.number().int().min(1_024).max(1_048_576).default(65_536),
    CHAT_MAX_CONNECTIONS_PER_IP: z.coerce.number().int().min(1).max(10_000).default(60),
    CHAT_MAX_MESSAGES_PER_MINUTE: z.coerce.number().int().min(1).max(10_000).default(120),
    CHAT_MAX_EVENTS_PER_MINUTE: z.coerce.number().int().min(1).max(100_000).default(600),
    CHAT_MAX_ROOMS: z.coerce.number().int().min(1).max(1_000).default(100),
    CHAT_MAX_WRITE_BUFFER: z.coerce.number().int().min(1).max(100_000).default(512),
    CHAT_DRAIN_RECONNECT_MS: z.coerce.number().int().min(0).max(60_000).default(2_000),
    RATE_LIMIT_FALLBACK_MAX_KEYS: z.coerce.number().int().min(100).max(100_000).default(10_000),
    // Coarse app-wide ceiling per client address. Defence in depth behind a WAF, not a
    // substitute for one: it stops single-source floods, never a distributed botnet.
    RATE_LIMIT_IP_PER_MINUTE: z.coerce.number().int().min(10).max(1_000_000).default(600),
    RATE_LIMIT_ALLOWLIST_CIDRS: rateLimitAllowlist,
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
    // OpenTelemetry is opt-in so local development and clients without a collector do not pay
    // instrumentation/export cost. The OTLP exporter reads its endpoint and headers from the
    // standard OTEL_EXPORTER_OTLP_* environment variables.
    OTEL_ENABLED: booleanFromString,
    OTEL_SERVICE_NAME: z.string().min(1).max(128).default('backend-foundation'),
    OTEL_TRACE_SAMPLE_RATIO: z.coerce.number().min(0).max(1).default(0.1),
    OTEL_EXPORTER_OTLP_TRACES_ENDPOINT: optionalUrl,
    OTEL_EXPORTER_OTLP_HEADERS: z.string().default(''),
    // Prometheus text format on its own port, never the public API port -- metrics leak route
    // topology, queue depths, and traffic volumes. Both the API and worker processes expose one.
    METRICS_ENABLED: booleanFromString,
    // Loopback by default. A non-loopback production bind requires a bearer token below; private
    // networking remains the preferred deployment boundary.
    METRICS_HOST: z.string().default('127.0.0.1'),
    METRICS_API_PORT: z.coerce.number().int().min(1).max(65_535).default(9464),
    METRICS_WORKER_PORT: z.coerce.number().int().min(1).max(65_535).default(9465),
    METRICS_BEARER_TOKEN: z.string().default(''),
    EMAIL_FROM: z.email().default('no-reply@example.com'),
    EMAIL_PROVIDER: z.enum(['disabled', 'log', 'smtp']).default('log'),
    // Included in List-Unsubscribe/List-Unsubscribe-Post on non-transactional templates. A
    // mailto: fallback to EMAIL_FROM is used when unset; a one-click HTTPS URL is preferred.
    EMAIL_UNSUBSCRIBE_URL: optionalUrl,
    EMAIL_EVENT_WEBHOOK_SECRET: z.string().default(''),
    SMTP_HOST: z.string().default(''),
    SMTP_PORT: z.coerce.number().int().min(1).max(65_535).default(587),
    SMTP_SECURE: booleanFromString,
    SMTP_USER: z.string().default(''),
    SMTP_PASSWORD: z.string().default(''),
    SMS_PROVIDER: z.enum(['disabled', 'log', 'twilio']).default('log'),
    TWILIO_ACCOUNT_SID: z.string().default(''),
    TWILIO_AUTH_TOKEN: z.string().default(''),
    TWILIO_FROM: z.string().default(''),
    FIREBASE_SERVICE_ACCOUNT_JSON: z.string().default(''),
    PUSH_PROVIDER: z.enum(['disabled', 'log', 'firebase']).default('log'),
    BILLING_ENABLED: booleanFromString,
    STRIPE_SECRET_KEY: z.string().default(''),
    STRIPE_WEBHOOK_SECRET: z.string().default(''),
    STRIPE_DEFAULT_PRICE_KEY: z
      .union([z.string().regex(stripeCatalogKeyPattern), z.literal('')])
      .default(''),
    STRIPE_PRICE_CATALOG: stripePriceCatalog,
    // Dynamic amounts are always resolved server-side from a reference. These bounds exist so a
    // pricing bug produces a rejected request rather than a five-figure charge.
    DYNAMIC_PRICING_ENABLED: booleanFromString,
    CHARGE_MIN_AMOUNT_BY_CURRENCY: refundAmountLimits,
    CHARGE_MAX_AMOUNT_BY_CURRENCY: refundAmountLimits,
    CHARGE_ALLOWED_CURRENCIES: commaSeparatedList.pipe(
      z.array(z.string().regex(/^[a-z]{3}$/)).max(50),
    ),
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
    // Proxy is universal and accounts bytes in the API. Redirect removes API bandwidth for S3
    // while retaining authorization and full-object quota reservation at issuance time.
    UPLOAD_DOWNLOAD_MODE: z.enum(['proxy', 'redirect']).default('proxy'),
    UPLOAD_DOWNLOAD_URL_TTL_SECONDS: z.coerce.number().int().min(15).max(300).default(60),
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
    UPLOAD_SCAN_WEBHOOK_AUTH_TOKEN: z.string().default(''),
    UPLOAD_SCAN_TIMEOUT_MS: z.coerce.number().int().min(1_000).max(300_000).default(30_000),
    UPLOAD_PROVIDER_TIMEOUT_MS: z.coerce.number().int().min(1_000).max(300_000).default(30_000),
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
    if (config.BILLING_OWNER === 'organization' && config.TENANCY_MODE === 'disabled') {
      context.addIssue({
        code: 'custom',
        path: ['BILLING_OWNER'],
        message: 'cannot be organization while TENANCY_MODE=disabled; no organization exists',
      });
    }
    if (config.UPLOAD_SCAN_MODE === 'webhook' && !config.UPLOAD_SCAN_WEBHOOK_URL) {
      context.addIssue({
        code: 'custom',
        path: ['UPLOAD_SCAN_WEBHOOK_URL'],
        message: 'is required when UPLOAD_SCAN_MODE=webhook',
      });
    }
    if (
      config.NODE_ENV === 'production' &&
      config.UPLOAD_SCAN_MODE === 'webhook' &&
      config.UPLOAD_SCAN_WEBHOOK_AUTH_TOKEN.length < 32
    ) {
      context.addIssue({
        code: 'custom',
        path: ['UPLOAD_SCAN_WEBHOOK_AUTH_TOKEN'],
        message: 'must be at least 32 characters for the upload scanner webhook in production',
      });
    }
    if (
      config.METRICS_ENABLED &&
      config.METRICS_API_PORT === config.PORT &&
      config.METRICS_HOST === config.HOST
    ) {
      context.addIssue({
        code: 'custom',
        path: ['METRICS_API_PORT'],
        message: 'must differ from PORT/HOST; metrics are served on a separate listener',
      });
    }
    if (config.METRICS_ENABLED && config.METRICS_API_PORT === config.METRICS_WORKER_PORT) {
      context.addIssue({
        code: 'custom',
        path: ['METRICS_WORKER_PORT'],
        message: 'must differ from METRICS_API_PORT when processes share a network namespace',
      });
    }
    if (
      config.NODE_ENV === 'production' &&
      config.METRICS_ENABLED &&
      !['127.0.0.1', '::1', 'localhost'].includes(config.METRICS_HOST) &&
      config.METRICS_BEARER_TOKEN.length < 32
    ) {
      context.addIssue({
        code: 'custom',
        path: ['METRICS_BEARER_TOKEN'],
        message: 'must be at least 32 characters for a non-loopback production metrics listener',
      });
    }
    if (config.COOKIE_SAME_SITE === 'none' && !config.COOKIE_SECURE) {
      context.addIssue({
        code: 'custom',
        path: ['COOKIE_SECURE'],
        message: 'must be true when COOKIE_SAME_SITE=none',
      });
    }

    const configuredChannels = new Set(config.WORKER_CHANNELS);
    for (const [channel, provider] of [
      ['EMAIL', config.EMAIL_PROVIDER],
      ['SMS', config.SMS_PROVIDER],
      ['PUSH', config.PUSH_PROVIDER],
    ] as const) {
      if (configuredChannels.has(channel) && provider === 'disabled') {
        context.addIssue({
          code: 'custom',
          path: [`${channel}_PROVIDER`],
          message: `cannot be disabled while WORKER_CHANNELS includes ${channel}`,
        });
      }
    }

    if (config.EMAIL_PROVIDER === 'smtp') {
      for (const key of ['SMTP_HOST', 'SMTP_USER', 'SMTP_PASSWORD'] as const) {
        if (!config[key]) {
          context.addIssue({ code: 'custom', path: [key], message: 'is required for SMTP email' });
        }
      }
    }
    if (config.SMS_PROVIDER === 'twilio') {
      for (const key of ['TWILIO_ACCOUNT_SID', 'TWILIO_AUTH_TOKEN', 'TWILIO_FROM'] as const) {
        if (!config[key]) {
          context.addIssue({ code: 'custom', path: [key], message: 'is required for Twilio SMS' });
        }
      }
    }
    if (config.PUSH_PROVIDER === 'firebase' && !config.FIREBASE_SERVICE_ACCOUNT_JSON) {
      context.addIssue({
        code: 'custom',
        path: ['FIREBASE_SERVICE_ACCOUNT_JSON'],
        message: 'is required for Firebase push',
      });
    }
    if (config.EMAIL_UNSUBSCRIBE_URL) {
      const protocol = new URL(config.EMAIL_UNSUBSCRIBE_URL).protocol;
      if (protocol !== 'https:') {
        context.addIssue({
          code: 'custom',
          path: ['EMAIL_UNSUBSCRIBE_URL'],
          message: 'must use HTTPS before one-click List-Unsubscribe-Post can be emitted',
        });
      }
    }

    const stripeEnabled = config.BILLING_ENABLED;
    if (stripeEnabled && (!config.STRIPE_SECRET_KEY || !config.STRIPE_WEBHOOK_SECRET)) {
      context.addIssue({
        code: 'custom',
        path: [!config.STRIPE_SECRET_KEY ? 'STRIPE_SECRET_KEY' : 'STRIPE_WEBHOOK_SECRET'],
        message: 'is required when BILLING_ENABLED=true',
      });
    }
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

    if (config.DYNAMIC_PRICING_ENABLED) {
      if (config.CHARGE_ALLOWED_CURRENCIES.length === 0) {
        context.addIssue({
          code: 'custom',
          path: ['CHARGE_ALLOWED_CURRENCIES'],
          message: 'must list at least one currency when dynamic pricing is enabled',
        });
      }
      for (const currency of config.CHARGE_ALLOWED_CURRENCIES) {
        if (!Object.hasOwn(config.CHARGE_MAX_AMOUNT_BY_CURRENCY, currency)) {
          context.addIssue({
            code: 'custom',
            path: ['CHARGE_MAX_AMOUNT_BY_CURRENCY'],
            message: `must define an upper bound for ${currency} when dynamic pricing is enabled`,
          });
        }
      }
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
    if (config.UPLOAD_DOWNLOAD_MODE === 'redirect' && config.UPLOAD_PROVIDER !== 's3') {
      context.addIssue({
        code: 'custom',
        path: ['UPLOAD_DOWNLOAD_MODE'],
        message: 'redirect requires the S3 provider because its download signatures expire',
      });
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
      ['AUDIT_INTEGRITY_SECRET', config.AUDIT_INTEGRITY_SECRET.length >= 32],
    ];

    if (config.EMAIL_PROVIDER === 'log' && configuredChannels.has('EMAIL')) {
      productionRequirements.push(['EMAIL_PROVIDER', false]);
    }
    if (config.EMAIL_PROVIDER === 'smtp') {
      productionRequirements.push(
        ['EMAIL_EVENT_WEBHOOK_SECRET', config.EMAIL_EVENT_WEBHOOK_SECRET.length >= 32],
        ['EMAIL_UNSUBSCRIBE_URL', Boolean(config.EMAIL_UNSUBSCRIBE_URL)],
      );
    }
    if (config.SMS_PROVIDER === 'log' && configuredChannels.has('SMS')) {
      productionRequirements.push(['SMS_PROVIDER', false]);
    }
    if (config.PUSH_PROVIDER === 'log' && configuredChannels.has('PUSH')) {
      productionRequirements.push(['PUSH_PROVIDER', false]);
    }

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
