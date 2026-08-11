import type { NextFunction, Request, Response } from 'express';
import { Counter, Histogram } from 'prom-client';
import { metricsRegistry } from '#app/observability/metrics.js';

const httpRequestsTotal = new Counter({
  name: 'http_requests_total',
  help: 'Total HTTP requests handled, labeled by route template.',
  labelNames: ['method', 'route', 'status_code'],
  registers: [metricsRegistry],
});

const httpRequestDuration = new Histogram({
  name: 'http_request_duration_seconds',
  help: 'HTTP request duration in seconds, labeled by route template.',
  labelNames: ['method', 'route', 'status_code'],
  registers: [metricsRegistry],
  buckets: [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10],
});

/**
 * Route TEMPLATE (`/api/v1/users/:id`), never the raw path: a label containing a UUID or other
 * per-request value is the fastest way to destroy a Prometheus instance under cardinality growth.
 * Unmatched requests (404s, and anything rejected before routing ever resolves req.route)
 * collapse into the fixed string "unmatched" rather than the attacker-controlled path that
 * produced them.
 */
function routeTemplate(request: Request): string {
  const route = request.route as { path?: string } | undefined;
  if (!route?.path) return 'unmatched';
  const combined = `${request.baseUrl}${route.path}`;
  return combined.length > 1 && combined.endsWith('/') ? combined.slice(0, -1) : combined;
}

const KNOWN_METHODS = new Set(['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS']);

/** Prevent a non-standard, attacker-chosen method from creating a new label series. */
export function normalizedHttpMethod(method: string): string {
  const normalized = method.toUpperCase();
  return KNOWN_METHODS.has(normalized) ? normalized : 'OTHER';
}

/** Mounted early in app.ts so every request is counted, including ones later rejected. */
export function httpMetricsMiddleware(
  request: Request,
  response: Response,
  next: NextFunction,
): void {
  const stopTimer = httpRequestDuration.startTimer();
  response.on('finish', () => {
    const labels = {
      method: normalizedHttpMethod(request.method),
      route: routeTemplate(request),
      status_code: String(response.statusCode),
    };
    httpRequestsTotal.inc(labels);
    stopTimer(labels);
  });
  next();
}
