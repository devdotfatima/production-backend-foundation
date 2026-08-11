import type { AccessClaims } from '#app/lib/jwt.js';

declare global {
  namespace Express {
    interface Request {
      auth?: AccessClaims;
      permissionEpoch?: number;
      /** Resolved from `Session.activeOrganizationId`, never from client input. */
      organizationId?: string;
      organizationPermissionEpoch?: number;
      idempotencyKey?: string;
      id: string;
      validated?: {
        body?: unknown;
        headers?: unknown;
        params?: unknown;
        query?: unknown;
      };
    }
  }
}

export {};
