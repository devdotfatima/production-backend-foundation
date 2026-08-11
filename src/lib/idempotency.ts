import { randomUUID } from 'node:crypto';
import { Prisma } from '@prisma/client';
import type { Request } from 'express';
import {
  candidateMetadataHashes,
  decryptSecret,
  encryptSecret,
  hashMetadata,
} from '#app/lib/crypto.js';
import { errors } from '#app/lib/errors.js';
import { prisma } from '#app/lib/prisma.js';

/** Stable suffix identifying the acting principal, independent of tenant. */
export function idempotencyActorSuffix(request: Request): string {
  if (request.auth) return `user:${request.auth.userId}`;
  throw errors.unauthenticated();
}

/**
 * Composes the active tenant into the idempotency actor.
 *
 * Without the tenant, a user who belongs to two organizations could replay a response stored
 * while acting in the first organization by reusing the same key in the second — the record is
 * keyed on (actorKey, scope, keyHash), all three of which would otherwise match.
 */
export function idempotencyActorKey(request: Request): string {
  const suffix = idempotencyActorSuffix(request);
  return request.organizationId ? `org:${request.organizationId}:${suffix}` : suffix;
}

export function canonicalizeIdempotencyInput(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map(canonicalizeIdempotencyInput).join(',')}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalizeIdempotencyInput(record[key])}`)
    .join(',')}}`;
}

const encryptedResponseKey = '__idempotencyCiphertextV1';

function encryptResponse(response: unknown): Prisma.InputJsonObject {
  return { [encryptedResponseKey]: encryptSecret(JSON.stringify(response) ?? 'null') };
}

function decryptResponse<T>(response: Prisma.JsonValue): T {
  if (
    response &&
    typeof response === 'object' &&
    !Array.isArray(response) &&
    typeof response[encryptedResponseKey] === 'string'
  ) {
    return JSON.parse(decryptSecret(response[encryptedResponseKey])) as T;
  }
  // Backward compatibility for records written before replay payload encryption.
  return response as T;
}

const EXTERNAL_OPERATION_LEASE_MS = 2 * 60_000;

type IdempotencyHashes = {
  keyHash: string;
  keyHashCandidates: string[];
  requestHash: string;
  requestHashCandidates: string[];
};

function idempotencyHashes(key: string, request: unknown): IdempotencyHashes {
  const keyHashInput = `idempotency-key:${key}`;
  const requestHashInput = `idempotency-request:${canonicalizeIdempotencyInput(request)}`;
  return {
    keyHash: hashMetadata(keyHashInput),
    keyHashCandidates: candidateMetadataHashes(keyHashInput),
    requestHash: hashMetadata(requestHashInput),
    requestHashCandidates: candidateMetadataHashes(requestHashInput),
  };
}

function completedResult<T>(record: {
  statusCode: number | null;
  response: Prisma.JsonValue | null;
}): { statusCode: number; response: T; replayed: true } | undefined {
  if (record.statusCode === null || record.response === null) return undefined;
  return {
    statusCode: record.statusCode,
    response: decryptResponse<T>(record.response),
    replayed: true,
  };
}

function assertSameRequest(recordRequestHash: string, hashes: IdempotencyHashes): void {
  if (!hashes.requestHashCandidates.includes(recordRequestHash)) {
    throw errors.conflict('Idempotency-Key was already used for a different request');
  }
}

type IdempotencyInput<T> = {
  /** Compose with `idempotencyActorKey(request)` so replays cannot cross tenants. */
  actorKey: string;
  scope: string;
  key: string;
  request: unknown;
  operation: () => Promise<{ statusCode: number; response: T }>;
  ttlHours?: number;
};

export async function runIdempotent<T>(
  input: IdempotencyInput<T>,
): Promise<{ statusCode: number; response: T; replayed: boolean }> {
  const now = new Date();
  const hashes = idempotencyHashes(input.key, input.request);
  const lockToken = randomUUID();
  const lockedUntil = new Date(now.getTime() + EXTERNAL_OPERATION_LEASE_MS);
  const expiresAt = new Date(now.getTime() + (input.ttlHours ?? 24) * 60 * 60 * 1_000);
  let record = await prisma.idempotencyRecord.findFirst({
    where: {
      actorKey: input.actorKey,
      scope: input.scope,
      keyHash: { in: hashes.keyHashCandidates },
      deletedAt: null,
    },
  });
  // Completed responses may expire and release their key. An unfinished external operation is
  // never deleted automatically: its downstream result may exist even when this process crashed.
  if (record && record.expiresAt <= now && completedResult(record)) {
    await prisma.idempotencyRecord.deleteMany({
      where: { id: record.id, expiresAt: { lte: now }, statusCode: { not: null } },
    });
    record = null;
  }

  if (record) {
    assertSameRequest(record.requestHash, hashes);
    const completed = completedResult<T>(record);
    if (completed) return completed;
    const acquired = await prisma.idempotencyRecord.updateMany({
      where: {
        id: record.id,
        statusCode: null,
        OR: [{ lockedUntil: null }, { lockedUntil: { lte: now } }],
      },
      data: {
        lockToken,
        lockedUntil,
        expiresAt,
        attempts: { increment: 1 },
      },
    });
    if (acquired.count !== 1) {
      throw errors.conflict('An operation with this Idempotency-Key is already in progress');
    }
  } else {
    try {
      record = await prisma.idempotencyRecord.create({
        data: {
          actorKey: input.actorKey,
          scope: input.scope,
          keyHash: hashes.keyHash,
          requestHash: hashes.requestHash,
          lockToken,
          lockedUntil,
          attempts: 1,
          expiresAt,
        },
      });
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
        throw errors.conflict('An operation with this Idempotency-Key is already in progress');
      }
      throw error;
    }
  }

  try {
    const result = await input.operation();
    const saved = await prisma.idempotencyRecord.updateMany({
      where: { id: record.id, lockToken, statusCode: null },
      data: {
        statusCode: result.statusCode,
        response: encryptResponse(result.response),
        lockToken: null,
        lockedUntil: null,
      },
    });
    if (saved.count !== 1) throw new Error('Idempotency ownership lease was lost');
    return { ...result, replayed: false };
  } catch (error) {
    // Preserve the request fingerprint across failures. The same request may reacquire the lease
    // immediately; external providers must receive the same downstream idempotency key.
    await prisma.idempotencyRecord.updateMany({
      where: { id: record.id, lockToken, statusCode: null },
      data: { lockToken: null, lockedUntil: now },
    });
    throw error;
  }
}

/**
 * Runs a database-only mutation and its replay record in one transaction. A crash commits both
 * or neither, closing the window where the business row existed but the idempotency response did
 * not. Never perform network/provider I/O inside this function.
 */
export async function runIdempotentTransaction<T>(input: {
  actorKey: string;
  scope: string;
  key: string;
  request: unknown;
  operation: (tx: Prisma.TransactionClient) => Promise<{ statusCode: number; response: T }>;
  ttlHours?: number;
}): Promise<{ statusCode: number; response: T; replayed: boolean }> {
  const hashes = idempotencyHashes(input.key, input.request);
  const now = new Date();

  const execute = () =>
    prisma.$transaction(
      async (tx) => {
        let record = await tx.idempotencyRecord.findFirst({
          where: {
            actorKey: input.actorKey,
            scope: input.scope,
            keyHash: { in: hashes.keyHashCandidates },
            deletedAt: null,
          },
        });
        if (record && record.expiresAt <= now && completedResult(record)) {
          await tx.idempotencyRecord.delete({ where: { id: record.id } });
          record = null;
        }
        if (record) {
          assertSameRequest(record.requestHash, hashes);
          const completed = completedResult<T>(record);
          if (completed) return completed;
          throw errors.conflict('An operation with this Idempotency-Key is already in progress');
        }

        const created = await tx.idempotencyRecord.create({
          data: {
            actorKey: input.actorKey,
            scope: input.scope,
            keyHash: hashes.keyHash,
            requestHash: hashes.requestHash,
            attempts: 1,
            expiresAt: new Date(now.getTime() + (input.ttlHours ?? 24) * 60 * 60 * 1_000),
          },
        });
        const result = await input.operation(tx);
        await tx.idempotencyRecord.update({
          where: { id: created.id },
          data: { statusCode: result.statusCode, response: encryptResponse(result.response) },
        });
        return { ...result, replayed: false };
      },
      { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
    );

  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      return await execute();
    } catch (error) {
      const known = error instanceof Prisma.PrismaClientKnownRequestError;
      // SERIALIZABLE intentionally aborts one side of some safe races. The entire callback was
      // rolled back, so a bounded retry cannot duplicate its database mutation.
      if (known && error.code === 'P2034' && attempt < 2) continue;
      if (!(known && error.code === 'P2002')) throw error;

      // A concurrent transaction won the unique key. It has committed by the time PostgreSQL
      // reports the conflict, so read and replay its durable response.
      const winner = await prisma.idempotencyRecord.findFirst({
        where: {
          actorKey: input.actorKey,
          scope: input.scope,
          keyHash: { in: hashes.keyHashCandidates },
          deletedAt: null,
        },
      });
      if (!winner) throw error;
      assertSameRequest(winner.requestHash, hashes);
      const completed = completedResult<T>(winner);
      if (completed) return completed;
      throw errors.conflict('An operation with this Idempotency-Key is already in progress');
    }
  }
  throw new Error('Idempotency transaction retry budget exhausted');
}
