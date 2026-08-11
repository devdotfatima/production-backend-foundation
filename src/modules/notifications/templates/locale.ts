export const DEFAULT_LOCALE = 'en';

/**
 * Fallback chain: the exact requested locale, then its language-only prefix (`es-MX` -> `es`),
 * then `en`. Every template must ship an `en` variant; anything else is optional.
 */
export function resolveLocale(requested: string | undefined, available: readonly string[]): string {
  const candidates = [requested, requested?.split('-')[0], DEFAULT_LOCALE].filter(
    (locale): locale is string => Boolean(locale),
  );

  for (const candidate of candidates) {
    if (available.includes(candidate)) return candidate;
  }
  return DEFAULT_LOCALE;
}
