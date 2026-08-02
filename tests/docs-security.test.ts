import { describe, expect, it } from 'vitest';
import { openApiDocument } from '../dist/src/modules/docs/docs.document.js';

describe('OpenAPI route and browser security coverage', () => {
  it('documents all previously omitted administrative and identity routes', () => {
    for (const path of [
      '/api/v1/auth/otp/send',
      '/api/v1/auth/otp/verify',
      '/api/v1/auth/phone/send-verification',
      '/api/v1/users',
      '/api/v1/users/{id}',
      '/api/v1/roles',
      '/api/v1/roles/assignments',
      '/api/v1/audit-events',
      '/api/v1/outbox-events/dead-letter',
      '/api/v1/outbox-events/{id}/redrive',
      '/api/v1/uploads',
    ]) {
      expect(openApiDocument.paths).toHaveProperty(path);
    }
  });

  it('requires only authentication on safe GETs and CSRF on mutations', () => {
    expect(openApiDocument.paths['/api/v1/users/me'].get.security).toEqual([{ cookieAuth: [] }]);
    expect(openApiDocument.paths['/api/v1/users/me'].patch.security).toEqual([
      { cookieAuth: [], csrfToken: [] },
    ]);
    expect(openApiDocument.paths['/api/v1/auth/login'].post.security).toEqual([{ csrfToken: [] }]);
  });

  it('describes the secure production cookie name', () => {
    expect(openApiDocument.components.securitySchemes.cookieAuth.description).toContain(
      '__Host-access_token',
    );
  });
});
