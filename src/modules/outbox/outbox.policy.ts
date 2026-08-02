export const OUTBOX_MAX_DELIVERY_ATTEMPTS = 5;

export type DeliveryFailureDisposition = 'RETRY' | 'DEAD_LETTER';

export function deliveryFailureDisposition(
  attemptsMadeBeforeCurrentAttempt: number,
  configuredAttempts: number | undefined,
): DeliveryFailureDisposition {
  const maximumAttempts = Math.max(1, configuredAttempts ?? 1);
  return attemptsMadeBeforeCurrentAttempt + 1 >= maximumAttempts ? 'DEAD_LETTER' : 'RETRY';
}

export function outboxJobId(outboxId: string, deliveryGeneration: number): string {
  return `outbox-${outboxId}-${deliveryGeneration}`;
}
