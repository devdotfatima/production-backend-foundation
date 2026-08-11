import { z } from 'zod';

/**
 * Every template's variables must be a flat string record: the interpolator does not support
 * nested paths, and keeping it that way is what makes it dependency-free.
 */
export interface EmailTemplateDefinition<Variables extends Record<string, string>> {
  schema: z.ZodType<Variables>;
  /** Non-transactional templates get List-Unsubscribe headers; see email-transport.ts. */
  transactional: boolean;
  /** Used by the dev preview route and the snapshot tests -- one fixture, two consumers. */
  example: Variables;
}

function defineTemplate<Variables extends Record<string, string>>(
  definition: EmailTemplateDefinition<Variables>,
): EmailTemplateDefinition<Variables> {
  return definition;
}

const otpVariables = z.object({
  code: z.string().min(1),
  expiresInMinutes: z.string().min(1),
});

const noVariables = z.object({});
const invitationVariables = z.object({
  organizationName: z.string().min(1),
  actionUrl: z.string().url(),
  expiresInDays: z.string().min(1),
});
const announcementVariables = z.object({
  headline: z.string().min(1),
  message: z.string().min(1),
  actionUrl: z.string().url(),
});

/**
 * Adding a template: create `{key}/en/{subject.txt,body.txt,body.html}`, add one entry below with
 * its payload schema and example, then reference the key from the caller. Nothing else changes.
 */
export const emailTemplates = {
  'auth-verification-otp': defineTemplate({
    schema: otpVariables,
    transactional: true,
    example: { code: '482913', expiresInMinutes: '5' },
  }),
  'auth-password-reset-otp': defineTemplate({
    schema: otpVariables,
    transactional: true,
    example: { code: '719204', expiresInMinutes: '5' },
  }),
  'auth-signup-existing': defineTemplate({
    schema: noVariables,
    transactional: true,
    example: {},
  }),
  'organization-invitation': defineTemplate({
    schema: invitationVariables,
    transactional: true,
    example: {
      organizationName: 'Acme, Inc.',
      actionUrl: 'https://app.example.com/invitations/accept?token=example',
      expiresInDays: '7',
    },
  }),
  'product-announcement': defineTemplate({
    schema: announcementVariables,
    transactional: false,
    example: {
      headline: 'A faster workspace is here',
      message: 'We improved search and made large projects load more quickly.',
      actionUrl: 'https://app.example.com/updates',
    },
  }),
} satisfies Record<string, EmailTemplateDefinition<Record<string, string>>>;

export type EmailTemplateKey = keyof typeof emailTemplates;
