# Soroban Smart Contracts

This directory contains the Soroban smart contracts powering the ScoutOff decentralized football scouting platform on Stellar.

## Contracts in this Workspace

- **`shared`**: Common types, error codes, and shared utility helpers.
- **`register`**: Player and scout onboarding and identity registration.
- **`progress`**: Milestone submission, validation, and player progression tracking.
- **`subscription`**: Platform subscriptions and access gating.
- **`connection`**: Scout-to-player connection requests, trial offers, and scouting agreements.
- **`player_token`**: Tokenized player scouting representations and rewards.

---

## Error Codes

All contracts return the shared `Error` enum defined in [`shared/src/errors.rs`](shared/src/errors.rs). A failed invocation surfaces the numeric code below. These values are part of the ABI and never change.

| Code | Variant | Returned by | Meaning |
|------|---------|-------------|---------|
| 1 | `AlreadyInitialized` | `initialize` (all contracts) | The contract has already been initialized. |
| 2 | `NotInitialized` | Any entrypoint that reads config (all contracts) | Called before `initialize`. |
| 3 | `PlayerNotFound` | `register::{get_player, update_profile, update_progress_level}`, `connection::{get_connection, close_connection}` | No player is registered under the given id. |
| 4 | `NotFound` | `progress::{submit_milestone, approve_milestone}` | The referenced milestone does not exist. |
| 5 | `InvalidInput` | Most mutating and paginated entrypoints (all contracts) | An argument failed validation (empty/oversized string, zero amount, bad fee bps, invalid page size). |
| 6 | `AlreadyVerified` | `player_token::issue_tokens`, `progress::approve_milestone` | Tokens were already issued, or the milestone was already approved. |
| 7 | `InsufficientFee` | `subscription::{subscribe, withdraw_fees}` | Payment below the required fee, or withdrawal exceeds collected fees. |
| 8 | `NotSubscribed` | `subscription::cancel_subscription` and subscription access guards | The scout has no active subscription. |
| 9 | `Unauthorized` | Admin-only and role-gated entrypoints (all contracts) | The caller is not the admin or an authorized updater. |
| 10 | `ContractPaused` | State-changing entrypoints (all contracts) | The contract is paused by its admin. |
| 11 | `Overflow` | `player_token::{buy_token, distribute_fee}`, `subscription::{initialize, subscribe, pay_to_contact}` | A checked arithmetic operation overflowed. |
| 12 | `InsufficientSupply` | `player_token::buy_token` | Fewer unsold tokens remain than were requested. |

---

## Rust Toolchain & Reproducibility

The Rust compiler toolchain for this workspace is pinned via [`rust-toolchain.toml`](rust-toolchain.toml):

```toml
[toolchain]
channel = "1.81.0"
targets = ["wasm32-unknown-unknown"]
components = ["rustfmt", "clippy"]
```

### Why Pinning Matters
In Soroban smart contract development, the compiled WASM bytecode and resulting contract hashes depend directly on the compiler version, optimization passes, and code generation settings. Pinning the toolchain guarantees:
1. **Deterministic WASM Hashes**: Contract bytecode hashes match across contributor machines, CI runners, and mainnet deployments.
2. **Consistent Linting & Checks**: `clippy` and `rustfmt` checks evaluate identically across all development environments.
3. **No Drift**: Avoids silent breaking changes from upstream compiler updates.

---

## Building and Testing

When you run `cargo` commands inside the `contracts/` directory, `rustup` automatically resolves and uses the pinned toolchain defined in `rust-toolchain.toml`.

### 1. Build Contracts (WASM)
```bash
cd contracts
cargo build --target wasm32-unknown-unknown --release
```

### 2. Run Unit Tests
Contracts compile to host architectures for native testing:
```bash
cargo test --workspace --lib --target x86_64-unknown-linux-gnu
# Or for macOS (Apple Silicon):
cargo test --workspace --lib --target aarch64-apple-darwin
```

### 3. Run Invariant Fuzz Tests
```bash
cargo test --workspace --tests --target x86_64-unknown-linux-gnu -- invariants
```

---

## How to Update the Toolchain

When upgrading to a new stable Rust toolchain:
1. Update `channel` in [`contracts/rust-toolchain.toml`](rust-toolchain.toml).
2. Update the `toolchain:` input in GitHub Actions workflows:
   - [`.github/workflows/contract-ci.yml`](../.github/workflows/contract-ci.yml)
   - [`.github/workflows/rust.yml`](../.github/workflows/rust.yml)
   - [`.github/workflows/ci.yml`](../.github/workflows/ci.yml)
   - [`.github/workflows/soroban-e2e.yml`](../.github/workflows/soroban-e2e.yml)
3. Update references in [`CONTRIBUTING.md`](../CONTRIBUTING.md).
4. Run `cargo test` and `cargo build --release` to verify compilation, test passes, and bytecode stability.

## Role-based administration

All five contracts share per-contract RBAC from `scout_off_shared::access`.
`DEFAULT_ADMIN` manages roles and WASM upgrades; `PAUSER` controls pausing;
`FEE_MANAGER` controls fees; `VALIDATOR_MANAGER` controls progress validators;
`UPDATER_MANAGER` controls register updater allowlists; `MIGRATOR` controls data
migrations. Initialization grants every role to the initial admin. Removing the
last `DEFAULT_ADMIN` is prohibited, including through self-renunciation.
Existing implicit-admin methods remain as compatibility wrappers; delegated
operators use their explicit `*_as` variants. See [the role and upgrade
runbook](../docs/admin-multisig.md#contract-roles) for API details, role hierarchy,
multisig requirements and the one-time `initialize_roles` bootstrap required by
upgraded instances. Shared and per-contract invariant tests cover membership,
unauthorized operations, role isolation and last-admin protection.
---

## WASM Size Budgets & CI Enforcement

Soroban contracts are limited to **65 KB (65536 bytes)** per contract at deployment. To prevent silent size growth that could eventually exceed this hard limit, we enforce per-contract WASM size budgets in CI.

### Overview

- **Budget file**: [`contracts/wasm-size-budgets.json`](wasm-size-budgets.json)
  - Defines maximum WASM size (in bytes) for each contract.
  - Includes a `_default` fallback (set to 65000 bytes) for any contract not explicitly listed.
- **CI check**: [`scripts/check-contract-wasm-size.js`](../scripts/check-contract-wasm-size.js)
  - Runs during the **contract-ci** workflow after building WASM binaries.
  - Compares each built `.wasm` file size against its budget.
  - Reports sizes to the GitHub Step Summary with a markdown table.
  - **Fails CI** if any contract exceeds its budget.
  - On pull requests, displays size delta (change) vs. the base branch.

### Current Budgets

| Contract | Budget |
|---|---:|
| `scout_off_register.wasm` | 60 KB |
| `scout_off_progress.wasm` | 58 KB |
| `scout_off_subscription.wasm` | 62 KB |
| `scout_off_connection.wasm` | 61 KB |
| `scout_off_player_token.wasm` | 64 KB |
| `_default` | 65 KB |

Initial budgets are set with **15% headroom** below the Soroban 65 KB limit to provide room for code growth while keeping sizes within safe operating bounds.

### Raising a Budget

If a contract legitimately needs a larger budget (e.g., due to new features or refactoring), follow this process:

1. **Edit the budget file**:
   ```bash
   # contracts/wasm-size-budgets.json
   {
     "scout_off_register.wasm": 60000,
     "scout_off_progress.wasm": 58000,
     …
   }
   ```

2. **Commit and push** your changes (both code and budget update) to your branch.

3. **Create a pull request** with:
   - Explanation of why the size increase is necessary (new feature, refactoring, etc.).
   - Before and after WASM size comparison (shown automatically in the PR via the CI step summary).

4. **Request reviewer approval**:
   - Reviewers should verify the size increase is justified and not due to inefficient code or unnecessary dependencies.
   - Only merge if the increase is approved and necessary.

### Monitoring Size Over Time

The CI step summary on each PR shows:
- Current contract size
- Budget for that contract
- Percentage of budget used
- ✓ / ✗ indicator (pass/fail)
- **Delta vs. base branch** (how many bytes the contract grew or shrank on this PR)

Consistently reviewing deltas helps catch unintended bloat early.

### Optimization Strategies

If a contract is approaching its budget, consider:
1. **Review dependencies** – Unused crates add significant WASM bloat; audit `Cargo.toml`.
2. **Inline vs. helper functions** – Small helper functions can sometimes be inlined by the compiler to reduce code size.
3. **Feature flags** – Use Cargo feature flags to conditionally compile code.
4. **Code deduplication** – Move repeated logic into shared utility functions in the `shared` contract.
5. **Compiler optimizations** – `.cargo/config.toml` already sets `opt-level = "z"` for release builds; ensure this is not accidentally overridden.
