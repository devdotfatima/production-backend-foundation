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
- [x] Add `createAuthService`, `createStripeService`, and matching controller/router factories.
- [x] Keep default factories that compose the current Prisma/environment/provider implementations.
- [x] Pass an application dependency registry into `buildApp` for router/provider replacement.
- [x] Add a worker composition root with independent outbox/scheduler/billing/uploads/metrics
      switches and injectable infrastructure factories.
- [x] Add tests using selective fake use-case dependencies without module-level mocks.

Acceptance: a client can replace one provider or repository without editing use-case code, and
integration tests do not require global Prisma/environment mutation.

## 3. Reusable request and query infrastructure

- [x] Define allowlisted filtering, sorting, and text-search schemas.
- [x] Add stable cursor composition for non-ID sort keys with an ID tie-breaker.
- [x] Add durable idempotency middleware/runner backed by `IdempotencyRecord`.
- [x] Specify request fingerprints, in-progress leases, encrypted replayable responses, expiry, and conflict
      behavior.
- [x] Add real-database concurrency tests for encrypted transactional replay, charge reservation,
      and gap-free hot-conversation sequencing.

Acceptance: modules declare allowed fields/operators rather than parsing arbitrary client-provided
SQL-like input, and duplicate mutations cannot execute twice.

## 4. OpenTelemetry, metrics, and SLOs

- [x] Add configurable OpenTelemetry SDK bootstrap before application imports.
- [x] Instrument Express, Node HTTP/HTTPS, Undici/fetch, Prisma/Postgres, and Redis; wrap the durable
      outbox/BullMQ relay and worker boundaries with explicit spans.
- [x] Persist and propagate W3C trace context through outbox jobs.
- [x] Export request rate/error/duration and worker success/failure/duration metrics.
- [x] Add queue waiting-count/oldest-job-age gauges and durable dead-letter gauges.
- [x] Define low-cardinality metric labels and redact secrets/PII.
- [x] Add Prometheus alert rules for availability, latency, queue lag, dead letters, and scheduler
      staleness.
- [x] Add an exporter-backed trace smoke test proving parent/child continuity across the async
      carrier boundary.
- [ ] Add trace dashboard provisioning. Metric cardinality tests and alert documentation are
      already present.

Acceptance: one request can be followed API-to-queue-to-worker, alerts are tied to explicit SLOs,
and no metric label contains unbounded user/request/resource IDs.

## 5. Backup and recovery

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
4. Telemetry, metrics, and SLO alerts.
5. Backup verification and restore drill.

Every slice must include schema/migration review where relevant, security tests, generated OpenAPI,
operator documentation, and the repository's full verification commands.
