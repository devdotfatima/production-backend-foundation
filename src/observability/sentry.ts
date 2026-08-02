import * as Sentry from '@sentry/node';
import type { Express } from 'express';
import { env } from '#app/config/env.js';

let initialized = false;

export function initializeSentry(): void {
  if (initialized) return;
  initialized = true;

  Sentry.init({
    dsn: env.SENTRY_DSN || undefined,
    enabled: Boolean(env.SENTRY_DSN),
    environment: env.SENTRY_ENVIRONMENT,
    tracesSampleRate: env.SENTRY_TRACES_SAMPLE_RATE,
    sendDefaultPii: false,
  });
}

export function attachSentryErrorHandler(app: Express): void {
  if (env.SENTRY_DSN) Sentry.setupExpressErrorHandler(app);
}

export function captureException(error: unknown, context?: Record<string, unknown>): void {
  Sentry.withScope((scope) => {
    if (context) scope.setContext('application', context);
    Sentry.captureException(error);
  });
}

export async function flushSentry(): Promise<void> {
  await Sentry.flush(2_000);
}
