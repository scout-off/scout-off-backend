/**
 * Bounded, in-process indexer webhook fan-out (#1795).
 *
 * A work item represents ONE subscriber delivery (not one event), so the
 * configured concurrency is also the maximum simultaneous outbound requests.
 * Backpressure is intentional: if the pending queue fills, indexing pauses
 * until space exists. A process crash can still lose in-memory work; a durable
 * outbox is tracked separately in #1101.
 */
import config from '../config';
import { listWebhookSubscriptions, insertWebhookDeadLetter } from '../db';
import type { WebhookSubscription } from '../db';
import { withRestoredCorrelation } from './txCorrelation';
import { dispatchWebhookToSubscription, generateDeliveryId } from './webhooks';
import { isSuspended } from './webhookHealth';
import { logger } from '../utils/logger';
import { getCorrelationId } from '../utils/requestContext';
import {
  incrementWebhookDeadLettersTotal,
  recordWebhookDelivery,
  setWebhookDispatchQueueDepth,
  observeWebhookDispatchQueueLatency,
} from '../middleware/metrics';

export interface IndexerWebhookEvent {
  type: string;
  payload: unknown;
  txHash: string;
  ledger: number;
}

interface Delivery extends IndexerWebhookEvent {
  subscription: WebhookSubscription;
  deliveryId: string;
  enqueuedAt: number;
}

/** Generic queue exported for deterministic concurrency and shutdown tests. */
export class BoundedDispatchQueue<T> {
  private readonly pending: T[] = [];
  private readonly active = new Set<T>();
  private readonly spaceWaiters: Array<() => void> = [];
  private readonly idleWaiters: Array<() => void> = [];
  private closed = false;

  constructor(
    private readonly concurrency: number,
    private readonly maxPending: number,
    private readonly dispatch: (item: T) => Promise<void>,
    private readonly deadLetter: (item: T, reason: string) => void,
    private readonly observe: (pending: number, active: number, durationMs?: number) => void = () => undefined,
  ) {
    if (!Number.isSafeInteger(concurrency) || concurrency < 1 || !Number.isSafeInteger(maxPending) || maxPending < 1) {
      throw new Error('Webhook queue concurrency and capacity must be positive integers');
    }
  }

  get pendingCount(): number { return this.pending.length; }
  get activeCount(): number { return this.active.size; }

  /** Resolves once accepted, NOT once delivered. Waits on a full queue. */
  async enqueue(item: T): Promise<void> {
    while (!this.closed && this.pending.length >= this.maxPending) {
      await new Promise<void>((resolve) => this.spaceWaiters.push(resolve));
    }
    if (this.closed) throw new Error('Webhook queue is draining');
    this.pending.push(item);
    this.pump();
  }

  private signalCapacity(): void {
    const next = this.spaceWaiters.shift();
    next?.();
  }

  private signalIdle(): void {
    if (this.pending.length || this.active.size) return;
    while (this.idleWaiters.length) this.idleWaiters.shift()?.();
  }

  private pump(): void {
    while (!this.closed && this.active.size < this.concurrency && this.pending.length) {
      const item = this.pending.shift()!;
      this.active.add(item);
      this.signalCapacity();
      this.observe(this.pending.length, this.active.size);
      const startedAt = Date.now();
      void Promise.resolve().then(() => this.dispatch(item)).catch((err: unknown) => {
        // Single-delivery dispatch normally persists its own dead letter;
        // an unexpected failure here must still be recorded.
        this.deadLetter(item, `dispatch_error: ${err instanceof Error ? err.message : String(err)}`);
      }).finally(() => {
        this.active.delete(item);
        this.observe(this.pending.length, this.active.size, Date.now() - startedAt);
        if (!this.closed) this.pump();
        this.signalIdle();
      });
    }
    this.observe(this.pending.length, this.active.size);
  }

  /** Drain until deadline, then dead-letter all work not known to have completed. */
  async drain(timeoutMs: number): Promise<void> {
    // Prevent any new work while allowing the existing queue to progress.
    // This is invoked after indexer schedulers/jobs have been stopped.
    if (!this.pending.length && !this.active.size) {
      this.closed = true;
      while (this.spaceWaiters.length) this.spaceWaiters.shift()?.();
      return;
    }
    let timeout: ReturnType<typeof setTimeout> | undefined;
    const idle = new Promise<void>((resolve) => this.idleWaiters.push(resolve));
    await Promise.race([
      idle,
      new Promise<void>((resolve) => {
        timeout = setTimeout(resolve, Math.max(0, timeoutMs));
      }),
    ]);
    if (timeout) clearTimeout(timeout);
    this.closed = true;
    while (this.spaceWaiters.length) this.spaceWaiters.shift()?.();

    // Dead-letter queued and potentially in-flight work BEFORE the database closes.
    // In-flight deliveries may still succeed afterward: consumers should dedupe
    // with deliveryId (at-least-once semantics, never claim exactly-once delivery).
    const unfinished = [...this.pending, ...this.active];
    this.pending.length = 0;
    for (const item of unfinished) this.deadLetter(item, 'graceful_shutdown_deadline');
    this.observe(0, this.active.size);
  }
}

function persistUndeliveredDelivery(item: Delivery, reason: string): void {
  insertWebhookDeadLetter({
    subscriptionId: item.subscription.id,
    url: item.subscription.url,
    eventType: item.type,
    payload: JSON.stringify({ deliveryId: item.deliveryId, eventType: item.type, payload: item.payload }),
    deliveryId: item.deliveryId,
    failureReason: reason,
    attempts: 0,
  });
  recordWebhookDelivery('dead_letter');
  incrementWebhookDeadLettersTotal();
}

const queue = new BoundedDispatchQueue<Delivery>(
  config.webhook.dispatchConcurrency,
  config.webhook.dispatchMaxQueue,
  async (item) => {
    await withRestoredCorrelation(item.txHash, 'indexer.webhookDispatch', async () => {
      const correlationId = getCorrelationId();
      await dispatchWebhookToSubscription(
        item.subscription,
        item.type,
        {
          deliveryId: item.deliveryId, eventType: item.type, payload: item.payload,
          ...(correlationId ? { correlationId } : {}),
        },
        item.deliveryId,
      );
    }, undefined, { 'stellar.ledger': item.ledger, 'scoutoff.event_type': item.type });
  },
  (item, reason) => {
    persistUndeliveredDelivery(item, reason);
    logger.warn(`[indexer] webhook delivery dead-lettered: ${reason}, event=${item.type}`);
  },
  (pending, active, durationMs) => {
    setWebhookDispatchQueueDepth(pending, active);
    if (durationMs !== undefined) observeWebhookDispatchQueueLatency(durationMs);
  },
);

/** Queue events without awaiting subscriber HTTP delivery. */
export async function enqueueIndexerWebhookEvents(events: readonly IndexerWebhookEvent[]): Promise<void> {
  if (!events.length) return;
  const subscriptions = listWebhookSubscriptions().filter((sub) => !isSuspended(sub));
  for (const event of events) {
    const deliveryId = generateDeliveryId();
    for (const subscription of subscriptions) {
      await queue.enqueue({ ...event, subscription, deliveryId, enqueuedAt: Date.now() });
    }
  }
}

export async function drainIndexerWebhookQueue(deadlineMs: number): Promise<void> {
  await queue.drain(deadlineMs);
}

export function getIndexerWebhookQueueSize(): number {
  return queue.pendingCount + queue.activeCount;
}
