import type { RequestHandler } from 'express';
import { sendSuccess } from '#app/lib/api-response.js';
import { getValidated } from '#app/middleware/request-validation.js';
import {
  conversationIdRequestValidation,
  createConversationRequestValidation,
  listMessagesRequestValidation,
  markReadRequestValidation,
  messageIdRequestValidation,
  sendMessageRequestValidation,
} from '#app/modules/chat/chat.schemas.js';
import {
  createConversation,
  deleteMessage,
  listConversations,
  listMessages,
  markRead,
  sendMessage,
  serializeMessage,
} from '#app/modules/chat/chat.service.js';

export const index: RequestHandler = async (request, response) => {
  sendSuccess(request, response, { data: await listConversations(request.auth!.userId) });
};

export const create: RequestHandler = async (request, response) => {
  const { body: input } = getValidated(request, createConversationRequestValidation);
  const conversation = await createConversation(request.auth!.userId, input);
  sendSuccess(request, response, {
    status: 201,
    message: 'Conversation ready',
    data: { ...conversation, lastSeq: Number(conversation.lastSeq) },
  });
};

export const messages: RequestHandler = async (request, response) => {
  const { params, query } = getValidated(request, listMessagesRequestValidation);
  sendSuccess(request, response, {
    data: await listMessages(params.conversationId, request.auth!.userId, query),
  });
};

/**
 * REST fallback for sending. Shares the schema and the idempotency contract with the socket
 * path, so a client that loses its socket can keep sending without duplicating messages.
 */
export const send: RequestHandler = async (request, response) => {
  const { params, body: input } = getValidated(request, sendMessageRequestValidation);
  const { message, duplicate } = await sendMessage(
    params.conversationId,
    request.auth!.userId,
    input,
  );
  response.setHeader('Idempotency-Replayed', String(duplicate));
  sendSuccess(request, response, {
    status: duplicate ? 200 : 201,
    message: duplicate ? 'Message already sent' : 'Message sent',
    data: serializeMessage(message),
  });
};

export const read: RequestHandler = async (request, response) => {
  const { params, body: input } = getValidated(request, markReadRequestValidation);
  sendSuccess(request, response, {
    data: await markRead(params.conversationId, request.auth!.userId, input.seq),
  });
};

export const removeMessage: RequestHandler = async (request, response) => {
  const { params } = getValidated(request, messageIdRequestValidation);
  await deleteMessage(params.messageId, request.auth!.userId);
  sendSuccess(request, response, { message: 'Message deleted' });
};

export const show: RequestHandler = async (request, response) => {
  const { params } = getValidated(request, conversationIdRequestValidation);
  const conversations = await listConversations(request.auth!.userId, 200);
  sendSuccess(request, response, {
    data: conversations.find((conversation) => conversation.id === params.conversationId) ?? null,
  });
};
