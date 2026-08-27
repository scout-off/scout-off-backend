# Reindexing

The reindex feature replays historical Soroban contract events into the
backend's local database. It is a sharp operational tool — use it with care.

## When to Reindex

Reindex when the local database has fallen out of sync with on-chain state,
typically after:

- A database migration that added a new event-derived table that must be
  backfilled from historical events
- A bug fix that caused events to be skipped or incorrectly processed
- Manual database intervention that deleted or corrupted indexed events
- A prolonged outage where the live indexer's cursor advanced past events
  that were never recorded locally

**Do not reindex** for routine maintenance. The live indexer keeps the
database in sync under normal operation. Reindexing is a heavyweight
operation that temporarily pauses the live cursor.

## How to Reindex

### 1. Start a reindex job

```bash
curl -X POST http://localhost:4000/api/admin/reindex \
  -H "Authorization: Bearer <admin-token>" \
  -H "Content-Type: application/json" \
  -d '{
    "startLedger": 100000,
    "endLedger": 110000
  }'
```

| Field | Required | Description |
| ----- | -------- | ----------- |
| `startLedger` | Yes | First ledger sequence to replay (inclusive) |
| `endLedger` | Yes | Last ledger sequence to replay (inclusive) |

### Range limit

The difference `endLedger - startLedger + 1` must not exceed
`MAX_REINDEX_RANGE` (**10,000 ledgers**). Larger ranges must be split into
multiple reindex jobs run sequentially.

### Response (accepted)

```json
{
  "status": "started",
  "jobId": "reindex-2026-08-27T10-00-00Z",
  "startLedger": 100000,
  "endLedger": 110000,
  "totalLedgers": 10001
}
```

### Response (rejected — another job running)

```json
{
  "error": "A reindex job is already in progress",
  "activeJobId": "reindex-2026-08-27T09-00-00Z"
}
```

Only **one reindex job** can run at a time (singleton guard). Attempting to
start a second job returns `409 Conflict` with the active job's ID.

## How Reindex Works

The reindexer processes the requested ledger range in **batches of
100 ledgers**, with a **50 ms delay** between batches to avoid overwhelming
the Soroban RPC endpoint.

```
For each batch of 100 ledgers:
  1. Fetch events from Soroban RPC for the batch range
  2. Insert/process events in the local database
  3. Write an audit log entry for each batch
  4. Wait 50 ms
  5. Advance to the next batch
```

### Interaction with the live indexer

While a reindex job is running:

- The **live indexer cursor is paused** — new on-chain events are not
  processed, preventing race conditions between live and historical events.
- On reindex **completion**, the live cursor is **rewound** to the reindex
  job's `endLedger + 1`, ensuring no gap between replayed and live events.
- If the reindex job is **cancelled** (or crashes), the live cursor is
  **not** rewound — it resumes from where it left off.

## Polling Progress

`GET /api/admin/reindex/:jobId/status` (requires admin JWT)

```bash
curl http://localhost:4000/api/admin/reindex/reindex-2026-08-27T10-00-00Z/status \
  -H "Authorization: Bearer <admin-token>"
```

### Response fields

| Field | Type | Description |
| ----- | ---- | ----------- |
| `status` | string | One of `running`, `completed`, `failed`, `cancelled` |
| `jobId` | string | The job identifier |
| `startLedger` | number | Starting ledger of the reindex range |
| `endLedger` | number | Ending ledger of the reindex range |
| `ledgersProcessed` | number | Number of ledgers processed so far |
| `totalLedgers` | number | Total ledgers in the range |
| `eventsInserted` | number | Number of events inserted/replayed so far |
| `currentLedger` | number | Last ledger fully processed |
| `progressPercent` | number | `ledgersProcessed / totalLedgers * 100` |
| `errorMessage` | string | Present only when `status` is `failed` |
| `startedAt` | string (ISO 8601) | When the job was started |
| `completedAt` | string (ISO 8601) | When the job finished (null while running) |

### State meanings

| State | Meaning |
| ----- | ------- |
| `running` | The job is actively processing ledgers. Poll periodically to track progress. |
| `completed` | All ledgers in the range have been processed. The live cursor has been rewound. |
| `failed` | The job encountered an unrecoverable error. Check `errorMessage`. The live cursor is **not** rewound. |
| `cancelled` | An admin cancelled the job via `POST /api/admin/reindex/:jobId/cancel`. The live cursor is **not** rewound. |

### Example responses

**In progress (60% done):**

```json
{
  "status": "running",
  "jobId": "reindex-2026-08-27T10-00-00Z",
  "startLedger": 100000,
  "endLedger": 110000,
  "ledgersProcessed": 6000,
  "totalLedgers": 10001,
  "eventsInserted": 42,
  "currentLedger": 106000,
  "progressPercent": 59.99,
  "startedAt": "2026-08-27T10:00:02.000Z",
  "completedAt": null
}
```

**Completed:**

```json
{
  "status": "completed",
  "jobId": "reindex-2026-08-27T10-00-00Z",
  "startLedger": 100000,
  "endLedger": 110000,
  "ledgersProcessed": 10001,
  "totalLedgers": 10001,
  "eventsInserted": 73,
  "currentLedger": 110000,
  "progressPercent": 100,
  "startedAt": "2026-08-27T10:00:02.000Z",
  "completedAt": "2026-08-27T10:05:33.000Z"
}
```

## Cancelling a Reindex

`POST /api/admin/reindex/:jobId/cancel` (requires admin JWT)

```bash
curl -X POST http://localhost:4000/api/admin/reindex/reindex-2026-08-27T10-00-00Z/cancel \
  -H "Authorization: Bearer <admin-token>"
```

Cancellation is graceful — the current batch completes before the job stops.
The audit log records a `reindex.cancelled` entry.

## Audit Trail

Every reindex lifecycle event is written to the audit log (see
[docs/audit-log.md](audit-log.md)):

| Event | When |
| ----- | ---- |
| `reindex.start` | Job is accepted and begins processing |
| `reindex.complete` | All ledgers processed successfully |
| `reindex.cancelled` | Admin requests cancellation (after current batch finishes) |

Audit entries include the job ID, ledger range, and (on completion) the
total events inserted, enabling post-hoc verification that a reindex
produced the expected number of events.

## Troubleshooting

### \"A reindex job is already in progress\"

A previous reindex job is still running. Poll its status with
`GET /api/admin/reindex/:jobId/status`. If the job appears stuck (no
progress for > 5 minutes), cancel it and restart.

### Reindex is very slow

Each batch (100 ledgers) requires a Soroban RPC round-trip. At ~1 second
per batch, 10,000 ledgers takes ~100 seconds. If it's slower:

- Check Soroban RPC latency from the server (`curl $SOROBAN_RPC_URL/health`)
- Reduce network hops between the backend and the RPC endpoint
- If the RPC endpoint is rate-limiting, increase the 50 ms delay by setting
  `REINDEX_BATCH_DELAY_MS` (default: 50)

### Cursor-rewind side effect after completion

When a reindex job completes, the live indexer cursor is set to
`endLedger + 1`. This means any events between the old cursor position and
`startLedger` that were previously indexed will be re-encountered by the
live indexer. The indexer is designed to handle this (idempotent event
inserts keyed by transaction hash), but it may cause a brief spike in
indexer CPU and database writes as duplicates are skipped.

## Related Documents

- [DEPLOYMENT.md](DEPLOYMENT.md) — environment configuration
- [docs/audit-log.md](audit-log.md) — audit log schema and verification
- `src/services/reindex.ts` — reindex implementation
- `src/services/indexer.ts` — live indexer and cursor management
