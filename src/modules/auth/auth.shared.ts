import type { AuditInput } from '#app/modules/audit/audit.service.js';
import { hashSecret, randomToken } from '#app/lib/crypto.js';

export const dummyPasswordHash = hashSecret(randomToken());

export interface RequestMetadata {
  ip: string;
  userAgent?: string;
  requestId: string;
}

export interface TokenPair {
  accessToken: string;
  refreshToken: string;
}

export function expiresIn(amount: number, unitMilliseconds: number): Date {
  return new Date(Date.now() + amount * unitMilliseconds);
}

export function auditMetadata(
  metadata: RequestMetadata,
): Pick<AuditInput, 'requestId' | 'ip' | 'userAgent'> {
  return {
    requestId: metadata.requestId,
    ip: metadata.ip,
    userAgent: metadata.userAgent,
  };
}
