import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

interface PackageManifest {
  scripts?: Record<string, string>;
}

describe('production entry points', () => {
  const workspace = process.cwd();
  const manifest = JSON.parse(
    readFileSync(resolve(workspace, 'package.json'), 'utf8'),
  ) as PackageManifest;

  it.each([
    ['start', 'dist/src/server.js'],
    ['worker:start', 'dist/src/worker.js'],
    ['maintenance:cleanup', 'dist/src/maintenance/cleanup.js'],
    ['maintenance:audit-verify', 'dist/src/maintenance/audit-verify.js'],
  ])('%s references an emitted build artifact', (scriptName, artifact) => {
    expect(manifest.scripts?.[scriptName]).toBe(`node ${artifact}`);
    expect(existsSync(resolve(workspace, artifact))).toBe(true);
  });
});
