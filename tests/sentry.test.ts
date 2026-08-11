import { describe, expect, it, vi } from 'vitest';

const sentry = vi.hoisted(() => ({
  init: vi.fn(),
  setupExpressErrorHandler: vi.fn(),
  withScope: vi.fn(),
  captureException: vi.fn(),
  flush: vi.fn(),
}));

vi.mock('@sentry/node', () => sentry);
vi.mock('#app/config/env.js', () => ({
  env: {
    SENTRY_DSN: 'https://public@example.invalid/1',
    SENTRY_ENVIRONMENT: 'test',
    SENTRY_TRACES_SAMPLE_RATE: 0.5,
    OTEL_ENABLED: true,
  },
}));

import { initializeSentry } from '../dist/src/observability/sentry.js';

describe('Sentry and OpenTelemetry ownership', () => {
  it('keeps Sentry error reporting but leaves the global tracer provider to OpenTelemetry', () => {
    initializeSentry();

    expect(sentry.init).toHaveBeenCalledWith(
      expect.objectContaining({
        enabled: true,
        skipOpenTelemetrySetup: true,
        tracesSampleRate: 0,
      }),
    );
  });
});
