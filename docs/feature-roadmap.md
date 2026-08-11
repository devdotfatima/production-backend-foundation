# Feature roadmap

This plans the next five capability areas for the template. It is a companion to
`production-roadmap.md`, which covers hardening work already in flight.

## Framing: what "template" means for these features

This repository is not one product. It is the starting point for many client MVPs, so every
feature below is judged on three axes that a single-product backend would not care about:

1. **Cost when unused.** A client who does not need chat must not pay for it in migrations,
   boot time, environment variables, or cognitive load. Every feature here ships behind an env
   switch, defaulting to _off_ unless it is a safety control.
2. **Cost to retrofit.** The reverse of the above. A feature whose _seam_ is cheap now but
   catastrophic later must land its seam immediately, even if the feature stays off. Tenancy is
   the whole reason this document exists.
3. **Blast radius on existing modules.** Prefer additive columns and new choke points over
   rewriting `auth`, `stripe`, or `uploads`.

The single most important consequence: **tenancy is not a feature you schedule, it is a
coordinate system you either have or you do not.** Chat conversations, saved payment methods,
and scheduled-job scoping all need to know whether a tenant exists. If tenancy lands after them,
all three get rewritten. It goes first.

---

## 1. Multi-tenancy

### Current state

RBAC is global: `Role` and `Permission` are singletons, `UserRole` maps a user to a role with no
scope, and `requirePermission` in `src/middleware/access-control.ts` checks "does this user hold
this permission anywhere". Ownership is a single equality check in
`src/lib/resource-ownership.ts`. `User.stripeCustomerId` makes the _user_ the billing entity.
Nothing in the schema can express "this row belongs to Acme Corp".

### The decision that shapes everything else

Three isolation models were considered:

| Model                                                  | Isolation                               | MVP cost                                                                                                                | Verdict                                        |
| ------------------------------------------------------ | --------------------------------------- | ----------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------- |
| Database or schema per tenant                          | Strongest                               | Migration fan-out, connection-pool explosion, per-tenant ops                                                            | **No.** Wrong economics for MVPs.              |
| Shared schema + Postgres RLS                           | Strong, enforced by the database        | Prisma needs `SET LOCAL` per transaction; every query must run inside an interactive transaction; debugging gets harder | **Optional hardening layer**, not the default. |
| Shared schema + application scoping at one choke point | Good, if the choke point is unavoidable | Low                                                                                                                     | **Default.**                                   |

Recommendation: **shared schema, application-scoped, enforced through a single unavoidable
choke point** — a Prisma client extension that refuses to query a tenant-scoped model without a
resolved tenant. The failure mode of application scoping is a developer forgetting a `where`
clause; the extension removes the opportunity to forget rather than relying on review. RLS is
planned as an opt-in second layer for clients with a compliance driver, not as the baseline.

### Tenancy modes

The template ships three modes, selected by `TENANCY_MODE`:

- `disabled` — no `Organization` tables mounted, `requirePermission` behaves exactly as today.
  This is the current behavior and stays the default so existing client projects are unaffected.
- `single` — tables exist, one implicit default organization is auto-created and every user
  joins it. Lets a B2C client adopt org-scoped code paths without exposing org concepts in the
  product, and makes a later switch to `multi` a data migration instead of a rewrite.
- `multi` — full organization lifecycle, invitations, org switching.

### Model additions

```
Organization        id, slug (unique), name, status, permissionEpoch, settings Json,
                    stripeCustomerId?, createdAt/updatedAt/deletedAt
Membership          id, organizationId, userId, roleId, status (INVITED|ACTIVE|SUSPENDED),
                    invitedByUserId?, joinedAt?, @@unique([organizationId, userId])
Invitation          id, organizationId, email, roleId, tokenHash, expiresAt, acceptedAt?,
                    revokedAt?, invitedByUserId
Role                + organizationId String?   // null = system/global role
```

`User` is deliberately **not** tenant-scoped. One human, many organizations — this is the call
that makes invitations, org switching, and B2B sales motions work, and reversing it later is
expensive.

Tenant-scoped columns (`organizationId`) are present on uploads, billing projections, audit
events, chat records, notification preferences/deliveries, and new tenant models. The scope
registry is derived from Prisma's DMMF so adding such a column cannot
silently omit its model; only tenancy-bootstrap models have explicit exemptions. `OutboxEvent`
carries tenant attribution in its payload/aggregate because the relay is deliberately
tenant-agnostic. `IdempotencyRecord.actorKey` uses an organization prefix rather than a nullable
column.

### Tenant resolution and the choke point

- **Resolution.** The active organization lives on `Session`, not in a request header. A header
  such as `X-Organization-Id` is attacker-controlled and forces a membership lookup on every
  request; a session column is authoritative and cached with the session read that
  `authenticate` already performs. `AccessClaims` gains `organizationId?`, so the JWT and the
  session agree, and switching orgs issues a new access token.
- **Switching.** `POST /api/v1/organizations/:id/switch` verifies membership, updates the
  session, and re-issues the access token. Refresh-token rotation is untouched.
- **Propagation.** An `AsyncLocalStorage` request context carries `{ userId, organizationId,
requestId }`, set by `authenticate` and read by the Prisma extension. This avoids threading an
  org argument through every service signature — the change that would otherwise touch every
  file in `src/modules`.
- **Enforcement.** A Prisma client extension holds a registry of tenant-scoped models. For those
  models it injects `organizationId` into every `where`, and **throws** if no organization is
  resolved. Escaping the scope requires an explicit, greppable `withoutTenantScope()` wrapper —
  used by the outbox relay, maintenance jobs, and the webhook receiver, all of which legitimately
  run outside a request.

### RBAC changes

Permission guards make their authorization coordinate explicit:

- `requirePermission(code)` accepts only a **global** `UserRole` grant and is safe for platform-wide
  operations even when the session has an active organization.
- `requireOrgPermission(code)` accepts only an active membership grant for the active organization.
- `requireContextPermission(code)` accepts either, but is reserved for services whose database
  operations are guaranteed to pass through tenant scoping.

The Redis cache key in `access-control.ts` becomes
`permission:{userId}:{userEpoch}:{orgId}:{orgEpoch}:{code}`. Adding `Organization.permissionEpoch`
gives O(1) invalidation when an org role's permissions change — the alternative, bumping every
member's `permissionEpoch`, is an unbounded write on a large org.

New permissions: `organizations:read`, `organizations:write`, `members:read`, `members:write`,
`invitations:write`.

### Billing ownership

The sharpest coupling. `User.stripeCustomerId` and `ensureCustomer()` in `stripe.shared.ts`
assume the user pays. B2B clients need the org to pay.

Introduce `resolveBillingOwner(context) → { type: 'user' | 'organization', id, stripeCustomerId }`,
selected by `BILLING_OWNER` env (`user` | `organization`). `ensureCustomer` and every Stripe use
case take the resolved owner instead of a `userId`. `Organization.stripeCustomerId` mirrors the
existing user column. Doing this _before_ section 3 means saved payment methods are attached to
the right entity from day one.

### Tasks

- [x] Add `TENANCY_MODE` to env and `.env.example`.
- [x] Add the `organizations` route gate, defaulting to the tenancy switch.
- [x] Add `BILLING_OWNER` to env, rejecting `organization` while `TENANCY_MODE=disabled`.
- [x] Add `Organization`, `Membership`, `Invitation`; add `Role.organizationId`; migration + seed update.
- [x] Add `organizationId` to tenant-scoped models and register them in the scope registry.
- [x] Add `Session.activeOrganizationId` and resolve it in `authenticate`, re-checking membership
      and organization status per request.
- [x] Split global, organization-only, and explicitly tenant-scoped context permission guards;
      extend the cache key and add `Organization.permissionEpoch`.
- [x] Add the `AsyncLocalStorage` request context and set it in `authenticate`.
- [x] Add the tenant-scoping Prisma extension, the scoped-model registry, and `withoutTenantScope()`.
- [x] Wrap the outbox relay, notification workers, and maintenance entrypoints in `withoutTenantScope()`.
- [x] Bootstrap `single` mode: create the implicit organization on demand and set
      `Session.activeOrganizationId` at session creation.
- [x] Add org CRUD, member list/role-change/remove, invitation issue/accept/revoke, and org switch endpoints.
- [x] Stamp `organizationId` on audit writes and bring it under the integrity signature
      (`integrityVersion` 2); audit must record actions taken before a tenant is resolved.
- [x] Add the organizations module to the generated OpenAPI document, with a test asserting every
      `$ref` in the document resolves (a dangling ref renders as an empty box in Swagger UI
      rather than failing).
- [x] Add `resolveBillingOwner` and route Stripe customer resolution through it. Resolved from the
      request context rather than threaded through every signature, so switching a client project
      from user-pays to organization-pays stays a configuration change.
- [x] Tenant-prefix the idempotency actor key. **This was a real cross-tenant leak**: records are
      keyed on (actorKey, scope, keyHash), so a user in two organizations could replay the first
      organization's stored response by reusing the key in the second.
- [x] Add cross-tenant leak tests: every tenant-scoped model across every operation, cursor
      pagination, idempotency replay, and concurrent tenant contexts.
- [x] Document the three modes and the `disabled → single → multi` upgrade path (README).
- [x] ~~Replace `assertResourceOwner` call sites with tenant-scope assertions.~~ **Withdrawn.**
      Its only call site guards `Device`, an FCM push token belonging to a human who may be in
      many organizations. User ownership is the correct check there; tenant-scoping it would be
      a regression.
- [ ] _(Optional, separate slice)_ RLS policies plus a `SET LOCAL app.current_organization` transaction wrapper.

**Acceptance:** a tenant-scoped query without a resolved organization throws rather than returning
another tenant's rows; a user in two organizations sees disjoint data across a switch; `disabled`
mode is byte-for-byte behaviorally identical to today; and a deliberately-written leaky query
fails a test rather than review.

---

## 2. Chat

### Scope

A generic conversation substrate, not a product-specific chat. `DIRECT`, `GROUP`, and `SUPPORT`
conversation types cover the three shapes client MVPs actually ask for (user-to-user, team room,
customer-to-agent). Explicit non-goals for v1: end-to-end encryption, threads/replies, voice and
video, message search beyond Postgres full-text, and federation. Each is a plausible v2; none
should hold up v1.

### Transport decision

| Option                                     | Ships in  | Ops cost                                           | Notes                                                                                                               |
| ------------------------------------------ | --------- | -------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------- |
| SSE (`text/event-stream`) + REST for sends | Days      | Redis pub/sub only, already present                | One-way, no sticky sessions, survives every corporate proxy, trivially auth'd with the existing cookie/bearer logic |
| `socket.io` + Redis adapter                | 1–2 weeks | New dep, client-lib coupling, sticky sessions      | Presence/rooms/acks for free                                                                                        |
| Managed (Ably, Pusher, Supabase Realtime)  | Days      | Per-message billing, vendor lock-in, auth bridging | Fastest, worst unit economics at scale                                                                              |

**Decision (set by the product owner): WebSockets, built to production scale.** SSE is off the
table. The notes below are what "production level" has to mean concretely — a raw `ws` server
with a `socket.emit` is not the deliverable.

**Library: `socket.io` with `@socket.io/redis-streams-adapter`.** Raw `ws` means hand-building
rooms, acks, reconnection with backoff, and heartbeat semantics — all of which are where bespoke
implementations break under load. `uWebSockets.js` is faster but ships a native binary and
complicates deploys for marginal gain at MVP scale. socket.io's cost is client-library coupling,
which is acceptable given what it removes.

Configure `transports: ['websocket']` only. socket.io's HTTP long-polling fallback is what forces
sticky sessions; disabling it means any node can serve any connection and the load balancer needs
no session affinity. The Redis streams adapter (not the classic pub/sub adapter) is chosen because
it survives a broker restart without silently dropping cross-node broadcasts.

Non-negotiables for the implementation, in rough order of how often they are gotten wrong:

- **Durability is not the socket's job.** Store → commit → _then_ broadcast. The adapter is a
  fanout optimisation; the `seq` catch-up path below is the source of truth. A dropped broadcast
  must cost latency, never data.
- **Connections outlive access tokens.** A 15-minute token cannot authorise an 8-hour socket.
  Authenticate on handshake, then re-validate the session on an interval and on a Redis-published
  revocation signal, disconnecting with a code the client understands as "re-auth and reconnect".
  Without this, logout and member-removal do not actually terminate live sockets.
- **Authorise every room join, not just the connection.** Room names are namespaced by
  organization, and joining a conversation requires an active participant row. Connection-time
  auth alone is how cross-tenant leaks happen.
- **Validate every inbound frame** with the same Zod schemas as REST, plus `maxHttpBufferSize`.
  A socket is an unauthenticated-shaped input surface once it is open.
- **Check `Origin` on handshake.** Browsers do not apply CORS to WebSockets and cookies are sent
  regardless, so origin validation is the CSRF equivalent here.
- **Backpressure.** Monitor per-socket write buffer depth; disconnect consumers that cannot keep
  up rather than growing the heap. One slow client must not degrade the node.
- **Graceful shutdown.** Stop accepting upgrades, tell connected clients to reconnect, drain, then
  close — otherwise every deploy is a thundering-herd reconnect storm.
- **Tune `pingInterval`/`pingTimeout` below the load balancer's idle timeout**, and confirm the
  balancer forwards `Upgrade`. This is the single most common cause of "it works locally".
- **Cap concurrent connections per IP and per user**, and rate-limit inbound events per socket.
  This is the §4 item that was blocked on chat existing.

Sends still go over the socket with acknowledgements, but the REST `POST` path stays as the
supported fallback and as the idempotent write path — same `clientMessageId` contract either way.

### Model

```
Conversation        id, organizationId, type, title?, createdByUserId, lastSeq BigInt @default(0),
                    lastMessageAt?, metadata Json?, createdAt/updatedAt/deletedAt
Participant         id, conversationId, userId, role (OWNER|MEMBER), lastReadSeq BigInt @default(0),
                    mutedUntil?, joinedAt, leftAt?, @@unique([conversationId, userId])
Message             id, conversationId, senderUserId?, seq BigInt, clientMessageId,
                    type (TEXT|SYSTEM|ATTACHMENT), body?, uploadId?, editedAt?, deletedAt?,
                    @@unique([conversationId, seq]), @@unique([conversationId, clientMessageId])
MessageReceipt      (optional, v1.1) messageId, userId, deliveredAt?, readAt?
```

### The three details that decide whether chat works

**Ordering.** `Message.seq` is a per-conversation gap-free counter assigned by incrementing
`Conversation.lastSeq` inside the same transaction as the insert. UUIDv7 is time-ordered and
would _almost_ work, but "give me everything after what I have" needs a dense sequence — with
UUIDs the client cannot tell a gap from a pause. `seq` makes reconnect-and-catch-up a single
indexed range scan and makes unread counts arithmetic: `lastSeq - participant.lastReadSeq`.

**Durability.** Store, commit, _then_ publish. The Redis pub/sub fanout is an optimization, never
the source of truth. On connect or reconnect the client sends its last known `seq` per
conversation and receives the delta over the same stream; a dropped pub/sub message costs latency,
not data. This is the difference between chat that survives a Redis restart and chat that does not.

**Idempotency.** The client generates `clientMessageId`; the unique constraint makes a retried
send return the original message instead of duplicating it. Mobile clients retry constantly on
flaky networks — without this, every subway ride produces double messages.

### Endpoints

```
WS     /socket.io  (namespace /chat)               websocket, transports: ['websocket'] only
POST   /api/v1/chat/conversations                  create (DIRECT dedupes on participant pair)
GET    /api/v1/chat/conversations                  list, cursor-paginated, unread counts
GET    /api/v1/chat/conversations/:id/messages     cursor page, or ?afterSeq= for catch-up
POST   /api/v1/chat/conversations/:id/messages     send
PATCH  /api/v1/chat/messages/:id                   edit (tombstone + editedAt)
DELETE /api/v1/chat/messages/:id                   soft delete
POST   /api/v1/chat/conversations/:id/read         advance lastReadSeq
POST   /api/v1/chat/conversations/:id/typing       ephemeral, Redis-only, never persisted
POST   /api/v1/chat/conversations/:id/participants add/remove
```

### Integration points

- **Uploads.** Attachments reuse the existing presign → scan → `READY` pipeline. A message
  referencing an upload that is not `READY` is rejected, so unscanned files never fan out.
- **Outbox.** A message to a participant with no live connection enqueues a push/email
  notification through the existing outbox, debounced per conversation so a burst of ten messages
  is one notification.
- **Tenancy.** `Conversation.organizationId` is set from the request context; participants must be
  members of the same organization. This is why chat follows section 1.
- **Rate limiting.** Per-user-per-conversation send limits, a per-user global send ceiling, body
  size caps, and a participant-count cap. Chat is the single easiest abuse surface in the product.
- **Scaling.** Sockets are stateful where the rest of the app is not: capacity is bounded by
  concurrent connections and file descriptors per node, not by request rate. Size on connections,
  keep the per-connection heap small, and treat the Redis adapter as a hard dependency of the
  chat module rather than an optimisation.

### Tasks

- [x] Add the `chat` module flag and websocket env (origins, ping/timeout, connection caps), plus models and migration.
- [x] Add the socket.io server on the existing HTTP server with `@socket.io/redis-streams-adapter`
      and `transports: ['websocket']`; no sticky sessions required.
- [x] Handshake auth reusing the session/membership checks, plus `Origin` validation.
- [x] Terminate live sockets on a published revocation signal, so logout and member removal close
      open connections instead of waiting for token expiry.
- [x] Add the periodic re-validation sweep as a second line of defence for sessions that expire
      without an explicit revocation event.
- [x] Authorise every room join against an active participant row; namespace rooms by organization.
- [x] Validate every inbound event with the REST Zod schemas; cap `maxHttpBufferSize`.
- [x] Add per-socket event rate limits and per-IP connection caps.
- [x] Add backpressure handling and heartbeat tuning. Swept on a timer rather than on inbound
      packets: the socket that needs disconnecting is the one that stopped reading, which by
      definition is not sending anything to sample on.
- [x] Add graceful drain on shutdown so deploys do not cause a reconnect storm.
- [x] Emit connection-count, room-count, and message-rate metrics for the §5b metrics endpoint.
- [x] Implement send with transactional `seq` assignment and `clientMessageId` idempotency.
- [x] Implement catch-up (`?afterSeq=`), read markers, and unread counts.
- [x] Implement typing as an ephemeral room relay, never persisted.
- [ ] Add presence as TTL'd Redis keys.
- [x] Wire attachments to the uploads pipeline (a message referencing a non-READY upload is
      rejected, so unscanned files never fan out).
- [ ] Wire offline fanout to the outbox with per-conversation debouncing.
- [x] Add per-conversation rate limits and body/participant caps.
- [ ] Add block/mute.
- [x] Add tests: sequence assignment, duplicate `clientMessageId`, catch-up direction, room-join
      rejection, handshake auth rejection (missing token, dead session, inactive membership),
      rejected `Origin`, oversized frame, and rate-limited send — 13 of them against a real
      socket.io server.
- [x] Add tests needing live infrastructure: ordering under genuinely concurrent sends, plus
      cross-node broadcast before and after restarting the Redis process.
- [x] Document load-balancer requirements (`Upgrade` forwarding, idle timeout above ping interval)
      and the client reconnect/catch-up contract (README).

**Acceptance:** two concurrent senders produce a strictly ordered gap-free sequence; a client that
disconnects for five minutes reconstructs exactly the missed messages from its last `seq`; a
retried send is idempotent; and a Redis restart loses zero messages.

---

## 3. Stripe: saved cards and dynamic-amount charges

### Current state

The module supports Checkout Sessions against a server-owned price catalog, subscriptions, portal,
refunds, SetupIntents, webhook-projected payment methods, off-session charging, and a server-owned
dynamic charge resolver. `BILLING_OWNER` selects personal or active-organization ownership without
accepting a customer or amount identifier from the request.

### The one non-negotiable rule

**The amount never comes from the client.** "Dynamic products" must mean _server-computed_, not
_client-supplied_. A `POST /charge { amount: 100 }` endpoint is a free-money endpoint, and it is
the single most common critical finding in MVP payment code.

The template therefore ships a `ChargeableResolver` seam rather than a generic charge endpoint:

```ts
interface ChargeableResolver {
  resolve(
    reference: string,
    context: BillingContext,
  ): Promise<{
    amount: number; // minor units, computed server-side
    currency: string;
    description: string;
    metadata: Record<string, string>;
  }>;
}
```

Each client project implements it against its own domain — an order, a booking, a quote, an
invoice. The template provides a default implementation backed by a `ChargeableItem` table for
projects that have no domain entity yet. The endpoint accepts a _reference_, never a price.

Guardrails on top: `DYNAMIC_PRICING_ENABLED` flag, per-currency min/max bounds (mirroring the
existing `REFUND_MAX_AMOUNT_BY_CURRENCY` pattern), and a currency allowlist. A pricing bug should
produce a rejected request, not a five-figure charge.

### Model

```
PaymentMethod   id, organizationId?, userId, stripePaymentMethodId (unique), type, brand?, last4?,
                expMonth?, expYear?, fingerprint?, isDefault, mandateId?, detachedAt?,
                createdAt/updatedAt/deletedAt

ChargeableItem  (default resolver only) id, organizationId?, reference (unique), amount, currency,
                description, status, expiresAt?, consumedAt?
```

No PAN, no CVC, no expiry beyond the display fields Stripe returns. Card data must never touch
this server — Stripe Elements or PaymentSheet only, which keeps the client on **PCI SAQ-A**.
Accepting raw card numbers escalates to SAQ-D and is an eight-figure-liability mistake for a
startup; the template should make it structurally impossible.

### Flows

**Saving a card.**
`POST /billing/setup-intents` → `client_secret` → client confirms with Stripe.js →
`setup_intent.succeeded` and `payment_method.attached` webhooks create the `PaymentMethod` row.
The card is recorded from the _webhook_, not from a client-supplied payment-method id. If a
client-supplied id is ever accepted, it must be verified as belonging to the resolved customer via
the Stripe API first.

**Charging without saving** (the "sometimes we don't" case).
`POST /billing/payment-intents` with no `savePaymentMethod` → PaymentIntent with no
`setup_future_usage`. Card is used once and never stored.

**Charging with saving.** Same call with `savePaymentMethod: true` → `setup_future_usage:
'off_session'`, which also establishes the mandate needed for later off-session charges.

**Charging a saved card (off-session).**
`POST /billing/payment-intents { reference, paymentMethodId }` → server resolves the amount, then
creates the PaymentIntent with `off_session: true, confirm: true`.

The failure case that sinks most implementations: the bank demands 3D Secure and Stripe returns
`authentication_required`. The endpoint must return `requires_action` plus the `client_secret` so
the frontend can prompt the customer, rather than treating it as a hard decline. Plan for it in
v1; retrofitting it means every saved-card charge silently fails for European customers.

### Additional considerations

- **Idempotency.** Mandatory `Idempotency-Key` on every charge endpoint, using the existing
  `IdempotencyRecord` runner plus Stripe's own `idempotencyKey`, exactly as
  `stripe.refunds.service.ts` already does. Two layers, because the local record protects against
  duplicate _business_ operations and Stripe's protects against duplicate _API_ calls.
- **Default payment method.** Setting a default writes both the local `isDefault` and the Stripe
  customer's `invoice_settings.default_payment_method`, in that order, reconciled by webhook.
- **Detaching.** Detach in Stripe, then soft-delete locally. Refuse to detach the last payment
  method backing an active subscription — otherwise the next renewal fails silently.
- **Webhook projection.** Extend `stripe.webhooks.service.ts` for `payment_method.attached`,
  `.detached`, `.updated`, `setup_intent.succeeded`, `payment_intent.succeeded`, `.payment_failed`,
  and `.requires_action`. The webhook is the source of truth; API responses are optimistic.
- **Regional compliance.** Off-session charging in India requires e-mandate registration and
  pre-debit notification; the EU requires the mandate to have been captured on-session. Document
  this rather than discovering it from a client's failed launch.
- **Tenancy.** `PaymentMethod` hangs off the resolved billing owner from section 1.

### Tasks

- [x] Add `PaymentMethod` and `ChargeableItem` models plus migration.
- [x] Add `DYNAMIC_PRICING_ENABLED`, per-currency bounds, and the currency allowlist to env.
- [x] Add the `ChargeableResolver` interface, the default table-backed implementation, and DI wiring
      through the existing `createStripeService` factory. Bounds are enforced by `resolveChargeable`
      rather than by the resolver, so a custom resolver cannot bypass them.
- [x] Add `stripe.payment-methods.service.ts`: setup intents, list, set default, detach.
- [x] Add `stripe.charges.service.ts`: on-session, on-session-with-save, and off-session charges.
- [x] Handle `requires_action` / `authentication_required` end to end. Stripe _throws_ rather than
      returning on an off-session challenge, so the intent is recovered from the error.
- [x] Extend webhook projection for payment-method lifecycle events. Driven from
      `setup_intent.succeeded` rather than `payment_method.attached`, because only the setup intent
      carries the `userId` metadata — under organization-owned billing the Stripe customer maps to
      an organization, so no user is recoverable from the customer alone. `payment_intent.*` was
      already projected.
- [x] Enforce idempotency and amount bounds on every charge path.
- [x] Add tests: client-supplied amount ignored, bounds enforced (including against a custom
      resolver), cross-user payment-method access rejected, 3DS path, detach ordering and
      last-card-with-subscription refusal.
- [ ] Add a database-backed test for duplicate idempotency-key replay on the charge path (the
      existing idempotency coverage is unit-level; this needs a live Postgres).
- [x] Extend the OpenAPI document and write the SAQ-A / mandate notes (README).

**Acceptance:** no code path lets a request body influence a charged amount; a saved card can be
charged off-session with a working 3DS fallback; a duplicate charge request is replayed rather
than re-executed; and stored card data is limited to Stripe identifiers and display metadata.

---

## 4. Per-IP and edge rate limiting

### Correction to the stated premise

Per-IP limiting is **not** absent. `src/modules/auth/auth.abuse.ts` applies per-IP _and_ global
ceilings to seven public auth endpoints (signup, login, OTP send/verify, and the three
password-reset steps), fail-closed, with capacity alerting. `password-reset:confirm` additionally
keys its tight bucket on IP. The design there is deliberately good: high shared-IP ceilings so an
office NAT is not treated as one account, with tight per-destination buckets layered on top.

The real gaps are narrower and more specific:

1. **IPv6 is bucketed per exact address.** A single consumer or VPS IPv6 allocation is a `/64` —
   18 quintillion addresses. Every per-IP limit in the codebase is trivially bypassed by rotating
   within one's own prefix. **This is the actual vulnerability**, and it is a small fix:
   canonicalize to `/64` for IPv6 and `/32` for IPv4 before hashing.
2. **No app-wide ceiling.** Everything outside those seven auth endpoints — `/api/v1/uploads`
   presign, billing, chat once it exists, docs, `/api/v1/system` — has no per-IP bound at all.
   `userIdentityRateLimit` calls `next()` when there is no `userId`, so it is per-account only by
   construction.
3. **`ip` degrades to the literal string `'unknown'`.** `requestMetadata` falls back to
   `'unknown'` when Express cannot resolve an address, collapsing all such clients into one shared
   bucket. Harmless today; a self-inflicted outage the day a proxy is misconfigured.
4. **Proxy misconfiguration is silent.** With `TRUST_PROXY_HOPS=0` behind a load balancer, every
   request reports the balancer's IP and every per-IP limit becomes a global limit. Nothing warns.
5. **No allowlist.** Uptime monitors, health checks, and office ranges cannot be exempted.

### Plan

- [x] Add `clientIpKey` in `src/lib/client-ip.ts`: canonicalize IPv6 to `/64`, IPv4 to `/32`, and
      return a namespaced sentinel for unresolvable addresses. (Its own module rather than
      `rate-limit.ts`: byte-level parsing is also what CIDR allowlist matching needs.)
- [x] Route every existing IP-keyed limiter through it (`auth.abuse.ts`, `password-reset:confirm`).
- [x] Add `ipRateLimit(scope, limit, window)` middleware alongside `userRateLimit`.
- [x] Mount a coarse app-wide per-IP ceiling in `buildApp` after `trust proxy`, before routers.
      Local-fallback failure mode, generous limit — this is a blunt instrument, not the real defense.
- [x] Add per-IP limits to unauthenticated and identity-rotatable surfaces: docs and system are
      covered by the app-wide ceiling; uploads presign has its own tighter bucket ahead of
      `authenticate`.
- [x] Cap chat stream connection count per IP, not just request rate.
- [x] Exempt the Stripe webhook route — throttling Stripe's retries corrupts billing state.
- [x] Add `RATE_LIMIT_ALLOWLIST_CIDRS` for monitors and internal callers.
- [x] Add a boot-time warning when `TRUST_PROXY_HOPS=0` and `TRUST_PROXY_CIDRS` is empty in
      production, since that combination almost always means the limiter is measuring the proxy.
- [x] Emit `rate_limit.rejected` counters keyed by scope for the metrics endpoint in section 5.
      Counted in-process rather than logged: one log line per rejection is itself an outage.
- [x] Add tests: IPv6 prefix collapsing, allowlist bypass, webhook exemption, sentinel bucketing,
      and CIDR matching across families.
- [ ] Add a test for spoofed `X-Forwarded-For` beyond the trusted hop count (needs an HTTP-level
      harness; the repo has no supertest-style dependency yet).

Document the limit explicitly: application-level IP limiting stops single-source floods and
credential stuffing from one host. It does not stop a distributed botnet — that needs Cloudflare
or a WAF in front. Say so in the README so nobody mistakes this for DDoS protection.

**Acceptance:** rotating within a `/64` no longer multiplies an attacker's budget; every route has
some per-IP bound; a misconfigured proxy fails loudly at boot rather than silently degrading; and
Stripe retries are never throttled.

---

## 5. Platform gaps

### 5a. Email templating

`notifications/providers.ts` builds subjects and bodies with an inline `if/else` chain and
plain-text only. Adding a fifth email means editing a function that already does provider
selection, OTP validation, and decryption.

- [x] Add a template registry: `src/modules/notifications/templates/{key}/{subject.txt,body.txt,body.html}`,
      with a Zod-typed payload contract per template so a template and its caller cannot drift.
- [x] Render with a minimal typed interpolator (no new runtime dependency) and escape HTML by
      default; MJML or `react-email` compiles at build time only if a client wants rich layouts.
- [x] Split provider transport from message construction so SMTP, SES, Resend, and Postmark are
      swappable per client.
- [x] Add locale resolution with a documented fallback chain.
- [x] Add `List-Unsubscribe` and `List-Unsubscribe-Post` headers for anything non-transactional.
- [x] Add a dev-only preview route and snapshot tests, so a broken template fails CI rather than
      arriving in a customer's inbox.

### 5b. Metrics endpoint

Roadmap section 6 plans full OpenTelemetry. That is the right destination but the wrong first
step for MVP timelines. Ship the cheap slice now and let OTel supersede it.

- [x] Expose Prometheus text format on a **separate internal port**, not a public path. Metrics
      leak route topology, queue depths, and traffic volumes.
- [x] RED metrics for HTTP using _route templates_ (`/api/v1/users/:id`), never raw paths — the
      fastest way to destroy a Prometheus instance is a label containing UUIDs.
- [x] Export queue waiting count, oldest job age, outbox dead-letter count, rate-limit rejections,
      and chat connections. Prisma model operations in flight are explicitly named as such; actual
      pool active/waiting/saturation must come from PostgreSQL or PgBouncer telemetry.
- [x] Worker exposes its own endpoint; document the multi-process scrape configuration.
- [x] Add cardinality tests asserting no label carries an unbounded value.

### 5c. Scheduled jobs

`maintenance:cleanup`, `:audit-verify`, and `:audit-backfill` are standalone entrypoints run by
external cron. That is operationally fine but invisible: nothing records whether a run happened,
and every client deployment reinvents the cron wiring.

- [x] Add a job registry mapping a name to a handler, schedule, and timeout, with the existing
      maintenance scripts refactored into handlers so both execution paths share code.
- [x] Use BullMQ repeatable jobs (`upsertJobScheduler`) so schedules live in code; keep the
      external-cron entrypoints for serverless deploys. Registration is idempotent and prunes
      entries no longer in the registry, which would otherwise fire forever.
- [x] Record `lastRunAt`, `lastDurationMs`, and `lastStatus` per job, plus a per-job timeout so a
      hung handler cannot block the queue.
- [x] Alert on staleness against `SCHEDULER_STALE_AFTER_HOURS` (needs the §5b metrics endpoint).
- [x] Add a permission-gated, audited manual trigger endpoint for on-call use.
- [x] Handle timezones explicitly via `SCHEDULER_TIMEZONE` and document DST behaviour.

**Acceptance:** adding an email template touches only the template directory and its payload
schema; metrics are unreachable from the public internet and carry no unbounded labels; and a job
that stops running raises an alert.

---

## Delivery order

1. **Tenancy seam** (section 1 through the Prisma extension and request context, in `disabled`
   mode). Nothing else is safe to build until the coordinate system exists.
2. **IP rate-limit fixes** (section 4). Days of work, closes a live IPv6 bypass, and depends on
   nothing.
3. **Tenancy features** (organizations, memberships, invitations, billing owner). Unblocks 3 and 2.
4. **Stripe saved cards and dynamic charges** (section 3). Highest immediate client demand,
   depends on billing owner.
5. **Scheduled jobs** (5c). Small, and makes the remaining work safer to roll out.
6. **Chat** (section 2). Largest single feature.
7. **Email templating and metrics** (5a, 5b), folding into the OpenTelemetry work in
   `production-roadmap.md` section 6.

Sections 2 and 4 can run in parallel with the rest once step 1 lands.

Every slice carries the same bar as the existing roadmap: schema and migration review, security
tests, generated OpenAPI, operator documentation, and the full verification commands.

## Decisions worth confirming before build starts

1. **Tenancy default.** Plan assumes new client projects start in `disabled` and opt into
   `single`/`multi`. If most clients are B2B, flipping the default to `single` now removes a
   migration later.
2. **Billing owner.** Plan assumes it is configurable and defaults to `user`. If org-pays is the
   common case, `resolveBillingOwner` can be simplified.
3. **Chat transport.** Plan commits to SSE-first behind a swappable interface. If a client is
   already contracted for typing indicators, presence, and read receipts at scale, going
   straight to websockets avoids building the SSE layer twice.
4. **Dynamic pricing shape.** Plan assumes clients implement `ChargeableResolver` against their
   own domain. If most client MVPs have no domain entity at checkout time, the default
   `ChargeableItem` table should become the primary path rather than the fallback.
