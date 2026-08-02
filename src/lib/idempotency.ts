import { Prisma } from '@prisma/client';
import { hashMetadata } from '#app/lib/crypto.js';
import { errors } from '#app/lib/errors.js';
import { prisma } from '#app/lib/prisma.js';

function canonical(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonical(record[key])}`)
    .join(',')}}`;
}

export async function runIdempotent<T>(input: {
  actorKey: string;
  scope: string;
  key: string;
  request: unknown;
  operation: () => Promise<{ statusCode: number; response: T }>;
  ttlHours?: number;
}): Promise<{ statusCode: number; response: T; replayed: boolean }> {
  const keyHash = hashMetadata(`idempotency-key:${input.key}`);
  const requestHash = hashMetadata(`idempotency-request:${canonical(input.request)}`);
  const unique = {
    actorKey_scope_keyHash: { actorKey: input.actorKey, scope: input.scope, keyHash },
  };
  const record = await prisma.idempotencyRecord.findUnique({ where: unique });
  if (record && record.requestHash !== requestHash) {
    throw errors.conflict('Idempotency-Key was already used for a different request');
  }
  if (record?.statusCode && record.response !== null) {
    return { statusCode: record.statusCode, response: record.response as T, replayed: true };
  }
  if (record)
    throw errors.conflict('An operation with this Idempotency-Key is already in progress');
  let created;
  try {
    created = await prisma.idempotencyRecord.create({
      data: {
        actorKey: input.actorKey,
        scope: input.scope,
        keyHash,
        requestHash,
        expiresAt: new Date(Date.now() + (input.ttlHours ?? 24) * 60 * 60 * 1_000),
      },
    });
  } catch (error) {
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
      throw errors.conflict('An operation with this Idempotency-Key is already in progress');
    }
    throw error;
  }
  const result = await input.operation();
  await prisma.idempotencyRecord.update({
    where: { id: created.id },
    data: { statusCode: result.statusCode, response: result.response as Prisma.InputJsonValue },
  });
  return { ...result, replayed: false };
}
