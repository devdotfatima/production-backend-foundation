import {
  context,
  propagation,
  SpanStatusCode,
  trace,
  type Attributes,
  type TextMapGetter,
} from '@opentelemetry/api';
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-http';
import { ExpressInstrumentation } from '@opentelemetry/instrumentation-express';
import { HttpInstrumentation } from '@opentelemetry/instrumentation-http';
import { IORedisInstrumentation } from '@opentelemetry/instrumentation-ioredis';
import { PgInstrumentation } from '@opentelemetry/instrumentation-pg';
import { UndiciInstrumentation } from '@opentelemetry/instrumentation-undici';
import { NodeSDK, type NodeSDKConfiguration } from '@opentelemetry/sdk-node';
import { ParentBasedSampler, TraceIdRatioBasedSampler } from '@opentelemetry/sdk-trace-node';
import { PrismaInstrumentation } from '@prisma/instrumentation';
import { env } from '#app/config/env.js';

export type TraceCarrier = Record<string, string>;

let sdk: NodeSDK | undefined;

export type TracingOptions = Pick<
  Partial<NodeSDKConfiguration>,
  'traceExporter' | 'spanProcessors' | 'instrumentations' | 'autoDetectResources'
>;

/**
 * Registers instrumentation before Express, Prisma, Redis, BullMQ, or provider modules load.
 * OTLP configuration intentionally follows the standard OTEL_EXPORTER_OTLP_* variables.
 */
export function initializeTracing(options: TracingOptions = {}): void {
  if (!env.OTEL_ENABLED || sdk) return;

  sdk = new NodeSDK({
    serviceName: env.OTEL_SERVICE_NAME,
    ...(options.spanProcessors
      ? { spanProcessors: options.spanProcessors }
      : { traceExporter: options.traceExporter ?? new OTLPTraceExporter() }),
    sampler: new ParentBasedSampler({
      root: new TraceIdRatioBasedSampler(env.OTEL_TRACE_SAMPLE_RATIO),
    }),
    autoDetectResources: options.autoDetectResources,
    instrumentations: options.instrumentations ?? [
      new HttpInstrumentation(),
      new UndiciInstrumentation(),
      new ExpressInstrumentation(),
      new PrismaInstrumentation(),
      new IORedisInstrumentation(),
      new PgInstrumentation(),
    ],
  });
  sdk.start();
}

export async function shutdownTracing(): Promise<void> {
  const current = sdk;
  sdk = undefined;
  await current?.shutdown();
}

/** Captures the active W3C propagation fields for durable storage or a queue message. */
export function captureTraceContext(): TraceCarrier | undefined {
  if (!env.OTEL_ENABLED) return undefined;
  const carrier: TraceCarrier = {};
  propagation.inject(context.active(), carrier);
  return Object.keys(carrier).length > 0 ? carrier : undefined;
}

/** Accepts only the string-valued propagation carrier shape we write to JSONB. */
export function normalizeTraceContext(value: unknown): TraceCarrier | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const entries = Object.entries(value).filter(
    (entry): entry is [string, string] =>
      entry[0].length <= 128 && typeof entry[1] === 'string' && entry[1].length <= 1_024,
  );
  return entries.length > 0 ? Object.fromEntries(entries) : undefined;
}

const carrierGetter: TextMapGetter<TraceCarrier> = {
  keys: (carrier) => Object.keys(carrier),
  get: (carrier, key) => carrier[key],
};

/** Restores a remote parent before beginning worker-side spans. */
export function withTraceContext<T>(
  carrier: TraceCarrier | null | undefined,
  callback: () => Promise<T>,
): Promise<T> {
  if (!env.OTEL_ENABLED || !carrier) return callback();
  const extracted = propagation.extract(context.active(), carrier, carrierGetter);
  return context.with(extracted, callback);
}

export async function withSpan<T>(
  name: string,
  attributes: Attributes,
  callback: () => Promise<T>,
): Promise<T> {
  if (!env.OTEL_ENABLED) return callback();
  return trace
    .getTracer('backend-foundation')
    .startActiveSpan(name, { attributes }, async (span) => {
      try {
        const result = await callback();
        span.setStatus({ code: SpanStatusCode.OK });
        return result;
      } catch (error) {
        span.recordException(error instanceof Error ? error : new Error(String(error)));
        span.setStatus({ code: SpanStatusCode.ERROR });
        throw error;
      } finally {
        span.end();
      }
    });
}
