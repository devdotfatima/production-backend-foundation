import type { AccessClaims } from '#app/lib/jwt.js';

declare global {
  namespace Express {
    interface Request {
      auth?: AccessClaims;
      permissionEpoch?: number;
      serviceAuth?: {
        apiKeyId: string;
        serviceAccountId: string;
        permissions: string[];
        permissionEpoch: number;
      };
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
