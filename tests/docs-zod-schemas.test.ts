import { describe, expect, it } from 'vitest';
import { openApiDocument } from '../dist/src/modules/docs/docs.document.js';

describe('Zod-derived OpenAPI components', () => {
  it('keeps route-validation constraints in the published document', () => {
    const schemas = JSON.stringify(openApiDocument.components.schemas);

    expect(schemas).toContain('SignupRequest');
    expect(schemas).toContain('"minLength":12');
    expect(schemas).toContain('"maxLength":4096');
    expect(schemas).toContain('"maximum":100');
  });

  it('embeds schemas as OpenAPI components without nested dialect declarations', () => {
    for (const schema of Object.values(openApiDocument.components.schemas)) {
      expect(schema).not.toHaveProperty('$schema');
    }
  });
});
