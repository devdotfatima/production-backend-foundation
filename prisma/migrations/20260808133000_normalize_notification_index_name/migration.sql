-- PostgreSQL truncates identifiers at 63 bytes. Rename the automatically truncated spelling to
-- the deterministic Prisma spelling so drift detection is stable across environments.
ALTER INDEX "notification_preferences_organizationId_userId_channel_deletedA"
  RENAME TO "notification_preferences_organizationId_userId_channel_dele_idx";
