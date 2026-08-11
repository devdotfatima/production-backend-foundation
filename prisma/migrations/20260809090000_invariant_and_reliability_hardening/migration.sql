-- Close the cross-request and cross-tenant invariants identified by the second architecture audit.
-- This migration is intentionally additive/backfilled before constraints become authoritative.

-- Dynamic charges have a durable reservation between local validation and Stripe's response.
ALTER TYPE "ChargeableStatus" ADD VALUE IF NOT EXISTS 'RESERVED' BEFORE 'CONSUMED';

ALTER TABLE "chargeable_items"
  ADD COLUMN "reservationKeyHash" TEXT,
  ADD COLUMN "reservedAt" TIMESTAMPTZ(3);

DROP INDEX "chargeable_items_reference_key";
CREATE UNIQUE INDEX "chargeable_items_organizationId_reference_key"
  ON "chargeable_items"("organizationId", "reference");
CREATE UNIQUE INDEX "chargeable_items_global_reference_key"
  ON "chargeable_items"("reference")
  WHERE "organizationId" IS NULL;
CREATE INDEX "chargeable_items_status_reservedAt_idx"
  ON "chargeable_items"("status", "reservedAt");

-- Service-account names are unique inside one tenant, not across the whole installation.
DROP INDEX "service_accounts_name_key";
CREATE UNIQUE INDEX "service_accounts_organizationId_name_key"
  ON "service_accounts"("organizationId", "name");
CREATE UNIQUE INDEX "service_accounts_global_name_key"
  ON "service_accounts"("name")
  WHERE "organizationId" IS NULL;

-- One deterministic key makes concurrent direct-conversation creation conflict safely.
ALTER TABLE "conversations" ADD COLUMN "directKey" TEXT;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM (
      SELECT
        COALESCE(conversation."organizationId"::text, 'global') || ':' ||
          string_agg(participant."userId"::text, ':' ORDER BY participant."userId") AS direct_key,
        count(*) AS conversation_count
      FROM "conversations" AS conversation
      JOIN "conversation_participants" AS participant
        ON participant."conversationId" = conversation."id"
       AND participant."leftAt" IS NULL
       AND participant."deletedAt" IS NULL
      WHERE conversation."type" = 'DIRECT'
        AND conversation."deletedAt" IS NULL
      GROUP BY conversation."id", conversation."organizationId"
    ) AS pairs
    GROUP BY direct_key
    HAVING count(*) > 1
  ) THEN
    RAISE EXCEPTION 'Duplicate active direct conversations must be resolved before this migration';
  END IF;
END $$;

WITH direct_pairs AS (
  SELECT
    conversation."id",
    COALESCE(conversation."organizationId"::text, 'global') || ':' ||
      string_agg(participant."userId"::text, ':' ORDER BY participant."userId") AS direct_key
  FROM "conversations" AS conversation
  JOIN "conversation_participants" AS participant
    ON participant."conversationId" = conversation."id"
   AND participant."leftAt" IS NULL
   AND participant."deletedAt" IS NULL
  WHERE conversation."type" = 'DIRECT'
    AND conversation."deletedAt" IS NULL
  GROUP BY conversation."id", conversation."organizationId"
  HAVING count(*) = 2
)
UPDATE "conversations" AS conversation
SET "directKey" = direct_pairs.direct_key
FROM direct_pairs
WHERE conversation."id" = direct_pairs."id";

CREATE UNIQUE INDEX "conversations_directKey_key" ON "conversations"("directKey");

-- Global UserRole grants may reference only global roles. Membership is the sole organization
-- role grant path. Triggers also prevent converting an already-granted global role into an org role.
CREATE OR REPLACE FUNCTION enforce_global_user_role()
RETURNS trigger AS $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM "roles"
    WHERE "id" = NEW."roleId" AND "organizationId" IS NOT NULL
  ) THEN
    RAISE EXCEPTION 'user_roles may reference only global roles';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "user_roles_global_role_only"
BEFORE INSERT OR UPDATE OF "roleId" ON "user_roles"
FOR EACH ROW EXECUTE FUNCTION enforce_global_user_role();

CREATE OR REPLACE FUNCTION prevent_scoping_globally_granted_role()
RETURNS trigger AS $$
BEGIN
  IF OLD."organizationId" IS NULL
     AND NEW."organizationId" IS NOT NULL
     AND EXISTS (SELECT 1 FROM "user_roles" WHERE "roleId" = NEW."id") THEN
    RAISE EXCEPTION 'a role granted through user_roles cannot become organization-scoped';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "roles_prevent_granted_scope_change"
BEFORE UPDATE OF "organizationId" ON "roles"
FOR EACH ROW EXECUTE FUNCTION prevent_scoping_globally_granted_role();

-- Leases let the same request recover an interrupted external call. Database-only idempotent
-- operations instead store their response inside the same transaction as the mutation.
ALTER TABLE "idempotency_records"
  ADD COLUMN "lockToken" UUID,
  ADD COLUMN "lockedUntil" TIMESTAMPTZ(3),
  ADD COLUMN "attempts" INTEGER NOT NULL DEFAULT 0;

CREATE INDEX "idempotency_records_lockedUntil_idx"
  ON "idempotency_records"("lockedUntil");
