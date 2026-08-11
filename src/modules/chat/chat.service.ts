import { Prisma, type ConversationType } from '@prisma/client';
import { errors } from '#app/lib/errors.js';
import { prisma } from '#app/lib/prisma.js';
import { getRequestContext } from '#app/lib/request-context.js';

export const MAX_PARTICIPANTS = 256;
export const MESSAGE_PAGE_SIZE = 50;

const messageSelect = {
  id: true,
  conversationId: true,
  senderUserId: true,
  seq: true,
  clientMessageId: true,
  type: true,
  body: true,
  uploadId: true,
  editedAt: true,
  createdAt: true,
  deletedAt: true,
} as const;

export type ChatMessage = Prisma.MessageGetPayload<{ select: typeof messageSelect }>;

/** BigInt does not survive JSON.stringify; `seq` crosses the wire as a number. */
export function serializeMessage(message: ChatMessage) {
  if (message.seq > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new Error('Message sequence exceeds the JSON-safe integer range');
  }
  return { ...message, seq: Number(message.seq) };
}

function activeOrganizationId(): string | null {
  const context = getRequestContext();
  return context?.kind === 'request' ? (context.organizationId ?? null) : null;
}

function organizationFilter(): { organizationId: string } | Record<string, never> {
  const organizationId = activeOrganizationId();
  return organizationId ? { organizationId } : {};
}

/**
 * Proves the caller may see a conversation. Every read and write path goes through this — a
 * conversation id alone is never sufficient authorisation.
 */
export async function requireParticipant(conversationId: string, userId: string) {
  const participant = await prisma.conversationParticipant.findFirst({
    where: {
      ...organizationFilter(),
      conversationId,
      userId,
      leftAt: null,
      deletedAt: null,
      conversation: { deletedAt: null },
    },
    select: {
      id: true,
      role: true,
      lastReadSeq: true,
      mutedUntil: true,
      conversation: { select: { lastSeq: true } },
    },
  });
  if (!participant) throw errors.notFound('Conversation not found');
  return participant;
}

export async function listConversations(userId: string, limit = 30) {
  const rows = await prisma.conversationParticipant.findMany({
    where: {
      ...organizationFilter(),
      userId,
      leftAt: null,
      deletedAt: null,
      conversation: { deletedAt: null },
    },
    orderBy: { conversation: { lastMessageAt: 'desc' } },
    take: limit,
    select: {
      lastReadSeq: true,
      conversation: {
        select: {
          id: true,
          type: true,
          title: true,
          lastSeq: true,
          lastMessageAt: true,
          createdAt: true,
        },
      },
    },
  });

  return rows.map((row) => ({
    ...row.conversation,
    lastSeq: Number(row.conversation.lastSeq),
    // Arithmetic rather than a per-message read table.
    unreadCount: Number(
      row.conversation.lastSeq > row.lastReadSeq ? row.conversation.lastSeq - row.lastReadSeq : 0n,
    ),
  }));
}

export async function createConversation(
  userId: string,
  input: { type: ConversationType; participantUserIds: string[]; title?: string },
) {
  const participantIds = [...new Set([userId, ...input.participantUserIds])];
  if (participantIds.length > MAX_PARTICIPANTS) {
    throw errors.badRequest(`A conversation may have at most ${MAX_PARTICIPANTS} participants`);
  }
  if (input.type === 'DIRECT' && participantIds.length !== 2) {
    throw errors.badRequest('A direct conversation must have exactly two participants');
  }

  const organizationId = activeOrganizationId();

  // Everyone in a conversation must be reachable in the caller's tenant; otherwise a direct
  // conversation becomes a cross-tenant channel.
  const reachable = await prisma.user.count({
    where: {
      id: { in: participantIds },
      status: 'ACTIVE',
      deletedAt: null,
      ...(organizationId
        ? { memberships: { some: { organizationId, status: 'ACTIVE', deletedAt: null } } }
        : {}),
    },
  });
  if (reachable !== participantIds.length) {
    throw errors.badRequest('Every participant must be an active member of this organization');
  }

  if (input.type === 'DIRECT') {
    const directKey = directConversationKey(participantIds, organizationId);
    const existing = await findDirectConversation(directKey);
    if (existing) return existing;
  }

  const directKey =
    input.type === 'DIRECT' ? directConversationKey(participantIds, organizationId) : undefined;
  try {
    return await prisma.conversation.create({
      data: {
        type: input.type,
        title: input.title,
        directKey,
        createdByUserId: userId,
        ...(organizationId ? { organizationId } : {}),
        participants: {
          create: participantIds.map((participantId) => ({
            userId: participantId,
            role: participantId === userId ? 'OWNER' : 'MEMBER',
            ...(organizationId ? { organizationId } : {}),
          })),
        },
      },
      select: { id: true, type: true, title: true, lastSeq: true, createdAt: true },
    });
  } catch (error) {
    if (
      directKey &&
      error instanceof Prisma.PrismaClientKnownRequestError &&
      error.code === 'P2002'
    ) {
      const winner = await findDirectConversation(directKey);
      if (winner) return winner;
    }
    throw error;
  }
}

function directConversationKey(participantIds: string[], organizationId: string | null): string {
  return `${organizationId ?? 'global'}:${[...participantIds].sort().join(':')}`;
}

/** Dedupes a direct conversation on its exact tenant + participant pair. */
async function findDirectConversation(directKey: string) {
  return prisma.conversation.findFirst({
    where: {
      directKey,
      type: 'DIRECT',
      deletedAt: null,
    },
    select: { id: true, type: true, title: true, lastSeq: true, createdAt: true },
  });
}

export interface SendMessageInput {
  clientMessageId: string;
  body?: string;
  uploadId?: string;
  type?: 'TEXT' | 'ATTACHMENT';
}

/**
 * Persists a message and assigns its sequence in one atomic database statement.
 *
 * Gap-free per-conversation ordering necessarily serialises writers somewhere. A data-modifying
 * CTE keeps that critical section to one PostgreSQL round trip instead of holding the row lock
 * across an interactive transaction and a second query. A failed/duplicate insert rolls the
 * increment back with the statement, so retries cannot create sequence gaps.
 */
export async function sendMessage(
  conversationId: string,
  userId: string,
  input: SendMessageInput,
): Promise<{ message: ChatMessage; duplicate: boolean }> {
  await requireParticipant(conversationId, userId);

  if (input.uploadId) {
    const upload = await prisma.upload.findFirst({
      where: { id: input.uploadId, userId, status: 'READY', deletedAt: null },
      select: { id: true },
    });
    // An attachment that has not finished scanning must never fan out to other participants.
    if (!upload) throw errors.badRequest('Attachment is not available');
  }

  try {
    const organizationId = activeOrganizationId();
    const tenantPredicate = organizationId
      ? Prisma.sql`AND "organizationId" = CAST(${organizationId} AS UUID)`
      : Prisma.sql`AND "organizationId" IS NULL`;
    const messageType = input.type ?? (input.uploadId ? 'ATTACHMENT' : 'TEXT');
    const inserted = await prisma.$queryRaw<ChatMessage[]>(Prisma.sql`
      WITH next_sequence AS (
        UPDATE "conversations"
        SET
          "lastSeq" = "lastSeq" + 1,
          "lastMessageAt" = NOW(),
          "updatedAt" = NOW()
        WHERE "id" = CAST(${conversationId} AS UUID)
          AND "deletedAt" IS NULL
          ${tenantPredicate}
        RETURNING "id", "organizationId", "lastSeq"
      )
      INSERT INTO "messages" (
        "id",
        "organizationId",
        "conversationId",
        "senderUserId",
        "seq",
        "clientMessageId",
        "type",
        "body",
        "uploadId",
        "createdAt",
        "updatedAt"
      )
      SELECT
        uuid_generate_v7(),
        next_sequence."organizationId",
        next_sequence."id",
        CAST(${userId} AS UUID),
        next_sequence."lastSeq",
        ${input.clientMessageId},
        CAST(${messageType} AS "MessageType"),
        ${input.body ?? null},
        CAST(${input.uploadId ?? null} AS UUID),
        NOW(),
        NOW()
      FROM next_sequence
      RETURNING
        "id",
        "conversationId",
        "senderUserId",
        "seq",
        "clientMessageId",
        "type",
        "body",
        "uploadId",
        "editedAt",
        "createdAt",
        "deletedAt"
    `);
    const message = inserted[0];
    if (!message) throw errors.notFound('Conversation not found');
    return { message, duplicate: false };
  } catch (error) {
    const known = error instanceof Prisma.PrismaClientKnownRequestError ? error : undefined;
    const databaseCode = known?.meta?.code;
    if (known?.code === 'P2002' || (known?.code === 'P2010' && databaseCode === '23505')) {
      // A retry of a send that already succeeded. Return the original rather than a second copy.
      const existing = await prisma.message.findFirst({
        where: {
          ...organizationFilter(),
          conversationId,
          clientMessageId: input.clientMessageId,
        },
        select: messageSelect,
      });
      if (existing) return { message: existing, duplicate: true };
    }
    throw error;
  }
}

/**
 * Catch-up read. A reconnecting client sends its last known `seq` and receives exactly what it
 * missed, which is why the sequence has to be dense.
 */
export async function listMessages(
  conversationId: string,
  userId: string,
  input: { afterSeq?: number; beforeSeq?: number; limit?: number },
) {
  await requireParticipant(conversationId, userId);
  const take = Math.min(input.limit ?? MESSAGE_PAGE_SIZE, MESSAGE_PAGE_SIZE);

  const messages = await prisma.message.findMany({
    where: {
      ...organizationFilter(),
      conversationId,
      ...(input.afterSeq === undefined ? {} : { seq: { gt: BigInt(input.afterSeq) } }),
      ...(input.beforeSeq === undefined ? {} : { seq: { lt: BigInt(input.beforeSeq) } }),
    },
    orderBy: { seq: input.afterSeq === undefined ? 'desc' : 'asc' },
    take,
    select: messageSelect,
  });

  return messages.map(serializeMessage);
}

export async function markRead(conversationId: string, userId: string, seq: number) {
  const participant = await requireParticipant(conversationId, userId);
  const requested = BigInt(seq);
  if (requested > participant.conversation.lastSeq) {
    throw errors.badRequest('Read sequence cannot be ahead of the conversation');
  }
  // Monotonic: an out-of-order acknowledgement must not resurrect unread messages.
  if (requested <= participant.lastReadSeq) {
    return { lastReadSeq: Number(participant.lastReadSeq) };
  }
  const updated = await prisma.conversationParticipant.update({
    where: { id: participant.id, ...organizationFilter() },
    data: { lastReadSeq: requested },
    select: { lastReadSeq: true },
  });
  return { lastReadSeq: Number(updated.lastReadSeq) };
}

export async function deleteMessage(messageId: string, userId: string) {
  const message = await prisma.message.findFirst({
    where: { ...organizationFilter(), id: messageId, deletedAt: null },
    select: { id: true, conversationId: true, senderUserId: true },
  });
  if (!message) throw errors.notFound('Message not found');
  await requireParticipant(message.conversationId, userId);
  if (message.senderUserId !== userId)
    throw errors.forbidden('You can only delete your own messages');

  // Tombstoned rather than removed so the sequence stays dense for catch-up.
  await prisma.message.update({
    where: { id: message.id, ...organizationFilter() },
    data: { deletedAt: new Date(), body: null, uploadId: null },
  });
  return { id: message.id, conversationId: message.conversationId };
}

export async function listParticipantUserIds(conversationId: string): Promise<string[]> {
  const participants = await prisma.conversationParticipant.findMany({
    where: { ...organizationFilter(), conversationId, leftAt: null, deletedAt: null },
    select: { userId: true },
  });
  return participants.map((participant) => participant.userId);
}
