import { AsyncLocalStorage } from 'node:async_hooks';
import type { RequestHandler } from 'express';

/**
 * Ambient per-request identity. Carrying this in async storage rather than a service argument
 * keeps tenant resolution out of every use-case signature; the tenant-scope Prisma extension is
 * the only consumer that must never be bypassed.
 */
export type RequestContext =
  | {
      kind: 'request';
      requestId: string;
      userId?: string;
      organizationId?: string;
    }
  | { kind: 'unscoped'; reason: string };

const storage = new AsyncLocalStorage<RequestContext>();

export function getRequestContext(): RequestContext | undefined {
  return storage.getStore();
}

export function runWithRequestContext<T>(context: RequestContext, callback: () => T): T {
  return storage.run(context, callback);
}

/**
 * Runs trusted server-side work that legitimately spans tenants: the outbox relay, queue
 * workers, and maintenance jobs. Deliberately explicit and greppable — absence of any context
 * is treated as a bug, not as permission.
 */
export function withoutTenantScope<T>(reason: string, callback: () => T): T {
  return storage.run({ kind: 'unscoped', reason }, callback);
}

/** Records the authenticated identity on the active request context. */
export function setRequestIdentity(identity: { userId?: string; organizationId?: string }): void {
  const context = storage.getStore();
  if (context?.kind !== 'request') return;
  if (identity.userId !== undefined) context.userId = identity.userId;
  if (identity.organizationId !== undefined) context.organizationId = identity.organizationId;
}

function resolveRequestId(value: unknown): string {
  if (typeof value === 'string') return value;
  if (typeof value === 'number') return value.toString();
  return 'unknown';
}

/**
 * Establishes the context for every request so that a missing identity is distinguishable from
 * a missing context. Mount immediately after request-id assignment and before any router.
 */
export const requestContext: RequestHandler = (request, _response, next) => {
  runWithRequestContext({ kind: 'request', requestId: resolveRequestId(request.id) }, () => {
    next();
  });
};
