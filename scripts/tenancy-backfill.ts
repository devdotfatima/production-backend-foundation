import 'dotenv/config';
import { Prisma, PrismaClient } from '@prisma/client';
import { signAuditEvent } from '#app/modules/audit/audit.integrity.js';

const database = new PrismaClient();

const apply = process.argv.includes('--apply');
const valueOf = (name: string) =>
  process.argv.find((value) => value.startsWith(`${name}=`))?.slice(name.length + 1);
const organizationIdArgument = valueOf('--organization-id');
const organizationSlug = valueOf('--organization-slug') ?? 'default';
const organizationName = valueOf('--organization-name') ?? 'Default';

const ownedTables = [
  'uploads',
  'upload_bandwidth_usage',
  'chargeable_items',
  'conversations',
  'conversation_participants',
  'messages',
  'notification_deliveries',
] as const;

async function nullOwnerCounts(): Promise<Record<string, number>> {
  const counts: Record<string, number> = {};
  for (const table of ['audit_events', ...ownedTables]) {
    // Table names come exclusively from the fixed allowlist above, never from argv.
    const rows = await database.$queryRawUnsafe<Array<{ count: bigint }>>(
      `SELECT count(*)::bigint AS count FROM "${table}" WHERE "organizationId" IS NULL`,
    );
    counts[table] = Number(rows[0]?.count ?? 0n);
  }
  return counts;
}

async function main(): Promise<void> {
  if ((process.env.TENANCY_MODE ?? 'disabled') !== 'disabled') {
    throw new Error(
      'Run the backfill while TENANCY_MODE=disabled and application writers are stopped',
    );
  }

  const counts = await nullOwnerCounts();
  const existingOrganization = organizationIdArgument
    ? await database.organization.findUnique({ where: { id: organizationIdArgument } })
    : await database.organization.findUnique({ where: { slug: organizationSlug } });

  console.log(
    JSON.stringify(
      {
        mode: apply ? 'apply' : 'dry-run',
        target: existingOrganization ?? {
          id: organizationIdArgument ?? '(generated on apply)',
          slug: organizationSlug,
          name: organizationName,
        },
        nullOwnedRows: counts,
        billingRows: 'left user-global; migrate separately before changing BILLING_OWNER',
      },
      null,
      2,
    ),
  );
  if (!apply) {
    console.log('Dry run only. Re-run with --apply after stopping API and worker processes.');
    return;
  }

  await database.$transaction(
    async (tx) => {
      const organization = existingOrganization
        ? existingOrganization
        : await tx.organization.create({
            data: {
              ...(organizationIdArgument ? { id: organizationIdArgument } : {}),
              slug: organizationSlug,
              name: organizationName,
            },
          });
      const memberRole = await tx.role.findFirst({
        where: { name: 'member', organizationId: null, deletedAt: null },
        select: { id: true },
      });
      if (!memberRole) throw new Error('Global member role is missing; run npm run db:seed first');

      await tx.$executeRaw`
        INSERT INTO "memberships" (
          "id", "organizationId", "userId", "roleId", "status", "joinedAt",
          "createdAt", "updatedAt", "deletedAt"
        )
        SELECT
          uuid_generate_v7(), ${organization.id}::uuid, "id", ${memberRole.id}::uuid,
          CAST('ACTIVE' AS "MembershipStatus"), CURRENT_TIMESTAMP,
          CURRENT_TIMESTAMP, CURRENT_TIMESTAMP, NULL
        FROM "users"
        WHERE "deletedAt" IS NULL
        ON CONFLICT ("organizationId", "userId") DO UPDATE
        SET "status" = CAST('ACTIVE' AS "MembershipStatus"), "deletedAt" = NULL,
            "updatedAt" = CURRENT_TIMESTAMP
      `;
      await tx.session.updateMany({
        where: { activeOrganizationId: null, deletedAt: null },
        data: { activeOrganizationId: organization.id },
      });

      for (const table of ownedTables) {
        await tx.$executeRawUnsafe(
          `UPDATE "${table}" SET "organizationId" = $1::uuid WHERE "organizationId" IS NULL`,
          organization.id,
        );
      }
      await tx.$executeRaw`
        UPDATE "upload_bandwidth_usage"
        SET "scopeKey" = 'organization:' || ${organization.id}::text || ':user:' || "userId"::text
        WHERE "organizationId" = ${organization.id}::uuid
      `;
      await tx.$executeRaw`
        UPDATE "conversations"
        SET "directKey" = ${organization.id}::text || substring("directKey" FROM 7)
        WHERE "type" = CAST('DIRECT' AS "ConversationType")
          AND "organizationId" = ${organization.id}::uuid
          AND "directKey" LIKE 'global:%'
      `;

      // organizationId is part of integrity version 2, so audit rows must be re-signed rather
      // than mass-updated with SQL. Preserve updatedAt so the historical record does not change.
      const auditEvents = await tx.auditEvent.findMany({ where: { organizationId: null } });
      for (const event of auditEvents) {
        const organizationId = organization.id;
        await tx.auditEvent.update({
          where: { id: event.id },
          data: {
            organizationId,
            integrityHash: signAuditEvent({ ...event, organizationId }),
            updatedAt: event.updatedAt,
          },
        });
      }
    },
    { isolationLevel: Prisma.TransactionIsolationLevel.Serializable, timeout: 15 * 60_000 },
  );

  console.log(
    'Tenancy backfill committed. Run audit verification, then enable TENANCY_MODE=single or multi.',
  );
}

try {
  await main();
} finally {
  await database.$disconnect();
}
