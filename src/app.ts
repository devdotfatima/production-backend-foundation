import express, { type Express } from 'express';
import cookieParser from 'cookie-parser';
import cors from 'cors';
import helmet from 'helmet';
import { pinoHttp } from 'pino-http';
import { env } from '#app/config/env.js';
import { csrfProtection } from '#app/middleware/csrf.js';
import { errorHandler, notFoundHandler } from '#app/middleware/error-handler.js';
import { requestContext } from '#app/lib/request-context.js';
import { createAuthRouter } from '#app/modules/auth/auth.routes.js';
import { createAuthController } from '#app/modules/auth/auth.controller.js';
import { auditRouter } from '#app/modules/audit/audit.routes.js';
import { rolesRouter } from '#app/modules/roles/roles.routes.js';
import { organizationsRouter } from '#app/modules/organizations/organizations.routes.js';
import { chatRouter } from '#app/modules/chat/chat.routes.js';
import { schedulerRouter } from '#app/scheduler/scheduler.routes.js';
import { outboxRouter } from '#app/modules/outbox/outbox.routes.js';
import { createStripeRouters } from '#app/modules/stripe/stripe.routes.js';
import { createStripeClient } from '#app/modules/stripe/stripe.client.js';
import { usersRouter } from '#app/modules/users/users.routes.js';
import { createUploadProvider } from '#app/modules/uploads/uploads.provider.js';
import { createUploadsRouter } from '#app/modules/uploads/uploads.routes.js';
import { systemRouter } from '#app/modules/system/system.routes.js';
import { docsRouter } from '#app/modules/docs/docs.routes.js';
import {
  notificationPreviewRouter,
  notificationPublicRouter,
  notificationsRouter,
} from '#app/modules/notifications/notifications.routes.js';
import { attachSentryErrorHandler } from '#app/observability/sentry.js';
import { appLogger, loggerOptions } from '#app/observability/logger.js';
import { httpMetricsMiddleware } from '#app/observability/http-metrics.js';
import { globalIpRateLimit } from '#app/middleware/rate-limit.js';
import { emailEventsRouter } from '#app/modules/notifications/email-events.routes.js';

export function buildApp(): Express {
  const app = express();
  const stripeClient = env.BILLING_ENABLED ? createStripeClient() : null;
  const uploadProvider = createUploadProvider(env);
  const stripeRouters = env.BILLING_ENABLED ? createStripeRouters(stripeClient) : null;
  const uploadsRouter = createUploadsRouter(uploadProvider);
  const authRouter = createAuthRouter(
    createAuthController({
      getStripeClient: () => stripeClient,
      getUploadProvider: () => uploadProvider,
    }),
  );
  app.disable('x-powered-by');
  // Trust exactly the configured network boundary. A blanket boolean would allow
  // client-controlled forwarding headers whenever one proxy hop is bypassed.
  app.set(
    'trust proxy',
    env.TRUST_PROXY_CIDRS.length > 0 ? env.TRUST_PROXY_CIDRS : env.TRUST_PROXY_HOPS,
  );
  // Behind a load balancer with no configured trust, every request reports the balancer's
  // address and every per-IP limit silently collapses into one global bucket.
  if (
    env.NODE_ENV === 'production' &&
    env.TRUST_PROXY_HOPS === 0 &&
    env.TRUST_PROXY_CIDRS.length === 0
  ) {
    appLogger.warn(
      { metric: 'rate_limit.proxy_trust_unconfigured' },
      'No proxy trust configured: per-IP rate limits will bucket every proxied client together',
    );
  }
  app.use(pinoHttp(loggerOptions));
  // Established for every request so a missing identity is distinguishable from a missing
  // context; the tenant-scope extension refuses the latter.
  app.use(requestContext);
  // Early so every request is counted, including ones a later middleware rejects.
  app.use(httpMetricsMiddleware);
  app.use(helmet());
  app.use(
    cors({
      origin: env.CORS_ALLOWED_ORIGINS.length > 0 ? env.CORS_ALLOWED_ORIGINS : [env.APP_ORIGIN],
      credentials: true,
      methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
      allowedHeaders: ['content-type', 'idempotency-key', 'x-csrf-token', 'x-request-id'],
    }),
  );
  app.use(cookieParser(env.COOKIE_SECRET));
  // Stripe requires the exact raw bytes, so this route must stay before express.json(). It also
  // sits above the IP ceiling: throttling Stripe's retries would corrupt billing state.
  if (stripeRouters) app.use('/api/v1/webhooks/stripe', stripeRouters.stripeRouter);
  app.use('/api/v1/webhooks/email-events', emailEventsRouter);
  app.use(globalIpRateLimit);
  app.use(docsRouter);

  app.use(express.json({ limit: '1mb' }));
  app.use(express.urlencoded({ extended: false, limit: '100kb' }));
  app.use(systemRouter);
  // Signed-token endpoint used by email clients; it cannot depend on an authenticated cookie or
  // CSRF token. The token and the dedicated IP limiter are its authorization boundary.
  app.use('/api/v1/notifications', notificationPublicRouter);
  app.use(csrfProtection);
  app.use('/api/v1/auth', authRouter);
  if (stripeRouters) app.use('/api/v1/billing', stripeRouters.billingRouter);
  app.use('/api/v1/users', usersRouter);
  app.use('/api/v1/roles', rolesRouter);
  if (env.TENANCY_MODE !== 'disabled') app.use('/api/v1/organizations', organizationsRouter);
  if (env.CHAT_ENABLED) app.use('/api/v1/chat', chatRouter);
  app.use('/api/v1/scheduled-jobs', schedulerRouter);
  app.use('/api/v1/outbox-events', outboxRouter);
  app.use('/api/v1/audit-events', auditRouter);
  app.use('/api/v1/uploads', uploadsRouter);
  app.use('/api/v1/notifications', notificationsRouter);
  // Dev tooling only: previewing a broken template belongs in a browser tab, not in production.
  if (env.NODE_ENV !== 'production') {
    app.use('/api/v1/notifications', notificationPreviewRouter);
  }
  app.use(notFoundHandler);
  attachSentryErrorHandler(app);
  app.use(errorHandler);
  return app;
}
