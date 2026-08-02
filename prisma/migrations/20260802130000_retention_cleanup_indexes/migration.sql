CREATE INDEX "sessions_expiresAt_id_idx" ON "sessions"("expiresAt", "id");

CREATE INDEX "sessions_revokedAt_id_idx" ON "sessions"("revokedAt", "id");

CREATE INDEX "outbox_events_status_updatedAt_id_idx" ON "outbox_events"("status", "updatedAt", "id");

CREATE INDEX "audit_events_createdAt_id_idx" ON "audit_events"("createdAt", "id");
