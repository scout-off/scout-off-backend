Design: Mitigating unbounded instance-storage growth for `player_token`

Summary

The contract originally stored per-player holder lists and paged pending payouts inside the contract _instance_ storage map (via `env.storage().instance()`): a single per-contract-instance ledger entry whose read/write cost scales with the total serialized size of the map. As holder counts and payout pages grow indefinitely for a popular player, the instance entry size grows without bound, increasing the cost of _every_ contract call (not only calls touching that player) and eventually making the contract unusable.

Goal

Bound the contract's per-instance storage footprint so that a popular player's historic holder/payout data does not inflate the instance entry and raise the cost of unrelated operations.

Alternatives considered

1. Keep instance storage but paginate the lists inside instance storage
   - Pros: minimal API change; simple to implement.
   - Cons: still stores all pages inside the single instance map; while the in-memory representation can be logically paginated, the instance map's serialized size grows with total pages and still increases the instance read/write cost. This does NOT solve the core problem.

2. Move large/variable collections to `persistent` storage (per-key entries), keep only small per-player metadata in instance
   - Pros: Soroban persistent storage stores each key/value as a separate ledger entry, avoiding a single monolithic instance entry that grows with total data. Reads/writes to unrelated keys do not cost against a single large instance blob. Suitable for large collections.
   - Cons: Persistent keys have their own cost model (size, TTL bumping, and storage rent considerations). Access patterns that touch many persistent keys still pay per-key costs, but these are localized to the relevant player pages.

3. Use a bounded in-instance cache plus archival/hard-delete of old pages
   - Pros: Could keep hot recent data in instance and archive/expire old pages.
   - Cons: Requires careful eviction semantics and cross-instance coordination (who archives? when?). Deleting data from instance storage may still be expensive and, without persistent backing, could lose historical data.

4. Rework data model to use per-holder storage (balance keys) only and avoid a holder list entirely
   - Pros: No list state; per-holder balances are separate keys and can be iterated via an off-chain index.
   - Cons: Soroban currently does not provide efficient server-side iteration over all keys matching a prefix; iterating holders on-chain would be impossible without an explicit on-chain index (the very thing we are trying to avoid). Off-chain index+relayers are possible but shift complexity off-chain.

Decision and justification

We chose alternative (2): move holder pages, per-holder balances, pending payouts, and per-player token metadata into `persistent` storage as separate keys. The contract keeps only small, constant-cost instance items (admin flag, initialization marker). Specifically:

- Token metadata (`TokenMeta`) is stored persistently and augmented with a `holder_pages` count (u32) to locate holder pages.
- Holder addresses are stored as paginated pages under a per-player per-page key: `HolderPage(player_id, page_index)`.
- Pending payout pages are stored under `PendingPayouts(player_id, page)` in persistent storage.
- Per-holder balances remain stored per-key (`HolderBalance(player_id, holder)`) in persistent storage.

Why persistent storage?

- Persistent storage creates separate ledger entries per key, avoiding a single monolithic instance blob whose size affects every contract call.
- The new layout bounds the _instance_ storage footprint (it now contains only small, fixed keys) while allowing player-specific data to grow in a way that only affects operations touching that player.
- Paging keeps the per-call processing bounded (we still process at most `MAX_HOLDERS_PER_PAGE` per distribute call), and storing pages persistently prevents instance growth.

Tradeoffs

- Persistent storage is not free: each persistent key has its own cost, and reading many pages costs more than reading a single in-memory list. However, this cost is local to whoever processes that player's pages — it does not inflate the cost of unrelated operations on other players.
- We allocate a `holder_pages` counter in `TokenMeta` (also persistent) for quick page count access. The TokenMeta remains small (fixed-size scalar fields) and doesn't reintroduce unbounded instance growth.
- The contract no longer stores the monolithic holder vector in instance storage, which was the root cause of unbounded instance-size growth.

Implementation summary

- `DataKey::HolderList(player_id)` → replaced by `DataKey::HolderPage(player_id, page)`.
- `TokenMeta` gained `holder_pages: u32`.
- `issue_tokens` stores `TokenMeta` in persistent storage with `holder_pages = 0`.
- `buy_token` appends a buyer to the last `HolderPage`; if the last page is full (≥ `MAX_HOLDERS_PER_PAGE`), a new page is created and `holder_pages` incremented. All holder pages and balances are stored persistently.
- `distribute_fee(player_id, page)` reads exactly `HolderPage(player_id, page)` and writes `PendingPayouts(player_id, page)` persistently. No monolithic instance writes occur.
- `get_holders` reconstructs the full holder list by concatenating pages from 0..`holder_pages` (useful for small lists; heavy on-chain iteration remains possible but bounded by pages).

Testing and proof

- Unit tests simulate many unique buyers (200+) and successive `distribute_fee` calls across multiple pages. Tests assert that there is no monolithic holder list in instance storage and that pending payout pages are written to persistent storage.
- This proves the instance storage footprint no longer grows with holder/payout data.

Migration path for existing deployments

Existing deployed contracts will have data in the old layout (e.g. a `HolderList(player_id)` Vec stored in instance storage and `PendingPayouts` entries in instance). Migration requires coordination and an on-chain migration strategy. Options:

1. In-place on-chain migration via an admin-invoked `migrate_player(player_id)` function
   - The admin calls a migration method that reads the old `HolderList(player_id)` from instance storage, splits it into pages, writes those pages into persistent storage, writes `TokenMeta` into persistent storage with `holder_pages` set, and deletes the old `HolderList` entry from instance storage.
   - This must be called for each player with significant state. The migration function should include gas limits (e.g., process N holders per migration call) so it can be invoked iteratively with page indices.
   - Pros: fully on-chain, allows gradual migration.
   - Cons: migration transaction costs (gas) for the admin; requires careful gating to avoid DoS if many players have massive lists.

2. Off-chain migration using a privileged relayer
   - Off-chain agent reads the old instance storage (via RPC indexer), writes new persistent keys using a privileged admin operation that writes pages and removes the old instance entry.
   - Pros: avoid heavy on-chain read costs by batching; centralised control.
   - Cons: requires admin key and careful coordination; still requires on-chain writes per migrated page.

Recommended migration plan

- Provide a `migrate_player_step(player_id, start_index, count)` admin RPC that migrates `count` holders starting at `start_index` from the old `HolderList` in instance storage to persistent `HolderPage` entries. The admin repeatedly calls this until all holders are migrated, then calls a finalisation method to delete the old instance `HolderList`.
- Document the migration procedure, gas costs, and recommended batch sizes (e.g., 100 holders per migration call) to avoid running out of gas.

Notes

- This change intentionally shifts storage cost from a single instance blob to per-player persistent keys. That is the only practical way to prevent the instance entry from growing unbounded and affecting unrelated calls.
- If your deployment environment values short-lived data with TTL-like semantics, you can layer expiration by storing timestamps/epochs in pages and providing an admin archival workflow to prune old pages when safe.

**_ End of document _**
