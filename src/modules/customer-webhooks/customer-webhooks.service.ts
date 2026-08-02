import { createHmac } from 'node:crypto';
import { isIP } from 'node:net';
import { lookup } from 'node:dns/promises';
import type { Prisma } from '@prisma/client';
import { decryptSecret, encryptSecret, randomToken } from '#app/lib/crypto.js';
import { errors } from '#app/lib/errors.js';
import { uuidV7 } from '#app/lib/id.js';
import { prisma } from '#app/lib/prisma.js';
import { addOutboxEvent } from '#app/modules/outbox/outbox.service.js';

function parsedWebhookUrl(value: string): URL {
  const url = new URL(value);
  if (url.protocol !== 'https:' || url.username || url.password || url.hash) {
    throw errors.badRequest('Webhook URL must be an HTTPS URL without credentials or fragments');
  }
  return url;
}

function isPrivateAddress(address: string): boolean {
  if (
    address === '::1' ||
    address.startsWith('fc') ||
    address.startsWith('fd') ||
    address.startsWith('fe80:')
  )
    return true;
  if (isIP(address) === 4) {
    const [a = 0, b = 0] = address.split('.').map(Number);
    return (
      a === 10 ||
      a === 127 ||
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168)
    );
  }
  return false;
}

async function assertPublicDestination(url: URL): Promise<void> {
  const addresses = await lookup(url.hostname, { all: true, verbatim: true });
  if (addresses.length === 0 || addresses.some((entry) => isPrivateAddress(entry.address))) {
    throw new Error('Webhook destination resolved to a private or unavailable address');
  }
}

export async function createWebhookEndpoint(
  userId: string,
  input: { url: string; description?: string; events: string[] },
) {
  parsedWebhookUrl(input.url);
  const secret = randomToken(32);
  const endpoint = await prisma.customerWebhookEndpoint.create({
    data: {
      userId,
      ...input,
      events: [...new Set(input.events)],
      secretEncrypted: encryptSecret(secret),
    },
    select: { id: true, url: true, description: true, events: true, active: true, createdAt: true },
  });
  return { endpoint, secret };
}

export const listWebhookEndpoints = (userId: string) =>
  prisma.customerWebhookEndpoint.findMany({
    where: { userId, deletedAt: null },
    orderBy: { createdAt: 'desc' },
    select: { id: true, url: true, description: true, events: true, active: true, createdAt: true },
  });

export async function deleteWebhookEndpoint(userId: string, endpointId: string) {
  const result = await prisma.customerWebhookEndpoint.updateMany({
    where: { id: endpointId, userId, deletedAt: null },
    data: { active: false, deletedAt: new Date() },
  });
  if (result.count !== 1) throw errors.notFound('Webhook endpoint not found');
}

export async function queueCustomerWebhookEvent(
  tx: Prisma.TransactionClient,
  userId: string,
  eventType: string,
  payload: Prisma.InputJsonValue,
): Promise<void> {
  const endpoints = await tx.customerWebhookEndpoint.findMany({
    where: { userId, active: true, events: { has: eventType }, deletedAt: null },
    select: { id: true },
  });
  for (const endpoint of endpoints) {
    const eventId = uuidV7();
    const delivery = await tx.customerWebhookDelivery.create({
      data: { endpointId: endpoint.id, eventId, eventType, payload },
    });
    await addOutboxEvent(tx, {
      aggregateType: 'customer_webhook_delivery',
      aggregateId: delivery.id,
      eventType: 'customer.webhook',
      channel: 'INTERNAL',
      payload: { deliveryId: delivery.id },
      dedupeKey: `customer-webhook:${eventId}`,
      expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1_000),
    });
  }
}

export async function deliverCustomerWebhook(deliveryId: string): Promise<void> {
  const delivery = await prisma.customerWebhookDelivery.findFirst({
    where: { id: deliveryId, deliveredAt: null, deletedAt: null },
    include: { endpoint: true },
  });
  if (!delivery || !delivery.endpoint.active || delivery.endpoint.deletedAt) return;
  const url = parsedWebhookUrl(delivery.endpoint.url);
  await assertPublicDestination(url);
  const timestamp = Math.floor(Date.now() / 1_000);
  const body = JSON.stringify({
    id: delivery.eventId,
    type: delivery.eventType,
    data: delivery.payload,
  });
  const signature = createHmac('sha256', decryptSecret(delivery.endpoint.secretEncrypted))
    .update(`${timestamp}.${body}`)
    .digest('hex');
  let response: Response;
  try {
    response = await fetch(url, {
      method: 'POST',
      redirect: 'manual',
      signal: AbortSignal.timeout(10_000),
      headers: {
        'content-type': 'application/json',
        'user-agent': 'backend-foundation-webhooks/1.0',
        'x-webhook-id': delivery.eventId,
        'x-webhook-signature': `t=${timestamp},v1=${signature}`,
      },
      body,
    });
  } catch (error) {
    await prisma.customerWebhookDelivery.update({
      where: { id: delivery.id },
      data: {
        attempts: { increment: 1 },
        lastError: error instanceof Error ? error.message : 'Network error',
      },
    });
    throw error;
  }
  await prisma.customerWebhookDelivery.update({
    where: { id: delivery.id },
    data: {
      attempts: { increment: 1 },
      lastStatusCode: response.status,
      ...(response.ok
        ? { deliveredAt: new Date(), lastError: null }
        : { lastError: `HTTP ${response.status}` }),
    },
  });
  if (!response.ok) throw new Error(`Customer webhook returned HTTP ${response.status}`);
}
