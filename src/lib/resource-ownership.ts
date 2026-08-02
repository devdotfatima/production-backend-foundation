import { errors } from '#app/lib/errors.js';

/** Enforces ownership for user-scoped resources without trusting client input. */
export function assertResourceOwner(ownerUserId: string, actorUserId: string): void {
  if (ownerUserId !== actorUserId) throw errors.forbidden();
}
