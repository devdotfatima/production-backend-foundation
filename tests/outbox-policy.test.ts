import { describe, expect, it } from 'vitest';
import { deliveryFailureDisposition, outboxJobId } from '../src/modules/outbox/outbox.policy.js';

describe('durable outbox delivery policy', () => {
  it('lets BullMQ retry transient failures until the configured final attempt', () => {
    expect(deliveryFailureDisposition(0, 5)).toBe('RETRY');
    expect(deliveryFailureDisposition(3, 5)).toBe('RETRY');
    expect(deliveryFailureDisposition(4, 5)).toBe('DEAD_LETTER');
  });

  it('treats a missing attempts configuration as a single final attempt', () => {
    expect(deliveryFailureDisposition(0, undefined)).toBe('DEAD_LETTER');
  });

  it('uses a new BullMQ identity after an explicit redrive', () => {
    expect(outboxJobId('event-id', 0)).toBe('outbox-event-id-0');
    expect(outboxJobId('event-id', 1)).toBe('outbox-event-id-1');
  });
});
