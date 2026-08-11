import { Prisma, PrismaClient } from '@prisma/client';
import { env } from '#app/config/env.js';
import { tenantScopeExtension } from '#app/lib/tenant-scope.js';

/** Derived from the generated schema so new soft-deletable models are filtered by default. */
export const softDeleteModels = new Set(
  Prisma.dmmf.datamodel.models
    .filter(
      (model) =>
        model.name !== 'Message' && model.fields.some((field) => field.name === 'deletedAt'),
    )
    .map((model) => model.name),
);

let inFlightQueries = 0;

/** Read by the metrics endpoint (roadmap 5b); kept dependency-free of prom-client. */
export function getInFlightQueryCount(): number {
  return inFlightQueries;
}

/** `connection_limit` from DATABASE_URL, if the client set one explicitly. */
export function getConfiguredPoolSize(): number | undefined {
  try {
    const raw = new URL(env.DATABASE_URL).searchParams.get('connection_limit');
    return raw ? Number(raw) : undefined;
  } catch {
    return undefined;
  }
}

const poolMetricsExtension = Prisma.defineExtension({
  name: 'pool-metrics',
  query: {
    $allModels: {
      async $allOperations({ args, query }) {
        inFlightQueries += 1;
        try {
          return await query(args);
        } finally {
          inFlightQueries -= 1;
        }
      },
    },
  },
});

function activeWhere(args: unknown): void {
  if (!args || typeof args !== 'object') return;
  const input = args as { where?: Record<string, unknown> };
  input.where ??= {};
  if (!Object.hasOwn(input.where, 'deletedAt')) input.where.deletedAt = null;
}

const softDeleteExtension = Prisma.defineExtension({
  name: 'mandatory-soft-delete-filter',
  query: {
    $allModels: {
      async $allOperations({ model, operation, args, query }) {
        if (
          model &&
          softDeleteModels.has(model) &&
          [
            'findUnique',
            'findUniqueOrThrow',
            'findFirst',
            'findFirstOrThrow',
            'findMany',
            'count',
            'aggregate',
            'groupBy',
            'update',
            'updateMany',
            'delete',
            'deleteMany',
          ].includes(operation)
        ) {
          activeWhere(args);
        }
        return query(args);
      },
    },
  },
});

function createPrismaClient(): PrismaClient {
  const client = new PrismaClient({
    log:
      env.NODE_ENV === 'development'
        ? [
            { emit: 'event' as const, level: 'error' as const },
            { emit: 'event' as const, level: 'warn' as const },
          ]
        : [{ emit: 'event' as const, level: 'error' as const }],
  })
    .$extends(softDeleteExtension)
    .$extends(poolMetricsExtension);

  // Left uninstalled in single-tenant deployments so disabled mode stays byte-for-byte identical.
  const extended = env.TENANCY_MODE === 'disabled' ? client : client.$extends(tenantScopeExtension);
  return extended as unknown as PrismaClient;
}

const globalForPrisma = globalThis as unknown as { prisma?: PrismaClient };

export const prisma = globalForPrisma.prisma ?? createPrismaClient();

if (env.NODE_ENV !== 'production') globalForPrisma.prisma = prisma;
