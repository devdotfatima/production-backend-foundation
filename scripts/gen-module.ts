import { access, mkdir, writeFile } from 'node:fs/promises';
import { constants } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const moduleNamePattern = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/;

function pascalCase(value: string): string {
  return value
    .split('-')
    .map((part) => `${part[0]!.toUpperCase()}${part.slice(1)}`)
    .join('');
}

function camelCase(value: string): string {
  const pascal = pascalCase(value);
  return `${pascal[0]!.toLowerCase()}${pascal.slice(1)}`;
}

function templates(name: string): Record<string, string> {
  const pascal = pascalCase(name);
  const camel = camelCase(name);
  const modulePath = `#app/modules/${name}`;

  return {
    [`src/modules/${name}/${name}.schemas.ts`]: `import { z } from 'zod';

export const ${camel}IdParams = z.object({ id: z.uuid() });

export const ${camel}IdRequestValidation = { params: ${camel}IdParams } as const;
`,
    [`src/modules/${name}/${name}.service.ts`]: `export interface ${pascal}Summary {
  id: string;
  module: '${name}';
}

/** Replace this compile-safe seam with the module's injected repository. */
export async function get${pascal}(id: string): Promise<${pascal}Summary> {
  return { id, module: '${name}' };
}
`,
    [`src/modules/${name}/${name}.controller.ts`]: `import type { RequestHandler } from 'express';
import { sendSuccess } from '#app/lib/api-response.js';
import { getValidated } from '#app/middleware/request-validation.js';
import { ${camel}IdRequestValidation } from '${modulePath}/${name}.schemas.js';
import { get${pascal} } from '${modulePath}/${name}.service.js';

export const show: RequestHandler = async (request, response) => {
  const { params } = getValidated(request, ${camel}IdRequestValidation);
  sendSuccess(request, response, { data: await get${pascal}(params.id) });
};
`,
    [`src/modules/${name}/${name}.routes.ts`]: `import { Router } from 'express';
import { authenticate } from '#app/middleware/access-control.js';
import { validateRequest } from '#app/middleware/request-validation.js';
import { show } from '${modulePath}/${name}.controller.js';
import { ${camel}IdRequestValidation } from '${modulePath}/${name}.schemas.js';

export const ${camel}Router = Router();

${camel}Router.get('/:id', authenticate, validateRequest(${camel}IdRequestValidation), show);
`,
    [`tests/${name}-service.test.ts`]: `import { describe, expect, it } from 'vitest';
import { get${pascal} } from '${modulePath}/${name}.service.js';

describe('${name} service', () => {
  it('exposes the generated service seam', async () => {
    await expect(get${pascal}('00000000-0000-4000-8000-000000000000')).resolves.toEqual({
      id: '00000000-0000-4000-8000-000000000000',
      module: '${name}',
    });
  });
});
`,
  };
}

async function exists(path: string): Promise<boolean> {
  try {
    await access(path, constants.F_OK);
    return true;
  } catch {
    return false;
  }
}

export async function generateModule(name: string, projectRoot = process.cwd()): Promise<string[]> {
  if (!moduleNamePattern.test(name)) {
    throw new Error('Module name must be lowercase kebab-case (for example, service-orders)');
  }

  const files = Object.entries(templates(name)).map(([relativePath, content]) => ({
    relativePath,
    path: resolve(projectRoot, relativePath),
    content,
  }));
  const conflicts = (
    await Promise.all(
      files.map(async (file) => ((await exists(file.path)) ? file.relativePath : null)),
    )
  ).filter((path): path is string => path !== null);

  if (conflicts.length > 0) {
    throw new Error(`Refusing to overwrite existing files: ${conflicts.join(', ')}`);
  }

  await Promise.all(files.map((file) => mkdir(dirname(file.path), { recursive: true })));
  await Promise.all(files.map((file) => writeFile(file.path, file.content, { flag: 'wx' })));
  return files.map((file) => file.relativePath);
}

async function main(): Promise<void> {
  const name = process.argv[2];
  if (!name) throw new Error('Usage: npm run gen:module -- <module-name>');

  const files = await generateModule(name);
  process.stdout.write(
    `Generated ${files.length} files:\n${files.map((file) => `  - ${file}`).join('\n')}\n\n` +
      `Mount ${camelCase(name)}Router in src/app.ts when the feature is ready.\n`,
  );
}

const invokedPath = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : null;
if (invokedPath === import.meta.url) {
  main().catch((error: unknown) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
