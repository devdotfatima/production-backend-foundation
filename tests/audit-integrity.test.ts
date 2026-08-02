import { describe, expect, it } from 'vitest';
import { signAuditEvent, verifyAuditEvent } from '../dist/src/modules/audit/audit.integrity.js';

describe('audit integrity signatures', () => {
  const secret = 'audit-integrity-test-secret-that-is-long-enough';
  const record = {
    id: '00000000-0000-4000-8000-000000000001',
    actorUserId: '00000000-0000-4000-8000-000000000002',
    action: 'user.updated',
    entityType: 'user',
    entityId: '00000000-0000-4000-8000-000000000003',
    requestId: 'request-1',
    ipHash: 'ip-hash',
    userAgent: 'test',
    metadata: { fields: ['status'], nested: { b: 2, a: 1 } },
    createdAt: new Date('2026-08-02T12:00:00.000Z'),
    integrityVersion: 1,
  };

  it('verifies canonical records independent of object-key insertion order', () => {
    const integrityHash = signAuditEvent(record, secret);
    expect(
      verifyAuditEvent(
        {
          ...record,
          metadata: { nested: { a: 1, b: 2 }, fields: ['status'] },
          integrityHash,
        },
        secret,
      ),
    ).toBe(true);
  });

  it('detects a changed audited value', () => {
    const integrityHash = signAuditEvent(record, secret);
    expect(verifyAuditEvent({ ...record, action: 'user.deleted', integrityHash }, secret)).toBe(
      false,
    );
  });

  it('detects soft deletion or any update timestamp change', () => {
    const integrityHash = signAuditEvent(record, secret);
    expect(
      verifyAuditEvent(
        { ...record, deletedAt: new Date('2026-08-03T00:00:00.000Z'), integrityHash },
        secret,
      ),
    ).toBe(false);
  });
});
