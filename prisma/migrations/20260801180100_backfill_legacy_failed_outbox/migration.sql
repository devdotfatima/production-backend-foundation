-- Old FAILED rows may still have exhausted BullMQ jobs with the same job ID.
-- Preserve them for explicit operator redrive instead of silently re-enqueueing.
UPDATE "outbox_events"
SET
  "status" = 'DEAD_LETTER',
  "deadLetteredAt" = COALESCE("failedAt", CURRENT_TIMESTAMP),
  "updatedAt" = CURRENT_TIMESTAMP
WHERE "status" = 'FAILED';
