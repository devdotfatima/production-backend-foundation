import { Prisma } from '@prisma/client';
import { getRequestContext } from '#app/lib/request-context.js';

/** Models deliberately exempt from automatic scoping despite carrying `organizationId`. */
export const tenantScopeExemptModels = new Set<string>(['Membership', 'Invitation', 'Role']);

/**
 * Models that deliberately contain both tenant-owned rows and explicit user-global rows.
 * A literal `organizationId: null` is preserved only for this audited set; omitting the field
 * still stamps the active organization, and all other tenant models remain impossible to bypass.
 */
export const nullableGlobalOwnerModels = new Set<string>([
  'NotificationPreference',
  'PaymentMethod',
  'StripePayment',
  'StripeRefundOperation',
  'StripeSubscription',
]);

/**
 * Derived from Prisma's generated data model so adding a tenant-owned table fails closed without
 * requiring a second hand-maintained registry. Deliberately exempt:
 * - `User`, because one human belongs to many organizations.
 * - `Organization`, `Membership`, `Invitation`, `Role`, because the tenancy module itself must
 *   query across organizations to resolve membership and switch scope.
 * - `OutboxEvent`, because the relay partitions rows across every tenant by design.
 * - `Session`, because refresh and revocation run before a tenant is resolved.
 */
export const tenantScopedModels = new Set<string>(
  Prisma.dmmf.datamodel.models
    .filter(
      (model) =>
        model.fields.some((field) => field.name === 'organizationId') &&
        !tenantScopeExemptModels.has(model.name),
    )
    .map((model) => model.name),
);

/** Raised when a tenant-scoped query cannot be proven to belong to exactly one organization. */
export class TenantScopeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TenantScopeError';
  }
}

const filterOperations = new Set([
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
]);

const createOperations = new Set(['create', 'createMany', 'createManyAndReturn']);

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

/**
 * An explicit organizationId is only tolerated when it already agrees with the resolved tenant.
 * A relation filter or a mismatch is refused rather than silently overwritten, so a
 * cross-tenant read fails loudly instead of returning the wrong rows.
 */
function assertAgrees(existing: unknown, organizationId: string, location: string): void {
  if (existing === undefined || existing === null) return;
  if (existing === organizationId) return;
  if (typeof existing === 'string') {
    throw new TenantScopeError(
      `${location} targets organization ${existing} while the request resolved ${organizationId}`,
    );
  }
  throw new TenantScopeError(
    `${location} sets organizationId to a non-literal filter, which cannot be proven single-tenant`,
  );
}

function scopeWhere(
  model: string,
  args: Record<string, unknown>,
  organizationId: string,
  location: string,
): void {
  const where = asRecord(args.where) ?? {};
  if (where.organizationId === null && nullableGlobalOwnerModels.has(model)) {
    args.where = where;
    return;
  }
  assertAgrees(where.organizationId, organizationId, location);
  where.organizationId = organizationId;
  args.where = where;
}

function scopeCreateData(
  model: string,
  data: unknown,
  organizationId: string,
  location: string,
): void {
  const rows = Array.isArray(data) ? data : [data];
  for (const row of rows) {
    const record = asRecord(row);
    if (!record) continue;
    if (record.organization !== undefined) {
      throw new TenantScopeError(
        `${location} connects the organization relation; set the scalar organizationId instead`,
      );
    }
    if (record.organizationId === null && nullableGlobalOwnerModels.has(model)) continue;
    assertAgrees(record.organizationId, organizationId, location);
    record.organizationId = organizationId;
  }
}

/**
 * Injects the resolved organization into a Prisma operation's arguments.
 *
 * Prisma's extended `where` support (GA in v5) accepts non-unique fields alongside the unique
 * identifier, so `findUnique`, `update`, `delete`, and `upsert` can all be narrowed in place
 * without rewriting them into `findFirst`.
 *
 * Mutates `args` in the same style as the soft-delete extension.
 */
export function applyTenantScope<T>(
  model: string,
  operation: string,
  args: T,
  organizationId: string,
): T {
  const location = `${model}.${operation}`;

  if (operation === 'upsert') {
    const record = asRecord(args) ?? {};
    scopeWhere(model, record, organizationId, location);
    scopeCreateData(model, record.create, organizationId, location);
    return record as T;
  }

  if (filterOperations.has(operation)) {
    const record = asRecord(args) ?? {};
    scopeWhere(model, record, organizationId, location);
    return record as T;
  }

  if (createOperations.has(operation)) {
    const record = asRecord(args) ?? {};
    scopeCreateData(model, record.data, organizationId, location);
    return record as T;
  }

  throw new TenantScopeError(
    `${location} is not a tenant-scopable operation; wrap it in withoutTenantScope() if it is trusted`,
  );
}

/**
 * Decides whether an operation must be narrowed, and to which organization.
 *
 * Returns null when the model is not tenant-scoped or the caller is explicitly running unscoped.
 * Throws when a tenant-scoped model is reached without a provable tenant — the absence of a
 * context is a bug, never permission.
 */
export function resolveScopeOrganization(
  model: string | undefined,
  operation: string,
  args?: unknown,
): string | null {
  if (!model || !tenantScopedModels.has(model)) return null;

  const context = getRequestContext();
  if (context?.kind === 'unscoped') return null;
  if (!context) {
    throw new TenantScopeError(
      `${model}.${operation} ran outside a request context; wrap trusted background work in withoutTenantScope()`,
    );
  }
  if (!context.organizationId) {
    const record = asRecord(args);
    const explicitlyGlobal =
      model &&
      nullableGlobalOwnerModels.has(model) &&
      ((filterOperations.has(operation) && asRecord(record?.where)?.organizationId === null) ||
        (createOperations.has(operation) &&
          (Array.isArray(record?.data)
            ? record.data.every((row) => asRecord(row)?.organizationId === null)
            : asRecord(record?.data)?.organizationId === null)) ||
        (operation === 'upsert' &&
          asRecord(record?.where)?.organizationId === null &&
          asRecord(record?.create)?.organizationId === null));
    if (explicitlyGlobal) return null;
    throw new TenantScopeError(
      `${model}.${operation} ran before an organization was resolved for the request`,
    );
  }
  return context.organizationId;
}

export const tenantScopeExtension = Prisma.defineExtension({
  name: 'mandatory-tenant-scope',
  query: {
    $allModels: {
      async $allOperations({ model, operation, args, query }) {
        const organizationId = resolveScopeOrganization(model, operation, args);
        if (organizationId === null) return query(args);
        return query(applyTenantScope(model, operation, args, organizationId));
      },
    },
  },
});
