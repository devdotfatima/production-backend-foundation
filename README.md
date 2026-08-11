# Node.js + TypeScript backend foundation

A secure Express backend foundation using Node.js, TypeScript, Prisma/PostgreSQL, Redis/BullMQ, Pino, and Sentry.

`buildApp` wires one fixed set of routes; billing, chat, and organizations/tenancy stay behind the
`BILLING_ENABLED`, `CHAT_ENABLED`, and `TENANCY_MODE` env vars because they depend on real
infrastructure (Stripe keys, socket transport, a chosen tenancy model). A module that is not needed
at all should be deleted from `src/modules` and its `app.use()` line removed from `src/app.ts`;
`tsc --noEmit` finds every remaining reference. PostgreSQL and Redis are the only infrastructure
required by the full template; Stripe, Twilio, SMTP, Firebase, and object-storage credentials are
not required for local development or the automated test suite.

## Included

- Validated environment configuration with module-aware, production fail-closed provider checks
- Prisma Migrate schema and generated initial migration; bounded Prisma connection pool settings
- Structured Pino logs with credential/cookie redaction and Sentry error reporting
- Standard error envelopes and typed Zod route validation for body, headers, params, and query
- Redis-backed per-account/destination, high-ceiling shared-IP, endpoint-wide, and provider-spend
  limits with `Retry-After` responses, capacity alerts, a bounded
  per-process outage fallback, and fail-closed protection for signup, OTP, and password reset
- Password signup/login with Argon2id and generic anti-enumeration responses
- Google and Apple OIDC ID-token social login with provider-account linking
- Six-digit email/SMS OTPs with Argon2id hashes, five-minute expiry, resend suppression, send limits, and attempt locks
- 15-minute HS256 access JWTs in `httpOnly` cookies (web) or returned as bearer tokens (mobile) with
  server-side algorithm allowlisting
- HKDF-separated, key-versioned token hashing, metadata hashing, and AES-GCM encryption with
  rotation-safe legacy readers
- Opaque, hashed refresh tokens with rotation, session families, reuse detection, and session-wide revocation
- Signed double-submit CSRF protection for every state-changing cookie-authenticated request; bearer-authenticated requests are exempt since they carry no ambient credential
- Email OTP password reset with atomic attempt locks, short-lived single-use reset credentials,
  and session revocation
- Self-service profile/email changes, password changes, social reauthentication for destructive
  actions, transactional account anonymization with resumable Stripe/provider erasure work,
  login-session listing/revocation,
  and push-device listing/unregistration
- Global roles, permissions, seed data, and permission middleware
- FCM device registration and multicast push; stale/invalid device tokens are deleted
- Typed, localized email templates; per-user and per-organization notification preferences;
  one-click signed unsubscribe; delivery tracking; and bounce/complaint suppression
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
- User- or organization-owned Stripe customers with permission-gated tenant billing, owner-scoped
  idempotency, and organization attribution on Stripe metadata and local webhook projections
- Owner-scoped private/public uploads through S3-compatible storage or authenticated Cloudinary
  delivery, with quarantine → signature check → malware/CDR scan → ready lifecycle, per-user storage
  and bandwidth quotas, cursor-paginated records, downloads, and deletion
- UUIDv7 database identifiers, Prisma-enforced soft-delete filters, configurable CORS origins, and
  exact proxy-hop/CIDR trust
- Durable idempotency primitives and allowlisted filtering/sorting/search
- Compile-safe module generation, optional feature mounting, shared cursor pagination, and a single
  audited-transaction primitive for extending the foundation without copying infrastructure code
- OpenAPI 3.1 JSON at `/openapi.json` and `/api/v1/openapi.json`, plus a CSP-compatible,
  self-hosted Swagger UI at `/docs`; request components are generated from the Zod schemas used at
  runtime
- Protected per-process Prometheus endpoints with low-cardinality HTTP, queue, worker, scheduler,
  outbox, chat, rate-limit, and Prisma-operation metrics plus baseline SLO alert rules

## Local setup

Requirements: Node.js 22+, Docker Desktop/Engine, and Docker Compose. PostgreSQL and Redis are bound
to loopback by the included Compose file, so development credentials are not exposed on the LAN.

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

The API defaults to `http://localhost:4000`; use `/health` for liveness, `/ready` for dependency
readiness, `/docs` for Swagger UI, and `/openapi.json` for the machine-readable contract. The API
and worker are separate processes because HTTP scaling and background-delivery scaling are
different concerns. Both must be running for queued email, SMS, push, Stripe reconciliation,
upload scanning, account erasure, and scheduled jobs to progress.

### Developing without provider keys

The safe local defaults are intentionally useful without paid accounts:

| Capability | No-key behavior                                                            | Automated coverage                                                              | Real-provider check before launch                           |
| ---------- | -------------------------------------------------------------------------- | ------------------------------------------------------------------------------- | ----------------------------------------------------------- |
| Email      | Structured-log transport; rendered subject is logged, secrets/body are not | Template, policy, outbox, retry, and lifecycle tests                            | Mailpit/sandbox SMTP or the client's email provider sandbox |
| SMS/Twilio | Structured-log transport                                                   | OTP policy and worker tests with provider doubles                               | Twilio test credentials/numbers                             |
| Push/FCM   | Structured-log transport when Firebase is absent                           | Device/policy and worker tests with doubles                                     | Firebase test project                                       |
| Stripe     | Routes remain disabled with `BILLING_ENABLED=false`                        | Stripe SDK doubles plus webhook fixture/reconciliation tests                    | Stripe test-mode keys and Stripe CLI forwarding             |
| Uploads    | Routes report unavailable with `UPLOAD_PROVIDER=disabled`                  | In-memory provider adapters exercise validation, quarantine, quota, and cleanup | MinIO/S3 sandbox or Cloudinary test account                 |

Do not put live credentials into unit tests. Provider doubles verify what this application sends;
the provider's sandbox verifies that its API accepts it. Those are separate tests and both matter.

Development uses structured-log notification adapters by default. Production validates only the
providers selected by `WORKER_CHANNELS`, `EMAIL_PROVIDER`, `SMS_PROVIDER`, `PUSH_PROVIDER`,
`BILLING_ENABLED`, and `UPLOAD_PROVIDER`; disabled modules do not force unrelated credentials.

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

Stripe routes are disabled unless `BILLING_ENABLED=true`. When enabled, configure the Stripe
credentials, webhook secret, a server-owned price catalogue, and optionally a default key. Set
`BILLING_OWNER=organization` to store the customer and all billing projections on the active
organization; those routes then require `billing:read` or `billing:write` membership grants.

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

Configure the Stripe endpoint to send at least `checkout.session.completed`, `payment_intent.*`,
`setup_intent.succeeded`, `payment_method.detached`, `payment_method.updated`, `customer.updated`,
`customer.subscription.*`, and `charge.refunded`. The API acknowledges only after the signed event
and its internal outbox job commit; the worker retrieves and projects provider state later, so slow
reconciliation does not block Stripe's webhook request.

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

### Mobile clients

Native mobile apps don't get an automatic cookie jar or a way to complete the CSRF handshake, so
`POST /api/v1/auth/login`, `POST /api/v1/auth/oauth/{provider}`, `POST /api/v1/auth/otp/verify`,
and `POST /api/v1/auth/refresh` support a bearer-token transport as an alternative to cookies:

1. Send `X-Client-Type: mobile` on the request. No CSRF token is required for this request or any
   subsequent bearer-authenticated request — mobile clients never rely on an ambient cookie, which is
   what CSRF protects.
2. The response returns `{ "accessToken": "...", "refreshToken": "..." }` in the JSON body instead of
   setting cookies. Store both in Keychain (iOS) or Keystore (Android) — never in plain storage.
3. Send the access token on every subsequent request as `Authorization: Bearer <accessToken>`.
4. To refresh, `POST /api/v1/auth/refresh` with `X-Client-Type: mobile` and
   `{ "refreshToken": "<refreshToken>" }` in the body. As with the cookie flow, reusing a consumed
   refresh token revokes its whole session.

Web and mobile share the same access/refresh token issuance and rotation logic; only the transport
(cookie vs. header/body) differs.

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

`buildApp()` takes no options — `docs`, `auth`, `users`, `roles`, `outbox`, `audit`, `uploads`,
`notifications`, and `scheduler` are always mounted. Three routes stay behind env vars because they
depend on infrastructure that isn't always present: `organizations` follows `TENANCY_MODE !==
'disabled'`, `chat` follows `CHAT_ENABLED`, and the Stripe billing/webhook routes follow
`BILLING_ENABLED` (unset, their provider clients are never constructed, so no Stripe key is
required). System health routes stay available regardless.

To drop a module you don't use, delete its directory under `src/modules` and remove its `app.use()`
line (and import) from `src/app.ts`; `tsc --noEmit` will list every other file that referenced it.

`createAuthService` and `createStripeService` accept selective use-case overrides directly (e.g.
`createAuthService({ loginWithPassword: fake })`), independent of `buildApp` — their
controller/router factories consume those narrow contracts, so tests can replace one use case
without mutating module globals.

The worker process has its own, separate composition boundary through `buildWorkerRuntime`. Its
`outbox`, `scheduler`, `billing`, `uploads`, and `metrics` switches avoid constructing disabled
queues or providers, and `WorkerDependencies` permits process-level factories and resources to be
replaced for tests.

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

| Method          | Route                                      | Protection                                              |
| --------------- | ------------------------------------------ | ------------------------------------------------------- |
| GET             | `/health`                                  | Public liveness                                         |
| GET             | `/ready`                                   | Public dependency readiness                             |
| GET             | `/api/v1/auth/csrf`                        | Public                                                  |
| POST            | `/api/v1/auth/signup`                      | CSRF + account limits                                   |
| POST            | `/api/v1/auth/login`                       | CSRF + account limits                                   |
| POST            | `/api/v1/auth/otp/send`                    | CSRF + destination/account limits                       |
| POST            | `/api/v1/auth/otp/verify`                  | CSRF + attempt/destination limits                       |
| POST            | `/api/v1/auth/phone/send-verification`     | Session + CSRF + limits                                 |
| POST            | `/api/v1/auth/refresh`                     | Refresh cookie + CSRF, or mobile body + `X-Client-Type` |
| POST            | `/api/v1/auth/password-reset/request`      | CSRF + limits                                           |
| POST            | `/api/v1/auth/password-reset/verify-otp`   | CSRF + attempt/account limits                           |
| POST            | `/api/v1/auth/password-reset/confirm`      | CSRF + limits                                           |
| POST            | `/api/v1/auth/password/change`             | Session + CSRF                                          |
| POST            | `/api/v1/auth/email-change/...`            | Session + CSRF + reauthentication                       |
| POST            | `/api/v1/auth/oauth/{provider}`            | CSRF + provider token verification                      |
| POST            | `/api/v1/auth/logout`, `/logout-all`       | Session + CSRF                                          |
| DELETE          | `/api/v1/auth/account`                     | Session + CSRF                                          |
| GET/POST        | `/api/v1/users/...`                        | Session; permission where administrative                |
| PATCH/DELETE    | `/api/v1/users/me`                         | Session + CSRF                                          |
| GET/POST/DELETE | `/api/v1/users/me/devices...`              | Session + CSRF for mutations                            |
| GET/DELETE      | `/api/v1/users/me/sessions...`             | Session + CSRF for revocation                           |
| GET/POST        | `/api/v1/roles/...`                        | `roles:read` / `roles:write`                            |
| GET             | `/api/v1/audit-events`                     | `audit:read`                                            |
| GET             | `/api/v1/outbox-events/dead-letter`        | `outbox:read`                                           |
| POST            | `/api/v1/outbox-events/:id/redrive`        | `outbox:write` + CSRF                                   |
| POST            | `/api/v1/webhooks/stripe`                  | Stripe signature; CSRF-exempt                           |
| POST            | `/api/v1/webhooks/email-events`            | Provider HMAC signature; CSRF-exempt                    |
| POST/GET        | `/api/v1/billing/checkout/sessions...`     | Session + CSRF for creation                             |
| GET/POST/PATCH  | `/api/v1/billing/subscriptions...`         | Session + CSRF for mutations                            |
| GET             | `/api/v1/billing/payments`                 | Session                                                 |
| POST            | `/api/v1/billing/refunds`                  | Session + CSRF                                          |
| POST            | `/api/v1/billing/promotion-codes/validate` | Session + CSRF                                          |
| GET/POST/DELETE | `/api/v1/uploads...`                       | Session + CSRF for mutations                            |
| GET/PATCH       | `/api/v1/notifications/preferences`        | Session + CSRF for mutation                             |
| POST            | `/api/v1/notifications/unsubscribe`        | Signed expiring token; CSRF-exempt                      |
| GET             | `/openapi.json`, `/docs`                   | Public                                                  |

"Session" means `authenticate` accepted either the `httpOnly` access cookie (web) or an
`Authorization: Bearer` access token (mobile); see [Mobile clients](#mobile-clients). CSRF is only
enforced for the cookie transport — bearer-authenticated requests carry no ambient credential, so
they're exempt automatically.

## Roles and first administrator

The seed creates the system `admin` role and standard permissions. To assign it safely, first create and verify the user, set `BOOTSTRAP_ADMIN_EMAIL` in `.env`, then rerun `npm run db:seed`. The seed is idempotent.

## Database and deployment rules

- Change the schema only through `prisma/schema.prisma` and commit migrations created by Prisma Migrate. Do not run hand-maintained production SQL.
- `DATABASE_URL` uses a bounded `connection_limit`. Put PgBouncer in transaction mode in front of PostgreSQL for horizontally scaled production deployments and keep `DIRECT_DATABASE_URL` for migrations.
- Run `npm run db:migrate:deploy` as a release step before starting new application instances.
- Run API and worker as separate processes. Nothing external (SMTP, Twilio, FCM, Stripe event
  processing, or account-erasure provider cleanup) runs in an API request handler.
- The outbox record and business change must be created in the same Prisma transaction. `dedupeKey` is mandatory, and each delivery channel gets its own outbox row/job.
- Relay replicas atomically claim disjoint batches with short `FOR UPDATE SKIP LOCKED` transactions.
  Redis calls happen only after those transactions commit; expired claim leases are reclaimable.
- BullMQ owns transient delivery retries. The final failed attempt becomes a durable
  `DEAD_LETTER` row, is reported to Sentry, and must be explicitly redriven through the
  permission-gated endpoint. Redrive increments the delivery generation so an exhausted BullMQ
  job ID is never reused.
- Use a Redis `noeviction` policy for BullMQ. Monitor failed jobs, expired claims, and outbox rows
  in `DEAD_LETTER` state.

### Distributed tracing

Set `OTEL_ENABLED=true` and point `OTEL_EXPORTER_OTLP_TRACES_ENDPOINT` at an OTLP/HTTP traces
receiver (normally ending in `/v1/traces`). `OTEL_SERVICE_NAME` distinguishes API and worker
deployments, `OTEL_TRACE_SAMPLE_RATIO` controls root sampling, and
`OTEL_EXPORTER_OTLP_HEADERS` carries exporter authentication using the standard OpenTelemetry
header format. Tracing initializes before Express, Prisma, Redis, or HTTP clients are imported.

HTTP/Express, Prisma/Postgres, Redis, Node HTTP/HTTPS, and Undici/`fetch` calls are instrumented. The active W3C
carrier is persisted on the transactional outbox row, restored by the relay, passed in BullMQ job
data, and restored again by the worker. This preserves one trace across the asynchronous database
and queue boundary. Do not put user IDs, tokens, request bodies, message bodies, or object keys in
trace attributes.

When both OTLP and Sentry are enabled, the application OpenTelemetry SDK is the single global trace
owner and Sentry remains the error sink; Sentry performance tracing is disabled to prevent two SDKs
from racing to register providers or double-instrumenting requests. Send OTLP data to a collector
that exports to the tracing backend of choice, including Sentry if desired.

### Queue isolation and scaling

Email, SMS, push, and internal Stripe work use separate queue names and concurrency settings. An
early product can run them in one process. Later deployments can use `WORKER_CHANNELS` to reserve or
scale capacity per channel without changing application code. When upgrading a deployment that used
the legacy shared `notifications` queue, drain it with the old worker before switching all workers.

### Notification delivery and preferences

Email content is selected through the typed template registry and rendered using the recipient's
stored BCP 47 `locale`, falling back to English. Transactional messages ignore marketing
preferences; non-transactional topics check the exact organization preference, then the user's
global preference, and finally the registry default. `product-announcement` is the reference
non-transactional template.

Unsubscribe links carry an HMAC-signed, expiring token and disable the matching global email topic.
SMTP deployments must expose `EMAIL_UNSUBSCRIBE_URL` over HTTPS and configure
`EMAIL_EVENT_WEBHOOK_SECRET`. The email event webhook verifies the HMAC over the raw request body,
tracks delivered/bounced/complained status by provider message ID, and stores only a normalized
destination hash in the suppression list. Adapt `email-events.service.ts` if a provider uses a
different event envelope; keep signature verification and normalization at that boundary.

Notification delivery is deliberately at-least-once at the outbox boundary. A durable
`notification_deliveries` row prevents a retry from sending again after provider success was
recorded but before the outbox row was finalized. Email also uses a stable RFC Message-ID, and push
payloads include `notificationDeliveryId` so capable transports/clients can deduplicate. No generic
SMTP/Twilio call can guarantee exactly-once delivery if the process dies after the provider accepts
the request but before the database records success; consumers should make notifications harmless
to repeat, and high-value workflows should choose a provider API with an idempotency key or reconcile
an unknown delivery instead of blindly retrying it.

### Scheduled jobs

Jobs are declared in `scheduler.registry.ts` with a cron expression, timeout, and handler, and
registered as BullMQ repeatable jobs from the worker process (`SCHEDULER_ENABLED`). Schedules
travel with the code instead of living in a deployment's crontab, and registration is idempotent —
several worker replicas cannot produce duplicate runs. Entries no longer in the registry are
pruned, since they would otherwise keep firing forever.

Every run records `lastRunAt`, `lastDurationMs`, and `lastStatus`, exposed at
`GET /api/v1/scheduled-jobs`. **An unmonitored scheduled job is indistinguishable from one that
silently stopped running three weeks ago**, which is the entire reason this state exists. Each job
also has its own `AbortSignal` timeout and a Redis ownership lease. Handlers check the signal
between bounded batches, provider calls receive abort signals where supported, and two replicas
cannot run the same job concurrently. Cancellation is cooperative: a database statement already
executing cannot be forcibly interrupted by JavaScript, so handlers must remain batched.

`POST /api/v1/scheduled-jobs/:name/run` returns `202` after enqueuing an on-call run; it never runs
maintenance inside the HTTP request. The trigger and BullMQ job ID are audited, because an
out-of-band run is worth being able to explain afterwards.

The standalone `maintenance:*` entrypoints still work for serverless deploys that prefer external
cron. Both paths call the same handler functions, so they cannot drift apart. `SCHEDULER_TIMEZONE`
takes an IANA zone; daily jobs shift with DST in a named zone, so use `UTC` when a fixed interval
matters more than local wall-clock time.

### Chat over websockets

Disabled by default (`CHAT_ENABLED`). When enabled, a socket.io server attaches to the existing
HTTP server, so websockets and REST share one port and one TLS terminator.

**`transports: ['websocket']` only.** socket.io's HTTP long-polling fallback is what forces sticky
sessions; without it any node can serve any connection and the load balancer needs no session
affinity. Cross-node fanout uses `@socket.io/redis-streams-adapter` rather than the classic
pub/sub adapter, because it survives a broker restart instead of silently dropping broadcasts.

**Durability is not the socket's job.** Messages are committed, then broadcast. Each message
carries a per-conversation gap-free `seq` assigned inside the send transaction, so a reconnecting
client asks for `?afterSeq=` and receives exactly what it missed. A dropped broadcast costs
latency, never data.

**Retries are idempotent.** The client supplies `clientMessageId`; a unique constraint makes a
retried send return the original message. Mobile clients retry constantly, and without this every
flaky connection produces duplicates. The REST send path shares the same contract, so a client
that loses its socket can keep sending without duplicating anything.

Security properties worth knowing:

- The handshake resolves the session exactly as `authenticate` does — a signed token is not
  enough; the session must be live and, in a tenant deployment, the membership still active.
- `Origin` is validated on handshake. Browsers do not apply CORS to websockets and send cookies
  regardless, so this is the CSRF equivalent for this transport.
- Every **room join** is authorised against an active participant row, not just the connection.
  Rooms are namespaced by organization.
- Every inbound frame is validated with the same Zod schemas as REST, and `maxHttpBufferSize`
  caps frame size.
- Join, leave, typing, send, and read events share a per-socket/user rate budget; message sends
  also have their tighter dedicated budget. Each socket has a hard room limit.
- Read acknowledgements cannot advance past `conversation.lastSeq`, so they cannot make messages
  that do not exist yet appear read. Deleted messages remain consistent tombstones in history and
  reconnect catch-up responses.
- A deterministic, unique `directKey` closes the concurrent find-then-create race for one-to-one
  conversations across API replicas.
- A participant may download an attachment shared in an active conversation even when another
  participant uploaded it; ownership is proved through the message and participation rows.
- Sockets are disconnected when their outbound queue exceeds `CHAT_MAX_WRITE_BUFFER`, so one slow
  consumer cannot grow the heap until the process dies.
- Publishing a user id on the revocation channel disconnects their live sockets, so logout and
  member removal take effect immediately rather than whenever the connection happens to drop.

Deployment requirements: the load balancer must forward `Upgrade`, and its idle timeout must
exceed `CHAT_PING_INTERVAL_MS`. Sockets are stateful where the rest of the app is not — capacity
is bounded by concurrent connections and file descriptors per node, not by request rate.
WebSocket client addresses are resolved with the same exact trusted-proxy hop/CIDR policy as HTTP;
do not trust arbitrary `X-Forwarded-For` values.

### Saved cards and dynamic charges

**The amount never comes from the client.** `POST /api/v1/billing/charges` accepts a `reference`,
never a price. The server resolves what that reference costs through a `ChargeableResolver` and
rejects anything outside the configured per-currency bounds. An endpoint that accepts an amount
from a request body is a free-money endpoint, and no amount of validation elsewhere fixes that.

Each client project implements `ChargeableResolver` against its own domain — an order, a booking,
a quote. The template ships a table-backed default (`chargeable_items`) for projects that have no
such entity yet. Bounds are enforced by `resolveChargeable`, not by the resolver, so a custom
resolver cannot bypass them. Set `DYNAMIC_PRICING_ENABLED`, `CHARGE_ALLOWED_CURRENCIES`, and
`CHARGE_MAX_AMOUNT_BY_CURRENCY` before the charge routes will do anything.

The resolver used by the charge endpoint must implement an atomic state machine:

```text
OPEN -> RESERVED -> CONSUMED
                    ^ payment_intent.succeeded webhook also reconciles this transition
RESERVED -> OPEN     only when Stripe reports the PaymentIntent canceled
```

The reservation stores a hash of the billing owner plus business idempotency key. A retry with the
same key resumes the same Stripe PaymentIntent; a different key receives `409` instead of charging
the same invoice/order again. The PaymentIntent carries the chargeable item and reservation IDs in
verified Stripe metadata, so webhook reconciliation can finish the transition after an API crash.
Custom domain resolvers must provide equivalent atomic `reserve` and `recordPaymentIntent`
operations—read-then-charge is not safe.

Every mutating billing route requires `Idempotency-Key`, including Checkout, SetupIntent, saved-card
default/detach, subscription cancel/resume/change, Customer Portal, dynamic charge, and refund.
The same stable key is forwarded into Stripe's idempotency layer. Customer and payment-method
webhooks reconcile local default/detached state if the provider call succeeds but the API process
dies before its local write.

**PCI scope.** `payment_methods` stores Stripe identifiers and display metadata only — brand,
last four, expiry month/year. No PAN, no CVC. Card details are collected by Stripe Elements or
PaymentSheet and never reach this server, which keeps the deployment in **SAQ-A**. Accepting raw
card numbers escalates to SAQ-D; do not add fields for them.

**Saving a card** is a SetupIntent flow: `POST /billing/setup-intents` returns a client secret,
the client confirms it, and the card is recorded from the `setup_intent.succeeded` webhook — not
from a client-supplied payment-method id, which could name another customer's card. The intent is
created with `usage: 'off_session'` so the mandate later off-session charges depend on exists.

**Charging a saved card** sets `off_session: true, confirm: true`. When the bank demands 3D
Secure, Stripe _throws_ rather than returning, and the response carries `requiresAction: true`
plus a `clientSecret`. **This is not a decline.** Treating it as one is the single most common
saved-card bug: it silently fails for every SCA-region customer while working fine in test mode.

Regional caveats worth checking before launch: India requires e-mandate registration and
pre-debit notification for recurring off-session charges, and the EU requires the mandate to have
been captured on-session.

### Multi-tenancy

`TENANCY_MODE` selects one of three modes:

- **`disabled`** (default) — no organization concepts. Behaviour is identical to a single-tenant
  deployment: the scoping extension is never installed, so there is no runtime cost.
- **`single`** — one implicit organization, created on demand and joined by every user at login.
  Data is stored tenant-correctly without the product exposing organizations, so moving to `multi`
  later is a data migration rather than a rewrite.
- **`multi`** — full lifecycle: create organizations, invite members, switch between them.

The active organization lives on `Session.activeOrganizationId` and nowhere else. It is **never**
read from a request header, and `authenticate` re-checks organization status and active membership
on every request so that removing a member takes effect immediately rather than at session expiry.

Scoping is enforced by a Prisma client extension: a model registered in `tenantScopedModels` cannot
be queried without a resolved organization — the query throws rather than returning another
tenant's rows. Trusted background work (the outbox relay, queue workers, maintenance jobs) opts out
explicitly through `withoutTenantScope('reason', …)`, which is deliberately greppable. Raw SQL
bypasses the extension entirely, so raw queries against tenant-scoped tables must filter by hand.

Permission scope comes from how a role is _granted_, not from the role itself. A `UserRole` grant
is platform-wide and satisfies `requirePermission` anywhere; a `Membership` grants the same role
only inside that organization. `requireOrgPermission` refuses platform-wide grants, and every
endpoint taking an `:organizationId` additionally requires that it match the active organization —
a permission proves what you may do in the tenant you are in, not which tenant the URL names.

Run `npm run db:seed` before enabling a non-default mode: `single` and `multi` need the global
`owner` and `member` system roles to exist.

#### Upgrading an existing disabled deployment

Never switch a live database directly from `TENANCY_MODE=disabled` to `single` or `multi`. Existing
tenant-owned rows have `organizationId=NULL`; once scoping is enabled those rows are intentionally
invisible. Use the backfill while the API and workers are stopped (or in maintenance mode):

```bash
# 1. Keep TENANCY_MODE=disabled and inspect exactly what would change.
npm run tenancy:backfill -- --organization-slug=legacy --organization-name="Legacy tenant"

# 2. Back up the database, then apply the same plan.
npm run tenancy:backfill -- --organization-slug=legacy --organization-name="Legacy tenant" --apply

# 3. Deploy with TENANCY_MODE=single first, verify counts/readiness, then choose multi when ready.
```

The script creates/reuses the organization, memberships and member role, backfills all currently
tenant-owned tables, fixes upload quota/direct-chat keys, selects the organization on active
sessions, and re-signs audit rows whose organization attribution changed. Stripe customers and
saved payment methods remain user-owned; migrate them as a separate Stripe/customer project before
changing `BILLING_OWNER` to `organization`. Keep the dry-run output and row counts with the release
record, and have a database restore plan before `--apply`.

### Per-address rate limiting

Limits are layered. Per-identity buckets (per user, per account) stop one account abusing the API;
per-address buckets stop an attacker buying budget by rotating accounts.

Addresses are canonicalised before bucketing. IPv4 is bucketed at full `/32`, but **IPv6 is
bucketed by `/64`**, because a single consumer or VPS allocation _is_ a `/64`: bucketing per exact
address would hand an attacker 2^64 free buckets. IPv4-mapped IPv6 (`::ffff:1.2.3.4`) is unwrapped
so one client cannot occupy two buckets, and an unresolvable address falls into a namespaced
sentinel bucket that client input cannot collide with.

`RATE_LIMIT_IP_PER_MINUTE` is a coarse app-wide ceiling applied before the routers.
`RATE_LIMIT_ALLOWLIST_CIDRS` exempts uptime monitors and internal callers. The Stripe webhook
route is mounted above the ceiling, because throttling Stripe's retries would corrupt billing
state.

Address-based limits depend entirely on `TRUST_PROXY_HOPS` or `TRUST_PROXY_CIDRS` matching your
actual deployment. With neither configured behind a load balancer, every request reports the
balancer's address and all per-address limits silently collapse into one global bucket; the
application logs a warning at boot in production when it detects that combination.

This is defence in depth, not DDoS protection. Application-level limits stop single-source floods
and credential stuffing from one host. They do not stop a distributed botnet — that needs
Cloudflare or a WAF in front of the application.

### Rate-limit degradation policy

Redis is the authoritative distributed rate-limit store. If it is temporarily unavailable,
ordinary limits use a bounded in-process fallback with at most
`RATE_LIMIT_FALLBACK_MAX_KEYS` counters per API process. Because those counters are not shared
between replicas, this is reduced protection intended only to keep ordinary authentication and
application traffic available during an incident. Signup, OTP send/verification, phone
verification, and password-reset operations instead return `503 SERVICE_UNAVAILABLE` until Redis
recovers. Redis failures and recovery emit structured metric fields, and the failure path sends a
rate-limited Sentry alert.

### Metrics and SLO alerts

The API and worker expose Prometheus text format on separate listeners when
`METRICS_ENABLED=true`: `METRICS_API_PORT` defaults to `9464` and `METRICS_WORKER_PORT` to `9465`.
The default `METRICS_HOST=127.0.0.1` is intentionally private. If a sidecar or private network
requires a non-loopback bind, configure a 32-character-or-longer `METRICS_BEARER_TOKEN` and enforce
the network boundary as well; the bearer token is defense in depth, not a substitute for a
firewall or NetworkPolicy.

Scrape each process independently because registries are process-local. A minimal Prometheus
configuration is:

```yaml
scrape_configs:
  - job_name: backend-api
    static_configs: [{ targets: ['backend-api:9464'] }]
    authorization: { type: Bearer, credentials: '${METRICS_BEARER_TOKEN}' }
  - job_name: backend-worker
    static_configs: [{ targets: ['backend-worker:9465'] }]
    authorization: { type: Bearer, credentials: '${METRICS_BEARER_TOKEN}' }
rule_files: ['/etc/prometheus/backend-foundation-alerts.yml']
```

Baseline availability, latency, worker failure, queue lag, dead-letter, and scheduler alerts live
in `ops/prometheus/alerts.yml`. Tune the thresholds to the product's SLOs. In particular, keep the
scheduled-job staleness expression aligned with `SCHEDULER_STALE_AFTER_HOURS` (36 hours by default).
`db_model_queries_in_flight` counts Prisma model operations in this process and is deliberately not
named or documented as live connection-pool saturation; use database/PgBouncer telemetry for actual
active, waiting, and saturated connection alerts.

### Retention maintenance

After building the application, run the single cleanup command:

```bash
npm run maintenance:cleanup
```

`DATA_RETENTION_DAYS` controls expired OTP challenges, expired/revoked sessions and their refresh
tokens, terminal outbox events, processed Stripe webhook events, failed/deleted upload records,
terminal/expired invitations, and completed monthly upload-bandwidth rows. Idempotency rows are
removed by their own `expiresAt` value.
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
server verifies exact size, magic bytes, and declared MIME synchronously, quarantines the object,
then enqueues malware/CDR scanning through the transactional outbox. The scan worker has explicit
provider and scanner timeouts and marks the upload ready only after a clean verdict. S3 supports the
AWS credential chain, explicit credentials, custom S3-compatible endpoints, and an optional CDN
base URL. Cloudinary private assets use authenticated delivery and signed URLs.

S3 upload directives include the signed `If-None-Match: *` header, and clients must send every
returned directive header exactly as supplied. The first PUT to the random object key wins; reuse of
the URL cannot overwrite the object that completion and the scanner accepted. S3-compatible storage
must implement conditional `PutObject` with the same semantics. In production, enforce conditional
writes for the upload prefix in bucket/IAM policy so no alternate writer can bypass the create-only
rule; AWS documents the `s3:if-none-match` policy condition in its
[conditional-write policy guide](https://docs.aws.amazon.com/AmazonS3/latest/userguide/conditional-writes-enforce.html).
Browser-facing bucket CORS must allow the `If-None-Match` and `Content-Type` request headers for
`PUT` from the configured application origins.
Treat `409 Conflict` or `412 Precondition Failed` as a consumed upload directive and request a new
upload rather than retrying different bytes to the same key.

`visibility=PRIVATE` is the default, and even application-public Cloudinary objects remain provider-
authenticated until scan approval. `UPLOAD_DOWNLOAD_MODE=proxy` keeps the correctness-first MVP
path: authorization and monthly bandwidth accounting happen in the API before it streams the file.
For S3-compatible storage, `UPLOAD_DOWNLOAD_MODE=redirect` performs the same authorization and
quota reservation, then returns a `307` to a short-lived signed GET URL; configure its lifetime with
`UPLOAD_DOWNLOAD_URL_TTL_SECONDS`. This removes file bytes from API processes, but the presigned URL
is a bearer credential and may be reused until it expires. One full-file quota reservation is
charged when the URL is issued; use a very short TTL and avoid logging the `Location` value. Clients
needing exact per-transfer accounting or single-use delivery should terminate downloads at a
private metered CDN/edge service. Cloudinary remains in proxy mode because its current adapter
cannot guarantee an expiring private download signature.
Completion reads only the small signature prefix needed for MIME verification. Documents remain quarantined unless a
scanner/CDR webhook is configured; the scanner receives a short-lived private source URL rather
than an in-memory/base64 copy. Production rejects PDF/document allowlists without that webhook and
requires `UPLOAD_SCAN_WEBHOOK_AUTH_TOKEN`. Configure storage and monthly bandwidth quotas plus
provider retention/deletion policies before launch.

Account deletion commits anonymization and a durable `account.erasure.requested` outbox event in one
transaction. The worker then cancels personal Stripe subscriptions and deletes provider objects in
resumable batches, retaining the object key only until deletion succeeds. If deployments can contain
objects from several historical upload providers, provide a routing adapter keyed by each row's
`provider`; the default adapter intentionally supports only the currently configured provider.

### Idempotency

`requireIdempotencyKey` plus `runIdempotent` provides durable request fingerprints, replay, expiry,
lease-based crash recovery, and conflicting-reuse detection for mutations that call an external
provider; the same business key must be forwarded to that provider. `runIdempotentTransaction` is
for database-only mutations and commits the business write plus encrypted replay record in the same
serializable transaction. Never perform network I/O inside that transaction. Replay bodies are
encrypted at rest. Callers must reuse a key only for the identical operation; responses include
`Idempotency-Replayed`.

## Verification

```bash
npm run typecheck
npm run lint
npm run build
npm run format:check
npm run db:migrate:status
```

The test layers are intentionally separate:

```bash
# Fast provider-double/unit/contract suite; Docker is not required.
npm run test:unit

# Starts isolated PostgreSQL 16 and Redis 7 containers, deploys every real Prisma migration,
# exercises database constraints/concurrency, and runs a real BullMQ queue/worker round trip.
npm run test:integration

# The CI/pre-merge command: unit followed by Testcontainers integration.
npm test

# Bounded HTTP load check (defaults: /health, 30 seconds, concurrency 20).
npm run load:http

# Fifteen-minute HTTP soak using the same bounded-memory runner.
npm run load:soak

# Authenticated websocket connection/message load; see variables below.
CHAT_LOAD_CONVERSATION_ID=<uuid> CHAT_LOAD_TOKENS=<token[,token]> npm run load:chat
```

`test:integration` uses Testcontainers and random host ports; it does not reuse, mutate, or require
the Compose development database. Docker must be running, and the first run pulls the PostgreSQL
and Redis images. The suite is pinned to Testcontainers 11.14 so the repository's Node 22 baseline
does not silently require a newer Node patch release.

The integration suite proves the invariants that mocks cannot: all migrations deploy from zero,
organization roles cannot become global grants, tenant-local uniqueness works, concurrent charge
reservation has one winner, transactional idempotency commits once, BullMQ deduplicates a stable
job ID on real Redis, concurrent chat sends remain gap-free, and two websocket nodes continue
cross-node delivery after a real Redis process restart. Unit tests continue to use local adapters
for SMTP/Twilio/FCM, uploads, and Stripe because CI must not depend on paid credentials or
third-party uptime.

The load runners print JSON summaries and exit non-zero when error-rate or p95 thresholds fail.
HTTP behavior is controlled by `LOAD_BASE_URL`, `LOAD_PATH`, `LOAD_METHOD`, `LOAD_CONCURRENCY`,
`LOAD_DURATION_SECONDS`, `LOAD_REQUEST_TIMEOUT_MS`, `LOAD_MAX_ERROR_RATE`, `LOAD_MAX_P95_MS`, and
optional authorization/body variables. Chat behavior is controlled by `CHAT_LOAD_URL`,
`CHAT_LOAD_CONNECTIONS`, `CHAT_LOAD_DURATION_SECONDS`, `CHAT_LOAD_RAMP_MS`,
`CHAT_LOAD_MESSAGES_PER_SECOND`, `CHAT_LOAD_ACK_TIMEOUT_MS`, and the corresponding threshold
variables. Run these against a production-shaped staging environment; localhost results are only a
regression signal, not a capacity claim.

Before a client production launch, add an environment-specific smoke job using Stripe CLI/test
mode, a Twilio test account, an SMTP sandbox, the Firebase test project, and the chosen storage
sandbox. Keep that job opt-in/secret-backed; never make the deterministic pull-request suite depend
on live provider accounts.
