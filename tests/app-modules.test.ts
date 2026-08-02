import type { Express } from 'express';
import { describe, expect, it } from 'vitest';
import { buildApp } from '#app/app.js';

interface RouterLayer {
  name: string;
  matchers: ((path: string) => false | { path: string })[];
  handle?: { stack?: { route?: { path: string | string[] } }[] };
}

function hasMountedRoute(app: Express, mountPath: string, routePath: string): boolean {
  const layers = (app as unknown as { router: { stack: RouterLayer[] } }).router.stack;
  return layers.some(
    (layer) =>
      layer.name === 'router' &&
      layer.matchers.some((match) => Boolean(match(mountPath))) &&
      layer.handle?.stack?.some((child) =>
        Array.isArray(child.route?.path)
          ? child.route.path.includes(routePath)
          : child.route?.path === routePath,
      ),
  );
}

describe('optional application modules', () => {
  it('does not expose billing or upload routes when those modules are disabled', () => {
    const app = buildApp({ modules: { billing: false, uploads: false } });

    expect(hasMountedRoute(app, '/api/v1/billing', '/payments')).toBe(false);
    expect(hasMountedRoute(app, '/api/v1/uploads', '/')).toBe(false);
  });

  it('keeps enabled feature routes mounted', () => {
    const app = buildApp({ modules: { billing: true, uploads: true } });

    expect(hasMountedRoute(app, '/api/v1/billing', '/payments')).toBe(true);
    expect(hasMountedRoute(app, '/api/v1/uploads', '/')).toBe(true);
  });
});
