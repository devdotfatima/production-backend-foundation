import express, { type Express } from 'express';
import cookieParser from 'cookie-parser';
import cors from 'cors';
import helmet from 'helmet';
import { pinoHttp } from 'pino-http';
import { env } from '#app/config/env.js';
import { csrfProtection } from '#app/middleware/csrf.js';
import { errorHandler, notFoundHandler } from '#app/middleware/error-handler.js';
import { authRouter } from '#app/modules/auth/auth.routes.js';
import { auditRouter } from '#app/modules/audit/audit.routes.js';
import { rolesRouter } from '#app/modules/roles/roles.routes.js';
import { outboxRouter } from '#app/modules/outbox/outbox.routes.js';
import { createStripeRouters } from '#app/modules/stripe/stripe.routes.js';
import { createStripeClient } from '#app/modules/stripe/stripe.client.js';
import { usersRouter } from '#app/modules/users/users.routes.js';
import { createUploadProvider } from '#app/modules/uploads/uploads.provider.js';
import { createUploadsRouter } from '#app/modules/uploads/uploads.routes.js';
import { systemRouter } from '#app/modules/system/system.routes.js';
import { docsRouter } from '#app/modules/docs/docs.routes.js';
import { serviceAccountsRouter } from '#app/modules/service-accounts/service-accounts.routes.js';
import { customerWebhooksRouter } from '#app/modules/customer-webhooks/customer-webhooks.routes.js';
import { attachSentryErrorHandler } from '#app/observability/sentry.js';
import { loggerOptions } from '#app/observability/logger.js';

export interface AppModules {
  docs: boolean;
  auth: boolean;
  users: boolean;
  roles: boolean;
  outbox: boolean;
  audit: boolean;
  billing: boolean;
  uploads: boolean;
  serviceAccounts: boolean;
  customerWebhooks: boolean;
}

export interface BuildAppOptions {
  modules?: Partial<AppModules>;
}

export const defaultAppModules: Readonly<AppModules> = {
  docs: true,
  auth: true,
  users: true,
  roles: true,
  outbox: true,
  audit: true,
  billing: true,
  uploads: true,
  serviceAccounts: true,
  customerWebhooks: true,
};

export function buildApp(options: BuildAppOptions = {}): Express {
  const app = express();
  const modules = { ...defaultAppModules, ...options.modules };
  const stripeRouters = modules.billing ? createStripeRouters(createStripeClient()) : null;
  const uploadsRouter = modules.uploads ? createUploadsRouter(createUploadProvider(env)) : null;
  app.disable('x-powered-by');
  // Trust exactly the configured network boundary. A blanket boolean would allow
  // client-controlled forwarding headers whenever one proxy hop is bypassed.
  app.set(
    'trust proxy',
    env.TRUST_PROXY_CIDRS.length > 0 ? env.TRUST_PROXY_CIDRS : env.TRUST_PROXY_HOPS,
  );
  app.use(pinoHttp(loggerOptions));
  app.use(helmet());
  app.use(
    cors({
      origin: env.CORS_ALLOWED_ORIGINS.length > 0 ? env.CORS_ALLOWED_ORIGINS : [env.APP_ORIGIN],
      credentials: true,
      methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
      allowedHeaders: [
        'content-type',
        'idempotency-key',
        'x-api-key',
        'x-csrf-token',
        'x-request-id',
      ],
    }),
  );
  app.use(cookieParser(env.COOKIE_SECRET));
  if (modules.docs) app.use(docsRouter);
  // Stripe requires the exact raw bytes; this route must stay before express.json().
  if (stripeRouters) app.use('/api/v1/webhooks/stripe', stripeRouters.stripeRouter);

  app.use(express.json({ limit: '1mb' }));
  app.use(express.urlencoded({ extended: false, limit: '100kb' }));
  app.use(systemRouter);
  app.use(csrfProtection);
  if (modules.auth) app.use('/api/v1/auth', authRouter);
  if (stripeRouters) app.use('/api/v1/billing', stripeRouters.billingRouter);
  if (modules.users) app.use('/api/v1/users', usersRouter);
  if (modules.roles) app.use('/api/v1/roles', rolesRouter);
  if (modules.outbox) app.use('/api/v1/outbox-events', outboxRouter);
  if (modules.audit) app.use('/api/v1/audit-events', auditRouter);
  if (uploadsRouter) app.use('/api/v1/uploads', uploadsRouter);
  if (modules.serviceAccounts) app.use('/api/v1/service-accounts', serviceAccountsRouter);
  if (modules.customerWebhooks) app.use('/api/v1/webhook-endpoints', customerWebhooksRouter);
  app.use(notFoundHandler);
  attachSentryErrorHandler(app);
  app.use(errorHandler);
  return app;
}
