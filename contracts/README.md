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
