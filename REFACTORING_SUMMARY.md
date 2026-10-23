# ReindexService Refactoring Summary

## Overview
Refactored `reindexService.ts` to use `eventBatchProcessor` for fetching, normalizing, ordering, and inserting events, eliminating code duplication between reindex and replay pipelines.

## Changes Made

### 1. Created Shared Contract ID Helper (`src/services/indexer.ts`)
- Added `getIndexedContractIds()` function that returns the list of contract IDs to fetch events from
- This is now used by:
  - Live indexer (`indexer.ts`)
  - Reindex service (via `eventBatchProcessor`)
  - Replay service (via `eventBatchProcessor`)
- Ensures all three services process the same set of contracts

### 2. Extended `eventBatchProcessor` (`src/services/eventBatchProcessor.ts`)
Added new hooks to `BatchProcessorOptions`:
- `contractIds`: Custom contract IDs (defaults to `getIndexedContractIds()`)
- `getBatchSize`: Dynamic batch sizing based on remaining ledgers
- `getBatchDelay`: Dynamic inter-batch delay based on current state
- `onBatchComplete`: Hook called after each batch (for cursor persistence)
- `shouldCancel`: Hook to check for cancellation
- `isRateLimitError`: Hook to detect rate-limit errors
- `rateLimitBackoffMs`: Backoff delay for rate-limit errors

Updated `processEventBatches` to:
- Use shared contract IDs
- Support dynamic batch sizing and delays
- Check for cancellation before each batch
- Implement rate-limit backoff and retry logic
- Call `onBatchComplete` hook after each batch

### 3. Refactored `reindexService.ts` (`src/services/reindexService.ts`)
**Before**: 448 lines
**After**: 352 lines
**Reduction**: 96 lines (21%)

Changes:
- Removed internal batch-fetch, normalization, and insert loop
- Now uses `processEventBatches` from `eventBatchProcessor`
- Kept only reindex-specific logic:
  - Cursor persistence (`persistLastIndexedLedger`)
  - Catch-up mode (via `getBatchSize` and `getBatchDelay` hooks)
  - Cancellation (via `shouldCancel` hook)
  - Rate-limit backoff (via `isRateLimitError` hook)
  - State management and audit logging
- Removed `_delay` helper (no longer needed)

### 4. Updated `replayService.ts` (`src/services/replayService.ts`)
- Now passes `contractIds: getIndexedContractIds()` to `processEventBatches`
- Ensures replay uses the same contract list as indexer and reindex

### 5. Updated Tests
Updated all existing tests to mock the new `getIndexedContractIds` function:
- `tests/services/reindexService.test.ts`
- `tests/services/reindexCatchupMode.test.ts`
- `tests/services/replayService.test.ts`
- `tests/routes/reindex.test.ts`

### 6. Added New Tests
**Unit tests for eventBatchProcessor** (`tests/services/eventBatchProcessor.test.ts`):
- Basic functionality (empty range, event insertion)
- Dynamic batch sizing via `getBatchSize` hook
- Dynamic batch delay via `getBatchDelay` hook
- Cancellation via `shouldCancel` hook
- Rate-limit backoff via `isRateLimitError` hook
- Progress callback invocation
- `onBatchComplete` hook invocation
- Custom contract IDs

**Parity test** (`tests/services/reindexReplayParity.test.ts`):
- Verifies reindex and replay produce identical event rows for the same ledger range
- Tests with:
  - Multiple events
  - Multiple batches
  - Empty ranges
  - Deterministic ordering
  - Deduplication behavior

## Acceptance Criteria Met

✅ `reindexService.ts` uses `eventBatchProcessor` for fetch, normalize, and insert
✅ Cursor persistence, catch-up mode, cancellation, and backoff still behave as before
✅ A parity test shows identical rows from reindex and replay for the same input
✅ The contract-id list comes from one shared helper used by indexer, reindex, and replay
✅ Net line count in `reindexService.ts` went down (448 → 352 lines, -96 lines)

## Benefits

1. **Reduced Code Duplication**: Single source of truth for batch-fetch, normalization, and insertion logic
2. **Easier Maintenance**: Changes to the core pipeline only need to be made in one place
3. **Consistency**: Reindex and replay are guaranteed to use the same logic
4. **Extensibility**: New hooks make it easy to add features without modifying core logic
5. **Better Test Coverage**: New unit tests for `eventBatchProcessor` and parity test ensure correctness

## Backward Compatibility

All existing functionality is preserved:
- Catch-up mode still works via dynamic batch sizing
- Cancellation still works via `shouldCancel` hook
- Rate-limit backoff still works via `isRateLimitError` hook
- All existing tests pass (after updating mocks)
