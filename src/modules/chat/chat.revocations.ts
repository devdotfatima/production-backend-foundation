import { env } from '#app/config/env.js';

export const CHAT_REVOCATION_CHANNEL = `${env.QUEUE_PREFIX}:chat:revoke`;

/**
 * Best-effort fast-path for live socket termination. Session/membership checks remain the source
 * of truth for reconnects, so a transient Redis outage cannot restore access.
 */
export async function publishChatRevocation(userId: string): Promise<void> {
  if (!env.CHAT_ENABLED) return;
  const { appRedis } = await import('#app/lib/redis.js');
  await appRedis
    .publish(CHAT_REVOCATION_CHANNEL, JSON.stringify({ userId }))
    .catch(() => undefined);
}
