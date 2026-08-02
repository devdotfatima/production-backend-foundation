import { createHmac, timingSafeEqual } from 'node:crypto';
import { env } from '#app/config/env.js';

export interface AuditIntegrityRecord {
  id: string;
  actorUserId?: string | null;
  action: string;
  entityType: string;
  entityId?: string | null;
  requestId?: string | null;
  ipHash?: string | null;
  userAgent?: string | null;
  metadata?: unknown;
  createdAt: Date;
  updatedAt?: Date;
  deletedAt?: Date | null;
  integrityVersion?: number;
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;

  const object = value as Record<string, unknown>;
  return `{${Object.keys(object)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalJson(object[key])}`)
    .join(',')}}`;
}

export function signAuditEvent(record: AuditIntegrityRecord, secret = env.AUDIT_INTEGRITY_SECRET) {
  // Production requires a dedicated audit key. The cookie key is only a development/test
  // fallback so even non-production databases never contain unsigned rows.
  const signingSecret = secret || env.COOKIE_SECRET;
  const payload = canonicalJson({
    version: record.integrityVersion ?? 1,
    id: record.id,
    actorUserId: record.actorUserId ?? null,
    action: record.action,
    entityType: record.entityType,
    entityId: record.entityId ?? null,
    requestId: record.requestId ?? null,
    ipHash: record.ipHash ?? null,
    userAgent: record.userAgent ?? null,
    metadata: record.metadata ?? null,
    createdAt: record.createdAt.toISOString(),
    updatedAt: (record.updatedAt ?? record.createdAt).toISOString(),
    deletedAt: record.deletedAt?.toISOString() ?? null,
  });
  return createHmac('sha256', signingSecret).update(payload).digest('base64url');
}

export function verifyAuditEvent(
  record: AuditIntegrityRecord & { integrityHash?: string | null },
  secret = env.AUDIT_INTEGRITY_SECRET,
): boolean {
  const signingSecret = secret || env.COOKIE_SECRET;
  if (!record.integrityHash || !signingSecret) return false;
  const expected = signAuditEvent(record, signingSecret);
  const actualBuffer = Buffer.from(record.integrityHash);
  const expectedBuffer = Buffer.from(expected);
  return (
    actualBuffer.length === expectedBuffer.length && timingSafeEqual(actualBuffer, expectedBuffer)
  );
}
