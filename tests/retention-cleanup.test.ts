import { describe, expect, it, vi } from 'vitest';
import {
  deleteInBatches,
  runRetentionCleanup,
  type RetentionCleanupDatabase,
} from '../dist/src/maintenance/retention.js';

type DelegateDouble = {
  findMany: ReturnType<typeof vi.fn<(args: unknown) => Promise<Array<{ id: string }>>>>;
  deleteMany: ReturnType<typeof vi.fn<(args: unknown) => Promise<{ count: number }>>>;
};

function emptyDelegate(): DelegateDouble {
  return {
    findMany: vi.fn().mockResolvedValue([]),
    deleteMany: vi.fn().mockResolvedValue({ count: 0 }),
  };
}

function databaseDouble() {
  const delegates = {
    auditEvent: emptyDelegate(),
    otpChallenge: emptyDelegate(),
    outboxEvent: emptyDelegate(),
    session: emptyDelegate(),
    stripeWebhookEvent: emptyDelegate(),
    upload: emptyDelegate(),
  };

  return {
    delegates,
    database: delegates as unknown as RetentionCleanupDatabase,
  };
}

describe('retention cleanup', () => {
  it('deletes work in bounded batches', async () => {
    const selectBatch = vi
      .fn()
      .mockResolvedValueOnce([{ id: 'one' }, { id: 'two' }])
      .mockResolvedValueOnce([{ id: 'three' }]);
    const deleteBatch = vi
      .fn()
      .mockResolvedValueOnce({ count: 2 })
      .mockResolvedValueOnce({ count: 1 });

    await expect(deleteInBatches(2, selectBatch, deleteBatch)).resolves.toBe(3);
    expect(selectBatch).toHaveBeenNthCalledWith(1, 2);
    expect(selectBatch).toHaveBeenNthCalledWith(2, 2);
    expect(deleteBatch).toHaveBeenNthCalledWith(1, ['one', 'two']);
    expect(deleteBatch).toHaveBeenNthCalledWith(2, ['three']);
  });

  it('uses separate data and audit cutoffs and preserves non-eligible records', async () => {
    const { database, delegates } = databaseDouble();
    delegates.otpChallenge.findMany
      .mockResolvedValueOnce([{ id: 'otp-1' }, { id: 'otp-2' }])
      .mockResolvedValueOnce([{ id: 'otp-3' }]);
    delegates.otpChallenge.deleteMany
      .mockResolvedValueOnce({ count: 2 })
      .mockResolvedValueOnce({ count: 1 });
    delegates.auditEvent.findMany.mockResolvedValueOnce([{ id: 'audit-1' }]);
    delegates.auditEvent.deleteMany.mockResolvedValueOnce({ count: 1 });

    const now = new Date('2026-08-02T12:00:00.000Z');
    const result = await runRetentionCleanup(
      { dataRetentionDays: 30, auditRetentionDays: 365, batchSize: 2, now },
      database,
    );

    expect(result.cutoffs.data).toEqual(new Date('2026-07-03T12:00:00.000Z'));
    expect(result.cutoffs.audit).toEqual(new Date('2025-08-02T12:00:00.000Z'));
    expect(result.deleted).toEqual({
      auditEvents: 1,
      otpChallenges: 3,
      outboxEvents: 0,
      sessions: 0,
      stripeWebhookEvents: 0,
      uploads: 0,
    });
    expect(delegates.outboxEvent.findMany.mock.calls[0]?.[0]).toMatchObject({
      where: { status: { in: ['DELIVERED', 'DEAD_LETTER'] } },
    });
    expect(delegates.stripeWebhookEvent.findMany.mock.calls[0]?.[0]).toMatchObject({
      where: { status: 'PROCESSED' },
    });
  });

  it('can retain audit events indefinitely', async () => {
    const { database, delegates } = databaseDouble();

    const result = await runRetentionCleanup(
      { dataRetentionDays: 30, auditRetentionDays: 0, batchSize: 100 },
      database,
    );

    expect(result.auditDeletionEnabled).toBe(false);
    expect(result.cutoffs.audit).toBeNull();
    expect(delegates.auditEvent.findMany).not.toHaveBeenCalled();
    expect(delegates.auditEvent.deleteMany).not.toHaveBeenCalled();
  });
});
