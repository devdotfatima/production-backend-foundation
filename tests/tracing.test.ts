import { InMemorySpanExporter, SimpleSpanProcessor } from '@opentelemetry/sdk-trace-base';
import { context, propagation, trace } from '@opentelemetry/api';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('#app/config/env.js', () => ({
  env: {
    OTEL_ENABLED: true,
    OTEL_SERVICE_NAME: 'backend-foundation-test',
    OTEL_TRACE_SAMPLE_RATIO: 1,
  },
}));

import {
  captureTraceContext,
  initializeTracing,
  shutdownTracing,
  withSpan,
  withTraceContext,
} from '../dist/src/observability/tracing.js';

afterEach(async () => {
  await shutdownTracing();
});

describe('distributed tracing', () => {
  it('exports parent/child spans and propagates a W3C trace carrier across an async boundary', async () => {
    // Vitest and Sentry may install no-op/global OTel delegates while loading the test process.
    // Reset them so this smoke test proves this application's SDK registration itself.
    trace.disable();
    context.disable();
    propagation.disable();
    const exporter = new InMemorySpanExporter();
    initializeTracing({
      spanProcessors: [new SimpleSpanProcessor(exporter)],
      instrumentations: [],
      autoDetectResources: false,
    });
    let carrier: Record<string, string> | undefined;

    await withSpan('request.accepted', { 'test.kind': 'smoke' }, async () => {
      carrier = captureTraceContext();
      await withTraceContext(carrier, () => withSpan('outbox.process', {}, async () => undefined));
    });
    expect(carrier?.traceparent).toMatch(/^00-[a-f0-9]{32}-[a-f0-9]{16}-01$/);
    const spans = exporter.getFinishedSpans();
    const parent = spans.find((span) => span.name === 'request.accepted');
    const child = spans.find((span) => span.name === 'outbox.process');
    expect(parent).toBeDefined();
    expect(child).toBeDefined();
    expect(child?.spanContext().traceId).toBe(parent?.spanContext().traceId);
    expect(child?.parentSpanContext?.spanId).toBe(parent?.spanContext().spanId);
  });
});
