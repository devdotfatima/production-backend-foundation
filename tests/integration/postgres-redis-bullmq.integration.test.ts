import { execFile } from 'node:child_process';
import { createServer, type Server as HttpServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { promisify } from 'node:util';
import { resolve } from 'node:path';
import { PrismaClient } from '@prisma/client';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { RedisContainer, type StartedRedisContainer } from '@testcontainers/redis';
import { Queue, QueueEvents, Worker } from 'bullmq';
import { io as createSocketClient, type Socket as ClientSocket } from 'socket.io-client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { chargeableItemResolver as ChargeableItemResolver } from '../../src/modules/stripe/stripe.chargeable.js';
import type { runIdempotentTransaction as RunIdempotentTransaction } from '../../src/lib/idempotency.js';
import type { sendMessage as SendMessage } from '../../src/modules/chat/chat.service.js';
import type { runWithRequestContext as RunWithRequestContext } from '../../src/lib/request-context.js';
import type { signAccessToken as SignAccessToken } from '../../src/lib/jwt.js';
import type { createChatGateway as CreateChatGateway } from '../../src/modules/chat/chat.gateway.js';
import type { appRedis as AppRedis } from '../../src/lib/redis.js';

const executeFile = promisify(execFile);

describe.sequential('PostgreSQL, Redis, and BullMQ integration', () => {
  let postgres: StartedPostgreSqlContainer;
  let redis: StartedRedisContainer;
  let database: PrismaClient;
  let appDatabase: PrismaClient;
  let chargeableItemResolver: typeof ChargeableItemResolver;
  let runIdempotentTransaction: typeof RunIdempotentTransaction;
  let sendMessage: typeof SendMessage;
  let runWithRequestContext: typeof RunWithRequestContext;
  let signAccessToken: typeof SignAccessToken;
  let createChatGateway: typeof CreateChatGateway;
  let appRedis: typeof AppRedis;

  beforeAll(async () => {
    [postgres, redis] = await Promise.all([
      new PostgreSqlContainer('postgres:16-alpine')
        .withDatabase('backend_template_test')
        .withUsername('test_user')
        .withPassword('test_password')
        .start(),
      // DEBUG RESTART restarts the Redis process without changing Docker's random host port,
      // which lets existing clients prove reconnection against the same production-shaped URL.
      new RedisContainer('redis:7-alpine')
        .withCommand(['redis-server', '--enable-debug-command', 'yes'])
        .start(),
    ]);

    const databaseUrl = `${postgres.getConnectionUri()}?schema=public`;
    process.env.NODE_ENV = 'test';
    process.env.LOG_LEVEL = 'silent';
    process.env.DATABASE_URL = databaseUrl;
    process.env.DIRECT_DATABASE_URL = databaseUrl;
    process.env.REDIS_URL = redis.getConnectionUrl();
    process.env.QUEUE_PREFIX = `integration-${process.pid}`;
    process.env.TENANCY_MODE = 'disabled';
    process.env.DYNAMIC_PRICING_ENABLED = 'true';
    process.env.CHARGE_ALLOWED_CURRENCIES = 'usd';
    process.env.CHARGE_MAX_AMOUNT_BY_CURRENCY = '{"usd":1000000}';
    process.env.CHARGE_MIN_AMOUNT_BY_CURRENCY = '{"usd":50}';
    process.env.CORS_ALLOWED_ORIGINS = 'http://localhost:3000';

    await executeFile(resolve('node_modules/.bin/prisma'), ['migrate', 'deploy'], {
      cwd: resolve('.'),
      env: { ...process.env, DATABASE_URL: databaseUrl, DIRECT_DATABASE_URL: databaseUrl },
      timeout: 120_000,
    });

    database = new PrismaClient({ datasourceUrl: databaseUrl });
    const prismaModule = await import('../../dist/src/lib/prisma.js');
    appDatabase = prismaModule.prisma;
    ({ chargeableItemResolver } =
      await import('../../dist/src/modules/stripe/stripe.chargeable.js'));
    ({ runIdempotentTransaction } = await import('../../dist/src/lib/idempotency.js'));
    ({ sendMessage } = await import('../../dist/src/modules/chat/chat.service.js'));
    ({ runWithRequestContext } = await import('../../dist/src/lib/request-context.js'));
    ({ signAccessToken } = await import('../../dist/src/lib/jwt.js'));
    ({ createChatGateway } = await import('../../dist/src/modules/chat/chat.gateway.js'));
    ({ appRedis } = await import('../../dist/src/lib/redis.js'));
  }, 180_000);

  afterAll(async () => {
    if (appRedis?.status === 'wait') appRedis.disconnect();
    else await appRedis?.quit();
    await appDatabase?.$disconnect();
    await database?.$disconnect();
    await Promise.all([postgres?.stop(), redis?.stop()]);
  }, 60_000);

  it('deploys every migration and enforces global versus organization role grants', async () => {
    const user = await database.user.create({
      data: { email: 'role-scope@example.test', status: 'ACTIVE' },
    });
    const organization = await database.organization.create({
      data: { slug: 'role-scope', name: 'Role Scope' },
    });
    const organizationRole = await database.role.create({
      data: { organizationId: organization.id, name: 'member' },
    });

    await expect(
      database.userRole.create({ data: { userId: user.id, roleId: organizationRole.id } }),
    ).rejects.toThrow(/user_roles may reference only global roles/);

    const globalRole = await database.role.create({ data: { name: 'global-support' } });
    await expect(
      database.userRole.create({ data: { userId: user.id, roleId: globalRole.id } }),
    ).resolves.toMatchObject({ roleId: globalRole.id });
  });

  it('allows tenant-local charge references while preserving uniqueness per tenant', async () => {
    const [left, right] = await Promise.all([
      database.organization.create({ data: { slug: 'left', name: 'Left' } }),
      database.organization.create({ data: { slug: 'right', name: 'Right' } }),
    ]);

    await Promise.all([
      database.chargeableItem.create({
        data: {
          organizationId: left.id,
          reference: 'invoice-100',
          amount: 500,
          currency: 'usd',
          description: 'Left invoice',
        },
      }),
      database.chargeableItem.create({
        data: {
          organizationId: right.id,
          reference: 'invoice-100',
          amount: 500,
          currency: 'usd',
          description: 'Right invoice',
        },
      }),
    ]);

    await expect(
      database.chargeableItem.create({
        data: {
          organizationId: left.id,
          reference: 'invoice-100',
          amount: 500,
          currency: 'usd',
          description: 'Duplicate left invoice',
        },
      }),
    ).rejects.toMatchObject({ code: 'P2002' });
  });

  it('atomically reserves and consumes one chargeable item under concurrent callers', async () => {
    const item = await database.chargeableItem.create({
      data: {
        reference: 'race-invoice',
        amount: 2500,
        currency: 'usd',
        description: 'Concurrent invoice',
      },
    });

    const attempts = await Promise.allSettled([
      chargeableItemResolver.reserve!('race-invoice', {
        userId: '00000000-0000-4000-8000-000000000001',
        reservationKeyHash: 'reservation-a',
      }),
      chargeableItemResolver.reserve!('race-invoice', {
        userId: '00000000-0000-4000-8000-000000000001',
        reservationKeyHash: 'reservation-b',
      }),
    ]);
    expect(attempts.filter((attempt) => attempt.status === 'fulfilled')).toHaveLength(1);
    expect(attempts.filter((attempt) => attempt.status === 'rejected')).toHaveLength(1);

    const winner = attempts.find(
      (
        attempt,
      ): attempt is PromiseFulfilledResult<
        Awaited<ReturnType<NonNullable<typeof chargeableItemResolver.reserve>>>
      > => attempt.status === 'fulfilled',
    )!.value;
    await chargeableItemResolver.recordPaymentIntent!(winner, 'pi_integration_1', true);

    const consumed = await database.chargeableItem.findUnique({ where: { id: item.id } });
    expect(consumed).toMatchObject({
      status: 'CONSUMED',
      paymentIntentId: 'pi_integration_1',
    });
    expect(consumed?.consumedAt).toBeInstanceOf(Date);
  });

  it('commits a database mutation and idempotency replay record atomically', async () => {
    const user = await database.user.create({
      data: { email: 'atomic-idempotency@example.test', status: 'ACTIVE' },
    });
    const input = {
      actorKey: `user:${user.id}`,
      scope: 'integration.permission-epoch.increment',
      key: 'same-logical-operation',
      request: { userId: user.id },
      operation: async (
        tx: Parameters<typeof runIdempotentTransaction>[0]['operation'] extends (
          tx: infer T,
        ) => unknown
          ? T
          : never,
      ) => {
        const updated = await tx.user.update({
          where: { id: user.id },
          data: { permissionEpoch: { increment: 1 } },
          select: { permissionEpoch: true },
        });
        return { statusCode: 200, response: updated };
      },
    };

    const [first, second] = await Promise.all([
      runIdempotentTransaction(input),
      runIdempotentTransaction(input),
    ]);
    expect(first.response).toEqual(second.response);
    expect([first.replayed, second.replayed].sort()).toEqual([false, true]);
    await expect(database.user.findUnique({ where: { id: user.id } })).resolves.toMatchObject({
      permissionEpoch: 1,
    });
  });

  it('runs BullMQ against Redis and deduplicates the same job id', async () => {
    const connection = { host: redis.getHost(), port: redis.getPort() };
    const queueName = `integration-queue-${process.pid}`;
    const prefix = `integration-bullmq-${process.pid}`;
    const queue = new Queue(queueName, { connection, prefix });
    const events = new QueueEvents(queueName, { connection, prefix });
    let executions = 0;
    const worker = new Worker(
      queueName,
      async () => {
        executions += 1;
        return { delivered: true };
      },
      { connection, prefix },
    );

    try {
      await Promise.all([worker.waitUntilReady(), events.waitUntilReady()]);
      const first = await queue.add('delivery', {}, { jobId: 'stable-delivery-id' });
      const duplicate = await queue.add('delivery', {}, { jobId: 'stable-delivery-id' });
      await Promise.all([first.waitUntilFinished(events), duplicate.waitUntilFinished(events)]);
      expect(executions).toBe(1);
      expect(await first.getState()).toBe('completed');
    } finally {
      await worker.close();
      await events.close();
      await queue.close();
    }
  });

  it('assigns a dense sequence under genuinely concurrent chat sends', async () => {
    const user = await database.user.create({
      data: { email: 'concurrent-chat@example.test', status: 'ACTIVE' },
    });
    const conversation = await database.conversation.create({
      data: {
        type: 'GROUP',
        createdByUserId: user.id,
        participants: { create: { userId: user.id, role: 'OWNER' } },
      },
    });

    const results = await Promise.all(
      Array.from({ length: 32 }, (_, index) =>
        runWithRequestContext(
          {
            kind: 'request',
            requestId: `integration-chat-${index}`,
            userId: user.id,
          },
          () =>
            sendMessage(conversation.id, user.id, {
              clientMessageId: `concurrent-${index}`,
              body: `message ${index}`,
            }),
        ),
      ),
    );

    expect(results.map(({ message }) => Number(message.seq)).sort((a, b) => a - b)).toEqual(
      Array.from({ length: 32 }, (_, index) => index + 1),
    );
    await expect(
      database.conversation.findUnique({ where: { id: conversation.id } }),
    ).resolves.toMatchObject({ lastSeq: 32n });
  });

  it('broadcasts across chat nodes before and after a Redis restart', async () => {
    const user = await database.user.create({
      data: { email: 'multi-node-chat@example.test', status: 'ACTIVE' },
    });
    const session = await database.session.create({
      data: { userId: user.id, expiresAt: new Date(Date.now() + 60 * 60_000) },
    });
    const conversation = await database.conversation.create({
      data: {
        type: 'GROUP',
        createdByUserId: user.id,
        participants: { create: { userId: user.id, role: 'OWNER' } },
      },
    });
    const token = await signAccessToken({ userId: user.id, sessionId: session.id });
    const firstHttp = createServer();
    const secondHttp = createServer();
    const firstGateway = createChatGateway(firstHttp);
    const secondGateway = createChatGateway(secondHttp);
    const clients: ClientSocket[] = [];

    const listen = (server: HttpServer) =>
      new Promise<void>((resolveListen) => server.listen(0, '127.0.0.1', resolveListen));
    const closeHttp = (server: HttpServer) =>
      server.listening
        ? new Promise<void>((resolveClose) => server.close(() => resolveClose()))
        : Promise.resolve();
    const connect = async (server: HttpServer): Promise<ClientSocket> => {
      const port = (server.address() as AddressInfo).port;
      const client = createSocketClient(`http://127.0.0.1:${port}`, {
        transports: ['websocket'],
        reconnection: false,
        timeout: 5_000,
        extraHeaders: { Origin: 'http://localhost:3000' },
        auth: { token },
      });
      clients.push(client);
      await new Promise<void>((resolveConnect, rejectConnect) => {
        client.once('connect', resolveConnect);
        client.once('connect_error', rejectConnect);
      });
      const joined = (await client.timeout(5_000).emitWithAck('conversation:join', {
        conversationId: conversation.id,
      })) as { ok?: boolean };
      expect(joined.ok).toBe(true);
      return client;
    };
    const expectCrossNodeBroadcast = (listener: ClientSocket, marker: string): Promise<void> =>
      new Promise((resolveBroadcast, rejectBroadcast) => {
        const event = 'integration:cross-node';
        const handler = (payload: { marker?: string }) => {
          if (payload.marker !== marker) return;
          clearInterval(retry);
          clearTimeout(timeout);
          listener.off(event, handler);
          resolveBroadcast();
        };
        listener.on(event, handler);
        const publish = () => firstGateway.publish(null, conversation.id, event, { marker });
        const retry = setInterval(publish, 200);
        const timeout = setTimeout(() => {
          clearInterval(retry);
          listener.off(event, handler);
          rejectBroadcast(new Error(`Cross-node broadcast ${marker} timed out`));
        }, 10_000);
        publish();
      });

    try {
      await Promise.all([listen(firstHttp), listen(secondHttp)]);
      await connect(firstHttp);
      const listener = await connect(secondHttp);
      await Promise.all([firstGateway.ready(), secondGateway.ready()]);

      await expect(expectCrossNodeBroadcast(listener, 'before-restart')).resolves.toBeUndefined();
      await redis.exec(['redis-cli', 'DEBUG', 'RESTART', 'NOSAVE']).catch(() => undefined);
      await Promise.all([firstGateway.ready(), secondGateway.ready()]);
      await expect(expectCrossNodeBroadcast(listener, 'after-restart')).resolves.toBeUndefined();
    } finally {
      for (const client of clients) client.disconnect();
      await Promise.allSettled([firstGateway.drain(), secondGateway.drain()]);
      await Promise.all([closeHttp(firstHttp), closeHttp(secondHttp)]);
    }
  }, 60_000);
});
