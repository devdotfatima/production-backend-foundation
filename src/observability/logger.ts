import { randomUUID } from 'node:crypto';
import type { Options } from 'pino-http';
import pino from 'pino';
import { env } from '#app/config/env.js';

const redactPaths = [
  'req.headers.authorization',
  'req.headers.cookie',
  'req.headers.idempotency-key',
  'req.body.password',
  'req.body.newPassword',
  'req.body.code',
  'req.body.token',
  'req.body.resetToken',
  'res.headers.set-cookie',
  '*.passwordHash',
  '*.tokenHash',
  '*.resetToken',
  '*.codeHash',
];

export const appLogger = pino(
  {
    level: env.LOG_LEVEL,
    redact: { paths: redactPaths, censor: '[REDACTED]' },
  },
  env.NODE_ENV === 'development'
    ? pino.transport({
        target: 'pino-pretty',
        options: { colorize: true, translateTime: 'SYS:standard', singleLine: true },
      })
    : undefined,
);

export const loggerOptions: Options = {
  logger: appLogger,
  level: env.LOG_LEVEL,
  redact: {
    paths: redactPaths,
    censor: '[REDACTED]',
  },
  genReqId(request, response) {
    const incoming = request.headers['x-request-id'];
    const id = typeof incoming === 'string' ? incoming : randomUUID();
    response.setHeader('x-request-id', id);
    return id;
  },
};
