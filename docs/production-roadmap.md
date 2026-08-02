# Production foundation roadmap

This roadmap turns the remaining foundation work into independently shippable slices. Complete the
service-boundary and dependency-injection work before adding new authentication or delivery
features; otherwise those features deepen the current coupling.

## 1. Service boundaries

### Stripe

- [x] Extract client/common billing helpers.
- [x] Extract Checkout and promotion-code use cases.
- [x] Extract subscription, portal, and plan-change use cases.
- [x] Extract refunds and payment-history use cases.
- [x] Extract inbound webhook verification and projection processing.
- [x] Keep `stripe.service.ts` as a compatibility barrel while internal callers migrate.
- [x] Preserve focused Stripe coverage and enforce a practical file-size ceiling.

Acceptance: no Stripe use-case file exceeds 400 lines, current imports continue to work, and all
Stripe tests pass without behavior changes.

### Authentication

- [x] Extract shared auth types, time helpers, and audit metadata.
- [x] Extract session creation, rotation, revocation, and reuse detection.
- [x] Extract signup/login and social-identity linking.
- [x] Extract OTP send/verify and phone/email verification.
- [x] Extract password change/reset flows.
- [x] Remove the temporary duplicate identity implementations and retain one owner per use case.
- [x] Extract account deletion and credential-confirmation flows.
- [x] Keep `auth.service.ts` as a compatibility barrel until callers migrate.

Acceptance: each use case has one clear owner, session/password/OTP tests can inject dependencies,
and current controller behavior remains unchanged.

## 2. Dependency-injected module factories

- [ ] Define narrow dependency contracts for databases, clocks, token/hash functions, queues, audit,
      Stripe, storage, email/SMS, and social identity verification.
- [ ] Add `createAuthService`, `createBillingService`, and matching controller/router factories.
- [ ] Keep default factories that compose the current Prisma/environment/provider implementations.
- [x] Pass an application dependency registry into `buildApp` for router/provider replacement.
- [ ] Add tests using in-memory/fake dependencies without module-level mocks.

Acceptance: a client can replace one provider or repository without editing use-case code, and
integration tests do not require global Prisma/environment mutation.

## 3. Reusable request and query infrastructure

- [x] Define allowlisted filtering, sorting, and text-search schemas.
- [ ] Add stable cursor composition for non-ID sort keys.
- [x] Add durable idempotency middleware/runner backed by `IdempotencyRecord`.
- [ ] Specify request fingerprints, in-progress leases, replayable responses, expiry, and conflict
      behavior.
- [ ] Add concurrency and replay tests.

Acceptance: modules declare allowed fields/operators rather than parsing arbitrary client-provided
SQL-like input, and duplicate mutations cannot execute twice.

## 4. Service accounts and API keys

- [x] Add service-account/API-key models and the initial migration.
- [x] Issue one-time API-key secrets and store only a lookup-safe hash and display prefix.
- [x] Reject unknown, expired, revoked, deleted, inactive, or under-scoped credentials.
- [x] Add create/key-issue/revoke endpoints behind an explicit management permission.
- [ ] Replace free-form permissions with a centrally allowlisted permission catalog.
- [ ] Add service-account list/update/disable, key list/rotate, and last-used inspection flows.
- [ ] Audit service-account, permission, issuance, rotation, revocation, and disable operations.
- [ ] Define Bearer/API-key precedence and apply API-key auth to documented machine endpoints.
- [ ] Add per-key rate limits without performing an unbounded database write on every request.
- [ ] Add lifecycle, scope-denial, expiry, revocation, rotation, concurrency, and audit tests.
- [ ] Document secret handling and expose the management API through generated OpenAPI.

Acceptance: raw keys are shown once, permissions are deny-by-default, credential lifecycle changes
are audited, revocation takes effect immediately, and logs/telemetry never contain raw keys.

## 5. Outbound customer webhooks

- [x] Add and migrate the initial endpoint/delivery models.
- [x] Add endpoint create/list/delete and event subscriptions with one-time secrets.
- [ ] Add endpoint update/verification state (delete disables; secret rotation is implemented).
- [ ] Finish SSRF hardening against DNS rebinding while preserving HTTPS-only destinations.
- [x] Create deliveries transactionally from domain/outbox events.
- [x] Sign timestamped payloads.
- [x] Define replay tolerance and document signature verification.
- [x] Add bounded outbox retries, durable dead-letter state, and permission-gated redrive.
- [ ] Add concurrency, signature, SSRF, retry, and redrive tests.

Acceptance: business transactions never perform outbound HTTP, every attempt is durable and
observable, and permanently failed deliveries require an explicit audited redrive.

## 6. OpenTelemetry, metrics, and SLOs

- [ ] Add configurable OpenTelemetry SDK bootstrap before application imports.
- [ ] Instrument Express, outbound HTTP, Prisma/Postgres, Redis, and BullMQ where supported.
- [ ] Propagate trace context into outbox jobs and outbound webhooks.
- [ ] Export request rate/error/duration and worker success/failure/duration metrics.
- [ ] Add queue waiting-count/oldest-job-age gauges and durable dead-letter gauges.
- [ ] Define low-cardinality attributes and redact secrets/PII.
- [ ] Add Prometheus recording/alert rules for availability, latency, queue lag, and dead letters.
- [ ] Add trace/metric smoke tests and dashboard/alert documentation.

Acceptance: one request can be followed API-to-queue-to-worker, alerts are tied to explicit SLOs,
and no metric label contains unbounded user/request/resource IDs.

## 7. Backup and recovery

- [ ] Document provider prerequisites for automated backups and PITR.
- [ ] Add a scheduled verification job that restores the newest backup into an isolated database.
- [ ] Run migrations/read-only integrity probes against the restored database.
- [ ] Record verification age/result as a metric and alert on stale/failing verification.
- [ ] Write a restore runbook covering authority, target time, commands, validation, cutover, and
      rollback.
- [ ] Run and record a restore drill on a fixed cadence.

Acceptance: backup success is proven by restoration, the maximum acceptable verification age is
alerted, and an on-call engineer can execute the runbook without inventing steps during an incident.

## Delivery order

1. Service splits and compatibility barrels.
2. Dependency-injected factories.
3. Query/idempotency infrastructure.
4. Service-account/API-key hardening.
5. Outbound customer-webhook hardening.
6. Telemetry, metrics, and SLO alerts.
7. Backup verification and restore drill.

Every slice must include schema/migration review where relevant, security tests, generated OpenAPI,
operator documentation, and the repository's full verification commands.
