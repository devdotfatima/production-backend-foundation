import { Prisma } from '@prisma/client';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => {
  const database = {
    conversationParticipant: {
      findFirst: vi.fn(),
      findMany: vi.fn(),
      update: vi.fn(),
    },
    conversation: { update: vi.fn(), create: vi.fn(), findFirst: vi.fn() },
    message: { create: vi.fn(), findFirst: vi.fn(), findMany: vi.fn(), update: vi.fn() },
    upload: { findFirst: vi.fn() },
    user: { count: vi.fn() },
    $queryRaw: vi.fn(),
    $transaction: vi.fn(),
  };
  return { database, organizationId: undefined as string | undefined };
});

vi.mock('#app/lib/prisma.js', () => ({ prisma: mocks.database }));
vi.mock('#app/lib/request-context.js', () => ({
  getRequestContext: () => ({
    kind: 'request',
    requestId: 'req-1',
    organizationId: mocks.organizationId,
  }),
}));

import {
  createConversation,
  listMessages,
  markRead,
  sendMessage,
} from '../dist/src/modules/chat/chat.service.js';

const userId = '00000000-0000-7000-8000-0000000000a1';
const otherId = '00000000-0000-7000-8000-0000000000b2';
const conversationId = '00000000-0000-7000-8000-0000000000c1';

const participant = {
  id: 'p1',
  role: 'MEMBER',
  lastReadSeq: 3n,
  mutedUntil: null,
  conversation: { lastSeq: 20n },
};

beforeEach(() => {
  vi.clearAllMocks();
  mocks.organizationId = undefined;
  mocks.database.$transaction.mockImplementation((fn: (tx: unknown) => unknown) =>
    fn(mocks.database),
  );
});

describe('participant authorization', () => {
  it('treats a non-participant as not-found rather than forbidden', async () => {
    // Returning 403 would confirm the conversation exists to someone who cannot see it.
    mocks.database.conversationParticipant.findFirst.mockResolvedValue(null);

    await expect(
      sendMessage(conversationId, userId, { clientMessageId: 'client-msg-1', body: 'hi' }),
    ).rejects.toMatchObject({ statusCode: 404 });
    expect(mocks.database.$queryRaw).not.toHaveBeenCalled();
  });

  it('guards message reads too, not just writes', async () => {
    mocks.database.conversationParticipant.findFirst.mockResolvedValue(null);
    await expect(listMessages(conversationId, userId, {})).rejects.toMatchObject({
      statusCode: 404,
    });
  });
});

describe('sequence assignment', () => {
  beforeEach(() => {
    mocks.database.conversationParticipant.findFirst.mockResolvedValue(participant);
  });

  it('assigns and inserts the sequence in one atomic database statement', async () => {
    mocks.database.$queryRaw.mockResolvedValue([{ id: 'm1', seq: 7n }]);

    const result = await sendMessage(conversationId, userId, {
      clientMessageId: 'client-msg-1',
      body: 'hi',
    });

    expect(result.message.seq).toBe(7n);
    expect(mocks.database.$queryRaw).toHaveBeenCalledTimes(1);
    expect(mocks.database.$transaction).not.toHaveBeenCalled();
  });

  it('stamps the conversation organization onto the message', async () => {
    mocks.organizationId = 'org-1';
    mocks.database.$queryRaw.mockResolvedValue([{ id: 'm1', seq: 1n }]);

    await sendMessage(conversationId, userId, { clientMessageId: 'client-msg-1', body: 'hi' });

    const query = mocks.database.$queryRaw.mock.calls[0]?.[0] as { values?: unknown[] };
    expect(query.values).toContain('org-1');
  });
});

describe('send idempotency', () => {
  beforeEach(() => {
    mocks.database.conversationParticipant.findFirst.mockResolvedValue(participant);
  });

  it('returns the original message when a send is retried', async () => {
    // Mobile clients retry constantly on flaky networks; without this every subway ride
    // produces duplicate messages.
    mocks.database.$queryRaw.mockRejectedValue(
      new Prisma.PrismaClientKnownRequestError('Unique constraint failed', {
        code: 'P2010',
        clientVersion: 'test',
        meta: { code: '23505' },
      }),
    );
    mocks.database.message.findFirst.mockResolvedValue({ id: 'm1', seq: 4n });

    const result = await sendMessage(conversationId, userId, {
      clientMessageId: 'client-msg-1',
      body: 'hi',
    });

    expect(result.duplicate).toBe(true);
    expect(result.message).toMatchObject({ id: 'm1' });
  });
});

describe('attachments', () => {
  beforeEach(() => {
    mocks.database.conversationParticipant.findFirst.mockResolvedValue(participant);
  });

  it('refuses an attachment that has not finished scanning', async () => {
    // Fanning out an unscanned upload would push malware to every participant.
    mocks.database.upload.findFirst.mockResolvedValue(null);

    await expect(
      sendMessage(conversationId, userId, {
        clientMessageId: 'client-msg-1',
        uploadId: '00000000-0000-7000-8000-0000000000u1',
      }),
    ).rejects.toMatchObject({ statusCode: 400 });
    expect(mocks.database.$queryRaw).not.toHaveBeenCalled();
  });
});

describe('catch-up reads', () => {
  beforeEach(() => {
    mocks.database.conversationParticipant.findFirst.mockResolvedValue(participant);
    mocks.database.message.findMany.mockResolvedValue([{ id: 'm1', seq: 5n }]);
  });

  it('reads forward in ascending order when catching up', async () => {
    await listMessages(conversationId, userId, { afterSeq: 4 });

    const query = mocks.database.message.findMany.mock.calls[0]?.[0] as {
      where: { seq?: { gt?: bigint } };
      orderBy: { seq: string };
    };
    expect(query.where.seq?.gt).toBe(4n);
    expect(query.orderBy.seq).toBe('asc');
  });

  it('reads backward for ordinary history paging', async () => {
    await listMessages(conversationId, userId, {});
    const query = mocks.database.message.findMany.mock.calls[0]?.[0] as {
      orderBy: { seq: string };
    };
    expect(query.orderBy.seq).toBe('desc');
  });

  it('caps the page size regardless of what the client asks for', async () => {
    await listMessages(conversationId, userId, { limit: 5000 });
    const query = mocks.database.message.findMany.mock.calls[0]?.[0] as { take: number };
    expect(query.take).toBe(50);
  });

  it('converts seq to a number so it survives JSON serialization', async () => {
    const [message] = await listMessages(conversationId, userId, {});
    expect(message?.seq).toBe(5);
  });

  it('does not filter tombstones out of history or catch-up reads', async () => {
    await listMessages(conversationId, userId, { afterSeq: 1 });
    const query = mocks.database.message.findMany.mock.calls[0]?.[0] as {
      where: Record<string, unknown>;
    };
    expect(query.where).not.toHaveProperty('deletedAt');
  });
});

describe('read state', () => {
  it('never moves the read marker backwards', async () => {
    // An out-of-order acknowledgement must not resurrect already-read messages.
    mocks.database.conversationParticipant.findFirst.mockResolvedValue(participant);

    await expect(markRead(conversationId, userId, 2)).resolves.toEqual({ lastReadSeq: 3 });
    expect(mocks.database.conversationParticipant.update).not.toHaveBeenCalled();
  });

  it('advances the read marker forwards', async () => {
    mocks.database.conversationParticipant.findFirst.mockResolvedValue(participant);
    mocks.database.conversationParticipant.update.mockResolvedValue({ lastReadSeq: 9n });

    await expect(markRead(conversationId, userId, 9)).resolves.toEqual({ lastReadSeq: 9 });
  });

  it('rejects a read marker ahead of the latest real message', async () => {
    mocks.database.conversationParticipant.findFirst.mockResolvedValue(participant);

    await expect(markRead(conversationId, userId, 21)).rejects.toMatchObject({ statusCode: 400 });
    expect(mocks.database.conversationParticipant.update).not.toHaveBeenCalled();
  });
});

describe('creating conversations', () => {
  it('requires exactly two participants for a direct conversation', async () => {
    await expect(
      createConversation(userId, { type: 'DIRECT', participantUserIds: [otherId, 'third'] }),
    ).rejects.toMatchObject({ statusCode: 400 });
  });

  it('refuses participants outside the active organization', async () => {
    // Otherwise a direct conversation becomes a cross-tenant channel.
    mocks.organizationId = 'org-1';
    mocks.database.user.count.mockResolvedValue(1);

    await expect(
      createConversation(userId, { type: 'DIRECT', participantUserIds: [otherId] }),
    ).rejects.toMatchObject({ statusCode: 400 });

    const query = mocks.database.user.count.mock.calls[0]?.[0] as {
      where: { memberships?: unknown };
    };
    expect(query.where.memberships).toBeDefined();
  });

  it('reuses an existing direct conversation instead of creating a duplicate', async () => {
    mocks.database.user.count.mockResolvedValue(2);
    mocks.database.conversation.findFirst.mockResolvedValue({ id: conversationId, lastSeq: 2n });

    const result = await createConversation(userId, {
      type: 'DIRECT',
      participantUserIds: [otherId],
    });

    expect(result).toMatchObject({ id: conversationId });
    expect(mocks.database.conversation.create).not.toHaveBeenCalled();
  });

  it('returns the unique-key winner when two direct conversations are created concurrently', async () => {
    mocks.database.user.count.mockResolvedValue(2);
    mocks.database.conversation.findFirst
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({ id: conversationId, type: 'DIRECT', lastSeq: 0n });
    mocks.database.conversation.create.mockRejectedValue(
      new Prisma.PrismaClientKnownRequestError('Unique constraint failed', {
        code: 'P2002',
        clientVersion: 'test',
      }),
    );

    await expect(
      createConversation(userId, { type: 'DIRECT', participantUserIds: [otherId] }),
    ).resolves.toMatchObject({ id: conversationId });
  });

  it('rejects a group larger than the participant cap', async () => {
    const many = Array.from({ length: 300 }, (_, index) => `user-${index}`);
    await expect(
      createConversation(userId, { type: 'GROUP', participantUserIds: many }),
    ).rejects.toMatchObject({ statusCode: 400 });
  });
});
