import type { Request } from 'express';
import { describe, expect, it } from 'vitest';
import { idempotencyActorKey, idempotencyActorSuffix } from '../dist/src/lib/idempotency.js';

const userId = '00000000-0000-7000-8000-0000000000a1';
const orgA = '00000000-0000-7000-8000-00000000000a';
const orgB = '00000000-0000-7000-8000-00000000000b';

function request(overrides: Partial<Request>): Request {
  return overrides as Request;
}

describe('idempotency actor key', () => {
  it('is the bare principal when no tenant is active', () => {
    expect(idempotencyActorKey(request({ auth: { userId, sessionId: 's1' } }))).toBe(
      `user:${userId}`,
    );
  });

  it('separates the same user acting in two organizations', () => {
    // The stored record is keyed on (actorKey, scope, keyHash). Without the tenant in the actor
    // key, a user in two organizations could replay the first organization's stored response by
    // reusing the same Idempotency-Key in the second.
    const inA = idempotencyActorKey(
      request({ auth: { userId, sessionId: 's1' }, organizationId: orgA }),
    );
    const inB = idempotencyActorKey(
      request({ auth: { userId, sessionId: 's1' }, organizationId: orgB }),
    );

    expect(inA).not.toBe(inB);
    expect(inA).toBe(`org:${orgA}:user:${userId}`);
  });

  it('keeps a stable suffix so account deletion can still find every record', () => {
    const suffix = idempotencyActorSuffix(request({ auth: { userId, sessionId: 's1' } }));
    expect(
      idempotencyActorKey(request({ auth: { userId, sessionId: 's1' }, organizationId: orgA })),
    ).toContain(suffix);
  });

  it('refuses an unauthenticated request rather than sharing a global bucket', () => {
    expect(() => idempotencyActorKey(request({}))).toThrow();
  });
});
