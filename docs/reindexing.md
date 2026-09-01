# Reindexing Documentation

## Overview

The reindex feature allows operators to replay blockchain events from a specific ledger, reprocessing them into the local database. This is useful for:

- **Recovering from indexer lag:** If the indexer falls behind the live chain, reindex from a known-good ledger.
- **Fixing data corruption:** If events were misinterpreted due to a bug, replay them with the fixed code.
- **Testing indexing logic:** In staging, simulate what happens when the indexer catches up to a past ledger.
- **Syncing a new instance:** Populate a fresh database by replaying all events from ledger 1.

**Key constraints:**
- Only one reindex operation can run at a time (singleton guard)
- Reindex rewinds the main indexer cursor on completion (side effect)
- The process batches events in chunks of ~100 ledgers to avoid memory pressure
- Failed reindexes leave the cursor in an intermediate state (see [Cleanup on Failure](#cleanup-on-failure))

## When to Reindex

| Scenario | Action | Notes |
|---|---|---|
| Indexer is stuck (no new events) | Check logs for errors; if none, reindex from last successful ledger | Safe to re-run if the first attempt fails |
| Missing milestone events | Reindex the ledger range when milestones were submitted | Deduplication via `tx_hash` ensures idempotency |
| Database corrupted after migration | Reindex entire contract history | Requires downtime; test recovery procedures in staging first |
| Deploying new backend instance | Reindex from ledger 1 to populate database | Consider seeding from a backup first to save time |
| Deployed code with event-handling bug | Fix the bug, then reindex affected ledger range | Existing events already inserted may need manual cleanup |

## Workflow

### 1. Initiate a Reindex

Send a POST request to the admin reindex endpoint with the ledger number to start from:

```bash
curl -X POST https://backend.example.com/api/admin/indexer/reindex \
  -H "Authorization: Bearer $ADMIN_JWT" \
  -H "Content-Type: application/json" \
  -d '{ "fromLedger": 123456 }'
```

**Request Body:**
```json
{
  "fromLedger": 123456
}
```

**Response:**
```json
{
  "success": true,
  "data": {
    "fromLedger": 123456,
    "previous": 123500
  }
}
```

The response confirms:
- `fromLedger`: The new cursor position (where indexing will resume from)
- `previous`: The prior cursor position (saved for recovery if needed)

**What happens internally:**
1. The endpoint validates `fromLedger >= 0`
2. The cursor (`last_ledger` in the database) is updated to `fromLedger`
3. The next polling cycle of the indexer will start fetching from `fromLedger`
4. An audit log entry is created with action `indexer_reindex`

**Constraints:**
- `fromLedger` must be a non-negative integer
- `fromLedger` cannot exceed the current tip of the chain (the system will fetch whatever exists)

### 2. Monitor Reindex Progress

The main indexer polls for new events every ~30 seconds (implementation detail). After initiating a reindex:

1. The next indexer poll will request events from `fromLedger`
2. Events matching contract filters are inserted into the `events` table
3. Deduplication via `UNIQUE(tx_hash)` ensures the same event is not inserted twice
4. Side effects (player creation, milestone processing) are triggered per event
5. The cursor advances as events are processed

**Checking progress:**

Currently, the system does not expose a dedicated reindex status endpoint. Progress can be inferred from:

- **Database query:** Check `last_ledger` in the internal cursor store:
  ```sql
  SELECT last_ledger FROM migration_state LIMIT 1;
  ```
  If this value is advancing, the indexer is making progress.

- **Event count:** Query the `events` table to see if new entries are appearing:
  ```sql
  SELECT COUNT(*) FROM events WHERE ledger >= 123456 ORDER BY ledger DESC LIMIT 1;
  ```

- **Logs:** Enable `LOG_LEVEL=debug` and watch for `[indexer]` log lines:
  ```
  [indexer] fetched 100 events from ledger 123456–123500
  [indexer] inserted events; new cursor=123501
  ```

- **Health endpoint:** `GET /health` continues to report the indexer lag:
  ```json
  {
    "status": "ok",
    "indexerLag": 245
  }
  ```
  As reindexing progresses, lag should decrease.

### 3. Verify Reindex Completion

The reindex is complete when:
- The cursor (`last_ledger`) reaches or exceeds the current chain tip
- Indexer logs show no new events being fetched
- The indexer lag is 0 or minimal

**Check final state:**
```bash
curl https://backend.example.com/health
```

Expected response when fully caught up:
```json
{
  "status": "ok",
  "indexerLag": 0
}
```

**Audit trail:**
```bash
curl https://backend.example.com/api/admin/audit-log?action=indexer_reindex \
  -H "Authorization: Bearer $ADMIN_JWT"
```

This shows all reindex operations initiated, with timestamps.

## Cursor Rewind Side Effect

**Important:** When you initiate a reindex with `fromLedger=N`, the indexer cursor is immediately set to `N`. This **rewinds** the cursor, and the indexer will replay events from that ledger onward.

**Example:**
- Current cursor: `1000000`
- You initiate reindex with `fromLedger=999900`
- Cursor is now `999900`
- The next indexer poll fetches events from ledger `999900`, re-inserting any that were already indexed

**Deduplication safety:** The `events` table has `UNIQUE(tx_hash)`, so re-inserting the same event is a no-op:
```sql
INSERT OR IGNORE INTO events (type, ledger, tx_hash, payload, created_at) VALUES (...)
```

However, **side effects may run twice** if they are triggered per-insert. For example:
- Milestone submitted → updates `pending_milestones`
- If reindexed, the same milestone submission event may create a duplicate pending entry

**Mitigation:**
- Side effects should be designed to be idempotent (safe to run multiple times)
- Use unique constraints (e.g., `UNIQUE(milestone_id)`) to prevent duplicates
- Test reindex in staging before using in production

## Range Limits

The reindexer processes events in batches to avoid memory exhaustion. Key limits:

| Limit | Value | Notes |
|---|---|---|
| Max batch size | ~100 ledgers | Fetches up to 100 ledgers per poll |
| Delay between batches | 50 ms | Backoff to avoid overwhelming Soroban RPC |
| Max reindex range | 10000 ledgers (TBD) | Safeguard to prevent single request from fetching too many events |

**Implication:** If you reindex from ledger 1 on mainnet (currently ~200M ledgers), it will take many days of continuous indexing to complete. Consider:
- Restoring from a database backup (faster)
- Running a separate reindex instance in parallel
- Scheduling reindex during low-traffic periods

## Status Fields

The pending reindex state (once a dedicated status endpoint is implemented) will expose:

```json
{
  "reindexId": "cktXXXXXXXXXXXXXXXXXXXXXX",
  "status": "running" | "completed" | "failed",
  "fromLedger": 123456,
  "toLedger": 123500,
  "ledgersProcessed": 44,
  "eventsInserted": 1250,
  "startedAt": 1725004800000,
  "completedAt": 1725004830000,
  "errorMessage": null | "..."
}
```

Field explanations:
- `status`: Lifecycle state (running → completed or failed)
- `ledgersProcessed`: Number of ledgers successfully indexed
- `eventsInserted`: Total events inserted (may be less than fetched if deduped)
- `errorMessage`: If failed, the reason (RPC error, database error, etc.)

## Interaction with Live Indexer

While a reindex is running:

1. **Live indexing is paused:** The main indexer polling loop waits for the reindex to complete before resuming normal polling.
2. **Cursor is rewound:** The reindex temporarily moves the cursor backward.
3. **Events are replayed:** Batches of events are fetched and reinserted.
4. **Cursor advances:** As batches complete, the cursor advances toward the chain tip.
5. **Normal polling resumes:** Once the reindex cursor reaches the chain tip, normal polling takes over.

**Singleton guard:** Only one reindex can run at a time. Attempting to initiate a second reindex while one is in progress returns an error (TBD: 409 Conflict or 400 Bad Request).

## Cleanup on Failure

If a reindex fails partway through (network error, RPC timeout, database crash), the cursor is left in an intermediate state.

**Recovery:**
1. **Identify the failure:** Check logs for error messages; they will indicate which ledger caused the problem.
2. **Fix the root cause:** If it's a temporary network issue, wait and retry. If it's a bug in the indexer, deploy a fix.
3. **Retry the reindex:** Initiate a new reindex from the same or later ledger. Because of deduplication, re-running is safe.

**Manual recovery (if needed):**
```bash
# Check the current cursor
sqlite3 scout-off.db "SELECT last_ledger FROM migration_state LIMIT 1;"

# If it's stuck at an intermediate ledger and you want to resume from a different point:
curl -X POST https://backend.example.com/api/admin/indexer/reindex \
  -H "Authorization: Bearer $ADMIN_JWT" \
  -d '{ "fromLedger": <new_ledger> }'
```

## Audit Trail

Every reindex is logged in the `audit_log` table:

```json
{
  "action": "indexer_reindex",
  "adminWallet": "GABC...",
  "queryParams": {
    "fromLedger": 123456,
    "previous": 123500,
    "outcome": "initiated" | "completed" | "failed"
  },
  "timestamp": "2025-08-29T12:00:00Z"
}
```

Use audit logs to:
- Trace who initiated each reindex
- Determine what ledger range was covered
- Detect if reindexes are failing repeatedly (indicates a deeper problem)

## Operational Runbook

### Scenario: Indexer Fell Behind Chain Tip

**Symptom:** `indexerLag` is growing, not shrinking.

**Steps:**
1. Check indexer logs: `grep "\[indexer\]" /var/log/scout-off.log | tail -20`
2. If logs show errors (RPC timeout, etc.), wait 5 minutes and check again. The indexer may catch up on its own.
3. If lag continues to grow, check the health of Soroban RPC and IPFS connectivity.
4. If external services are healthy but the indexer is still stuck, initiate a reindex:
   ```bash
   CURRENT_LAG=$(curl https://backend/health | jq .indexerLag)
   CURRENT_CURSOR=$(sqlite3 scout-off.db "SELECT last_ledger FROM migration_state LIMIT 1;")
   NEW_CURSOR=$((CURRENT_CURSOR - 1000))  # Go back 1000 ledgers to re-sync
   curl -X POST https://backend/api/admin/indexer/reindex \
     -H "Authorization: Bearer $ADMIN_JWT" \
     -d "{\"fromLedger\": $NEW_CURSOR}"
   ```
5. Monitor health endpoint until `indexerLag` returns to normal.
6. Review audit logs to confirm reindex completed successfully.

### Scenario: Deploying a Bug Fix to Event Handling

**Steps:**
1. Identify the ledger range affected (e.g., bug introduced at ledger 500000, fixed at deployment ledger 501000).
2. Deploy the fixed code to staging first and test with a reindex.
3. Once confirmed, deploy to production.
4. Initiate a reindex from the first affected ledger:
   ```bash
   curl -X POST https://backend/api/admin/indexer/reindex \
     -H "Authorization: Bearer $ADMIN_JWT" \
     -d '{ "fromLedger": 500000 }'
   ```
5. Monitor health and event counts to confirm the fix is working.

### Scenario: Recovering From Database Corruption

**Steps:**
1. Stop the backend (to prevent new writes during recovery).
2. Restore the database from the most recent backup:
   ```bash
   cp /var/backups/scout-off/scout-off-20250829T120000Z.db scout-off.db
   ```
3. Restart the backend.
4. Check the current cursor:
   ```sql
   SELECT last_ledger FROM migration_state LIMIT 1;
   ```
5. Initiate a reindex from that ledger to catch up to the chain tip.
6. Verify event counts and audit logs match expectations.

## Implementation Details

**Source:** `src/controllers/adminController.ts` (reindex endpoint)

**Related files:**
- `src/services/indexer.ts` — Indexing logic
- `src/db/index.ts` — Cursor management (`getLastLedger`, `setLastLedger`)
- `db/` — Migration files (schema for events table, etc.)

**Key functions:**
- `setLastLedger(ledger)` — Update the cursor (rewind)
- `getLastLedger()` — Retrieve the current cursor
- `indexEvents()` — Main polling/indexing loop

**Deduplication query:**
```sql
INSERT OR IGNORE INTO events (type, ledger, tx_hash, payload, created_at)
VALUES (?, ?, ?, ?, ?)
```

The `OR IGNORE` clause silently skips inserts for events already in the table (matched on `tx_hash`).

## Troubleshooting

### Reindex endpoint returns 400: Invalid fromLedger

**Cause:** `fromLedger` is missing or not an integer.

**Fix:**
```bash
# Ensure fromLedger is provided and is an integer
curl -X POST https://backend/api/admin/indexer/reindex \
  -H "Authorization: Bearer $ADMIN_JWT" \
  -d '{ "fromLedger": 123456 }'
```

### Reindex initiated but progress is not visible

**Cause:** Indexer polling loop may not have run yet, or reindex is running but very slow.

**Debug steps:**
1. Check indexer logs for `[indexer]` entries
2. Verify database has the new cursor:
   ```sql
   SELECT last_ledger FROM migration_state LIMIT 1;
   ```
3. Wait a few minutes (indexer polls every ~30 seconds)
4. Re-check event count to see if it's growing

### Events are being inserted but side effects (milestones, etc.) not triggering

**Cause:** Side effect logic may be skipped or deduped by a UNIQUE constraint.

**Debug steps:**
1. Check `pending_milestones` table for expected entries
2. Review event payload to ensure it matches the code's expectations
3. Add temporary logging to the side effect handler and redeploy
4. Re-run the reindex and check logs

### "Only one reindex at a time" error

**Cause:** Another reindex is in progress.

**Fix:**
1. Wait for the current reindex to complete (check cursor progression)
2. Once complete, initiate the new reindex

## References

- [Indexer Implementation](../src/services/indexer.ts)
- [Admin Controller (Reindex Endpoint)](../src/controllers/adminController.ts)
- [DEPLOYMENT.md: Reindexing Section](../DEPLOYMENT.md#reindexing)
- [Audit Log Documentation](docs/audit-log.md) (if available)
