import type { Server as HttpServer } from 'node:http';
import { createAdapter } from '@socket.io/redis-streams-adapter';
import { Server, type Socket } from 'socket.io';
import { env } from '#app/config/env.js';
import {
  clientIpKey,
  parseCidr,
  trustedClientAddress,
  type ParsedCidr,
} from '#app/lib/client-ip.js';
import { cookieNames } from '#app/lib/cookies.js';
import { verifyAccessToken } from '#app/lib/jwt.js';
import { prisma } from '#app/lib/prisma.js';
import { enforceRateLimit } from '#app/lib/rate-limit.js';
import { createRedisConnection } from '#app/lib/redis.js';
import { runWithRequestContext } from '#app/lib/request-context.js';
import { appLogger } from '#app/observability/logger.js';
import { recordChatMessage } from '#app/observability/metrics.js';
import {
  chatEvents,
  joinPayloadSchema,
  markReadPayloadSchema,
  sendMessagePayloadSchema,
  typingPayloadSchema,
} from '#app/modules/chat/chat.events.js';
import {
  listParticipantUserIds,
  markRead,
  requireParticipant,
  sendMessage,
  serializeMessage,
} from '#app/modules/chat/chat.service.js';
import { CHAT_REVOCATION_CHANNEL } from '#app/modules/chat/chat.revocations.js';

interface SocketIdentity {
  userId: string;
  sessionId: string;
  organizationId: string | null;
}

const identities = new WeakMap<Socket, SocketIdentity>();

/** Rooms are namespaced by tenant so a conversation id alone cannot address another org's room. */
function conversationRoom(organizationId: string | null, conversationId: string): string {
  return `${organizationId ?? 'global'}:conversation:${conversationId}`;
}

function userRoom(userId: string): string {
  return `user:${userId}`;
}

function tokenFromHandshake(
  socket: Socket,
): { token: string; source: 'explicit' | 'cookie' } | undefined {
  const auth = socket.handshake.auth as { token?: unknown } | undefined;
  if (typeof auth?.token === 'string' && auth.token) {
    return { token: auth.token, source: 'explicit' };
  }

  const header = socket.handshake.headers.authorization;
  if (header?.startsWith('Bearer ')) {
    const token = header.slice('Bearer '.length).trim();
    return token ? { token, source: 'explicit' } : undefined;
  }

  const cookies = socket.handshake.headers.cookie;
  if (!cookies) return undefined;
  for (const part of cookies.split(';')) {
    const [name, ...rest] = part.trim().split('=');
    if (name === cookieNames.access) {
      return { token: decodeURIComponent(rest.join('=')), source: 'cookie' };
    }
  }
  return undefined;
}

/**
 * Resolves the session exactly as `authenticate` does. A token alone is not enough: the session
 * must still be live and, in a tenant deployment, the membership must still be active.
 */
async function resolveIdentity(token: string): Promise<SocketIdentity | null> {
  const claims = await verifyAccessToken(token);
  const session = await prisma.session.findFirst({
    where: {
      id: claims.sessionId,
      userId: claims.userId,
      revokedAt: null,
      deletedAt: null,
      expiresAt: { gt: new Date() },
      user: { status: 'ACTIVE', deletedAt: null },
    },
    select: {
      activeOrganizationId: true,
      activeOrganization: { select: { status: true, deletedAt: true } },
    },
  });
  if (!session) return null;

  const organizationId = session.activeOrganizationId;
  if (organizationId) {
    const organization = session.activeOrganization;
    if (!organization || organization.deletedAt || organization.status !== 'ACTIVE') return null;
    const membership = await prisma.membership.findFirst({
      where: { organizationId, userId: claims.userId, status: 'ACTIVE', deletedAt: null },
      select: { id: true },
    });
    if (!membership) return null;
  }

  return { userId: claims.userId, sessionId: claims.sessionId, organizationId };
}

function allowedOrigin(origin: string | undefined): boolean {
  if (!origin) return false;
  const allowed = env.CORS_ALLOWED_ORIGINS.length > 0 ? env.CORS_ALLOWED_ORIGINS : [env.APP_ORIGIN];
  return allowed.includes(origin);
}

function configuredTrustedProxyCidrs(): ParsedCidr[] {
  return (env.TRUST_PROXY_CIDRS ?? []).flatMap((value) => {
    const parsed = parseCidr(value);
    return parsed ? [parsed] : [];
  });
}

function socketClientAddress(socket: Socket): string | undefined {
  return trustedClientAddress({
    remoteAddress: socket.handshake.address,
    forwardedFor: socket.handshake.headers['x-forwarded-for'],
    trustedHops: env.TRUST_PROXY_HOPS ?? 0,
    trustedCidrs: configuredTrustedProxyCidrs(),
  });
}

async function enforceSocketEventLimit(identity: SocketIdentity): Promise<void> {
  await enforceRateLimit('chat:event:user', identity.userId, env.CHAT_MAX_EVENTS_PER_MINUTE, 60);
}

function joinedConversationCount(socket: Socket): number {
  return [...socket.rooms].filter((room) => room.includes(':conversation:')).length;
}

/** Runs socket work inside a request context so tenant scoping applies to its queries too. */
function withIdentity<T>(identity: SocketIdentity, callback: () => Promise<T>): Promise<T> {
  return runWithRequestContext(
    {
      kind: 'request',
      requestId: `ws:${identity.sessionId}`,
      userId: identity.userId,
      ...(identity.organizationId ? { organizationId: identity.organizationId } : {}),
    },
    callback,
  );
}

export interface ChatGateway {
  server: Server;
  /** Resolves only when this node's cross-node adapter can reach Redis. */
  ready(): Promise<void>;
  /** Broadcasts an already-committed message. */
  publish(
    organizationId: string | null,
    conversationId: string,
    event: string,
    payload: unknown,
  ): void;
  drain(): Promise<void>;
}

export function createChatGateway(httpServer: HttpServer): ChatGateway {
  const server = new Server(httpServer, {
    path: env.CHAT_SOCKET_PATH,
    // Long-polling is what forces sticky sessions; websocket-only lets any node serve any
    // connection and keeps the load balancer configuration trivial.
    transports: ['websocket'],
    maxHttpBufferSize: env.CHAT_MAX_FRAME_BYTES,
    pingInterval: env.CHAT_PING_INTERVAL_MS,
    pingTimeout: env.CHAT_PING_TIMEOUT_MS,
    cors: {
      origin: env.CORS_ALLOWED_ORIGINS.length > 0 ? env.CORS_ALLOWED_ORIGINS : [env.APP_ORIGIN],
      credentials: true,
    },
  });

  // Cross-node fanout. The streams adapter is used rather than classic pub/sub because it
  // survives a broker restart instead of silently dropping broadcasts.
  const adapterRedis = createRedisConnection('chat-adapter');
  adapterRedis.on('error', (error) => {
    appLogger.warn({ err: error, subsystem: 'chat-adapter' }, 'Chat adapter Redis error');
  });
  server.adapter(
    createAdapter(adapterRedis, {
      streamName: `${env.QUEUE_PREFIX}:chat:stream`,
    }),
  );

  server.use((socket, next) => {
    void (async () => {
      try {
        const credential = tokenFromHandshake(socket);
        if (!credential) return next(new Error('unauthenticated'));
        // Browsers do not apply CORS to websockets and send cookies regardless, so the origin
        // check is the CSRF equivalent for cookie credentials. Native/bearer clients legitimately
        // omit Origin, but an explicitly disallowed Origin is always rejected.
        const origin = socket.handshake.headers.origin;
        if ((origin && !allowedOrigin(origin)) || (!origin && credential.source === 'cookie')) {
          return next(new Error('origin_not_allowed'));
        }

        const address = clientIpKey(socketClientAddress(socket));
        await enforceRateLimit('chat:connect:ip', address, env.CHAT_MAX_CONNECTIONS_PER_IP, 60);

        const identity = await resolveIdentity(credential.token);
        if (!identity) return next(new Error('unauthenticated'));

        identities.set(socket, identity);
        next();
      } catch {
        next(new Error('unauthenticated'));
      }
    })();
  });

  server.on('connection', (socket) => {
    const identity = identities.get(socket);
    if (!identity) return socket.disconnect(true);

    void socket.join(userRoom(identity.userId));

    socket.on(chatEvents.join, (raw: unknown, ack?: (result: unknown) => void) => {
      void (async () => {
        try {
          await enforceSocketEventLimit(identity);
          const payload = joinPayloadSchema.parse(raw);
          // Authorising the connection is not enough; each room join is checked separately.
          await withIdentity(identity, () =>
            requireParticipant(payload.conversationId, identity.userId),
          );
          const room = conversationRoom(identity.organizationId, payload.conversationId);
          if (!socket.rooms.has(room) && joinedConversationCount(socket) >= env.CHAT_MAX_ROOMS) {
            throw new Error('chat_room_limit_exceeded');
          }
          await socket.join(room);
          ack?.({ ok: true });
        } catch (error) {
          ack?.({ ok: false, error: errorCode(error) });
        }
      })();
    });

    socket.on(chatEvents.leave, (raw: unknown, ack?: (result: unknown) => void) => {
      void (async () => {
        try {
          await enforceSocketEventLimit(identity);
          const parsed = joinPayloadSchema.parse(raw);
          await socket.leave(conversationRoom(identity.organizationId, parsed.conversationId));
          ack?.({ ok: true });
        } catch (error) {
          ack?.({ ok: false, error: errorCode(error) });
        }
      })();
    });

    socket.on(chatEvents.send, (raw: unknown, ack?: (result: unknown) => void) => {
      void (async () => {
        try {
          await enforceSocketEventLimit(identity);
          const payload = sendMessagePayloadSchema.parse(raw);
          await enforceRateLimit(
            'chat:send:user',
            `${identity.userId}:${payload.conversationId}`,
            env.CHAT_MAX_MESSAGES_PER_MINUTE,
            60,
          );

          const { message, duplicate } = await withIdentity(identity, () =>
            sendMessage(payload.conversationId, identity.userId, payload),
          );
          const serialized = serializeMessage(message);

          // Committed first, broadcast second. A dropped broadcast costs latency, not data:
          // clients reconcile with `afterSeq` on reconnect.
          if (!duplicate) {
            recordChatMessage();
            server
              .to(conversationRoom(identity.organizationId, payload.conversationId))
              .emit(chatEvents.message, serialized);
          }
          ack?.({ ok: true, message: serialized, duplicate });
        } catch (error) {
          ack?.({ ok: false, error: errorCode(error) });
        }
      })();
    });

    socket.on(chatEvents.markRead, (raw: unknown, ack?: (result: unknown) => void) => {
      void (async () => {
        try {
          await enforceSocketEventLimit(identity);
          const payload = markReadPayloadSchema.parse(raw);
          const result = await withIdentity(identity, () =>
            markRead(payload.conversationId, identity.userId, payload.seq),
          );
          socket
            .to(conversationRoom(identity.organizationId, payload.conversationId))
            .emit(chatEvents.read, {
              conversationId: payload.conversationId,
              userId: identity.userId,
              ...result,
            });
          ack?.({ ok: true, ...result });
        } catch (error) {
          ack?.({ ok: false, error: errorCode(error) });
        }
      })();
    });

    socket.on(chatEvents.typing, (raw: unknown) => {
      void (async () => {
        try {
          await enforceSocketEventLimit(identity);
          const parsed = typingPayloadSchema.parse(raw);
          // Ephemeral: never persisted, and only ever relayed to an already-authorised room.
          if (!socket.rooms.has(conversationRoom(identity.organizationId, parsed.conversationId))) {
            return;
          }
          socket
            .to(conversationRoom(identity.organizationId, parsed.conversationId))
            .emit(chatEvents.typing, {
              conversationId: parsed.conversationId,
              userId: identity.userId,
              typing: parsed.typing,
            });
        } catch {
          // Typing is fire-and-forget. Rate-limited or malformed frames are intentionally dropped.
        }
      })();
    });
  });

  /**
   * Backpressure sweep. One slow consumer must not grow the heap until the process dies.
   *
   * Swept on a timer rather than on inbound packets: the socket that needs disconnecting is the
   * one that has stopped reading, which by definition is not sending anything to sample on.
   */
  const backpressureTimer = setInterval(() => {
    for (const socket of server.sockets.sockets.values()) {
      if (bufferedPacketCount(socket) <= env.CHAT_MAX_WRITE_BUFFER) continue;
      appLogger.warn(
        {
          userId: identities.get(socket)?.userId,
          buffered: bufferedPacketCount(socket),
          metric: 'chat.backpressure_disconnect',
        },
        'Disconnecting socket that cannot keep up',
      );
      socket.disconnect(true);
    }
  }, env.CHAT_PING_INTERVAL_MS);
  backpressureTimer.unref();

  // Pub/sub revocation is the fast path. This bounded sweep is the backstop for an expired
  // session, a tenant switch, or a revocation notice lost during a Redis incident.
  let revalidationRunning = false;
  const revalidationTimer = setInterval(() => {
    if (revalidationRunning) return;
    revalidationRunning = true;
    void revalidateConnectedSockets(server)
      .catch((error: unknown) => {
        appLogger.warn({ err: error }, 'Chat session revalidation sweep failed');
      })
      .finally(() => {
        revalidationRunning = false;
      });
  }, env.CHAT_SESSION_REVALIDATE_MS);
  revalidationTimer.unref();

  /**
   * Terminates live sockets when a session is revoked or a member is removed. Without this a
   * connection authorised once outlives logout for as long as it stays open.
   */
  const revocations = createRedisConnection('chat-revocations');
  revocations.on('error', (error) => {
    appLogger.warn({ err: error, subsystem: 'chat-revocations' }, 'Chat revocation Redis error');
  });
  void revocations.subscribe(CHAT_REVOCATION_CHANNEL).catch((error: unknown) => {
    appLogger.warn({ err: error }, 'Chat revocation subscription is unavailable');
  });
  revocations.on('message', (channel, raw) => {
    if (channel !== CHAT_REVOCATION_CHANNEL) return;
    try {
      const { userId } = JSON.parse(raw) as { userId?: string };
      if (userId) server.in(userRoom(userId)).disconnectSockets(true);
    } catch {
      // A malformed revocation notice must not take the gateway down.
    }
  });

  return {
    server,
    async ready() {
      await adapterRedis.ping();
    },
    publish(organizationId, conversationId, event, payload) {
      server.to(conversationRoom(organizationId, conversationId)).emit(event, payload);
    },
    async drain() {
      // Tell clients to reconnect before closing, so a deploy staggers instead of stampeding.
      server.emit(chatEvents.draining, { reconnectAfterMs: env.CHAT_DRAIN_RECONNECT_MS });
      clearInterval(backpressureTimer);
      clearInterval(revalidationTimer);
      server.disconnectSockets(true);
      revocations.disconnect();
      adapterRedis.disconnect();
      await server.close();
    },
  };
}

async function revalidateConnectedSockets(server: Server): Promise<void> {
  const socketEntries = [...server.sockets.sockets.values()]
    .map((socket) => ({ socket, identity: identities.get(socket) }))
    .filter(
      (entry): entry is { socket: Socket; identity: SocketIdentity } =>
        entry.identity !== undefined,
    );

  for (let offset = 0; offset < socketEntries.length; offset += 500) {
    const batch = socketEntries.slice(offset, offset + 500);
    const sessions = await prisma.session.findMany({
      where: {
        id: { in: [...new Set(batch.map(({ identity }) => identity.sessionId))] },
        revokedAt: null,
        deletedAt: null,
        expiresAt: { gt: new Date() },
        user: { status: 'ACTIVE', deletedAt: null },
      },
      select: {
        id: true,
        userId: true,
        activeOrganizationId: true,
        activeOrganization: { select: { status: true, deletedAt: true } },
      },
    });
    const liveSessions = new Map(sessions.map((session) => [session.id, session]));
    const tenantIdentities = batch.filter(({ identity }) => identity.organizationId !== null);
    const memberships =
      tenantIdentities.length === 0
        ? []
        : await prisma.membership.findMany({
            where: {
              OR: tenantIdentities.map(({ identity }) => ({
                organizationId: identity.organizationId!,
                userId: identity.userId,
              })),
              status: 'ACTIVE',
              deletedAt: null,
            },
            select: { organizationId: true, userId: true },
          });
    const activeMemberships = new Set(
      memberships.map(({ organizationId, userId }) => `${organizationId}:${userId}`),
    );

    for (const { socket, identity } of batch) {
      const session = liveSessions.get(identity.sessionId);
      const organizationValid =
        identity.organizationId === null ||
        (session?.activeOrganizationId === identity.organizationId &&
          session.activeOrganization?.status === 'ACTIVE' &&
          session.activeOrganization.deletedAt === null &&
          activeMemberships.has(`${identity.organizationId}:${identity.userId}`));
      if (
        !session ||
        session.userId !== identity.userId ||
        session.activeOrganizationId !== identity.organizationId ||
        !organizationValid
      ) {
        socket.disconnect(true);
      }
    }
  }
}

/**
 * engine.io exposes the outbound queue but types it private, so it is read through a narrow
 * structural view rather than by widening the socket type.
 */
function bufferedPacketCount(socket: Socket): number {
  const connection = socket.conn as unknown as { writeBuffer?: unknown[] };
  return connection.writeBuffer?.length ?? 0;
}

function errorCode(error: unknown): string {
  if (error && typeof error === 'object' && 'code' in error) {
    const code = (error as { code?: unknown }).code;
    if (typeof code === 'string') return code;
  }
  return 'error';
}

export { listParticipantUserIds };
