import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { generateModule } from '../scripts/gen-module.js';

describe('module generator', () => {
  it('creates the four module layers and a starter test', async () => {
    const projectRoot = await mkdtemp(join(tmpdir(), 'backend-module-'));

    const files = await generateModule('service-orders', projectRoot);

    expect(files).toEqual([
      'src/modules/service-orders/service-orders.schemas.ts',
      'src/modules/service-orders/service-orders.service.ts',
      'src/modules/service-orders/service-orders.controller.ts',
      'src/modules/service-orders/service-orders.routes.ts',
      'tests/service-orders-service.test.ts',
    ]);
    await expect(
      readFile(join(projectRoot, 'src/modules/service-orders/service-orders.routes.ts'), 'utf8'),
    ).resolves.toContain('serviceOrdersRouter.get');
  });

  it('validates names and refuses to overwrite files', async () => {
    const projectRoot = await mkdtemp(join(tmpdir(), 'backend-module-'));

    await expect(generateModule('Service Orders', projectRoot)).rejects.toThrow('kebab-case');
    await generateModule('orders', projectRoot);
    await expect(generateModule('orders', projectRoot)).rejects.toThrow('Refusing to overwrite');
  });
});
