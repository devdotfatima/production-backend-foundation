import { z } from 'zod';

const slug = z
  .string()
  .trim()
  .min(2)
  .max(64)
  .regex(/^[a-z0-9][a-z0-9-]*$/, 'must be lowercase alphanumeric with hyphens');

export const organizationIdParams = z.object({ organizationId: z.uuid() });

export const createOrganizationSchema = z.object({
  name: z.string().trim().min(2).max(120),
  slug: slug.optional(),
});

export const updateOrganizationSchema = z
  .object({
    name: z.string().trim().min(2).max(120).optional(),
    settings: z.record(z.string(), z.unknown()).optional(),
  })
  .refine((value) => Object.keys(value).length > 0, 'at least one field is required');

export const memberParams = organizationIdParams.extend({ userId: z.uuid() });
export const changeMemberRoleSchema = z.object({ roleId: z.uuid() });

export const createInvitationSchema = z.object({
  email: z.email().max(320),
  roleId: z.uuid(),
});

export const acceptInvitationSchema = z.object({ token: z.string().min(16).max(200) });

export const listQuery = z.object({
  cursor: z.string().max(200).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(25),
});

export const createOrganizationRequestValidation = { body: createOrganizationSchema } as const;
export const organizationIdRequestValidation = { params: organizationIdParams } as const;
export const updateOrganizationRequestValidation = {
  params: organizationIdParams,
  body: updateOrganizationSchema,
} as const;
export const listMembersRequestValidation = {
  params: organizationIdParams,
  query: listQuery,
} as const;
export const changeMemberRoleRequestValidation = {
  params: memberParams,
  body: changeMemberRoleSchema,
} as const;
export const removeMemberRequestValidation = { params: memberParams } as const;
export const createInvitationRequestValidation = {
  params: organizationIdParams,
  body: createInvitationSchema,
} as const;
export const revokeInvitationRequestValidation = {
  params: organizationIdParams.extend({ invitationId: z.uuid() }),
} as const;
export const acceptInvitationRequestValidation = { body: acceptInvitationSchema } as const;
