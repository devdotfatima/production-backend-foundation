import { describe, expect, it } from 'vitest';
import {
  TenantScopeError,
  applyTenantScope,
  resolveScopeOrganization,
  tenantScopedModels,
} from '../dist/src/lib/tenant-scope.js';
import { runWithRequestContext, withoutTenantScope } from '#app/lib/request-context.js';

const orgA = '00000000-0000-7000-8000-00000000000a';
const orgB = '00000000-0000-7000-8000-00000000000b';

function inOrganization<T>(organizationId: string, callback: () => T): T {
  return runWithRequestContext(
    { kind: 'request', requestId: 'req-1', userId: 'user-1', organizationId },
    callback,
  );
}

/** Every operation a list, read, or write endpoint can reach. */
const readOperations = [
  'findUnique',
  'findUniqueOrThrow',
  'findFirst',
  'findFirstOrThrow',
  'findMany',
  'count',
  'aggregate',
  'groupBy',
] as const;

const writeOperations = ['update', 'updateMany', 'delete', 'deleteMany'] as const;

describe('cross-tenant isolation for every scoped model', () => {
  it.each([...tenantScopedModels])('%s narrows every read to the active tenant', (model) => {
    for (const operation of readOperations) {
      const args = applyTenantScope<Record<string, unknown>>(
        model,
        operation,
        { where: { id: 'row-1' } },
        orgA,
      );
      expect(args.where).toMatchObject({ organizationId: orgA });
    }
  });

  it.each([...tenantScopedModels])('%s narrows every mutation to the active tenant', (model) => {
    for (const operation of writeOperations) {
      const args = applyTenantScope<Record<string, unknown>>(
        model,
        operation,
        { where: { id: 'row-1' } },
        orgA,
      );
      expect(args.where).toMatchObject({ organizationId: orgA });
    }
  });

  it.each([...tenantScopedModels])('%s stamps the active tenant on create', (model) => {
    const args = applyTenantScope<Record<string, unknown>>(
      model,
      'create',
      { data: { name: 'x' } },
      orgA,
    );
    expect(args.data).toMatchObject({ organizationId: orgA });
  });

  it.each([...tenantScopedModels])('%s refuses a read aimed at another tenant', (model) => {
    expect(() =>
      applyTenantScope(model, 'findMany', { where: { organizationId: orgB } }, orgA),
    ).toThrow(TenantScopeError);
  });

  it.each([...tenantScopedModels])('%s refuses a write aimed at another tenant', (model) => {
    expect(() =>
      applyTenantScope(model, 'create', { data: { organizationId: orgB } }, orgA),
    ).toThrow(TenantScopeError);
    expect(() =>
      applyTenantScope(model, 'updateMany', { where: { organizationId: orgB } }, orgA),
    ).toThrow(TenantScopeError);
  });

  it.each([...tenantScopedModels])('%s is unreachable with no tenant resolved', (model) => {
    runWithRequestContext({ kind: 'request', requestId: 'req-1', userId: 'user-1' }, () => {
      expect(() => resolveScopeOrganization(model, 'findMany')).toThrow(TenantScopeError);
    });
  });
});

describe('cursor pagination cannot cross tenants', () => {
  it('keeps the tenant filter alongside cursor and take arguments', () => {
    // paginateCursor spreads cursor/take/skip into the same args object, so the injected filter
    // has to survive that merge — a cursor from another tenant must still return nothing.
    const args = applyTenantScope<Record<string, unknown>>(
      'Upload',
      'findMany',
      {
        where: { status: 'READY' },
        cursor: { id: 'row-from-other-tenant' },
        skip: 1,
        take: 26,
        orderBy: [{ createdAt: 'desc' }],
      },
      orgA,
    );

    expect(args.where).toEqual({ status: 'READY', organizationId: orgA });
    expect(args.cursor).toEqual({ id: 'row-from-other-tenant' });
    expect(args.take).toBe(26);
  });
});

describe('idempotency replay cannot cross tenants', () => {
  it('leaves IdempotencyRecord unscoped so the actor key must carry the tenant', () => {
    // IdempotencyRecord is intentionally not registered: its uniqueness is (actorKey, scope,
    // keyHash). If the actor key ever stops encoding the tenant, one tenant could replay
    // another's stored response, so this test documents the coupling.
    expect(tenantScopedModels.has('IdempotencyRecord')).toBe(false);
  });
});

describe('the escape hatch is narrow', () => {
  it('only bypasses inside the callback', () => {
    inOrganization(orgA, () => {
      expect(resolveScopeOrganization('Upload', 'findMany')).toBe(orgA);
      withoutTenantScope('outbox-relay', () => {
        expect(resolveScopeOrganization('Upload', 'findMany')).toBeNull();
      });
      expect(resolveScopeOrganization('Upload', 'findMany')).toBe(orgA);
    });
  });

  it('does not leak between two concurrent tenant contexts', async () => {
    const seen: string[] = [];
    await Promise.all([
      inOrganization(orgA, async () => {
        await new Promise((resolve) => setTimeout(resolve, 5));
        seen.push(resolveScopeOrganization('Upload', 'findMany')!);
      }),
      inOrganization(orgB, async () => {
        await new Promise((resolve) => setTimeout(resolve, 1));
        seen.push(resolveScopeOrganization('Upload', 'findMany')!);
      }),
    ]);
    expect(seen.sort()).toEqual([orgA, orgB].sort());
  });
});
