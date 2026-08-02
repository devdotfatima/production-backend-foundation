import { describe, expect, it } from 'vitest';
import { outboxQueueNames } from '../dist/src/queues/notification.queue.js';

describe('outbox queue isolation', () => {
  it('assigns every delivery channel a distinct queue', () => {
    expect(new Set(Object.values(outboxQueueNames)).size).toBe(4);
    expect(outboxQueueNames.INTERNAL).not.toBe(outboxQueueNames.EMAIL);
  });
});
