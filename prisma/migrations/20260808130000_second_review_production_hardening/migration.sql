-- Second-review production hardening.
--
-- Nullable columns are backfilled before becoming required so this migration remains safe for
-- populated installations. Provider calls and data erasure remain application/worker concerns;
-- this migration only establishes the durable state needed to resume those workflows.

-- User locale is an explicit delivery preference input, with a conservative English fallback.
ALTER TABLE "users"
  ADD COLUMN "locale" TEXT NOT NULL DEFAULT 'en';

-- Namespace refund idempotency by the actual billing owner. This prevents two organization
-- members from independently replaying the same logical refund.
ALTER TABLE "stripe_refund_operations"
  ADD COLUMN "ownerKey" TEXT;

UPDATE "stripe_refund_operations"
SET "ownerKey" = CASE
  WHEN "organizationId" IS NOT NULL THEN 'organization:' || "organizationId"::text
  ELSE 'user:' || "userId"::text
END
WHERE "ownerKey" IS NULL;

ALTER TABLE "stripe_refund_operations"
  ALTER COLUMN "ownerKey" SET NOT NULL;

DROP INDEX "stripe_refund_operations_userId_idempotencyKeyHash_key";
CREATE UNIQUE INDEX "stripe_refund_operations_ownerKey_idempotencyKeyHash_key"
  ON "stripe_refund_operations"("ownerKey", "idempotencyKeyHash");
CREATE INDEX "stripe_refund_operations_organizationId_createdAt_idx"
  ON "stripe_refund_operations"("organizationId", "createdAt");

-- A non-null scope key gives Postgres a conflict target for both personal and organization
-- bandwidth quotas. Nullable composite keys cannot provide that guarantee.
ALTER TABLE "upload_bandwidth_usage"
  ADD COLUMN "scopeKey" TEXT;

UPDATE "upload_bandwidth_usage"
SET "scopeKey" = CASE
  WHEN "organizationId" IS NOT NULL THEN
    'organization:' || "organizationId"::text || ':user:' || "userId"::text
  ELSE 'user:' || "userId"::text
END
WHERE "scopeKey" IS NULL;

ALTER TABLE "upload_bandwidth_usage"
  ALTER COLUMN "scopeKey" SET NOT NULL;

DROP INDEX "upload_bandwidth_usage_userId_periodStart_key";
CREATE UNIQUE INDEX "upload_bandwidth_usage_scopeKey_periodStart_key"
  ON "upload_bandwidth_usage"("scopeKey", "periodStart");
CREATE INDEX "upload_bandwidth_usage_userId_periodStart_idx"
  ON "upload_bandwidth_usage"("userId", "periodStart");
CREATE INDEX "upload_bandwidth_usage_organizationId_periodStart_idx"
  ON "upload_bandwidth_usage"("organizationId", "periodStart");

-- The row is retained until physical object deletion succeeds, making account erasure resumable.
ALTER TABLE "uploads"
  ADD COLUMN "storageDeletedAt" TIMESTAMPTZ(3);

CREATE TYPE "NotificationDeliveryStatus" AS ENUM (
  'PROCESSING',
  'SENT',
  'DELIVERED',
  'SUPPRESSED',
  'BOUNCED',
  'COMPLAINED',
  'FAILED'
);

CREATE TYPE "EmailSuppressionReason" AS ENUM ('BOUNCE', 'COMPLAINT', 'MANUAL');

CREATE TABLE "notification_preferences" (
  "id" UUID NOT NULL DEFAULT uuid_generate_v7(),
  "organizationId" UUID,
  "userId" UUID NOT NULL,
  "scopeKey" TEXT NOT NULL,
  "channel" "NotificationChannel" NOT NULL,
  "topic" TEXT NOT NULL,
  "enabled" BOOLEAN NOT NULL DEFAULT true,
  "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMPTZ(3) NOT NULL,
  "deletedAt" TIMESTAMPTZ(3),
  CONSTRAINT "notification_preferences_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "email_suppressions" (
  "id" UUID NOT NULL DEFAULT uuid_generate_v7(),
  "destinationHash" TEXT NOT NULL,
  "reason" "EmailSuppressionReason" NOT NULL,
  "provider" TEXT,
  "providerEventId" TEXT,
  "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMPTZ(3) NOT NULL,
  "deletedAt" TIMESTAMPTZ(3),
  CONSTRAINT "email_suppressions_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "notification_deliveries" (
  "id" UUID NOT NULL DEFAULT uuid_generate_v7(),
  "organizationId" UUID,
  "userId" UUID,
  "outboxEventId" UUID NOT NULL,
  "channel" "NotificationChannel" NOT NULL,
  "destinationHash" TEXT,
  "templateKey" TEXT,
  "provider" TEXT,
  "providerMessageId" TEXT,
  "status" "NotificationDeliveryStatus" NOT NULL DEFAULT 'PROCESSING',
  "attempts" INTEGER NOT NULL DEFAULT 0,
  "lastError" TEXT,
  "sentAt" TIMESTAMPTZ(3),
  "deliveredAt" TIMESTAMPTZ(3),
  "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMPTZ(3) NOT NULL,
  "deletedAt" TIMESTAMPTZ(3),
  CONSTRAINT "notification_deliveries_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "notification_preferences_userId_scopeKey_channel_topic_key"
  ON "notification_preferences"("userId", "scopeKey", "channel", "topic");
CREATE INDEX "notification_preferences_organizationId_userId_channel_deletedAt_idx"
  ON "notification_preferences"("organizationId", "userId", "channel", "deletedAt");

CREATE UNIQUE INDEX "email_suppressions_destinationHash_key"
  ON "email_suppressions"("destinationHash");
CREATE INDEX "email_suppressions_reason_createdAt_idx"
  ON "email_suppressions"("reason", "createdAt");

CREATE UNIQUE INDEX "notification_deliveries_outboxEventId_key"
  ON "notification_deliveries"("outboxEventId");
CREATE UNIQUE INDEX "notification_deliveries_providerMessageId_key"
  ON "notification_deliveries"("providerMessageId");
CREATE INDEX "notification_deliveries_organizationId_status_createdAt_idx"
  ON "notification_deliveries"("organizationId", "status", "createdAt");
CREATE INDEX "notification_deliveries_userId_status_createdAt_idx"
  ON "notification_deliveries"("userId", "status", "createdAt");
CREATE INDEX "notification_deliveries_destinationHash_createdAt_idx"
  ON "notification_deliveries"("destinationHash", "createdAt");

ALTER TABLE "notification_preferences"
  ADD CONSTRAINT "notification_preferences_userId_fkey"
  FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "notification_preferences"
  ADD CONSTRAINT "notification_preferences_organizationId_fkey"
  FOREIGN KEY ("organizationId") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "notification_deliveries"
  ADD CONSTRAINT "notification_deliveries_userId_fkey"
  FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "notification_deliveries"
  ADD CONSTRAINT "notification_deliveries_organizationId_fkey"
  FOREIGN KEY ("organizationId") REFERENCES "organizations"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "notification_deliveries"
  ADD CONSTRAINT "notification_deliveries_outboxEventId_fkey"
  FOREIGN KEY ("outboxEventId") REFERENCES "outbox_events"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Permissions are data that gates code paths, so deployments must not depend on a separate seed
-- happening at exactly the same time as the migration.
INSERT INTO "permissions" ("id", "code", "description", "createdAt", "updatedAt", "deletedAt")
VALUES
  (uuid_generate_v7(), 'billing:read', 'View organization billing, subscriptions, payments, and payment methods', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP, NULL),
  (uuid_generate_v7(), 'billing:write', 'Manage organization billing, subscriptions, charges, and refunds', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP, NULL)
ON CONFLICT ("code") DO UPDATE
SET "description" = EXCLUDED."description", "updatedAt" = CURRENT_TIMESTAMP, "deletedAt" = NULL;

INSERT INTO "role_permissions" (
  "id", "roleId", "permissionId", "createdAt", "updatedAt", "deletedAt"
)
SELECT
  uuid_generate_v7(), role."id", permission."id", CURRENT_TIMESTAMP, CURRENT_TIMESTAMP, NULL
FROM "roles" AS role
CROSS JOIN "permissions" AS permission
WHERE role."organizationId" IS NULL
  AND role."name" IN ('admin', 'owner')
  AND role."deletedAt" IS NULL
  AND permission."code" IN ('billing:read', 'billing:write')
ON CONFLICT ("roleId", "permissionId") DO UPDATE
SET "updatedAt" = CURRENT_TIMESTAMP, "deletedAt" = NULL;
