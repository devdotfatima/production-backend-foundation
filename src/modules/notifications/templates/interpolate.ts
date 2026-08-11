const TOKEN_PATTERN = /\{\{\s*([a-zA-Z0-9_]+)\s*\}\}/g;

export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/**
 * Replaces `{{name}}` tokens with values, escaping each substituted value when `escape` is set
 * (the surrounding template markup is trusted and left untouched). A token with no matching key
 * throws rather than rendering blank, so a template edited out of sync with its payload contract
 * fails loudly instead of silently shipping broken copy.
 */
export function interpolate(
  template: string,
  values: Readonly<Record<string, string>>,
  options: { escape?: boolean } = {},
): string {
  return template.replace(TOKEN_PATTERN, (match, key: string) => {
    if (!Object.hasOwn(values, key)) {
      throw new Error(`Template references undefined variable "${key}"`);
    }
    const value = values[key]!;
    return options.escape ? escapeHtml(value) : value;
  });
}

/** Fallback HTML body for a template that ships no body.html: escape, then paragraph-wrap. */
export function textToHtml(text: string): string {
  return text
    .trim()
    .split(/\n{2,}/)
    .map((paragraph) => `<p>${escapeHtml(paragraph).replace(/\n/g, '<br>')}</p>`)
    .join('\n');
}
