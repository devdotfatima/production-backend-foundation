import { Prisma, PrismaClient } from '@prisma/client';
import { env } from '#app/config/env.js';

const softDeleteModels = new Set([
  'User',
  'Role',
  'Permission',
  'UserRole',
  'RolePermission',
  'Session',
  'RefreshToken',
  'OtpChallenge',
  'PasswordResetToken',
  'Device',
  'SocialAccount',
  'OutboxEvent',
  'AuditEvent',
  'StripeWebhookEvent',
  'StripeSubscription',
  'StripePayment',
  'Upload',
  'ServiceAccount',
  'ApiKey',
  'IdempotencyRecord',
  'CustomerWebhookEndpoint',
  'CustomerWebhookDelivery',
]);

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

function createPrismaClient() {
  return new PrismaClient({
    log:
      env.NODE_ENV === 'development'
        ? [
            { emit: 'event' as const, level: 'error' as const },
            { emit: 'event' as const, level: 'warn' as const },
          ]
        : [{ emit: 'event' as const, level: 'error' as const }],
  }).$extends(softDeleteExtension);
}

const globalForPrisma = globalThis as unknown as { prisma?: PrismaClient };

export const prisma = globalForPrisma.prisma ?? (createPrismaClient() as unknown as PrismaClient);

if (env.NODE_ENV !== 'production') globalForPrisma.prisma = prisma;
