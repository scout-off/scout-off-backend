// Avoid starting real network, metrics, or DB operations while testing the queue.
jest.mock('../../src/config', () => ({
  __esModule: true,
  default: { webhook: { dispatchConcurrency: 2, dispatchMaxQueue: 2 } },
}));
jest.mock('../../src/db', () => ({
  listWebhookSubscriptions: jest.fn(() => []),
  insertWebhookDeadLetter: jest.fn(),
}));
jest.mock('../../src/services/webhooks', () => ({
  dispatchWebhookToSubscription: jest.fn(),
  generateDeliveryId: jest.fn(() => 'id'),
}));
jest.mock('../../src/services/webhookHealth', () => ({ isSuspended: jest.fn(() => false) }));
jest.mock('../../src/services/txCorrelation', () => ({ withRestoredCorrelation: jest.fn() }));
jest.mock('../../src/middleware/metrics', () => ({
  incrementWebhookDeadLettersTotal: jest.fn(),
  recordWebhookDelivery: jest.fn(),
  setWebhookDispatchQueueDepth: jest.fn(),
  observeWebhookDispatchQueueLatency: jest.fn(),
}));
jest.mock('../../src/utils/logger', () => ({ logger: { warn: jest.fn() } }));

import { BoundedDispatchQueue } from '../../src/services/indexerWebhookQueue';

const pause = () => new Promise<void>((r) => setImmediate(r));

describe('BoundedDispatchQueue (#1795)', () => {
  it('limits concurrent dispatches and eventually processes all accepted items', async () => {
    let active = 0;
    let maxActive = 0;
    const processed: number[] = [];
    const queue = new BoundedDispatchQueue<number>(
      3,
      4,
      async (item) => {
        active++;
        maxActive = Math.max(maxActive, active);
        await new Promise<void>((resolve) => setTimeout(resolve, 2));
        processed.push(item);
        active--;
      },
      () => {
        throw new Error('unexpected dead-letter');
      },
    );

    await Promise.all(Array.from({ length: 50 }, (_, i) => queue.enqueue(i)));
    await queue.drain(5000);
    expect(maxActive).toBeLessThanOrEqual(3);
    expect(processed.sort((a, b) => a - b)).toEqual(Array.from({ length: 50 }, (_, i) => i));
    expect(queue.pendingCount).toBe(0);
    expect(queue.activeCount).toBe(0);
  });

  it('accepts an event without awaiting a slow webhook response', async () => {
    let release: () => void = () => {};
    const slow = new Promise<void>((resolve) => {
      release = resolve;
    });
    const queue = new BoundedDispatchQueue<number>(
      1,
      2,
      async () => slow,
      () => undefined,
    );
    await queue.enqueue(42); // If this awaited the webhook, the test would hang.
    expect(queue.activeCount).toBe(1);
    release();
    await queue.drain(500);
  });

  it('backpressures a full queue rather than dropping work', async () => {
    let releaseFirst: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    const processed: number[] = [];
    const queue = new BoundedDispatchQueue<number>(
      1,
      1,
      async (item) => {
        if (item === 1) await gate;
        processed.push(item);
      },
      () => {
        throw new Error('unexpected dead-letter');
      },
    );
    await queue.enqueue(1);
    await queue.enqueue(2);
    let accepted = false;
    const third = queue.enqueue(3).then(() => {
      accepted = true;
    });
    await pause();
    expect(accepted).toBe(false);
    releaseFirst();
    await third;
    await queue.drain(500);
    expect(processed).toEqual([1, 2, 3]);
  });

  it('dead-letters unfinished work when the shutdown deadline expires', async () => {
    const never = new Promise<void>(() => undefined);
    const deadLetters: number[] = [];
    const queue = new BoundedDispatchQueue<number>(
      1,
      2,
      async () => never,
      (item) => {
        deadLetters.push(item);
      },
    );
    await queue.enqueue(1);
    await queue.enqueue(2);
    await queue.drain(1);
    expect(deadLetters.sort()).toEqual([1, 2]);
    await expect(queue.enqueue(3)).rejects.toThrow('draining');
  });
});
