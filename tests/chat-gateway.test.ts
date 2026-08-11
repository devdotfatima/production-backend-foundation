import { createServer, type Server as HttpServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  sessionFindFirst: vi.fn(),
  membershipFindFirst: vi.fn(),
  participantFindFirst: vi.fn(),
  verifyAccessToken: vi.fn(),
  enforceRateLimit: vi.fn(),
  sendMessage: vi.fn(),
  markRead: vi.fn(),
}));

vi.mock('#app/config/env.js', () => ({
  env: {
    CHAT_SOCKET_PATH: '/socket.io',
    CHAT_MAX_FRAME_BYTES: 65_536,
    CHAT_PING_INTERVAL_MS: 25_000,
    CHAT_PING_TIMEOUT_MS: 20_000,
    CHAT_MAX_CONNECTIONS_PER_IP: 60,
    CHAT_MAX_MESSAGES_PER_MINUTE: 120,
    CHAT_MAX_WRITE_BUFFER: 512,
    CHAT_DRAIN_RECONNECT_MS: 2_000,
    CORS_ALLOWED_ORIGINS: ['http://localhost:3000'],
    APP_ORIGIN: 'http://localhost:3000',
    QUEUE_PREFIX: 'test',
  },
}));
vi.mock('#app/lib/prisma.js', () => ({
  getConfiguredPoolSize: () => undefined,
  prisma: {
    session: { findFirst: mocks.sessionFindFirst },
    membership: { findFirst: mocks.membershipFindFirst },
    conversationParticipant: { findFirst: mocks.participantFindFirst },
  },
}));
vi.mock('#app/lib/jwt.js', () => ({ verifyAccessToken: mocks.verifyAccessToken }));
vi.mock('#app/observability/logger.js', () => ({
  appLogger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));
vi.mock('#app/lib/rate-limit.js', () => ({ enforceRateLimit: mocks.enforceRateLimit }));
// Swap the Redis-backed adapter for socket.io's in-memory one. Cross-node fanout is the
// adapter's own concern; this test is about handshake authorisation and room routing.
vi.mock('@socket.io/redis-streams-adapter', async () => {
  const { Adapter } = await import('socket.io-adapter');
  return { createAdapter: () => Adapter };
});
vi.mock('#app/lib/redis.js', () => ({
  appRedis: { publish: vi.fn() },
  createRedisConnection: () => ({
    subscribe: vi.fn(async () => undefined),
    on: vi.fn(),
    disconnect: vi.fn(),
  }),
}));
vi.mock('#app/modules/chat/chat.service.js', async () => {
  const actual = await vi.importActual<Record<string, unknown>>(
    '#app/modules/chat/chat.service.js',
  );
  return {
    ...actual,
    requireParticipant: mocks.participantFindFirst,
    sendMessage: mocks.sendMessage,
    markRead: mocks.markRead,
  };
});

import { io as createClient, type Socket as ClientSocket } from 'socket.io-client';
import { createChatGateway } from '#app/modules/chat/chat.gateway.js';

const userId = '00000000-0000-7000-8000-0000000000a1';
const conversationId = '00000000-0000-7000-8000-0000000000c1';
const ORIGIN = 'http://localhost:3000';

interface Ack {
  ok: boolean;
  error?: string;
  duplicate?: boolean;
  message?: { id: string; seq: number };
  lastReadSeq?: number;
}

/** socket.io-client types dynamic events as `any`; narrow once here, not at every call site. */
interface DynamicEvents {
  emitWithAck(event: string, payload: unknown): Promise<unknown>;
  on(event: string, listener: (payload: unknown) => void): void;
}

function events(client: ClientSocket): DynamicEvents {
  return client;
}

async function ack(client: ClientSocket, event: string, payload: unknown): Promise<Ack> {
  return (await events(client).emitWithAck(event, payload)) as Ack;
}

function onEvent(client: ClientSocket, event: string, listener: (payload: unknown) => void): void {
  events(client).on(event, listener);
}

let httpServer: HttpServer;
let gateway: ReturnType<typeof createChatGateway>;
let url: string;
const clients: ClientSocket[] = [];

function connect(options: { token?: string; origin?: string } = {}): Promise<ClientSocket> {
  const client = createClient(url, {
    transports: ['websocket'],
    reconnection: false,
    extraHeaders: { Origin: options.origin ?? ORIGIN },
    auth: { token: options.token ?? 'valid-token' },
  });
  clients.push(client);
  return new Promise((resolve, reject) => {
    client.on('connect', () => {
      resolve(client);
    });
    client.on('connect_error', (error) => {
      reject(error);
    });
  });
}

beforeEach(async () => {
  vi.clearAllMocks();
  mocks.verifyAccessToken.mockResolvedValue({ userId, sessionId: 'session-1' });
  mocks.sessionFindFirst.mockResolvedValue({
    activeOrganizationId: null,
    activeOrganization: null,
  });
  mocks.enforceRateLimit.mockResolvedValue({ count: 1, limit: 60, retryAfterSeconds: 60 });
  mocks.participantFindFirst.mockResolvedValue({ id: 'p1', role: 'MEMBER', lastReadSeq: 0n });

  httpServer = createServer();
  gateway = createChatGateway(httpServer);
  await new Promise<void>((resolve) => httpServer.listen(0, resolve));
  url = `http://localhost:${(httpServer.address() as AddressInfo).port}`;
});

afterEach(async () => {
  for (const client of clients.splice(0)) client.disconnect();
  await gateway.drain();
  await new Promise<void>((resolve) => httpServer.close(() => resolve()));
});

describe('handshake', () => {
  it('accepts a valid token from an allowed origin', async () => {
    await expect(connect()).resolves.toBeDefined();
  });

  it('rejects a connection with no token', async () => {
    mocks.verifyAccessToken.mockRejectedValue(new Error('no token'));
    await expect(connect({ token: '' })).rejects.toThrow(/unauthenticated/);
  });

  it('rejects a token whose session is gone', async () => {
    // A signed token is not enough: logout must actually prevent a new connection.
    mocks.sessionFindFirst.mockResolvedValue(null);
    await expect(connect()).rejects.toThrow(/unauthenticated/);
  });

  it('rejects a disallowed origin', async () => {
    // Browsers do not apply CORS to websockets and send cookies anyway, so this is the CSRF
    // equivalent for the socket transport.
    await expect(connect({ origin: 'https://evil.example' })).rejects.toThrow();
  });

  it('rejects when the membership is no longer active', async () => {
    mocks.sessionFindFirst.mockResolvedValue({
      activeOrganizationId: 'org-1',
      activeOrganization: { status: 'ACTIVE', deletedAt: null },
    });
    mocks.membershipFindFirst.mockResolvedValue(null);

    await expect(connect()).rejects.toThrow(/unauthenticated/);
  });
});

describe('room authorisation', () => {
  it('refuses to join a conversation the caller is not part of', async () => {
    const client = await connect();
    mocks.participantFindFirst.mockRejectedValue(
      Object.assign(new Error('not found'), { code: 'NOT_FOUND' }),
    );

    const result = await ack(client, 'conversation:join', { conversationId });
    expect(result).toMatchObject({ ok: false });
  });

  it('joins when participation is proven', async () => {
    const client = await connect();
    const result = await ack(client, 'conversation:join', { conversationId });
    expect(result).toEqual({ ok: true });
  });

  it('rejects a malformed join payload', async () => {
    const client = await connect();
    const result = await ack(client, 'conversation:join', { conversationId: 'not-a-uuid' });
    expect(result).toMatchObject({ ok: false });
  });
});

describe('sending over the socket', () => {
  it('broadcasts a committed message to other members of the room', async () => {
    mocks.sendMessage.mockResolvedValue({
      message: {
        id: 'm1',
        conversationId,
        senderUserId: userId,
        seq: 1n,
        clientMessageId: 'client-msg-1',
        type: 'TEXT',
        body: 'hello',
        uploadId: null,
        editedAt: null,
        createdAt: new Date(),
        deletedAt: null,
      },
      duplicate: false,
    });

    const sender = await connect();
    const listener = await connect();
    await ack(sender, 'conversation:join', { conversationId });
    await ack(listener, 'conversation:join', { conversationId });

    const delivered = new Promise<unknown>((resolve) => {
      onEvent(listener, 'message:new', resolve);
    });
    const result = await ack(sender, 'message:send', {
      conversationId,
      clientMessageId: 'client-msg-1',
      body: 'hello',
    });

    expect(result).toMatchObject({ ok: true, duplicate: false });
    await expect(delivered).resolves.toMatchObject({ id: 'm1', seq: 1 });
  });

  it('does not rebroadcast a duplicate send', async () => {
    mocks.sendMessage.mockResolvedValue({
      message: {
        id: 'm1',
        conversationId,
        senderUserId: userId,
        seq: 1n,
        clientMessageId: 'client-msg-1',
        type: 'TEXT',
        body: 'hello',
        uploadId: null,
        editedAt: null,
        createdAt: new Date(),
        deletedAt: null,
      },
      duplicate: true,
    });

    const sender = await connect();
    const listener = await connect();
    await ack(sender, 'conversation:join', { conversationId });
    await ack(listener, 'conversation:join', { conversationId });

    let received = 0;
    onEvent(listener, 'message:new', () => {
      received += 1;
    });

    const result = await ack(sender, 'message:send', {
      conversationId,
      clientMessageId: 'client-msg-1',
      body: 'hello',
    });

    expect(result).toMatchObject({ ok: true, duplicate: true });
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(received).toBe(0);
  });

  it('rejects an oversized body without reaching the service', async () => {
    const client = await connect();
    const result = await ack(client, 'message:send', {
      conversationId,
      clientMessageId: 'client-msg-1',
      body: 'x'.repeat(5000),
    });

    expect(result).toMatchObject({ ok: false });
    expect(mocks.sendMessage).not.toHaveBeenCalled();
  });

  it('refuses a send that exceeds the per-conversation rate limit', async () => {
    const client = await connect();
    mocks.enforceRateLimit.mockRejectedValueOnce(
      Object.assign(new Error('limited'), { code: 'RATE_LIMITED' }),
    );

    const result = await ack(client, 'message:send', {
      conversationId,
      clientMessageId: 'client-msg-1',
      body: 'hello',
    });

    expect(result).toMatchObject({ ok: false, error: 'RATE_LIMITED' });
  });
});

describe('typing relay', () => {
  it('ignores typing for a room the socket never joined', async () => {
    // Otherwise a connected user could probe presence in conversations they cannot see.
    const sender = await connect();
    const listener = await connect();
    await ack(listener, 'conversation:join', { conversationId });

    let received = 0;
    onEvent(listener, 'conversation:typing', () => {
      received += 1;
    });

    sender.emit('conversation:typing', { conversationId, typing: true });
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(received).toBe(0);
  });
});
