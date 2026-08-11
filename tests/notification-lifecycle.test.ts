import { createHmac } from 'node:crypto';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  preferenceUpsert: vi.fn(),
  deliveryUpdateMany: vi.fn(),
  suppressionUpsert: vi.fn(),
}));

vi.mock('#app/config/env.js', () => ({
  env: {
    TOKEN_HASH_SECRET: 'token-secret-at-least-32-characters-long',
    EMAIL_EVENT_WEBHOOK_SECRET: 'email-event-secret-at-least-32-characters',
  },
}));
vi.mock('#app/lib/request-context.js', () => ({
  getRequestContext: () => ({ kind: 'request', requestId: 'request-1', userId: 'user-1' }),
  withoutTenantScope: (_reason: string, operation: () => unknown) => operation(),
}));
vi.mock('#app/lib/crypto.js', () => ({
  normalizeEmail: (value: string) => value.trim().toLowerCase(),
  hashMetadata: (value: string) => `current:${value}`,
  candidateMetadataHashes: (value: string) => [`current:${value}`, `legacy:${value}`],
}));
vi.mock('#app/lib/prisma.js', () => {
  const transaction = {
    notificationDelivery: { updateMany: mocks.deliveryUpdateMany },
    emailSuppression: { upsert: mocks.suppressionUpsert },
  };
  return {
    prisma: {
      notificationPreference: { upsert: mocks.preferenceUpsert },
      $transaction: (operation: (tx: typeof transaction) => unknown) => operation(transaction),
    },
  };
});

import { processEmailProviderEvent } from '#app/modules/notifications/email-events.service.js';
import {
  createUnsubscribeToken,
  unsubscribeWithToken,
  verifyUnsubscribeToken,
} from '#app/modules/notifications/unsubscribe.js';

const userId = '00000000-0000-7000-8000-0000000000a1';

beforeEach(() => {
  vi.clearAllMocks();
  mocks.preferenceUpsert.mockResolvedValue({});
  mocks.deliveryUpdateMany.mockResolvedValue({ count: 1 });
  mocks.suppressionUpsert.mockResolvedValue({});
});

describe('signed one-click unsubscribe', () => {
  it('creates a global preference and rejects token tampering', async () => {
    const token = createUnsubscribeToken(userId, 'product_updates');

    await expect(unsubscribeWithToken(token)).resolves.toBe(true);
    const preference = mocks.preferenceUpsert.mock.calls[0]?.[0] as
      { create?: Record<string, unknown> } | undefined;
    expect(preference?.create).toMatchObject({
      userId,
      organizationId: null,
      scopeKey: 'global',
      channel: 'EMAIL',
      topic: 'product_updates',
      enabled: false,
    });

    const tampered = `${token.slice(0, -1)}${token.endsWith('a') ? 'b' : 'a'}`;
    expect(verifyUnsubscribeToken(tampered)).toBeNull();
    await expect(unsubscribeWithToken(tampered)).resolves.toBe(false);
    expect(mocks.preferenceUpsert).toHaveBeenCalledTimes(1);
  });

  it('rejects an expired token', () => {
    expect(verifyUnsubscribeToken(createUnsubscribeToken(userId, 'product_updates', 0))).toBeNull();
  });
});

describe('email provider event ingestion', () => {
  it('tracks complaints and suppresses the normalized destination hash', async () => {
    const rawBody = Buffer.from(
      JSON.stringify({
        id: 'provider-event-1',
        type: 'complaint',
        destination: 'Recipient@Example.com',
        provider: 'smtp-relay',
        messageId: 'provider-message-1',
      }),
    );
    const signature = createHmac('sha256', 'email-event-secret-at-least-32-characters')
      .update(rawBody)
      .digest('hex');

    await processEmailProviderEvent(rawBody, `sha256=${signature}`);

    const delivery = mocks.deliveryUpdateMany.mock.calls[0]?.[0] as
      { data?: { status?: string } } | undefined;
    expect(delivery?.data?.status).toBe('COMPLAINED');
    const suppression = mocks.suppressionUpsert.mock.calls[0]?.[0] as
      { where?: Record<string, unknown>; create?: Record<string, unknown> } | undefined;
    expect(suppression?.where).toEqual({ destinationHash: 'current:recipient@example.com' });
    expect(suppression?.create).toMatchObject({
      destinationHash: 'current:recipient@example.com',
      reason: 'COMPLAINT',
      providerEventId: 'provider-event-1',
    });
    expect(JSON.stringify(mocks.suppressionUpsert.mock.calls)).not.toContain(
      'Recipient@Example.com',
    );
  });

  it('rejects an invalid signature before touching delivery state', async () => {
    const rawBody = Buffer.from(
      JSON.stringify({
        id: 'provider-event-1',
        type: 'bounce',
        destination: 'recipient@example.com',
        provider: 'smtp-relay',
      }),
    );

    await expect(processEmailProviderEvent(rawBody, 'sha256=00')).rejects.toMatchObject({
      statusCode: 400,
    });
    expect(mocks.deliveryUpdateMany).not.toHaveBeenCalled();
    expect(mocks.suppressionUpsert).not.toHaveBeenCalled();
  });
});
