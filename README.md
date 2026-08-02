# Node.js + TypeScript backend foundation

A secure Express backend foundation using Node.js, TypeScript, Prisma/PostgreSQL, Redis/BullMQ, Pino, and Sentry.

## Included

- Validated environment configuration with production fail-closed provider checks
- Prisma Migrate schema and generated initial migration; bounded Prisma connection pool settings
- Structured Pino logs with credential/cookie redaction and Sentry error reporting
- Standard error envelopes and typed Zod route validation for body, headers, params, and query
- Redis-backed per-account/destination, high-ceiling shared-IP, endpoint-wide, and provider-spend
  limits with `Retry-After` responses, capacity alerts, a bounded
  per-process outage fallback, and fail-closed protection for signup, OTP, and password reset
- Password signup/login with Argon2id and generic anti-enumeration responses
- Google and Apple OIDC ID-token social login with provider-account linking
- Six-digit email/SMS OTPs with Argon2id hashes, five-minute expiry, resend suppression, send limits, and attempt locks
- 15-minute HS256 access JWTs in `httpOnly` cookies with server-side algorithm allowlisting
- HKDF-separated, key-versioned token hashing, metadata hashing, and AES-GCM encryption with
  rotation-safe legacy readers
- Opaque, hashed refresh tokens with rotation, session families, reuse detection, and session-wide revocation
- Signed double-submit CSRF protection for every state-changing cookie-authenticated request
- Email OTP password reset with atomic attempt locks, short-lived single-use reset credentials,
  and session revocation
- Self-service profile/email changes, password changes, social reauthentication for destructive
  actions, anonymizing account erasure, login-session listing/revocation,
  and push-device listing/unregistration
- Global roles, permissions, seed data, and permission middleware
- FCM device registration and multicast push; stale/invalid device tokens are deleted
- Transactional outbox with Redis instant nudges plus polling, business expiry, leased
  `SKIP LOCKED` claims, durable dead letters, audited redrive,
  and isolated BullMQ queues/concurrency for email, SMS, push, and internal events
- Audit events for security- and administration-sensitive changes, with independently keyed HMAC
  integrity signatures and an offline verification command
- Configurable batch cleanup for expired operational data with independent audit retention
- Stripe Checkout with a server-owned price catalogue and request idempotency, promotion-code
  validation, subscription upgrade/downgrade/resume/cancellation and Customer Portal, account-erasure
  cancellation, authoritative object reconciliation, cursor-paginated billing lists, policy-limited and
  operation-idempotent refunds, payment history, raw-body
  signature verification, event deduplication, and ordered payment/subscription projections
- Owner-scoped private/public uploads through S3-compatible storage or authenticated Cloudinary
  delivery, with quarantine → signature check → malware/CDR scan → ready lifecycle, per-user storage
  and bandwidth quotas, cursor-paginated records, downloads, and deletion
- UUIDv7 database identifiers, Prisma-enforced soft-delete filters, configurable CORS origins, and
  exact proxy-hop/CIDR trust
- Service accounts with rotatable one-time API keys, durable idempotency primitives, allowlisted
  filtering/sorting/search, and signed outbound customer webhooks with SSRF protection
- Compile-safe module generation, optional feature mounting, shared cursor pagination, and a single
  audited-transaction primitive for extending the foundation without copying infrastructure code
- OpenAPI 3.1 JSON at `/openapi.json` and `/api/v1/openapi.json`, plus a CSP-compatible,
  self-hosted Swagger UI at `/docs`; request components are generated from the Zod schemas used at
  runtime

## Local setup

Requirements: Node.js 22+, Docker, and Docker Compose.

```bash
cp .env.example .env
docker compose up -d
npm install
npm run prisma:generate
npm run db:migrate
npm run db:seed
npm run dev
```

Run the queue worker separately:

```bash
npm run worker
```

Development uses structured-log notification adapters when provider variables are empty. Production configuration rejects missing Sentry, SMTP, Twilio, Firebase, Stripe, or secure-cookie settings at startup.

### Network boundary and browser origins

`TRUST_PROXY_HOPS` is the exact number of proxies between the public client and Node (direct Node is
`0`; one ALB/reverse proxy is `1`). Alternatively, set `TRUST_PROXY_CIDRS` to the comma-separated
CIDRs that are actually allowed to supply forwarding headers. For Cloudflare, deploy the current
published Cloudflare ranges; do not use a blanket boolean. Configure browser callers with the
comma-separated `CORS_ALLOWED_ORIGINS` list.

Shared-IP limits are deliberately much higher than destination limits. Hundreds of employees behind
one office NAT therefore retain normal capacity, while each account/destination remains tightly
bounded and the endpoint/provider-wide emergency buckets cap aggregate CPU and paid sends.

### Cryptographic key rotation

`TOKEN_HASH_SECRET` remains the legacy bootstrap master. New deployments should configure a
versioned ring and keep old entries available for reads during rotation:

```dotenv
CRYPTO_ACTIVE_KEY_ID=2026-08
CRYPTO_KEYRING={"2026-07":"old-master-at-least-32-characters","2026-08":"new-master-at-least-32-characters"}
```

HKDF derives independent keys for opaque-token lookup, metadata pseudonymization, and AES-GCM.
Changing the active ID affects only new writes; old encrypted OTP payloads and token hashes remain
readable until their key is deliberately retired.

Stripe is disabled when its credentials are empty. When enabled, configure a server-owned price
catalogue and optionally a default key:

```dotenv
STRIPE_PRICE_CATALOG={"starter":"price_...","pro":"price_..."}
STRIPE_DEFAULT_PRICE_KEY=starter
```

Checkout callers send a catalogue `priceKey`, never a raw Stripe Price ID, and must provide a
stable `Idempotency-Key` header for the business operation. Reusing the key with an identical
request returns Stripe's original Checkout Session; reusing it with different parameters is
rejected by Stripe.

Refund callers also send a unique `Idempotency-Key`. Reuse it only to retry the same refund; two
intentional refunds for the same target and amount use different keys. Self-service refunds are
disabled by default. Enable them only with a time window and per-currency minor-unit limits:

```dotenv
REFUND_SELF_SERVICE_ENABLED=true
REFUND_WINDOW_DAYS=30
REFUND_MAX_AMOUNT_BY_CURRENCY={"usd":5000,"gbp":4000}
```

Requests over a configured limit do not call Stripe and require an administrative workflow.
Subscription routes support plan changes (`PATCH /api/v1/billing/subscriptions/{id}`), removing a
scheduled cancellation (`POST .../{id}/resume`), period-end cancellation, and Stripe Customer Portal
sessions. Webhook projections retrieve the current Stripe object and serialize per-object database
updates, so equal-second and out-of-order deliveries converge on Stripe's authoritative state.

## Authentication flow

1. Call `GET /api/v1/auth/csrf` with credentials enabled.
2. Send the returned value in `x-csrf-token` on every `POST`, `PUT`, `PATCH`, or `DELETE`; the browser sends the signed CSRF cookie.
3. `POST /api/v1/auth/signup` creates a pending user and queues an email verification OTP.
4. Verify through `POST /api/v1/auth/otp/verify` with `purpose=VERIFY_EMAIL`.
5. Login through password or an OTP with `purpose=LOGIN`. Access and refresh credentials are set only as `httpOnly` cookies.
6. `POST /api/v1/auth/refresh` rotates the refresh credential. Reusing any consumed token revokes its whole session.
7. Password reset uses `POST /api/v1/auth/password-reset/request`, then
   `POST /api/v1/auth/password-reset/verify-otp` to obtain a short-lived `resetToken`, and finally
   `POST /api/v1/auth/password-reset/confirm` with that credential and the new password.
8. Email change requires a recent password or provider-token reauthentication, verifies the new
   address by OTP, and revokes all sessions. Social-only account deletion uses the same live social
   reauthentication rule.

Social login accepts a provider-issued OIDC ID token at `POST /api/v1/auth/oauth/google` or
`POST /api/v1/auth/oauth/apple`. Configure the matching provider client ID in
`GOOGLE_CLIENT_ID` or `APPLE_CLIENT_ID`; the server verifies the signature, issuer, audience, and
email verification status before linking the provider account.

All signup, OTP-send, and password-reset request endpoints return generic responses. Existing-email signup attempts produce a distinct queued security email, never a distinct API response.

## Application boundaries

Each feature follows the same dependency direction:

```text
routes -> middleware -> controllers -> services -> Prisma/providers
```

- Route files map an HTTP method/path to ordered security and validation middleware, then a controller.
- Validation middleware parses each configured body, headers, params, or query schema once and stores its
  transformed output in `request.validated`; controllers never reparse raw request input.
- Controllers translate validated request data, orchestrate services, and select the response
  status/message.
- Services own business rules, transactions, audit/outbox writes, and data access.
- Middleware owns cross-cutting request concerns such as authentication, permissions, CSRF, rate
  limits, and ownership checks that do not require a database resource lookup.
- Queue workers own every external notification/provider call.

Middleware order is deliberate. Authenticated routes apply per-user limits after authentication.
Public authentication flows apply per-account or per-destination limits after detailed input
validation. Protected routes authenticate and check coarse permissions before exposing validation
details. Resource ownership is then enforced from authenticated claims—not a client-supplied owner
field—either by the route policy or in the service query when the resource must be loaded. `/me`,
device, session, and phone-verification operations are owner-scoped this way. Administrative
user/role/audit routes are explicitly cross-owner operations gated by their RBAC permissions.

### Generate a module

Generate the standard schemas, service, controller, routes, and starter service test with:

```bash
npm run gen:module -- service-orders
```

Names must use lowercase kebab-case. The generator refuses to overwrite any existing target and
prints the router name to mount in `src/app.ts`. Generated routes require authentication by default.

### Optional modules

`buildApp` accepts per-module switches. All modules remain enabled by default, so existing
deployments are unchanged:

```ts
const app = buildApp({
  modules: {
    billing: false,
    uploads: false,
  },
});
```

Disabled modules are not mounted and their provider clients are not constructed. `docs`, `auth`,
`users`, `roles`, `outbox`, `audit`, `serviceAccounts`, and `customerWebhooks` can be switched the same way; system health routes stay
available as the application core.

`buildApp({ dependencies: ... })` can inject Stripe/storage adapters or replacement routers while
the default registry composes the production Prisma/environment implementations.

### Shared service primitives

Use `paginateCursor` for Prisma cursor lists. It owns the `limit + 1`, cursor/skip, immutable page
slice, and `nextCursor` contract; the query callback still owns filtering and a deterministic order
ending in `id`.

Use `withAuditedTransaction` for mutations that emit audit events. Its callback receives the Prisma
transaction client and an `audit` writer bound to that same transaction, so the business write and
its audit trail commit or roll back together.

## Universal response envelope

All endpoints use the same response helpers. Successful responses have this shape:

```json
{
  "success": true,
  "message": "User updated",
  "data": {},
  "error": null,
  "meta": { "requestId": "..." }
}
```

Errors use the same top-level fields:

```json
{
  "success": false,
  "message": "Validation failed",
  "data": null,
  "error": { "code": "BAD_REQUEST", "details": null },
  "meta": { "requestId": "..." }
}
```

Cursor pagination is returned inside `meta.nextCursor`; no controller builds an ad-hoc envelope.

## Routes

| Method          | Route                                      | Protection                               |
| --------------- | ------------------------------------------ | ---------------------------------------- |
| GET             | `/health`                                  | Public liveness                          |
| GET             | `/ready`                                   | Public dependency readiness              |
| GET             | `/api/v1/auth/csrf`                        | Public                                   |
| POST            | `/api/v1/auth/signup`                      | CSRF + account limits                    |
| POST            | `/api/v1/auth/login`                       | CSRF + account limits                    |
| POST            | `/api/v1/auth/otp/send`                    | CSRF + destination/account limits        |
| POST            | `/api/v1/auth/otp/verify`                  | CSRF + attempt/destination limits        |
| POST            | `/api/v1/auth/phone/send-verification`     | Session + CSRF + limits                  |
| POST            | `/api/v1/auth/refresh`                     | Refresh cookie + CSRF                    |
| POST            | `/api/v1/auth/password-reset/request`      | CSRF + limits                            |
| POST            | `/api/v1/auth/password-reset/verify-otp`   | CSRF + attempt/account limits            |
| POST            | `/api/v1/auth/password-reset/confirm`      | CSRF + limits                            |
| POST            | `/api/v1/auth/password/change`             | Session + CSRF                           |
| POST            | `/api/v1/auth/oauth/{provider}`            | CSRF + provider token verification       |
| POST            | `/api/v1/auth/logout`, `/logout-all`       | Session + CSRF                           |
| DELETE          | `/api/v1/auth/account`                     | Session + CSRF                           |
| GET/POST        | `/api/v1/users/...`                        | Session; permission where administrative |
| PATCH/DELETE    | `/api/v1/users/me`                         | Session + CSRF                           |
| GET/POST/DELETE | `/api/v1/users/me/devices...`              | Session + CSRF for mutations             |
| GET/DELETE      | `/api/v1/users/me/sessions...`             | Session + CSRF for revocation            |
| GET/POST        | `/api/v1/roles/...`                        | `roles:read` / `roles:write`             |
| GET             | `/api/v1/audit-events`                     | `audit:read`                             |
| GET             | `/api/v1/outbox-events/dead-letter`        | `outbox:read`                            |
| POST            | `/api/v1/outbox-events/:id/redrive`        | `outbox:write` + CSRF                    |
| POST            | `/api/v1/webhooks/stripe`                  | Stripe signature; CSRF-exempt            |
| POST/GET        | `/api/v1/billing/checkout/sessions...`     | Session + CSRF for creation              |
| GET/POST        | `/api/v1/billing/subscriptions...`         | Session + CSRF for cancellation          |
| GET             | `/api/v1/billing/payments`                 | Session                                  |
| POST            | `/api/v1/billing/refunds`                  | Session + CSRF                           |
| POST            | `/api/v1/billing/promotion-codes/validate` | Session + CSRF                           |
| GET/POST/DELETE | `/api/v1/uploads...`                       | Session + CSRF for mutations             |
| GET             | `/openapi.json`, `/docs`                   | Public                                   |

## Roles and first administrator

The seed creates the system `admin` role and standard permissions. To assign it safely, first create and verify the user, set `BOOTSTRAP_ADMIN_EMAIL` in `.env`, then rerun `npm run db:seed`. The seed is idempotent.

## Database and deployment rules

- Change the schema only through `prisma/schema.prisma` and commit migrations created by Prisma Migrate. Do not run hand-maintained production SQL.
- `DATABASE_URL` uses a bounded `connection_limit`. Put PgBouncer in transaction mode in front of PostgreSQL for horizontally scaled production deployments and keep `DIRECT_DATABASE_URL` for migrations.
- Run `npm run db:migrate:deploy` as a release step before starting new application instances.
- Run API and worker as separate processes. Nothing external (SMTP, Twilio, FCM, or Stripe event processing) runs in an API request handler.
- The outbox record and business change must be created in the same Prisma transaction. `dedupeKey` is mandatory, and each delivery channel gets its own outbox row/job.
- Relay replicas atomically claim disjoint batches with short `FOR UPDATE SKIP LOCKED` transactions.
  Redis calls happen only after those transactions commit; expired claim leases are reclaimable.
- BullMQ owns transient delivery retries. The final failed attempt becomes a durable
  `DEAD_LETTER` row, is reported to Sentry, and must be explicitly redriven through the
  permission-gated endpoint. Redrive increments the delivery generation so an exhausted BullMQ
  job ID is never reused.
- Use a Redis `noeviction` policy for BullMQ. Monitor failed jobs, expired claims, and outbox rows
  in `DEAD_LETTER` state.

### Queue isolation and scaling

Email, SMS, push, and internal Stripe work use separate queue names and concurrency settings. An
early product can run them in one process. Later deployments can use `WORKER_CHANNELS` to reserve or
scale capacity per channel without changing application code. When upgrading a deployment that used
the legacy shared `notifications` queue, drain it with the old worker before switching all workers.

### Rate-limit degradation policy

Redis is the authoritative distributed rate-limit store. If it is temporarily unavailable,
ordinary limits use a bounded in-process fallback with at most
`RATE_LIMIT_FALLBACK_MAX_KEYS` counters per API process. Because those counters are not shared
between replicas, this is reduced protection intended only to keep ordinary authentication and
application traffic available during an incident. Signup, OTP send/verification, phone
verification, and password-reset operations instead return `503 SERVICE_UNAVAILABLE` until Redis
recovers. Redis failures and recovery emit structured metric fields, and the failure path sends a
rate-limited Sentry alert.

### Retention maintenance

After building the application, run the single cleanup command:

```bash
npm run maintenance:cleanup
```

`DATA_RETENTION_DAYS` controls expired OTP challenges, expired/revoked sessions and their refresh
tokens, terminal outbox events, processed Stripe webhook events, and failed/deleted upload records.
The cleanup also removes provider objects for direct uploads that never completed before their
signed URL expired. `AUDIT_RETENTION_DAYS` is
independent because audit requirements commonly differ; set it to `0` to retain audit events
indefinitely. Each table is deleted in transactions of at most `RETENTION_BATCH_SIZE` rows. Pending
outbox work, non-processed webhooks, and active sessions are never selected.

For example, this cron entry runs cleanup every day at 03:15 from a built deployment:

```cron
15 3 * * * cd /srv/backend && npm run maintenance:cleanup
```

Configure exactly one scheduler for each database. Cleanup is safe to rerun after a failure.

Audit events written after the integrity migration are HMAC-signed with
`AUDIT_INTEGRITY_SECRET`. Verify them after building with:

```bash
npm run maintenance:audit-verify
```

Existing installations must sign legacy rows before applying the non-null integrity migration:

```bash
npm run build
npm run maintenance:audit-backfill
npm run db:migrate:deploy
```

Verification exits non-zero for either invalid or unexpected unsigned rows.

This detects record mutation without the external key, but a database-only signature cannot prove
that rows were not deleted. Regulated products should also stream audit events to immutable/WORM
storage or a SIEM and retain external checkpoints.

### File uploads

Set `UPLOAD_PROVIDER=s3` or `UPLOAD_PROVIDER=cloudinary`. The API returns a short-lived signed upload
directive; clients send bytes directly to the provider and then call the completion endpoint. The
server verifies exact size, magic bytes, declared MIME, and scan verdict before marking it ready. S3 supports the
AWS credential chain, explicit credentials, custom S3-compatible endpoints, and an optional CDN
base URL. Cloudinary private assets use authenticated delivery and signed URLs.

`visibility=PRIVATE` is the default. Documents remain quarantined unless a scanner/CDR webhook is
configured; production configuration rejects PDF/document allowlists without it. Configure
`UPLOAD_SCAN_WEBHOOK_URL`, storage and monthly bandwidth quotas, and provider retention/deletion
policies before launch.

### API keys, idempotency, and outbound webhooks

Administrators can create service accounts and one-time API keys under `/api/v1/service-accounts`;
callers authenticate with `x-api-key`. Keys store only versioned hashes and can be revoked or expired.
`requireIdempotencyKey` plus `runIdempotent` provides durable request fingerprints, replay, expiry,
and conflicting-reuse detection for new mutations.

Users manage outbound endpoints under `/api/v1/webhook-endpoints`. Delivery is transactional through
the outbox, HTTPS-only, DNS/private-range checked, redirect-disabled, bounded by worker retries, and
signed as `t=<unix>,v1=<HMAC-SHA256>` over `<timestamp>.<raw-body>`. Secrets are shown once and can be
rotated. Consumers should enforce a five-minute timestamp tolerance and deduplicate `x-webhook-id`.

## Verification

```bash
npm run typecheck
npm run lint
npm test
npm run build
npm run format:check
```

Provider integrations should also be exercised against Stripe CLI/test mode, a Twilio test account, an SMTP sandbox, and a Firebase test project before production rollout.
