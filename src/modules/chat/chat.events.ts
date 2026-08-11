import { z } from 'zod';

/**
 * Wire contract shared by the socket gateway and the REST fallback. Every inbound frame is
 * validated with these schemas — an open socket is an untrusted input surface, exactly like a
 * request body.
 */
export const chatEvents = {
  join: 'conversation:join',
  leave: 'conversation:leave',
  send: 'message:send',
  message: 'message:new',
  markRead: 'conversation:read',
  read: 'conversation:read:update',
  typing: 'conversation:typing',
  draining: 'server:draining',
} as const;

export const MAX_MESSAGE_LENGTH = 4000;

export const joinPayloadSchema = z.object({ conversationId: z.uuid() });

export const sendMessagePayloadSchema = z
  .object({
    conversationId: z.uuid(),
    clientMessageId: z.string().trim().min(8).max(100),
    body: z.string().trim().min(1).max(MAX_MESSAGE_LENGTH).optional(),
    uploadId: z.uuid().optional(),
    type: z.enum(['TEXT', 'ATTACHMENT']).optional(),
  })
  .refine((value) => Boolean(value.body ?? value.uploadId), {
    message: 'a message must have a body or an attachment',
  });

export const markReadPayloadSchema = z.object({
  conversationId: z.uuid(),
  seq: z.coerce.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
});

export const typingPayloadSchema = z.object({
  conversationId: z.uuid(),
  typing: z.boolean(),
});
