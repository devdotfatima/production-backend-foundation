import { Router } from 'express';
import { authenticate } from '#app/middleware/access-control.js';
import { ipRateLimit, userIdentityRateLimit } from '#app/middleware/rate-limit.js';
import { validateRequest } from '#app/middleware/request-validation.js';
import {
  create,
  index,
  messages,
  read,
  removeMessage,
  send,
  show,
} from '#app/modules/chat/chat.controller.js';
import {
  conversationIdRequestValidation,
  createConversationRequestValidation,
  listMessagesRequestValidation,
  markReadRequestValidation,
  messageIdRequestValidation,
  sendMessageRequestValidation,
} from '#app/modules/chat/chat.schemas.js';

export const chatRouter = Router();

chatRouter.get('/conversations', authenticate, userIdentityRateLimit, index);
chatRouter.post(
  '/conversations',
  ipRateLimit('chat:conversation:create:ip', 60, 60),
  authenticate,
  userIdentityRateLimit,
  validateRequest(createConversationRequestValidation),
  create,
);
chatRouter.get(
  '/conversations/:conversationId',
  authenticate,
  userIdentityRateLimit,
  validateRequest(conversationIdRequestValidation),
  show,
);
chatRouter.get(
  '/conversations/:conversationId/messages',
  authenticate,
  userIdentityRateLimit,
  validateRequest(listMessagesRequestValidation),
  messages,
);
chatRouter.post(
  '/conversations/:conversationId/messages',
  ipRateLimit('chat:send:ip', 600, 60),
  authenticate,
  userIdentityRateLimit,
  validateRequest(sendMessageRequestValidation),
  send,
);
chatRouter.post(
  '/conversations/:conversationId/read',
  authenticate,
  userIdentityRateLimit,
  validateRequest(markReadRequestValidation),
  read,
);
chatRouter.delete(
  '/messages/:messageId',
  authenticate,
  userIdentityRateLimit,
  validateRequest(messageIdRequestValidation),
  removeMessage,
);
