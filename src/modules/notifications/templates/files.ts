import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

// This module lives at the root of the templates directory, so its own directory *is* the root
// every {key}/{locale}/{subject.txt,body.txt,body.html} path is resolved against. That holds
// whether it runs from `src` (tsx, vitest) or `dist` (tsc mirrors the directory 1:1), so no
// separate asset-copy path resolution is needed -- only the raw .txt/.html files themselves have
// to be copied into dist/ alongside the compiled .js (see the `build` script).
const templatesRoot = dirname(fileURLToPath(import.meta.url));

export interface RawTemplateFiles {
  subject: string;
  text: string;
  html: string | null;
}

export function availableLocales(key: string): string[] {
  const keyDir = join(templatesRoot, key);
  if (!existsSync(keyDir)) return [];
  return readdirSync(keyDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name);
}

const fileCache = new Map<string, RawTemplateFiles>();

export function loadTemplateFiles(key: string, locale: string): RawTemplateFiles {
  const cacheKey = `${key}/${locale}`;
  const cached = fileCache.get(cacheKey);
  if (cached) return cached;

  const dir = join(templatesRoot, key, locale);
  const htmlPath = join(dir, 'body.html');
  const result: RawTemplateFiles = {
    subject: readFileSync(join(dir, 'subject.txt'), 'utf8').trim(),
    text: readFileSync(join(dir, 'body.txt'), 'utf8'),
    html: existsSync(htmlPath) ? readFileSync(htmlPath, 'utf8') : null,
  };
  fileCache.set(cacheKey, result);
  return result;
}
