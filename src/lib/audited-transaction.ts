import type { Prisma } from '@prisma/client';
import { prisma } from '#app/lib/prisma.js';
import { writeAuditEvent, type AuditInput } from '#app/modules/audit/audit.service.js';

export type AuditWriter = (input: AuditInput) => Promise<void>;

export interface AuditedTransactionOptions {
  maxWait?: number;
  timeout?: number;
  isolationLevel?: Prisma.TransactionIsolationLevel;
}

export interface TransactionRunner {
  $transaction<T>(
    operation: (tx: Prisma.TransactionClient) => Promise<T>,
    options?: AuditedTransactionOptions,
  ): Promise<T>;
}

export function createAuditedTransaction(
  database: TransactionRunner,
  auditEventWriter: typeof writeAuditEvent = writeAuditEvent,
) {
  return async function auditedTransaction<T>(
    operation: (tx: Prisma.TransactionClient, audit: AuditWriter) => Promise<T>,
    options?: AuditedTransactionOptions,
  ): Promise<T> {
    return database.$transaction(
      async (tx) => operation(tx, (input) => auditEventWriter(tx, input)),
      options,
    );
  };
}

/** Runs a mutation and its audit writes in the same database transaction. */
export const withAuditedTransaction = createAuditedTransaction(prisma);

/** Reuses an existing transaction while preserving the same audit-writer contract. */
export function runAuditedMutation<T>(
  tx: Prisma.TransactionClient,
  operation: (tx: Prisma.TransactionClient, audit: AuditWriter) => Promise<T>,
): Promise<T> {
  return operation(tx, (input) => writeAuditEvent(tx, input));
}
