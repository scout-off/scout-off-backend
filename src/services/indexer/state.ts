/**
 * indexer/state.ts
 *
 * Mutable module-level state owned by the indexer (split out of
 * services/indexer.ts).
 *
 * These three counters are read directly by src/app.ts — the readiness probe
 * (/ready, /health/readiness) and the Prometheus gauges — so they must stay
 * live bindings rather than values copied into the barrel. services/indexer.ts
 * therefore re-exports them with `export { ... } from`, which TypeScript emits
 * as getter-backed accessors (a live read of the binding declared here).
 *
 * Mutations go through the setters below so the write always lands on this
 * module's binding — the one the barrel's getters read.
 */

/** Current indexer lag in ledgers (latestChainLedger - lastIndexedLedger). Reset after each poll. */
export let indexerLedgerLag = 0;

/** Epoch ms of the last successful indexEvents() run (0 = never succeeded). */
export let indexerLastSuccessAt = 0;

/** Lifetime count of poll failures (thrown errors in indexEvents()). */
export let indexerPollFailuresTotal = 0;

/** Publish the indexer's ledger lag (in ledgers). */
export function setIndexerLedgerLag(lag: number): void {
  indexerLedgerLag = lag;
}

/** Record the completion time of a successful poll (defaults to now). */
export function markIndexerSuccess(at: number = Date.now()): void {
  indexerLastSuccessAt = at;
}

/** Count one poll failure. */
export function incrementIndexerPollFailures(): void {
  indexerPollFailuresTotal += 1;
}
