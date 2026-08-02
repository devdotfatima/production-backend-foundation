-- Add durable relay-claim and dead-letter states. FAILED remains for compatibility
-- with rows created by earlier application versions and is backfilled separately.
ALTER TYPE "OutboxStatus" ADD VALUE 'CLAIMED';
ALTER TYPE "OutboxStatus" ADD VALUE 'DEAD_LETTER';

ALTER TABLE "outbox_events"
ADD COLUMN "deliveryGeneration" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN "claimedAt" TIMESTAMPTZ(3),
ADD COLUMN "claimExpiresAt" TIMESTAMPTZ(3),
ADD COLUMN "claimToken" UUID,
ADD COLUMN "deadLetteredAt" TIMESTAMPTZ(3);

DROP INDEX "outbox_events_status_availableAt_idx";

CREATE INDEX "outbox_events_status_availableAt_createdAt_idx"
ON "outbox_events"("status", "availableAt", "createdAt");

CREATE INDEX "outbox_events_status_claimExpiresAt_idx"
ON "outbox_events"("status", "claimExpiresAt");

CREATE INDEX "outbox_events_status_deadLetteredAt_id_idx"
ON "outbox_events"("status", "deadLetteredAt", "id");
