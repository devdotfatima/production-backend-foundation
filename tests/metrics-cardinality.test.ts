import { randomUUID } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import express from 'express';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { httpMetricsMiddleware, normalizedHttpMethod } from '#app/observability/http-metrics.js';
import { metricsRegistry } from '#app/observability/metrics.js';

/**
 * `fetch()` resolves once response headers arrive, which can race the server's `res.on('finish')`
 * handler that actually records the metric. A macrotask tick is enough for a same-process,
 * localhost round trip to settle.
 */
function waitForFinish(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

describe('HTTP metrics cardinality', () => {
  let server: Server;
  let baseUrl: string;

  beforeEach(async () => {
    metricsRegistry.resetMetrics();
    const app = express();
    app.use(httpMetricsMiddleware);
    app.get('/api/v1/users/:id', (_request, response) => response.json({ ok: true }));
    server = createServer(app);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const { port } = server.address() as AddressInfo;
    baseUrl = `http://127.0.0.1:${port}`;
  });

  afterEach(async () => {
    // Node's built-in fetch pools keep-alive sockets; close them so the test server can shut down
    // immediately instead of waiting for the HTTP idle timeout.
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  it('labels a parameterized route by its template, never the raw id', async () => {
    const id = randomUUID();
    const response = await fetch(`${baseUrl}/api/v1/users/${id}`);
    expect(response.status).toBe(200);
    await response.text();
    await waitForFinish();

    const text = await metricsRegistry.metrics();
    expect(text).toContain('route="/api/v1/users/:id"');
    expect(text).not.toContain(id);
  });

  it('labels an unmatched route as the fixed string "unmatched", never the raw path', async () => {
    const probe = `/does-not-exist/${randomUUID()}`;
    const response = await fetch(`${baseUrl}${probe}`);
    expect(response.status).toBe(404);
    await response.text();
    await waitForFinish();

    const text = await metricsRegistry.metrics();
    expect(text).toContain('route="unmatched"');
    expect(text).not.toContain(probe);
  });

  it('collapses repeated requests to the same template into one label series', async () => {
    for (let attempt = 0; attempt < 3; attempt += 1) {
      await (await fetch(`${baseUrl}/api/v1/users/${randomUUID()}`)).text();
    }
    await waitForFinish();

    const text = await metricsRegistry.metrics();
    const seriesForRoute = text
      .split('\n')
      .filter(
        (line) => line.startsWith('http_requests_total') && line.includes('/api/v1/users/:id'),
      );
    expect(seriesForRoute).toHaveLength(1);
    expect(seriesForRoute[0]).toContain(' 3');
  });

  it('collapses unknown methods into the bounded OTHER label', () => {
    expect(normalizedHttpMethod('BREW')).toBe('OTHER');
    expect(normalizedHttpMethod('get')).toBe('GET');
  });
});
