import type { Request, Response } from 'express';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  getOrganization: vi.fn(),
  listMembers: vi.fn(),
  changeMemberRole: vi.fn(),
  removeMember: vi.fn(),
  createInvitation: vi.fn(),
  updateOrganization: vi.fn(),
  revokeInvitation: vi.fn(),
  sendSuccess: vi.fn(),
}));

vi.mock('#app/modules/organizations/organizations.service.js', () => ({
  getOrganization: mocks.getOrganization,
  listMembers: mocks.listMembers,
  changeMemberRole: mocks.changeMemberRole,
  removeMember: mocks.removeMember,
  createInvitation: mocks.createInvitation,
  updateOrganization: mocks.updateOrganization,
  revokeInvitation: mocks.revokeInvitation,
  listMyOrganizations: vi.fn(),
  createOrganization: vi.fn(),
  switchOrganization: vi.fn(),
  acceptInvitation: vi.fn(),
}));
vi.mock('#app/lib/api-response.js', () => ({ sendSuccess: mocks.sendSuccess }));
vi.mock('#app/lib/request-metadata.js', () => ({
  requestMetadata: () => ({ ip: '203.0.113.7', userAgent: 'test', requestId: 'req-1' }),
}));

import {
  changeRole,
  invite,
  members,
  removeMemberHandler,
  revokeInvite,
  show,
  update,
} from '../dist/src/modules/organizations/organizations.controller.js';

const activeOrg = '00000000-0000-7000-8000-00000000000a';
const otherOrg = '00000000-0000-7000-8000-00000000000b';
const userId = '00000000-0000-7000-8000-0000000000b2';
const roleId = '00000000-0000-7000-8000-0000000000r1';
const invitationId = '00000000-0000-7000-8000-0000000000i1';

function buildRequest(pathOrganizationId: string, activeOrganizationId?: string): Request {
  return {
    auth: { userId: '00000000-0000-7000-8000-0000000000a1', sessionId: 'session-1' },
    organizationId: activeOrganizationId,
    validated: {
      params: { organizationId: pathOrganizationId, userId, invitationId },
      body: { roleId, email: 'a@b.com', name: 'Renamed' },
      query: { limit: 25 },
    },
  } as unknown as Request;
}

const handlers: [string, (request: Request, response: Response) => Promise<void>][] = [
  ['show', show as never],
  ['update', update as never],
  ['members', members as never],
  ['changeRole', changeRole as never],
  ['removeMember', removeMemberHandler as never],
  ['invite', invite as never],
  ['revokeInvite', revokeInvite as never],
];

describe('organization path-parameter scope guard', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it.each(handlers)(
    '%s refuses a path organization that is not the active one',
    async (_name, handler) => {
      // The permission guard proves what the caller may do in their *active* organization; it
      // says nothing about the organization named in the path. Without this check, any member of
      // any organization could manage any other by changing the URL.
      await expect(
        handler(buildRequest(otherOrg, activeOrg), {} as Response),
      ).rejects.toMatchObject({ statusCode: 403 });
      expect(mocks.sendSuccess).not.toHaveBeenCalled();
    },
  );

  it.each(handlers)('%s refuses when no organization is active at all', async (_name, handler) => {
    await expect(handler(buildRequest(activeOrg, undefined), {} as Response)).rejects.toMatchObject(
      { statusCode: 403 },
    );
  });

  it('permits the handler when the path matches the active organization', async () => {
    mocks.getOrganization.mockResolvedValue({ id: activeOrg });

    await show(buildRequest(activeOrg, activeOrg), {} as Response, vi.fn());

    expect(mocks.getOrganization).toHaveBeenCalledWith(activeOrg);
    expect(mocks.sendSuccess).toHaveBeenCalled();
  });

  it('passes the path organization through to member mutations once in scope', async () => {
    mocks.changeMemberRole.mockResolvedValue({ id: 'membership-1' });

    await changeRole(buildRequest(activeOrg, activeOrg), {} as Response, vi.fn());

    expect(mocks.changeMemberRole).toHaveBeenCalledWith(
      activeOrg,
      userId,
      roleId,
      expect.any(String),
      expect.any(Object),
    );
  });
});
