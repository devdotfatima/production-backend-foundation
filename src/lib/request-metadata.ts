import type { Request } from 'express';

export interface RequestMetadata {
  ip: string;
  userAgent: string | undefined;
  requestId: string;
}

export function requestMetadata(request: Request): RequestMetadata {
  const requestId =
    typeof request.id === 'string'
      ? request.id
      : typeof request.id === 'number'
        ? request.id.toString()
        : 'unknown';
  return {
    ip: request.ip ?? request.socket.remoteAddress ?? 'unknown',
    userAgent: request.get('user-agent'),
    requestId,
  };
}
