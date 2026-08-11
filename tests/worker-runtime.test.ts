import { describe, expect, it, vi } from 'vitest';
import { buildWorkerRuntime } from '#app/runtime/worker-runtime.js';

describe('worker composition root', () => {
  it('constructs no optional infrastructure when every worker module is disabled', async () => {
    const createProviders = vi.fn();
    const createQueues = vi.fn();
    const startScheduler = vi.fn();
    const startMetricsServer = vi.fn();

    const runtime = await buildWorkerRuntime({
      modules: {
        outbox: false,
        scheduler: false,
        billing: false,
        uploads: false,
        metrics: false,
      },
      dependencies: {
        createNotificationProviders: createProviders,
        createOutboxQueues: createQueues,
        startScheduler,
        startMetricsServer,
      },
    });

    expect(createProviders).not.toHaveBeenCalled();
    expect(createQueues).not.toHaveBeenCalled();
    expect(startScheduler).not.toHaveBeenCalled();
    expect(startMetricsServer).not.toHaveBeenCalled();
    expect(runtime.workers).toEqual([]);
    await runtime.close();
  });

  it('uses injected process factories and closes only the resources it constructed', async () => {
    const providerClose = vi.fn().mockResolvedValue(undefined);
    const providers = { close: providerClose };
    const queues = { EMAIL: {}, SMS: {}, PUSH: {}, INTERNAL: {} };
    const workerClose = vi.fn().mockResolvedValue(undefined);
    const workers = [{ close: workerClose }];
    const schedulerClose = vi.fn().mockResolvedValue(undefined);
    const scheduler = { queue: {}, worker: {}, close: schedulerClose };
    const startWorkers = vi.fn().mockReturnValue(workers);
    const startRelay = vi.fn();
    const stopRelay = vi.fn();
    const closeQueues = vi.fn().mockResolvedValue(undefined);
    const startScheduler = vi.fn().mockResolvedValue(scheduler);

    const runtime = await buildWorkerRuntime({
      modules: {
        outbox: true,
        scheduler: true,
        billing: false,
        uploads: false,
        metrics: false,
      },
      dependencies: {
        notificationProviders: providers,
        outboxQueues: queues,
        startNotificationWorkers: startWorkers,
        startOutboxRelay: startRelay,
        stopOutboxRelay: stopRelay,
        closeOutboxQueues: closeQueues,
        startScheduler,
      } as never,
    });

    expect(startWorkers).toHaveBeenCalledWith(providers, {
      stripeClient: null,
      uploadProvider: null,
    });
    expect(startRelay).toHaveBeenCalledWith(queues);
    expect(startScheduler).toHaveBeenCalledOnce();

    await runtime.close();
    expect(stopRelay).toHaveBeenCalledOnce();
    expect(workerClose).toHaveBeenCalledOnce();
    expect(closeQueues).toHaveBeenCalledWith(queues);
    expect(schedulerClose).toHaveBeenCalledOnce();
    expect(providerClose).toHaveBeenCalledOnce();
  });
});
