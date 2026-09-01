# Contract invariant tests

The randomized contract tests in this workspace target the following invariants:

1. Register progress levels never decrease after authorized updates.
2. Progress milestones may be approved only once per milestone, and approval never decreases a player's progress level.
3. Unregistered validators cannot submit milestones or mutate milestone state.
4. Subscription expiry is evaluated correctly after each sequence step, so active subscriptions flip to inactive once the ledger sequence reaches the stored expiry.
5. Trial-offer logging is idempotent: repeated attempts for the same scout/player pair do not duplicate connection state, and successful offers never decrease a player's progress level.

The randomized harness uses deterministic seeds and a compact 24-step loop per test, which keeps the suite CI-friendly while still exercising many operation sequences. The test budget is intentionally modest so cargo test remains practical in repeated CI runs.
