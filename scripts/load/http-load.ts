const source = process.env;

export {};

function numberOption(name: string, fallback: number, min: number, max: number): number {
  const value = Number(source[name] ?? fallback);
  if (!Number.isFinite(value) || value < min || value > max) {
    throw new Error(`${name} must be between ${min} and ${max}`);
  }
  return value;
}

const baseUrl = source.LOAD_BASE_URL ?? 'http://127.0.0.1:4000';
const path = source.LOAD_PATH ?? '/health';
const target = new URL(path, baseUrl);
const method = (source.LOAD_METHOD ?? 'GET').toUpperCase();
const durationSeconds = numberOption('LOAD_DURATION_SECONDS', 30, 1, 86_400);
const concurrency = Math.floor(numberOption('LOAD_CONCURRENCY', 20, 1, 10_000));
const requestTimeoutMs = numberOption('LOAD_REQUEST_TIMEOUT_MS', 5_000, 100, 120_000);
const maxErrorRate = numberOption('LOAD_MAX_ERROR_RATE', 0.01, 0, 1);
const maxP95Ms = numberOption('LOAD_MAX_P95_MS', 500, 1, 120_000);
const maxSamples = 100_000;
const durations: number[] = [];
const statuses = new Map<number, number>();
let requestCount = 0;
let errorCount = 0;

function recordDuration(value: number): void {
  if (durations.length < maxSamples) {
    durations.push(value);
    return;
  }
  // Bounded reservoir: a long soak must not turn the load generator into the bottleneck.
  const replacement = Math.floor(Math.random() * requestCount);
  if (replacement < maxSamples) durations[replacement] = value;
}

function percentile(values: number[], ratio: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * ratio))] ?? 0;
}

const headers = new Headers({ accept: 'application/json' });
if (source.LOAD_AUTHORIZATION) headers.set('authorization', source.LOAD_AUTHORIZATION);
if (source.LOAD_CONTENT_TYPE) headers.set('content-type', source.LOAD_CONTENT_TYPE);
const body = source.LOAD_BODY;
const deadline = performance.now() + durationSeconds * 1_000;

async function virtualUser(): Promise<void> {
  while (performance.now() < deadline) {
    const startedAt = performance.now();
    requestCount += 1;
    try {
      const response = await fetch(target, {
        method,
        headers,
        ...(body === undefined || ['GET', 'HEAD'].includes(method) ? {} : { body }),
        signal: AbortSignal.timeout(requestTimeoutMs),
      });
      await response.arrayBuffer();
      statuses.set(response.status, (statuses.get(response.status) ?? 0) + 1);
      if (!response.ok) errorCount += 1;
    } catch {
      errorCount += 1;
      statuses.set(0, (statuses.get(0) ?? 0) + 1);
    } finally {
      recordDuration(performance.now() - startedAt);
    }
  }
}

const startedAt = performance.now();
await Promise.all(Array.from({ length: concurrency }, () => virtualUser()));
const elapsedSeconds = (performance.now() - startedAt) / 1_000;
const errorRate = requestCount === 0 ? 1 : errorCount / requestCount;
const maxDuration = durations.reduce((maximum, value) => Math.max(maximum, value), 0);
const summary = {
  target: target.toString(),
  method,
  concurrency,
  elapsedSeconds: Number(elapsedSeconds.toFixed(2)),
  requests: requestCount,
  requestsPerSecond: Number((requestCount / elapsedSeconds).toFixed(2)),
  errors: errorCount,
  errorRate: Number(errorRate.toFixed(6)),
  latencyMs: {
    p50: Number(percentile(durations, 0.5).toFixed(2)),
    p95: Number(percentile(durations, 0.95).toFixed(2)),
    p99: Number(percentile(durations, 0.99).toFixed(2)),
    max: Number(maxDuration.toFixed(2)),
  },
  statuses: Object.fromEntries([...statuses.entries()].sort(([left], [right]) => left - right)),
  thresholds: { maxErrorRate, maxP95Ms },
};

process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
if (errorRate > maxErrorRate || summary.latencyMs.p95 > maxP95Ms) process.exitCode = 1;
