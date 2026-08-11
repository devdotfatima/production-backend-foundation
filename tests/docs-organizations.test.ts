import { describe, expect, it } from 'vitest';
import { openApiDocument } from '../dist/src/modules/docs/docs.document.js';

const organizationPaths = [
  '/api/v1/organizations',
  '/api/v1/organizations/{organizationId}',
  '/api/v1/organizations/{organizationId}/switch',
  '/api/v1/organizations/{organizationId}/members',
  '/api/v1/organizations/{organizationId}/members/{userId}',
  '/api/v1/organizations/{organizationId}/invitations',
  '/api/v1/organizations/{organizationId}/invitations/{invitationId}',
  '/api/v1/organizations/invitations/accept',
];

function collectRefs(value: unknown, found: string[] = []): string[] {
  if (Array.isArray(value)) {
    for (const entry of value) collectRefs(entry, found);
    return found;
  }
  if (!value || typeof value !== 'object') return found;

  for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
    if (key === '$ref' && typeof entry === 'string') found.push(entry);
    else collectRefs(entry, found);
  }
  return found;
}

function resolve(document: unknown, ref: string): unknown {
  return ref
    .replace(/^#\//, '')
    .split('/')
    .reduce<unknown>(
      (node, segment) =>
        node && typeof node === 'object' ? (node as Record<string, unknown>)[segment] : undefined,
      document,
    );
}

describe('organizations module documentation', () => {
  it('publishes every organization route', () => {
    for (const path of organizationPaths) {
      expect(openApiDocument.paths).toHaveProperty(path);
    }
  });

  it('declares the Organizations tag', () => {
    expect(openApiDocument.tags.map((tag) => tag.name)).toContain('Organizations');
  });

  it('publishes the request schemas derived from the route validators', () => {
    for (const schema of [
      'CreateOrganizationRequest',
      'UpdateOrganizationRequest',
      'ChangeMemberRoleRequest',
      'CreateInvitationRequest',
      'AcceptInvitationRequest',
    ]) {
      expect(openApiDocument.components.schemas).toHaveProperty(schema);
    }
  });

  it('marks every mutation as requiring CSRF alongside the session', () => {
    const mutations = [
      ['/api/v1/organizations', 'post'],
      ['/api/v1/organizations/{organizationId}', 'patch'],
      ['/api/v1/organizations/{organizationId}/switch', 'post'],
      ['/api/v1/organizations/{organizationId}/members/{userId}', 'patch'],
      ['/api/v1/organizations/{organizationId}/members/{userId}', 'delete'],
      ['/api/v1/organizations/{organizationId}/invitations', 'post'],
    ] as const;

    for (const [path, method] of mutations) {
      const paths = openApiDocument.paths as Record<string, Record<string, unknown>>;
      const operation = paths[path]?.[method] as { security?: unknown[] } | undefined;
      expect(JSON.stringify(operation?.security)).toContain('csrfToken');
    }
  });
});

describe('document integrity', () => {
  it('resolves every $ref in the document', () => {
    // A dangling $ref renders as an empty box in Swagger UI rather than failing loudly, so the
    // only place this gets caught is here.
    const refs = [...new Set(collectRefs(openApiDocument))];
    expect(refs.length).toBeGreaterThan(0);

    const dangling = refs.filter((ref) => resolve(openApiDocument, ref) === undefined);
    expect(dangling).toEqual([]);
  });
});
