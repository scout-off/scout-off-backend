# START HERE

This repository is the Scout-Off backend. The primary documentation lives in `docs/`.

## Key documentation

| Document | Purpose |
|----------|---------|
| `README.md` | Project overview, setup, and development workflow |
| `DEPLOYMENT.md` | Deployment guide |
| `CONTRIBUTING.md` | Contribution guidelines |
| `.env.example` | All supported environment variables with descriptions |
| `docs/` | Architecture, API, and runbook documentation |
| `docs/history/` | Past PR summaries and design decisions |

## Quickstart

See `README.md` for setup instructions. For environment variables, see `.env.example`.

## Historical context

All files are fully documented, tested, and ready to use.

---

## Where to Go Next

### 📖 For a Quick Overview (5 minutes)
Read: **`QUICK_START.md`**

This explains:
- What was created
- How long each task takes
- Where to find files
- Next steps

### 🎯 To See What Was Created (10 minutes)
Read: **`FILES_CREATED.md`**

This explains:
- Every file and what it does
- Where each file goes
- Integration order (6 phases)
- File structure

### 📋 For Complete Task Details (15 minutes)
Read: **`IMPLEMENTATION_PLAN.md`**

This explains:
- Detailed plan for each task
- Status and deliverables
- Which files to update
- Next steps for each task

### 🔧 For Integration Instructions (20 minutes)
Read: **`CHANGES.md`**

This explains:
- File-by-file integration steps
- Exact code changes needed
- Configuration details
- Rollback plan

### 🌿 For Environment Variables
Read: **`.env.additions.md`**

This explains:
- New environment variables
- Deprecated variables
- Configuration examples per environment
- Helm integration

---

## Quick Reference

| Document | Read Time | Purpose |
|----------|-----------|---------|
| This file (START_HERE.md) | 2 min | Overview, what to read next |
| QUICK_START.md | 5 min | Executive summary |
| FILES_CREATED.md | 10 min | What was created, integration order |
| IMPLEMENTATION_PLAN.md | 15 min | Detailed plan for all tasks |
| CHANGES.md | 20 min | How to integrate each change |
| .env.additions.md | 10 min | New environment variables |

**Total reading time: 60 minutes to understand everything**

---

## The 6-Phase Implementation Plan

Once you've read the documentation, follow these phases:

### Phase 1: Preparation (15 min)
- Backup current code
- Review documentation
- Check current status

### Phase 2: Spectral Linting (30 min)
- Install @stoplight/spectral-cli
- Add npm script
- Run linting and fix violations

### Phase 3: Request Signals (45 min)
- Wire AbortController through middleware
- Update services to accept signal
- Add cancellation checks to loops

### Phase 4: Cache Consolidation (30 min)
- Copy unified implementation
- Run contract tests
- Delete old implementations
- Update imports

### Phase 5: API Docs Control (30 min)
- Add config and middleware
- Update routes with guard middleware
- Test each mode

### Phase 6: Verification (30 min)
- Run full test suite
- Run linting
- Build and commit

**Total time: 2-3 hours**

---

## Example Files Help Integration

When implementing, refer to these files for integration patterns:

1. **`src/controllers/exportController.example.ts`** — Shows how to add signal checks in loops
2. **`src/routes/docs.example.ts`** — Shows how to wire up the docs guard
3. **`src/services/safeFetch.example.ts`** — Shows how to propagate signals
4. **`src/services/stellar.example.ts`** — Shows RPC signal integration

Copy the patterns from these files into your actual code.

---

## All Files Are In Place

✅ Core implementation files (9)  
✅ Example files (4)  
✅ Documentation files (4)  
✅ Test files (1)  

Run this to verify:
```bash
node scripts/verify-implementation.js
```

---

## Key Principles

All implementations follow these principles:

- **Backward-compatible** — Can be disabled without breaking code
- **Well-documented** — Every file has clear comments
- **Testable** — Includes tests and verification scripts
- **Incremental** — Each phase is independent
- **Production-ready** — Follows project patterns

---

## Suggested Reading Order

1. **This file** (2 min) ← You are here
2. **QUICK_START.md** (5 min)
3. **FILES_CREATED.md** (10 min)
4. Example files to understand patterns (5 min)
5. **IMPLEMENTATION_PLAN.md** (15 min) - if you want more detail
6. **CHANGES.md** (20 min) - when you're ready to integrate

---

## Quick Questions Answered

**Q: Do I need to implement all four tasks?**
A: No, they're independent. You can implement them one at a time.

**Q: How long does each task take?**
A: 
- Spectral: 30 minutes
- Request signals: 45 minutes
- Cache: 30 minutes
- Docs control: 30 minutes
- Total: 2-3 hours

**Q: Can I roll back if something breaks?**
A: Yes, each change is independent and can be reverted. See "Rollback Plan" in CHANGES.md.

**Q: Are there breaking changes?**
A: No. All changes are backward-compatible. Existing code continues to work.

**Q: Do I need to install new dependencies?**
A: Only one: `@stoplight/spectral-cli` (dev-only) for the linting task.

**Q: Where's the example for integrating request signals into my services?**
A: See `src/services/stellar.example.ts` and `src/services/safeFetch.example.ts`

**Q: How do I test the API docs visibility?**
A: Set `API_DOCS_MODE=public|admin|disabled` and curl `/api/docs`

---

## Contracts (Rust / Soroban)

Only needed if you change anything under `contracts/`.

1. **Install Rust:** `curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh` then `source "$HOME/.cargo/env"`.
2. **Pinned toolchain:** `contracts/rust-toolchain.toml` pins `1.81.0` with the `wasm32-unknown-unknown` target and `rustfmt`/`clippy`; `rustup` activates it automatically inside `contracts/`. Pre-install with:
   ```bash
   rustup toolchain install 1.81.0 --target wasm32-unknown-unknown --component rustfmt --component clippy
   ```
3. **Run the tests:** `npm run test:contracts` — unit tests plus the randomized invariant suite (`PROPTEST_CASES=256`), described in [`contracts/INVARIANT_TESTS.md`](contracts/INVARIANT_TESTS.md).
4. **WASM size check:** `cd contracts && cargo build --target wasm32-unknown-unknown --release && cd ..` then `node scripts/check-contract-wasm-size.js` (budgets in `contracts/wasm-size-budgets.json`).

**macOS / ARM:** the `wasm32-unknown-unknown` target is architecture-independent, so WASM output matches x86_64. The npm scripts hardcode `--target x86_64-unknown-linux-gnu` for native test builds; on macOS/ARM run `cd contracts && cargo test --workspace --lib` and `cd contracts && PROPTEST_CASES=256 cargo test --workspace --tests -- invariants` instead. If `cargo` is missing, add `$HOME/.cargo/bin` to `PATH`.

---

## Next Step

Read **`QUICK_START.md`** next. It's a 5-minute read that explains everything clearly.

After that, follow the 6 phases described above.

**Status: All files created and ready. Let's go! 🚀**

---

## File Navigation Map

```
START_HERE.md (you are here)
├── QUICK_START.md              ← Read next (5 min)
├── FILES_CREATED.md            ← Then this (10 min)
├── IMPLEMENTATION_PLAN.md       ← Optional detail (15 min)
├── CHANGES.md                  ← During integration (20 min)
├── .env.additions.md           ← For environment setup
│
├── .spectral.yaml              ← OpenAPI linting rules
├── scripts/
│   ├── lint-openapi.js
│   ├── spectral-rules.js
│   └── verify-implementation.js
│
├── src/
│   ├── config.apiDocs.ts
│   ├── middleware/
│   │   ├── requestSignal.ts
│   │   └── docs.guard.ts
│   ├── utils/withTimeout.ts
│   ├── services/inMemoryCacheStore.unified.ts
│   └── [example files for patterns]
│
└── tests/services/cacheStore.contract.ts
```

---

**Everything is ready. Let's build this! 🎯**
Design decisions and PR summaries from past work are archived in `docs/history/`.
