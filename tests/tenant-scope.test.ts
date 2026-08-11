import type { NextFunction, Request, Response } from 'express';
import { describe, expect, it } from 'vitest';
import type { RequestContext } from '#app/lib/request-context.js';
import {
  TenantScopeError,
  applyTenantScope,
  resolveScopeOrganization,
  tenantScopedModels,
} from '#app/lib/tenant-scope.js';
import {
  getRequestContext,
  requestContext,
  runWithRequestContext,
  setRequestIdentity,
  withoutTenantScope,
} from '#app/lib/request-context.js';

const org = '00000000-0000-7000-8000-00000000000a';
const other = '00000000-0000-7000-8000-00000000000b';

describe('tenant scope argument injection', () => {
  it('adds the resolved organization to filter operations', () => {
    for (const operation of [
      'findUnique',
      'findFirst',
      'findMany',
      'count',
      'aggregate',
      'groupBy',
      'update',
      'updateMany',
      'delete',
      'deleteMany',
    ]) {
      expect(applyTenantScope('Upload', operation, { where: { id: 'x' } }, org)).toEqual({
        where: { id: 'x', organizationId: org },
      });
    }
  });

  it('creates a where clause when the caller supplied none', () => {
    expect(applyTenantScope('Upload', 'findMany', {}, org)).toEqual({
      where: { organizationId: org },
    });
    expect(applyTenantScope('Upload', 'count', undefined, org)).toEqual({
      where: { organizationId: org },
    });
  });

  it('scopes findUnique in place rather than rewriting it', () => {
    // Prisma's extended where-unique support accepts non-unique fields alongside the identifier.
    expect(applyTenantScope('Upload', 'findUnique', { where: { id: 'x' } }, org)).toEqual({
      where: { id: 'x', organizationId: org },
    });
  });

  it('stamps the organization onto created rows', () => {
    expect(applyTenantScope('Upload', 'create', { data: { name: 'a' } }, org)).toEqual({
      data: { name: 'a', organizationId: org },
    });
    expect(
      applyTenantScope('Upload', 'createMany', { data: [{ name: 'a' }, { name: 'b' }] }, org),
    ).toEqual({
      data: [
        { name: 'a', organizationId: org },
        { name: 'b', organizationId: org },
      ],
    });
  });

  it('scopes both halves of an upsert', () => {
    expect(
      applyTenantScope(
        'Upload',
        'upsert',
        { where: { id: 'x' }, create: { name: 'a' }, update: { name: 'b' } },
        org,
      ),
    ).toEqual({
      where: { id: 'x', organizationId: org },
      create: { name: 'a', organizationId: org },
      update: { name: 'b' },
    });
  });

  it('accepts an explicit organization that already agrees', () => {
    expect(applyTenantScope('Upload', 'findMany', { where: { organizationId: org } }, org)).toEqual(
      { where: { organizationId: org } },
    );
  });

  it('preserves explicit user-global ownership only for audited dual-owner models', () => {
    expect(
      applyTenantScope(
        'StripePayment',
        'findMany',
        { where: { userId: 'user-1', organizationId: null } },
        org,
      ),
    ).toEqual({ where: { userId: 'user-1', organizationId: null } });
    expect(
      applyTenantScope('Upload', 'findMany', { where: { organizationId: null } }, org),
    ).toEqual({ where: { organizationId: org } });
  });

  it('refuses a query aimed at a different organization', () => {
    expect(() =>
      applyTenantScope('Upload', 'findMany', { where: { organizationId: other } }, org),
    ).toThrow(TenantScopeError);
    expect(() =>
      applyTenantScope('Upload', 'create', { data: { organizationId: other } }, org),
    ).toThrow(TenantScopeError);
  });

  it('refuses an organization filter it cannot prove is single-tenant', () => {
    expect(() =>
      applyTenantScope(
        'Upload',
        'findMany',
        { where: { organizationId: { in: [org, other] } } },
        org,
      ),
    ).toThrow(/non-literal filter/);
  });

  it('refuses a nested organization relation on create', () => {
    expect(() =>
      applyTenantScope(
        'Upload',
        'create',
        { data: { organization: { connect: { id: org } } } },
        org,
      ),
    ).toThrow(/scalar organizationId/);
  });

  it('fails closed on operations it does not know how to scope', () => {
    expect(() => applyTenantScope('Upload', 'findRaw', {}, org)).toThrow(
      /not a tenant-scopable operation/,
    );
  });

  it('registers exactly the models carrying an organizationId column', () => {
    expect([...tenantScopedModels].sort()).toEqual([
      'AuditEvent',
      'ChargeableItem',
      'Conversation',
      'ConversationParticipant',
      'Message',
      'NotificationDelivery',
      'NotificationPreference',
      'PaymentMethod',
      'StripePayment',
      'StripeRefundOperation',
      'StripeSubscription',
      'Upload',
      'UploadBandwidthUsage',
    ]);
  });

  it('leaves cross-tenant models unregistered', () => {
    // Registering any of these would deadlock the tenancy module against itself: resolving a
    // membership or rotating a session has to work before a tenant is known.
    for (const model of [
      'User',
      'Session',
      'RefreshToken',
      'Organization',
      'Membership',
      'Invitation',
      'Role',
      'OutboxEvent',
    ]) {
      expect(tenantScopedModels.has(model)).toBe(false);
    }
  });
});

describe('tenant scope enforcement decision', () => {
  function withRegisteredModel<T>(model: string, callback: () => T): T {
    tenantScopedModels.add(model);
    try {
      return callback();
    } finally {
      tenantScopedModels.delete(model);
    }
  }

  it('leaves unregistered models alone even with no context at all', () => {
    expect(resolveScopeOrganization('User', 'findMany')).toBeNull();
    expect(resolveScopeOrganization('Session', 'findFirst')).toBeNull();
  });

  it('scopes a registered model that now has a tenant column', () => {
    expect(() => resolveScopeOrganization('AuditEvent', 'findMany')).toThrow(
      /outside a request context/,
    );
  });

  it('allows a provably user-global dual-owner query without an active tenant', () => {
    const context: RequestContext = {
      kind: 'request',
      requestId: 'request-global-billing',
      userId: 'user-1',
    };
    runWithRequestContext(context, () => {
      expect(
        resolveScopeOrganization('StripePayment', 'findMany', {
          where: { userId: 'user-1', organizationId: null },
        }),
      ).toBeNull();
      expect(() =>
        resolveScopeOrganization('StripePayment', 'findMany', { where: { userId: 'user-1' } }),
      ).toThrow(/before an organization was resolved/);
    });
  });

  it('scopes a registered model to the resolved organization', () => {
    withRegisteredModel('Upload', () => {
      runWithRequestContext(
        { kind: 'request', requestId: 'r1', userId: 'u1', organizationId: org },
        () => {
          expect(resolveScopeOrganization('Upload', 'findMany')).toBe(org);
        },
      );
    });
  });

  it('refuses a registered model when no context exists', () => {
    withRegisteredModel('Upload', () => {
      expect(() => resolveScopeOrganization('Upload', 'findMany')).toThrow(
        /outside a request context/,
      );
    });
  });

  it('refuses a registered model before an organization is resolved', () => {
    withRegisteredModel('Upload', () => {
      runWithRequestContext({ kind: 'request', requestId: 'r1', userId: 'u1' }, () => {
        expect(() => resolveScopeOrganization('Upload', 'findMany')).toThrow(
          /before an organization was resolved/,
        );
      });
    });
  });

  it('lets explicitly unscoped background work through', () => {
    withRegisteredModel('Upload', () => {
      withoutTenantScope('outbox-relay', () => {
        expect(resolveScopeOrganization('Upload', 'findMany')).toBeNull();
      });
    });
  });
});

describe('request context', () => {
  it('has no ambient context outside a request', () => {
    expect(getRequestContext()).toBeUndefined();
  });

  it('records identity onto the active request context', () => {
    runWithRequestContext({ kind: 'request', requestId: 'r1' }, () => {
      setRequestIdentity({ userId: 'u1' });
      expect(getRequestContext()).toEqual({ kind: 'request', requestId: 'r1', userId: 'u1' });
    });
  });

  it('ignores identity writes when the context is unscoped', () => {
    withoutTenantScope('outbox-relay', () => {
      setRequestIdentity({ userId: 'u1' });
      expect(getRequestContext()).toEqual({ kind: 'unscoped', reason: 'outbox-relay' });
    });
  });

  it('propagates across awaits', async () => {
    await runWithRequestContext({ kind: 'request', requestId: 'r2', userId: 'u2' }, async () => {
      await Promise.resolve();
      await new Promise((resolve) => setTimeout(resolve, 1));
      expect(getRequestContext()).toMatchObject({ requestId: 'r2', userId: 'u2' });
    });
  });

  it('restores the outer context after an unscoped block', () => {
    runWithRequestContext({ kind: 'request', requestId: 'r3' }, () => {
      withoutTenantScope('maintenance', () => {
        expect(getRequestContext()?.kind).toBe('unscoped');
      });
      expect(getRequestContext()?.kind).toBe('request');
    });
  });
});

describe('request context middleware', () => {
  function run(request: unknown): RequestContext | undefined {
    let observed: RequestContext | undefined;
    requestContext(
      request as Request,
      {} as Response,
      (() => {
        observed = getRequestContext();
      }) as NextFunction,
    );
    return observed;
  }

  it('establishes a request context carrying the assigned request id', () => {
    expect(run({ id: 'req-1' })).toEqual({ kind: 'request', requestId: 'req-1' });
  });

  it('normalises a numeric request id and tolerates a missing one', () => {
    expect(run({ id: 7 })).toEqual({ kind: 'request', requestId: '7' });
    expect(run({})).toEqual({ kind: 'request', requestId: 'unknown' });
  });

  it('establishes a context even when no identity is ever resolved', () => {
    // A missing identity must stay distinguishable from a missing context, because the
    // tenant-scope extension refuses the latter outright.
    expect(run({ id: 'req-2' })?.kind).toBe('request');
  });
});
