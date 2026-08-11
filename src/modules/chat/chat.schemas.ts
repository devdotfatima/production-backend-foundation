import { z } from 'zod';
import { MAX_MESSAGE_LENGTH } from '#app/modules/chat/chat.events.js';

export const conversationIdParams = z.object({ conversationId: z.uuid() });
export const messageIdParams = z.object({ messageId: z.uuid() });

export const createConversationSchema = z.object({
  type: z.enum(['DIRECT', 'GROUP', 'SUPPORT']),
  participantUserIds: z.array(z.uuid()).min(1).max(255),
  title: z.string().trim().min(1).max(200).optional(),
});

/** Mirrors the socket payload so both transports accept exactly the same message. */
export const sendMessageSchema = z
  .object({
    clientMessageId: z.string().trim().min(8).max(100),
    body: z.string().trim().min(1).max(MAX_MESSAGE_LENGTH).optional(),
    uploadId: z.uuid().optional(),
    type: z.enum(['TEXT', 'ATTACHMENT']).optional(),
  })
  .refine((value) => Boolean(value.body ?? value.uploadId), {
    message: 'a message must have a body or an attachment',
  });

export const listMessagesQuery = z.object({
  afterSeq: z.coerce.number().int().min(0).max(Number.MAX_SAFE_INTEGER).optional(),
  beforeSeq: z.coerce.number().int().min(1).max(Number.MAX_SAFE_INTEGER).optional(),
  limit: z.coerce.number().int().min(1).max(50).optional(),
});

export const markReadSchema = z.object({
  seq: z.coerce.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
});

export const createConversationRequestValidation = { body: createConversationSchema } as const;
export const conversationIdRequestValidation = { params: conversationIdParams } as const;
export const sendMessageRequestValidation = {
  params: conversationIdParams,
  body: sendMessageSchema,
} as const;
export const listMessagesRequestValidation = {
  params: conversationIdParams,
  query: listMessagesQuery,
} as const;
export const markReadRequestValidation = {
  params: conversationIdParams,
  body: markReadSchema,
} as const;
export const messageIdRequestValidation = { params: messageIdParams } as const;
