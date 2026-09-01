Idempotent fee distribution design for `player_token`

Problem

The original `distribute_fee` accepted an unbound `transfer_fee_xlm` and treated each call independently. This allowed replay and fabrication: the same distribution (or fabricated one) could be invoked multiple times and `TokenMeta.total_distributed` would grow incorrectly.

Goal

Ensure a real-world fee/transfer event can be distributed to holders exactly once, even if distribution calls are retried or replayed; support multi-page distributions (paginated processing) while preventing double-counting or fabricated inputs.

Chosen design

- Require a caller-supplied `transfer_id: u128` for each distribution. This must uniquely identify the real-world transfer event (e.g., a payment ID, transaction hash truncated to 128 bits, or an off-chain nonce coordinated by the operator).

- Record a `TransferInfo(player_id, transfer_id)` in persistent storage containing:
  - `total_fee: u128` — the canonical total fee for that transfer, set on the first processing call.
  - `accumulated: u128` — sum of per-page payouts already processed for this transfer.

- Record per-page processing with a `ProcessedTransferPage(player_id, transfer_id, page)` marker (persistent). This ensures each page is processed at most once; repeated attempts on the same `(player,transfer_id,page)` are a no-op.

- On the first per-transfer call the contract stores `TransferInfo.total_fee = transfer_fee_xlm`.
  - Subsequent calls for the same `transfer_id` must pass the same `transfer_fee_xlm`, otherwise the call is rejected.

- When processing a page the contract computes the page's `page_total` and verifies `accumulated + page_total <= total_fee`. If this would exceed the declared `total_fee`, the call is rejected.
  - After adding the page, `accumulated` is increased by `page_total` and the per-page marker is set, and `TokenMeta.total_distributed` is increased by `page_total`.

- Replaying the same `(player,transfer_id,page)` is an explicit no-op returning 0 queued payouts; replaying with the same `transfer_id` but different `total_fee` is rejected; replaying a different page for the same `transfer_id` is allowed once, as long as it doesn't cause `accumulated` to exceed `total_fee`.

Alternatives considered

1. Global per-transfer marker only (no per-page markers)
   - Simpler, but incompatible with paginated processing: single marker would prevent processing page-by-page.

2. Bind distributions to verifiable on-chain transfer events
   - Strongest security: require a proof of transfer (transaction hash, Merkle inclusion, or token contract event). Implementation complexity depends on available on-chain primitives and whether the token transfer exists in the same ledger environment; may not be feasible in the short term.

3. Operator-signed attestations
   - Operator signs a statement of `(player_id, transfer_id, total_fee)`; contract verifies signature. This moves trust to the operator's key and requires signature verification support.

Why we chose `transfer_id` + `TransferInfo` + per-page markers

- Supports paginated processing without risking double-counting.
- Keeps on-chain logic modest and deterministic; storage is persistent and per-key so large data is partitioned.
- Works with an operator-or-relayer-run workflow where `transfer_id` is provided by the off-chain system that observes the real transfer.

Operational notes

- Operators must choose `transfer_id` values that are globally unique per player (or per deployment), e.g., a truncated payment hash or a monotonically-increasing sequence maintained off-chain.
- Batch size controls (pages) remain important to avoid gas limits; migration tools and relayers must process pages until `accumulated == total_fee`.
- Consider adding a `TransferCompleted` marker once `accumulated == total_fee` for convenience.

Security notes

- This design prevents in-contract replay and fabrication when operators provide correct `transfer_id` values.
- If an attacker can fabricate `transfer_id` values and is allowed to submit distributions (access-control issue), they could create fake `TransferInfo` records; therefore this should be combined with access control (separately tracked) or with operator-attestation (signed transfer assertions) depending on your threat model.

**_ End of document _**
