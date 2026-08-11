import { randomUUID } from 'node:crypto';
import { io, type Socket } from 'socket.io-client';

const source = process.env;

function numberOption(name: string, fallback: number, min: number, max: number): number {
  const value = Number(source[name] ?? fallback);
  if (!Number.isFinite(value) || value < min || value > max) {
    throw new Error(`${name} must be between ${min} and ${max}`);
  }
  return value;
}

function percentile(values: number[], ratio: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * ratio))] ?? 0;
}

const baseUrl = source.CHAT_LOAD_URL ?? 'http://127.0.0.1:4000';
const conversationId = source.CHAT_LOAD_CONVERSATION_ID;
const tokens = (source.CHAT_LOAD_TOKENS ?? '')
  .split(',')
  .map((value) => value.trim())
  .filter(Boolean);
if (!conversationId) throw new Error('CHAT_LOAD_CONVERSATION_ID is required');
if (tokens.length === 0) throw new Error('CHAT_LOAD_TOKENS requires at least one bearer token');

const connectionCount = Math.floor(numberOption('CHAT_LOAD_CONNECTIONS', 40, 1, 100_000));
const durationSeconds = numberOption('CHAT_LOAD_DURATION_SECONDS', 60, 1, 86_400);
const rampMs = numberOption('CHAT_LOAD_RAMP_MS', 5_000, 0, 3_600_000);
const messagesPerSecond = numberOption('CHAT_LOAD_MESSAGES_PER_SECOND', 0, 0, 100_000);
const ackTimeoutMs = numberOption('CHAT_LOAD_ACK_TIMEOUT_MS', 5_000, 100, 120_000);
const maxErrorRate = numberOption('CHAT_LOAD_MAX_ERROR_RATE', 0.01, 0, 1);
const maxP95Ms = numberOption('CHAT_LOAD_MAX_P95_MS', 500, 1, 120_000);
const socketPath = source.CHAT_SOCKET_PATH ?? '/socket.io';
const origin = source.CHAT_LOAD_ORIGIN ?? 'http://localhost:3000';
const clients: Socket[] = [];
const connectLatencies: number[] = [];
const ackLatencies: number[] = [];
let errors = 0;
let sends = 0;
const pendingSends = new Set<Promise<void>>();

async function connectOne(index: number): Promise<void> {
  const startedAt = performance.now();
  const client = io(baseUrl, {
    path: socketPath,
    transports: ['websocket'],
    reconnection: false,
    timeout: ackTimeoutMs,
    extraHeaders: { Origin: origin },
    auth: { token: tokens[index % tokens.length] },
  });
  try {
    await new Promise<void>((resolve, reject) => {
      client.once('connect', resolve);
      client.once('connect_error', reject);
    });
    const joined = (await client.timeout(ackTimeoutMs).emitWithAck('conversation:join', {
      conversationId,
    })) as { ok?: boolean };
    if (!joined.ok) throw new Error('conversation join rejected');
    connectLatencies.push(performance.now() - startedAt);
    clients.push(client);
  } catch (error) {
    errors += 1;
    client.disconnect();
    if (source.CHAT_LOAD_FAIL_FAST === 'true') throw error;
  }
}

const stepMs = connectionCount === 0 ? 0 : rampMs / connectionCount;
for (let index = 0; index < connectionCount; index += 1) {
  await connectOne(index);
  if (stepMs > 0) await new Promise((resolve) => setTimeout(resolve, stepMs));
}

let sendTimer: NodeJS.Timeout | undefined;
if (messagesPerSecond > 0 && clients.length > 0) {
  const intervalMs = Math.max(1, 1_000 / messagesPerSecond);
  sendTimer = setInterval(() => {
    const client = clients[sends % clients.length];
    if (!client) return;
    sends += 1;
    const startedAt = performance.now();
    const pending = client
      .timeout(ackTimeoutMs)
      .emitWithAck('message:send', {
        conversationId,
        clientMessageId: randomUUID(),
        body: `load message ${sends}`,
      })
      .then((result: unknown) => {
        if (!(result as { ok?: boolean }).ok) errors += 1;
        ackLatencies.push(performance.now() - startedAt);
      })
      .catch(() => {
        errors += 1;
        ackLatencies.push(performance.now() - startedAt);
      })
      .finally(() => {
        pendingSends.delete(pending);
      });
    pendingSends.add(pending);
  }, intervalMs);
}

await new Promise((resolve) => setTimeout(resolve, durationSeconds * 1_000));
if (sendTimer) clearInterval(sendTimer);
await Promise.allSettled(pendingSends);
for (const client of clients) client.disconnect();

const attempts = connectionCount + sends;
const errorRate = attempts === 0 ? 1 : errors / attempts;
const summary = {
  target: baseUrl,
  requestedConnections: connectionCount,
  connected: clients.length,
  sends,
  errors,
  errorRate: Number(errorRate.toFixed(6)),
  connectionLatencyMs: {
    p50: Number(percentile(connectLatencies, 0.5).toFixed(2)),
    p95: Number(percentile(connectLatencies, 0.95).toFixed(2)),
  },
  messageAckLatencyMs: {
    p50: Number(percentile(ackLatencies, 0.5).toFixed(2)),
    p95: Number(percentile(ackLatencies, 0.95).toFixed(2)),
  },
  thresholds: { maxErrorRate, maxP95Ms },
};
process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
if (
  errorRate > maxErrorRate ||
  summary.connectionLatencyMs.p95 > maxP95Ms ||
  (sends > 0 && summary.messageAckLatencyMs.p95 > maxP95Ms)
) {
  process.exitCode = 1;
}
