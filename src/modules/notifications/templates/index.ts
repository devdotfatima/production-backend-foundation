import type { z } from 'zod';
import { availableLocales, loadTemplateFiles } from '#app/modules/notifications/templates/files.js';
import { interpolate, textToHtml } from '#app/modules/notifications/templates/interpolate.js';
import { resolveLocale } from '#app/modules/notifications/templates/locale.js';
import {
  emailTemplates,
  type EmailTemplateKey,
} from '#app/modules/notifications/templates/registry.js';

export {
  emailTemplates,
  type EmailTemplateKey,
} from '#app/modules/notifications/templates/registry.js';

export interface RenderedEmail {
  subject: string;
  text: string;
  html: string;
  transactional: boolean;
}

/**
 * Renders one template. The variables type is inferred from the template's own Zod schema, so a
 * caller passing the wrong shape fails to compile; a template referencing a variable the caller
 * never supplies fails at render time (see interpolate.ts). Either way, template and caller
 * cannot silently drift apart.
 */
export function renderEmailTemplate<K extends EmailTemplateKey>(
  key: K,
  variables: z.infer<(typeof emailTemplates)[K]['schema']>,
  locale?: string,
): RenderedEmail {
  const definition = emailTemplates[key];
  const parsed = definition.schema.parse(variables);
  const resolvedLocale = resolveLocale(locale, availableLocales(key));
  const files = loadTemplateFiles(key, resolvedLocale);

  return {
    subject: interpolate(files.subject, parsed),
    text: interpolate(files.text, parsed),
    html: interpolate(files.html ?? textToHtml(files.text), parsed, { escape: true }),
    transactional: definition.transactional,
  };
}

export function listEmailTemplateKeys(): EmailTemplateKey[] {
  return Object.keys(emailTemplates) as EmailTemplateKey[];
}
