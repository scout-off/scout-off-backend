# Indexer webhook dispatch queue (#1795)

After persisted events are indexed, they are **enqueued**, not delivered inline with the poll. Work is queued **per subscriber**, so the concurrency limit applies to outbound webhook requests, not merely to events. The existing signing, subscriber health, retry/backoff, and dead-letter logic in `src/services/webhooks.ts` remains in use.

## Configuration

- `WEBHOOK_DISPATCH_CONCURRENCY` (default `10`, positive integer): maximum concurrent subscriber deliveries per process.
- `WEBHOOK_DISPATCH_MAX_QUEUE` (default `1000`, positive integer): maximum pending subscriber deliveries, excluding those currently running.

When the queue is full, the producer **backpressures the indexer poll** until a slot is available. There is no silent event drop when queue capacity is reached. Ordinary polls under capacity no longer wait for remote subscriber latency. The indexer cursor advances after the batch has been accepted into the queue, not after remote delivery.

At graceful shutdown the scheduler stops, the queue drains until the shutdown deadline, then unfinished deliveries are persisted to the existing webhook dead-letter table **before closing the DB**. Active deliveries may also finish after being dead-lettered on a deadline; subscribers should dedupe with `deliveryId` (at-least-once semantics). A hard process crash can still lose in-memory queued deliveries; **this is not a durable outbox**. For crash-safe delivery use the separate durable-outbox initiative (#1101).

## Prometheus metrics

The existing `/metrics` endpoint includes:

- `scout_off_webhook_dispatch_queue_depth` (gauge): currently pending subscriber deliveries.
- `scout_off_webhook_dispatch_active` (gauge): currently active subscriber deliveries.
- `scout_off_webhook_dispatch_duration_seconds_sum` (summary): cumulative outbound dispatch time in seconds, including any webhook retries.
- `scout_off_webhook_dispatch_duration_seconds_count` (summary): completed dispatch attempts.

Monitor sustained queue growth and the ratio of dispatch count to delivered/dead-lettered requests. These are **per-process** gauges, not globally aggregated metrics across pods.

## Limitations

- This mechanism is in-memory; an abrupt process crash may lose already-enqueued work until the durable outbox exists.
- A queue-full event can increase poll time by design; this is bounded backpressure, not remote latency blocking on every normal poll.
- The existing webhook dead-letter repository is currently SQLite-specific. Production Postgres dead-letter migration remains separate from this issue.
