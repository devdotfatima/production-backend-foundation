import { describe, expect, it } from 'vitest';
import {
  emailTemplates,
  listEmailTemplateKeys,
  renderEmailTemplate,
} from '../dist/src/modules/notifications/templates/index.js';
import {
  escapeHtml,
  interpolate,
  textToHtml,
} from '../dist/src/modules/notifications/templates/interpolate.js';
import { resolveLocale } from '../dist/src/modules/notifications/templates/locale.js';

describe('email template rendering', () => {
  it.each(listEmailTemplateKeys())('renders %s from its example payload', (key) => {
    const rendered = renderEmailTemplate(key, emailTemplates[key].example);
    expect({
      subject: rendered.subject,
      text: rendered.text,
      html: rendered.html,
      transactional: rendered.transactional,
    }).toMatchSnapshot();
  });

  it('escapes HTML-significant characters in interpolated values but not in surrounding markup', () => {
    const rendered = renderEmailTemplate('auth-verification-otp', {
      code: '<script>alert(1)</script>',
      expiresInMinutes: '5',
    });
    expect(rendered.html).not.toContain('<script>alert(1)</script>');
    expect(rendered.html).toContain('&lt;script&gt;');
    expect(rendered.html).toContain('<strong>');
    expect(rendered.text).toContain('<script>alert(1)</script>');
  });

  it('throws rather than rendering blank when a template references an unsupplied variable', () => {
    expect(() => interpolate('{{missing}}', {})).toThrow(/undefined variable "missing"/);
  });

  it('falls back to an escaped, paragraph-wrapped body when no body.html is authored', () => {
    const html = textToHtml('line one\nline two\n\nsecond paragraph');
    expect(html).toBe('<p>line one<br>line two</p>\n<p>second paragraph</p>');
  });

  it('escapes all five HTML-significant characters', () => {
    expect(escapeHtml(`&<>"'`)).toBe('&amp;&lt;&gt;&quot;&#39;');
  });
});

describe('locale resolution fallback chain', () => {
  it('prefers an exact match', () => {
    expect(resolveLocale('es', ['en', 'es'])).toBe('es');
  });

  it('falls back to the language-only prefix', () => {
    expect(resolveLocale('es-MX', ['en', 'es'])).toBe('es');
  });

  it('falls back to en when nothing matches', () => {
    expect(resolveLocale('fr', ['en', 'es'])).toBe('en');
  });

  it('falls back to en when no locale was requested', () => {
    expect(resolveLocale(undefined, ['en'])).toBe('en');
  });
});
