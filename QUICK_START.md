# Quick Start: Four Backend Improvements

This guide gets you started immediately. For details, see the accompanying documentation.

## What You're Implementing

Four independent improvements to the backend:

1. **OpenAPI Linting** — Automatic quality checks on API specs
2. **Request Timeouts** — Clean cancellation of expensive operations
3. **Cache Consolidation** — One cache implementation instead of three
4. **API Docs Control** — Public/admin/disabled visibility modes

## Files Created

All files are ready to use:
- 9 core implementation files
- 4 example files showing integration patterns
- 4 documentation files
- 1 verification script

**Total: 18 files created** ✓

Run this to verify they're all present:
```bash
node scripts/verify-implementation.js
```

## Start Here

1. **Understand the scope:**
   - Read `FILES_CREATED.md` (2 min) — What was created
   - Read `IMPLEMENTATION_PLAN.md` (5 min) — Overview of all tasks

2. **Plan your integration:**
   - Read `CHANGES.md` (10 min) — Integration guide
   - Review `FILES_CREATED.md` Phase 1-6 (integration order)

3. **Follow the phases:**
   - Phase 1: Preparation
   - Phase 2: Spectral Linting (independent)
   - Phase 3: Request Signals
   - Phase 4: Cache Consolidation
   - Phase 5: API Docs Control
   - Phase 6: Verification

## Each Phase Takes ~30-60 Minutes

**Phase 2 (Spectral):** 30 min
- Install dependency
- Run linter
- Fix violations in openapi.yaml

**Phase 3 (Request Signals):** 45 min
- Wire signal through middleware
- Update 5-6 services/controllers
- Test end-to-end

**Phase 4 (Cache):** 30 min
- Copy new implementation
- Delete old files
- Run tests
- Update config

**Phase 5 (Docs Control):** 30 min
- Add config and middleware
- Update docs.ts with examples
- Test each mode

## Quick Reference

| Task | Status | Files | Time |
|------|--------|-------|------|
| OpenAPI Linting | Ready | 3 | 30m |
| Request Signals | Ready | 2 | 45m |
| Cache Store | Ready | 1 | 30m |
| Docs Control | Ready | 2 | 30m |
| **Total** | **Ready** | **9** | **2-3h** |

## Key Files to Review

1. **Get oriented:** `FILES_CREATED.md`
2. **Understand scope:** `IMPLEMENTATION_PLAN.md`
3. **Do integration:** `CHANGES.md`
4. **Copy patterns:** Example files in src/

## Example Files Are Your Friends

When integrating, refer to:
- `src/controllers/exportController.example.ts` — Signal checks in loops
- `src/routes/docs.example.ts` — Docs guard integration
- `src/services/safeFetch.example.ts` — Signal propagation
- `src/services/stellar.example.ts` — RPC signal usage

These show exactly where and how to apply the changes.

## One-Sentence Summaries

- **Spectral:** Automated OpenAPI quality checking
- **Signals:** Requests abort when they timeout or client disconnects
- **Cache:** Three implementations become one
- **Docs:** Control who sees API documentation

## Commands You'll Use

```bash
# After Phase 2
npm run lint:openapi

# After Phase 4
npm test -- tests/services/cacheStore.contract.ts

# After everything
npm run typecheck && npm test && npm run build
```

## Contracts

The Soroban contracts in `contracts/` are a separate Rust workspace. You only need this section if you touch them.

### 1. Install Rust

```bash
curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh
source "$HOME/.cargo/env"
```

### 2. Use the pinned toolchain

`contracts/rust-toolchain.toml` pins the compiler, so `rustup` installs and activates it automatically the first time you run `cargo` inside `contracts/`:

```toml
[toolchain]
channel = "1.81.0"
targets = ["wasm32-unknown-unknown"]
components = ["rustfmt", "clippy"]
```

To pre-install it explicitly:

```bash
rustup toolchain install 1.81.0 --target wasm32-unknown-unknown --component rustfmt --component clippy
```

### 3. Run the contract tests

```bash
npm run test:contracts
```

This runs `test:contracts:unit` (workspace `--lib` tests) followed by `test:contracts:invariants` (randomized invariant tests, `PROPTEST_CASES=256`). The invariants are documented in [`contracts/INVARIANT_TESTS.md`](contracts/INVARIANT_TESTS.md) — e.g. progress levels never decrease, milestones are approved once, unregistered validators cannot mutate state, subscription expiry flips to inactive at the stored ledger, and role changes never remove the last root admin.

### 4. Check WASM size budgets

```bash
cd contracts && cargo build --target wasm32-unknown-unknown --release && cd ..
node scripts/check-contract-wasm-size.js
```

The check compares each built `.wasm` against `contracts/wasm-size-budgets.json` and fails if a contract exceeds its budget. `scripts/report-contract-wasm-size.sh` prints the raw sizes.

### macOS / ARM notes

- On Apple Silicon, `rustup` installs the `aarch64-apple-darwin` host toolchain; the `wasm32-unknown-unknown` target is architecture-independent, so WASM output is identical to x86_64.
- The npm scripts pass `--target x86_64-unknown-linux-gnu` for native test builds. On macOS/ARM run the equivalent directly:
  ```bash
  cd contracts && cargo test --workspace --lib
  cd contracts && PROPTEST_CASES=256 cargo test --workspace --tests -- invariants
  ```
- If `cargo` is not found after install, add `$HOME/.cargo/bin` to `PATH` (or `source "$HOME/.cargo/env"` in your shell profile).

## If You Get Stuck

1. **Check example files** — They show the pattern
2. **Re-read CHANGES.md** — Integration instructions
3. **Refer to inline comments** — All files are well-documented
4. **Run verify script** — Check what's in place

## Rollback Plan

If anything breaks:
- Each phase is independent (can roll back individually)
- All changes are backward-compatible when disabled
- See "Rollback Plan" in CHANGES.md

## Support

All files are fully documented with:
- Inline comments explaining the why
- Example files showing integration patterns
- Documentation files covering the what/when/how
- This quick start for the big picture

## Ready to Begin?

1. Run the verify script:
   ```bash
   node scripts/verify-implementation.js
   ```

2. Read the key files (in order):
   - `FILES_CREATED.md` (2 min)
   - `IMPLEMENTATION_PLAN.md` (5 min)
   - `CHANGES.md` (10 min)

3. Start with Phase 1 (Preparation)

4. Follow the integration phases in order

5. Test after each phase

**Estimated total time:** 2-3 hours

**Status:** All files created and ready ✓
