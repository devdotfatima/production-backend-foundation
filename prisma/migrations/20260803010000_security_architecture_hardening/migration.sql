-- Cross-cutting security hardening. Existing installations with unsigned audit rows must run
-- `npm run maintenance:audit-backfill` before deploying this migration; the assertion below
-- intentionally fails closed rather than blessing unverifiable history.
CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE OR REPLACE FUNCTION uuid_generate_v7()
RETURNS uuid
LANGUAGE plpgsql
VOLATILE
AS $$
DECLARE
  unix_millis text;
  random_hex text;
  variant_nibble text;
BEGIN
  unix_millis := lpad(to_hex(floor(extract(epoch FROM clock_timestamp()) * 1000)::bigint), 12, '0');
  random_hex := replace(gen_random_uuid()::text, '-', '');
  variant_nibble := substr('89ab', 1 + (get_byte(decode(substr(random_hex, 17, 2), 'hex'), 0) % 4), 1);
  RETURN (
    substr(unix_millis, 1, 8) || '-' ||
    substr(unix_millis, 9, 4) || '-' ||
    '7' || substr(random_hex, 14, 3) || '-' ||
    variant_nibble || substr(random_hex, 18, 3) || '-' ||
    substr(random_hex, 21, 12)
  )::uuid;
END;
$$;

ALTER TYPE "OtpPurpose" ADD VALUE IF NOT EXISTS 'EMAIL_CHANGE';
ALTER TYPE "UploadStatus" ADD VALUE IF NOT EXISTS 'QUARANTINED';
ALTER TYPE "UploadStatus" ADD VALUE IF NOT EXISTS 'SCANNING';
ALTER TYPE "UploadStatus" ADD VALUE IF NOT EXISTS 'REJECTED';
CREATE TYPE "UploadVisibility" AS ENUM ('PRIVATE', 'PUBLIC');

ALTER TABLE "users"
  ADD COLUMN "pendingEmail" TEXT,
  ADD COLUMN "permissionEpoch" INTEGER NOT NULL DEFAULT 0;
CREATE UNIQUE INDEX "users_pendingEmail_key" ON "users"("pendingEmail");

ALTER TABLE "outbox_events" ADD COLUMN "expiresAt" TIMESTAMPTZ(3);
CREATE INDEX "outbox_events_status_expiresAt_idx" ON "outbox_events"("status", "expiresAt");

ALTER TABLE "uploads"
  ADD COLUMN "visibility" "UploadVisibility" NOT NULL DEFAULT 'PRIVATE',
  ADD COLUMN "detectedContentType" TEXT,
  ADD COLUMN "scanProvider" TEXT,
  ADD COLUMN "scanReference" TEXT,
  ADD COLUMN "scanVerdict" TEXT,
  ADD COLUMN "scannedAt" TIMESTAMPTZ(3);

CREATE TABLE "upload_bandwidth_usage" (
  "id" UUID NOT NULL DEFAULT uuid_generate_v7(),
  "userId" UUID NOT NULL,
  "periodStart" DATE NOT NULL,
  "bytes" BIGINT NOT NULL DEFAULT 0,
  "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMPTZ(3) NOT NULL,
  CONSTRAINT "upload_bandwidth_usage_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "upload_bandwidth_usage_userId_fkey" FOREIGN KEY ("userId")
    REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "upload_bandwidth_usage_userId_periodStart_key"
  ON "upload_bandwidth_usage"("userId", "periodStart");

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM "audit_events" WHERE "integrityHash" IS NULL) THEN
    RAISE EXCEPTION 'Unsigned audit events exist. Run npm run maintenance:audit-backfill before this migration.';
  END IF;
END $$;
ALTER TABLE "audit_events" ALTER COLUMN "integrityHash" SET NOT NULL;

ALTER TABLE "users" ALTER COLUMN "id" SET DEFAULT uuid_generate_v7();
ALTER TABLE "roles" ALTER COLUMN "id" SET DEFAULT uuid_generate_v7();
ALTER TABLE "permissions" ALTER COLUMN "id" SET DEFAULT uuid_generate_v7();
ALTER TABLE "user_roles" ALTER COLUMN "id" SET DEFAULT uuid_generate_v7();
ALTER TABLE "role_permissions" ALTER COLUMN "id" SET DEFAULT uuid_generate_v7();
ALTER TABLE "sessions" ALTER COLUMN "id" SET DEFAULT uuid_generate_v7();
ALTER TABLE "sessions" ALTER COLUMN "familyId" SET DEFAULT uuid_generate_v7();
ALTER TABLE "refresh_tokens" ALTER COLUMN "id" SET DEFAULT uuid_generate_v7();
ALTER TABLE "otp_challenges" ALTER COLUMN "id" SET DEFAULT uuid_generate_v7();
ALTER TABLE "password_reset_tokens" ALTER COLUMN "id" SET DEFAULT uuid_generate_v7();
ALTER TABLE "devices" ALTER COLUMN "id" SET DEFAULT uuid_generate_v7();
ALTER TABLE "social_accounts" ALTER COLUMN "id" SET DEFAULT uuid_generate_v7();
ALTER TABLE "outbox_events" ALTER COLUMN "id" SET DEFAULT uuid_generate_v7();
ALTER TABLE "audit_events" ALTER COLUMN "id" SET DEFAULT uuid_generate_v7();
ALTER TABLE "stripe_webhook_events" ALTER COLUMN "id" SET DEFAULT uuid_generate_v7();
ALTER TABLE "stripe_subscriptions" ALTER COLUMN "id" SET DEFAULT uuid_generate_v7();
ALTER TABLE "stripe_payments" ALTER COLUMN "id" SET DEFAULT uuid_generate_v7();
ALTER TABLE "stripe_refund_operations" ALTER COLUMN "id" SET DEFAULT uuid_generate_v7();
ALTER TABLE "uploads" ALTER COLUMN "id" SET DEFAULT uuid_generate_v7();

CREATE TABLE "service_accounts" (
  "id" UUID NOT NULL DEFAULT uuid_generate_v7(),
  "name" TEXT NOT NULL,
  "permissions" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
  "permissionEpoch" INTEGER NOT NULL DEFAULT 0,
  "active" BOOLEAN NOT NULL DEFAULT true,
  "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMPTZ(3) NOT NULL,
  "deletedAt" TIMESTAMPTZ(3),
  CONSTRAINT "service_accounts_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "service_accounts_name_key" ON "service_accounts"("name");
CREATE INDEX "service_accounts_active_deletedAt_idx" ON "service_accounts"("active", "deletedAt");

CREATE TABLE "api_keys" (
  "id" UUID NOT NULL DEFAULT uuid_generate_v7(),
  "serviceAccountId" UUID NOT NULL,
  "name" TEXT NOT NULL,
  "prefix" TEXT NOT NULL,
  "keyHash" TEXT NOT NULL,
  "expiresAt" TIMESTAMPTZ(3),
  "lastUsedAt" TIMESTAMPTZ(3),
  "revokedAt" TIMESTAMPTZ(3),
  "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMPTZ(3) NOT NULL,
  "deletedAt" TIMESTAMPTZ(3),
  CONSTRAINT "api_keys_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "api_keys_serviceAccountId_fkey" FOREIGN KEY ("serviceAccountId")
    REFERENCES "service_accounts"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "api_keys_keyHash_key" ON "api_keys"("keyHash");
CREATE INDEX "api_keys_serviceAccountId_revokedAt_deletedAt_idx"
  ON "api_keys"("serviceAccountId", "revokedAt", "deletedAt");

CREATE TABLE "idempotency_records" (
  "id" UUID NOT NULL DEFAULT uuid_generate_v7(),
  "actorKey" TEXT NOT NULL,
  "scope" TEXT NOT NULL,
  "keyHash" TEXT NOT NULL,
  "requestHash" TEXT NOT NULL,
  "statusCode" INTEGER,
  "response" JSONB,
  "expiresAt" TIMESTAMPTZ(3) NOT NULL,
  "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMPTZ(3) NOT NULL,
  "deletedAt" TIMESTAMPTZ(3),
  CONSTRAINT "idempotency_records_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "idempotency_records_actorKey_scope_keyHash_key"
  ON "idempotency_records"("actorKey", "scope", "keyHash");
CREATE INDEX "idempotency_records_expiresAt_idx" ON "idempotency_records"("expiresAt");

CREATE TABLE "customer_webhook_endpoints" (
  "id" UUID NOT NULL DEFAULT uuid_generate_v7(),
  "userId" UUID NOT NULL,
  "url" TEXT NOT NULL,
  "description" TEXT,
  "events" TEXT[] NOT NULL,
  "secretEncrypted" TEXT NOT NULL,
  "active" BOOLEAN NOT NULL DEFAULT true,
  "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMPTZ(3) NOT NULL,
  "deletedAt" TIMESTAMPTZ(3),
  CONSTRAINT "customer_webhook_endpoints_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "customer_webhook_endpoints_userId_fkey" FOREIGN KEY ("userId")
    REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE INDEX "customer_webhook_endpoints_userId_active_deletedAt_idx"
  ON "customer_webhook_endpoints"("userId", "active", "deletedAt");

CREATE TABLE "customer_webhook_deliveries" (
  "id" UUID NOT NULL DEFAULT uuid_generate_v7(),
  "endpointId" UUID NOT NULL,
  "eventId" TEXT NOT NULL,
  "eventType" TEXT NOT NULL,
  "payload" JSONB NOT NULL,
  "attempts" INTEGER NOT NULL DEFAULT 0,
  "lastStatusCode" INTEGER,
  "lastError" TEXT,
  "deliveredAt" TIMESTAMPTZ(3),
  "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMPTZ(3) NOT NULL,
  "deletedAt" TIMESTAMPTZ(3),
  CONSTRAINT "customer_webhook_deliveries_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "customer_webhook_deliveries_endpointId_fkey" FOREIGN KEY ("endpointId")
    REFERENCES "customer_webhook_endpoints"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "customer_webhook_deliveries_eventId_key"
  ON "customer_webhook_deliveries"("eventId");
CREATE INDEX "customer_webhook_deliveries_endpointId_createdAt_idx"
  ON "customer_webhook_deliveries"("endpointId", "createdAt");
