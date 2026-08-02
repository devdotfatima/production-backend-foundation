import { access } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import type { Request, Response } from 'express';
import helmet from 'helmet';
import { describe, expect, it, vi } from 'vitest';
import { swaggerHtml, swaggerInitializer } from '../dist/src/modules/docs/docs.routes.js';

function helmetHeaders(): Record<string, string> {
  const headers: Record<string, string> = {};
  const response = {
    setHeader(name: string, value: number | string | readonly string[]) {
      headers[name.toLowerCase()] = Array.isArray(value) ? value.join(', ') : String(value);
      return response;
    },
    removeHeader(name: string) {
      delete headers[name.toLowerCase()];
    },
  } as unknown as Response;
  const next = vi.fn<(error?: unknown) => void>();

  helmet()({} as Request, response, next);

  expect(next).toHaveBeenCalledWith();
  return headers;
}

describe('Swagger UI content security policy', () => {
  it('uses Helmet self-only scripts without external or inline Swagger code', async () => {
    const headers = helmetHeaders();

    expect(headers['content-security-policy']).toContain("script-src 'self'");
    expect(swaggerHtml).not.toContain('unpkg.com');
    expect(swaggerHtml).not.toMatch(/<script(?:\s[^>]*)?>\s*[^<\s]/i);
    expect(swaggerHtml).toContain('src="/docs/assets/swagger-ui-bundle.js"');
    expect(swaggerHtml).toContain('src="/docs/swagger-initializer.js"');
    expect(swaggerInitializer).toContain("url: '/openapi.json'");

    await expect(
      access(fileURLToPath(import.meta.resolve('swagger-ui-dist/swagger-ui-bundle.js'))),
    ).resolves.toBeUndefined();
    await expect(
      access(fileURLToPath(import.meta.resolve('swagger-ui-dist/swagger-ui.css'))),
    ).resolves.toBeUndefined();
  });
});
