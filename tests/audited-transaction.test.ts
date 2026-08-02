import type { Prisma } from '@prisma/client';
import { describe, expect, it, vi } from 'vitest';
import { createAuditedTransaction, type TransactionRunner } from '#app/lib/audited-transaction.js';

describe('audited transactions', () => {
  it('binds audit writes to the same transaction client', async () => {
    const tx = { marker: 'transaction' } as unknown as Prisma.TransactionClient;
    const database: TransactionRunner = {
      async $transaction<T>(
        operation: (client: Prisma.TransactionClient) => Promise<T>,
      ): Promise<T> {
        return operation(tx);
      },
    };
    const auditEventWriter = vi.fn().mockResolvedValue(undefined);
    const transact = createAuditedTransaction(database, auditEventWriter);

    const result = await transact(async (client, audit) => {
      expect(client).toBe(tx);
      await audit({ action: 'thing.updated', entityType: 'thing', entityId: 'thing-1' });
      return 'done';
    });

    expect(result).toBe('done');
    expect(auditEventWriter).toHaveBeenCalledWith(tx, {
      action: 'thing.updated',
      entityType: 'thing',
      entityId: 'thing-1',
    });
  });

  it('propagates failures so the database runner can roll back', async () => {
    const tx = { marker: 'transaction' } as unknown as Prisma.TransactionClient;
    const database: TransactionRunner = {
      async $transaction<T>(
        operation: (client: Prisma.TransactionClient) => Promise<T>,
      ): Promise<T> {
        return operation(tx);
      },
    };
    const transact = createAuditedTransaction(database, vi.fn());

    await expect(
      transact(async () => {
        throw new Error('mutation failed');
      }),
    ).rejects.toThrow('mutation failed');
  });
});
