import type { Express } from 'express';
import { describe, expect, it } from 'vitest';
import { buildApp } from '#app/app.js';

interface RouterLayer {
  name: string;
  matchers: ((path: string) => false | { path: string })[];
  handle?: { stack?: { route?: { path: string | string[] } }[] };
}

function layerNames(app: Express): string[] {
  return (app as unknown as { router: { stack: RouterLayer[] } }).router.stack.map(
    (layer) => layer.name,
  );
}

function webhookMountIndex(app: Express): number {
  return (app as unknown as { router: { stack: RouterLayer[] } }).router.stack.findIndex(
    (layer) =>
      layer.name === 'router' &&
      layer.matchers.some((match) => Boolean(match('/api/v1/webhooks/email-events'))),
  );
}

describe('global IP rate-limit placement', () => {
  it('mounts the ceiling so that ordinary traffic passes through it', () => {
    const app = buildApp();
    expect(layerNames(app)).toContain('ipRateLimitHandler');
  });

  it('leaves inbound webhook receivers above the ceiling', () => {
    // Throttling a provider's retries would corrupt state (billing, delivery tracking, etc.), so
    // the exemption is structural: webhook routers must be reached before the limiter runs. The
    // Stripe webhook router is mounted the same way when BILLING_ENABLED=true; email-events is
    // exercised here because it is unconditional.
    const app = buildApp();
    const names = layerNames(app);

    const webhookIndex = webhookMountIndex(app);
    const limiterIndex = names.indexOf('ipRateLimitHandler');

    expect(webhookIndex).toBeGreaterThanOrEqual(0);
    expect(limiterIndex).toBeGreaterThanOrEqual(0);
    expect(webhookIndex).toBeLessThan(limiterIndex);
  });
});
