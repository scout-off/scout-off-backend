# Contributing to ScoutOff Backend

Welcome! This guide covers contribution workflows, code standards, and critical security practices including dependency management. All participants are expected to follow our [Code of Conduct](CODE_OF_CONDUCT.md).

## Table of Contents

- [Getting Started](#getting-started)
- [Seeding the Database](#seeding-the-database)
- [Choosing an Issue](#choosing-an-issue)
- [Contribution Workflow](#contribution-workflow)
- [Code Quality Standards](#code-quality-standards)
- [Security & Dependency Review](#security--dependency-review)
- [GitHub Labels and Priority Levels](#github-labels-and-priority-levels)
- [Filing Issues](#filing-backend-issues)
- [Getting Help](#getting-help)

## Getting Started

### Prerequisites

- Node.js — supported range is `>=18.0.0 <23.0.0` (see `engines.node` in [`package.json`](package.json)). [`.nvmrc`](.nvmrc) pins the version used for local dev and for the primary CI coverage upload (currently Node 20)
  - If you use **nvm**: `nvm install && nvm use` (reads `.nvmrc` automatically)
  - If you use **fnm**: `fnm install && fnm use`
  - If you use **asdf**: `asdf install nodejs` (reads `.nvmrc` via the Node.js plugin)
- npm ≥ 9
- Git

> CI's `lint` and `test` jobs run across a matrix of Node 18, 20, and 22 (`.github/workflows/ci.yml`) so a regression that only manifests on one supported version is caught before merge. `.nvmrc` remains the default for local dev; bump `engines.node` in `package.json` alongside the CI matrix if the supported range changes.

### Setup

1. **Fork and Clone**
   ```bash
   git clone https://github.com/scout-off/scout-off-backend.git
   cd scout-off-backend
   # Pick up the correct Node version automatically (nvm/fnm/asdf)
   nvm use   # or: fnm use
   npm install
   ```

2. **Create a Feature Branch**
   ```bash
   git checkout -b add-your-feature-description
   ```

3. **Pre-Contribution Checks**
   - All tests pass: `npm run test`
   - Linting passes: `npm run lint`
   - No security vulnerabilities: `npm audit`
   - Environment is set up: `cp .env.example .env`

### Database Migrations

The project uses SQL migrations to manage database schema across environments. Migrations are stored as numbered `.sql` files in the `db/` directory and are tracked in the `migrations` table. See [db/README.md](db/README.md) for the naming convention, SQLite/PostgreSQL pairing, and how to add a new migration.

**Checking migration status:**

To see which migrations have been applied to your current database and which are pending:

```bash
npm run migration:status
```

This command is read-only and does not modify the database. It queries the `migrations` table to determine which schema changes have been applied.

**Example output:**

```
Migration Status Report
═════════════════════════════════════════════════════════════════════

Status: 7 applied, 2 pending

┌──────────────────────────────────┬───────────┬──────────────────────┐
│ Migration                        │ Status    │ Applied At           │
├──────────────────────────────────┼───────────┼──────────────────────┤
│ 001_initial.sql                  │ ✓ Applied │ 2024-01-15 10:23:45  │
│ 002_audit_log.sql                │ ✓ Applied │ 2024-01-15 10:23:46  │
│ 003_idempotency_keys.sql         │ ✓ Applied │ 2024-01-15 10:23:48  │
│ 004_token_revocation.sql         │ ⧬ Pending │ —                    │
│ 004_validators.sql               │ ⧬ Pending │ —                    │
└──────────────────────────────────┴───────────┴──────────────────────┘
```

**Understanding the output:**

- **Status: X applied, Y pending**: Summary line showing how many migrations have been applied and how many are awaiting execution
- **✓ Applied**: Migration has been executed and is recorded in the `migrations` table
- **⧬ Pending**: Migration file exists but has not been applied yet
- **Applied At**: Timestamp (ISO 8601 format) when the migration was applied, or "—" for pending migrations

**Applying pending migrations:**

To apply all pending migrations, use:

```bash
npm run seed
```

This runs the migration system, which automatically applies any pending migrations found in the `db/` directory in alphabetical order.

## Seeding the Database

New contributors don't need to manually create players, events, or
subscriptions to start testing the API — `scripts/seed.ts` populates the
local SQLite database with a realistic sample dataset in one command.

### Running the seed

```bash
npm run seed
# or equivalently:
npx ts-node --project tsconfig.scripts.json scripts/seed.ts
```

This connects to the database at `DB_PATH` (default: `scout-off.db`),
runs any pending migrations, and inserts the sample rows described below.

### What gets seeded

| Data                 | Count | Details                                                                          |
| -------------------- | ----- | --------------------------------------------------------------------------------- |
| Players               | 5     | One per region (West Africa, East Africa, South America, Europe, Southeast Asia) |
| Positions             | 5     | Forward, Midfielder, Defender, Goalkeeper, Winger                                |
| Progress tiers        | 0–3   | One player at each tier level (0, 1, 1, 2, 3), showcasing the full tier model     |
| Milestone events      | 3     | `performance`, `identity`, and `trial_offer` milestones (`milestone_approved`)   |
| Scout subscriptions   | 2     | One `premium` (90 days) and one `basic` (30 days), both active                   |
| Contact unlocks       | 2     | Scout Alpha → `seed-player-001`, Scout Beta → `seed-player-003`                  |

The full player/scout wallet list (with the exact seed values) lives in
the comment block and constant declarations at the top of
[`scripts/seed.ts`](scripts/seed.ts). At the time of writing, the seeded
wallets used for manual API testing are:

| Role                   | Wallet                                                    |
| ----------------------- | ---------------------------------------------------------- |
| `seed-player-001` (Forward, West Africa)   | `GAEZI3BYWDXHZVJBDG5AXBLYMN6VJXVHAJBGZFAZQXNK3BFMN7XRVGB` |
| `seed-player-003` (Defender, South America) | `GCRVGBAEZI3BYWDXHZVJBDG5AXBLYMN6VJXVHAJBGZFAZQXNK3BFMN7X` |
| Scout Alpha (`premium` subscription)        | `GFAZQXNK3BFMN7XRVGBAEZI3BYWDXHZVJBDG5AXBLYMN6VJXVHAJBGZE` |
| Scout Beta (`basic` subscription)           | `GHAJBGZFAZQXNK3BFMN7XRVGBAEZI3BYWDXHZVJBDG5AXBLYMN6VJXVB` |

### Example requests against seeded data

Once seeded, the server (`npm run dev`) exposes the sample data through
the normal API — no manual setup required for read endpoints:

```bash
# List all players
curl http://localhost:4000/api/players

# Filter by region and minimum tier
curl "http://localhost:4000/api/players?region=West%20Africa&minTier=2"

# Fetch a specific seeded player and their milestone history
curl http://localhost:4000/api/players/seed-player-003
curl http://localhost:4000/api/players/seed-player-001/milestones
```

Scout-facing endpoints require a Bearer token for the seeded scout wallet
(see `POST /auth/challenge` and `POST /auth/token` in
[`BACKEND_API_DOCS.md`](BACKEND_API_DOCS.md) for how to mint one locally),
for example:

```bash
# Scout Alpha's subscription status (premium, seeded active)
curl http://localhost:4000/api/scouts/GFAZQXNK3BFMN7XRVGBAEZI3BYWDXHZVJBDG5AXBLYMN6VJXVHAJBGZE/subscription \
  -H "Authorization: Bearer <scout-jwt-for-GFAZQXNK3BFMN7XRVGBAEZI3BYWDXHZVJBDG5AXBLYMN6VJXVHAJBGZE>"

# Contacts Scout Alpha has already unlocked (seed-player-001)
curl http://localhost:4000/api/scouts/GFAZQXNK3BFMN7XRVGBAEZI3BYWDXHZVJBDG5AXBLYMN6VJXVHAJBGZE/contacts \
  -H "Authorization: Bearer <scout-jwt-for-GFAZQXNK3BFMN7XRVGBAEZI3BYWDXHZVJBDG5AXBLYMN6VJXVHAJBGZE>"
```

### Idempotency

The seed script is **idempotent** — every player is keyed by a stable
`player_id` and every event by a stable `tx_hash`, both enforced by
`UNIQUE`/primary-key constraints. Re-running `npm run seed` against an
already-seeded database skips rows that already exist instead of creating
duplicates or erroring, so it's always safe to run again (e.g. after
pulling `main` or restarting your dev environment).

### Resetting the seed

To start from a clean slate, delete the SQLite database file and re-run
the seed:

```bash
rm scout-off.db   # or whatever DB_PATH points at in your .env
npm run seed
```

## Understanding the Data Model

Before writing queries or modifying data flows, consult **[`docs/data-model.md`](docs/data-model.md)** to understand:
- Which table is authoritative for a given concept
- Whether data is populated by the indexer (on-chain mirror) or direct API writes
- The relationships between chain-mirror tables and API-owned tables
- Hybrid tables that receive writes from both sources

This prevents writing queries against the wrong table or misunderstanding where data originates.

## Choosing an Issue

All open issues carry a `difficulty` label — `easy`, `medium`, or `hard` — assigned by maintainers during triage. Use these labels to find work that matches your current experience level with the codebase.

- **`difficulty: easy`** — Self-contained changes usually limited to a single file or module. No deep knowledge of the codebase, Stellar, or Soroban is required. Typical examples: fixing a typo in docs, adding a missing test case, adding a small helper function, or updating a configuration value. **If this is your first contribution, start here.** Issues tagged `good first issue` are always `easy` — the `good first issue` label is a subset of `easy` issues that maintainers consider especially well-scoped and well-documented for a newcomer.

- **`difficulty: medium`** — Requires understanding two or more modules, or involves a non-trivial design or data-model decision. Some prior exposure to the project is helpful. Typical examples: adding a new API route with input validation, extending the indexer to handle a new event type, or improving test coverage across a feature area.

- **`difficulty: hard`** — Spans multiple layers of the stack (Soroban contract + backend + docs), requires deep domain knowledge (SEP-10, Stellar transaction semantics, or security-sensitive flows), or has meaningful performance implications. Typical examples: implementing the pay-to-contact flow end-to-end, introducing distributed caching, or hardening auth middleware against timing attacks.

> **Tip:** After claiming an `easy` or `medium` issue, it's fine to open a draft PR early and ask questions in the comments — maintainers are happy to give design feedback before you invest too much time.

## Contribution Workflow

### 1. Claim an Issue

Comment on the GitHub issue to indicate you're working on it. Maintainers will assign it to you.

### 2. Make Changes and Test

```bash
npm run dev                  # Start dev server with hot-reload
npm run test                 # Run full test suite
npm run lint                 # Check code style
npm run typecheck            # Fast type-check (tsc --noEmit), no build output
npm run check:sql-injection  # Scan src/db for unsafe SQL string interpolation
npm audit                    # Check for security vulnerabilities
```

### 3. Commit with Clear Messages

Use conventional commit format:

```bash
git commit -m "feat: add player region filter

- Add region parameter to /api/players endpoint
- Update Soroban contract to support region queries
- Add integration tests for region filter

Fixes #123"
```

**Commit types:**
- `feat:` – New feature
- `fix:` – Bug fix
- `docs:` – Documentation only
- `chore:` – Dependency update, build config
- `refactor:` – Code restructuring
- `perf:` – Performance improvement
- `test:` – Test addition or fix
- `security:` – Security hardening

### 4. Push and Open a Pull Request

```bash
git push origin add-your-feature-description
```

Reference the issue in the PR description:
```
## Summary
Brief description of what this PR does.

## Issue
Fixes #123

## Testing
- [ ] All tests pass
- [ ] npm audit passes
- [ ] Manual testing completed

## Type of Change
- [ ] Bug fix
- [ ] New feature
- [ ] Documentation update
- [ ] Dependency update
- [ ] Security fix
```

### 5. Review and Merge

- Respond to reviewer feedback in new commits (don't force-push)
- Ensure CI/CD checks pass
- Once approved, maintainers merge to `main`

## Code Quality Standards

### Pre-commit Hook

A [Husky](https://typicode.com/husky/) pre-commit hook runs
[lint-staged](https://github.com/lint-staged/lint-staged) automatically on
every `git commit`. It applies ESLint (with `--fix`) to all staged `.ts` files
under `src/` and `tests/`, so you catch and auto-fix lint violations before
they reach CI.

The configuration lives in the `"lint-staged"` key in `package.json`:

```json
"lint-staged": {
  "src/**/*.ts": ["eslint --fix --ext .ts"],
  "tests/**/*.ts": ["eslint --fix --ext .ts"]
}
```

Husky is set up automatically when you run `npm install` (via the `prepare`
lifecycle hook). If the hook does not run after cloning, enable it manually:

```bash
npx husky install
```

You can also run lint-staged on your current staged files at any time:

```bash
npx lint-staged
```

### Required Checks

- **Tests**: New features must include unit or integration tests
  ```bash
  npm run test
  ```

- **Linting**: No linting warnings
  ```bash
  npm run lint
  ```

- **SQL Injection Check**: `src/db/*.ts` must not splice values into SQL via string interpolation; use parameterized `?` placeholders instead
  ```bash
  npm run check:sql-injection
  ```

- **Types**: Use strict TypeScript; avoid `any` types where possible

- **Documentation**: Update README if your changes affect user-facing behavior

- **Git History**: Use atomic commits with meaningful messages

### Coverage Goals

Jest enforces minimum coverage thresholds automatically when running `npm run test:coverage`. The thresholds are configured in the `jest.coverageThreshold` block in `package.json`:

| Metric     | Minimum |
| ---------- | ------- |
| Branches   | 70%     |
| Functions  | 75%     |
| Lines      | 80%     |
| Statements | 80%     |

Running `npm run test:coverage` below these thresholds will fail the suite. CI enforces coverage on every pull request via the `test` job in `.github/workflows/ci.yml`, which calls `npm run test:coverage` and uploads the `lcov` report to Codecov. The default `npm test` command does **not** collect coverage and will not fail on threshold violations — use `npm run test:coverage` locally when you want threshold enforcement.

Focus coverage on critical paths: auth, payments, and data validation.

### Naming Conventions

- **Files**: `camelCase.ts` for source, `camelCase.test.ts` for tests
- **Functions**: `camelCase()` for functions, `PascalCase` for classes/types
- **Constants**: `UPPER_SNAKE_CASE` for compile-time constants
- **Directories**: `lowercase` for module directories

## Security & Dependency Review

**All contributors must perform regular security audits.** This is a critical responsibility when working with blockchain payments and user data.

### Regular Dependency Audits

Run `npm audit` **before every commit** and **before every PR submission**:

```bash
npm audit
```

**Output interpretation:**
- ✅ **No vulnerabilities**: Safe to proceed
- ⚠️ **Low severity**: Document in PR; fix in next sprint if no workaround exists
- 🔴 **Moderate/High/Critical**: **Must fix before merging**
  - Moderate: Fix unless infeasible; document trade-offs
  - High/Critical: Fix immediately or block the PR

### CI Enforcement & Exception Process

CI runs `npm audit --omit=dev --audit-level=high` as a required job (`audit` in
`.github/workflows/ci.yml`, alongside `lint`/`test`/`contracts`) and fails the
build on any high/critical finding in **production** dependencies. Dev-only
tooling (eslint, jest, autocannon, etc.) is excluded via `--omit=dev` so
findings that never ship don't block merges.

If this job fails on a finding that is genuinely not yet fixable:

1. **Check for a non-breaking fix first.** Most high/critical findings are in
   transitive dependencies — run `npm audit fix` (no `--force`) to pick up
   anything resolvable within the existing semver ranges, then check whether
   the direct dependency has a newer patch version. If the vulnerable package
   is only pulled in transitively and the maintainer hasn't released a fix
   yet, add an [`overrides`](https://docs.npmjs.com/cli/v10/configuring-npm/package-json#overrides)
   entry in `package.json` to force the patched transitive version — this is
   usually enough and doesn't require touching the direct dependency at all.
2. **If no fix exists upstream** (no patched version published, or the only
   fix is a major/breaking bump that needs its own dedicated PR): open a
   tracking issue documenting the advisory (GHSA/CVE id), the affected
   package and version, why it can't be resolved right now, and a re-check
   date no more than 60 days out.
3. **Get a second maintainer's sign-off** to merge despite the red `audit`
   check for that one PR (a repo admin can override a single required status
   check on a PR-by-PR basis — this is not a permanent CI change). Reference
   the tracking issue from step 2 in both the override and the PR
   description, e.g. `[audit-exception: GHSA-xxxx-xxxx-xxxx, tracked in #NNN,
   re-check by YYYY-MM-DD]`.
4. Do **not** work around the gate by lowering `--audit-level`, adding
   `--omit` for a production package, or piping the command through
   `|| true` — those changes are permanent and silently widen the gate for
   every future PR, not just the one with the known exception.

### Dependency Update Process

1. **Check for Updates**
   ```bash
   npm outdated
   ```

2. **Test Before Updating**
   ```bash
   npm update <package-name>
   npm run test && npm run lint && npm audit
   ```

3. **Review Breaking Changes**
   - Check the package's CHANGELOG
   - Test all affected code paths
   - Update types if needed

4. **Commit Dependency Updates**
   ```bash
   git commit -m "chore: update @stellar/stellar-sdk to 12.2.0

   - Update from 12.1.0 to 12.2.0
   - Fixes vulnerability in RPC error handling
   - All tests pass; no breaking changes

   Fixes #456"
   ```

### Critical Dependency Categories

The following dependencies require extra scrutiny during updates due to their security-sensitive roles:

| Package | Role | Why Critical |
|---------|------|-------------|
| `express` | Web framework | Handles auth, request validation, rate limiting |
| `@stellar/stellar-sdk` | Blockchain integration | Direct interaction with Stellar network, key material |
| `jsonwebtoken` | JWT handling | Authentication tokens, session management |
| `better-sqlite3` | Database | Stores user profiles, transaction records |
| `axios` / `node-fetch` | HTTP client | External API calls to Pinata/IPFS, Stellar Horizon |
| `dotenv` | Environment config | Loads sensitive secrets (JWT_SECRET, PINATA_KEY) |

**When updating these, always:**
- Run full test suite: `npm run test`
- Run security audit: `npm audit`
- Test integration points manually
- Verify no secrets are logged

### Automated Dependency Updates

Dependabot is configured in `.github/dependabot.yml` to open pull requests for outdated dependencies automatically, once per week on Mondays.

**npm (Node.js backend)**

- Directory: `/` (project root)
- Label: `dependencies`, `infrastructure`, `javascript`
- Limit: 5 open PRs at a time

**Cargo (Rust smart contracts)**

- Directory: `/contracts`
- Label: `infra`, `easy`
- Limit: 5 open PRs at a time
- Grouped: all `soroban-*` crates are bundled into a single PR via the `soroban-deps` group, reducing noise from Soroban SDK patch releases.

When Dependabot opens a Cargo PR, verify:
1. Review the Cargo.lock diff and the crate's CHANGELOG for breaking changes.
2. Run `cd contracts && cargo test --target x86_64-unknown-linux-gnu` locally to confirm the contracts still build and pass tests.
3. Merge or close the PR — do **not** leave stale Dependabot PRs open longer than one sprint.

### Supply Chain Security

- ✅ Use `npm ci` in CI/CD (reproducible installs)
- ✅ Lock `package-lock.json` in version control
- ✅ Audit transitive dependencies: `npm audit --depth=10`
- ✅ Review unknown publishers: `npm info <package> | grep -A5 contributors`
- ✅ Avoid deprecated packages in `npm audit`
- ❌ Do NOT use `npm install --force` or `--legacy-peer-deps` without justification

### Reviewing Deprecated Dependencies

When you encounter a deprecated package or see warnings during audit:

1. **Identify Deprecation Reason**
   ```bash
   npm info <package-name>
   ```
   Check for:
   - `deprecated` field (shows deprecation message)
   - No activity in past 12+ months
   - Known security vulnerabilities
   - Better alternatives available

2. **Evaluate Replacement Options**
   - Research recommended alternatives on npm
   - Check GitHub for active maintenance (recent commits, open issues)
   - Verify API compatibility with current usage
   - Consider migration effort vs. risk

3. **Migration Strategy**
   - Create a new issue to track the deprecation
   - Plan migration in a feature branch (e.g., `chore/replace-deprecated-package`)
   - Update one deprecated package at a time to isolate issues
   - Run full test suite after each replacement
   - Document any API changes in commit message

4. **Examples of Recently Handled Deprecations**
   | Old Package | Reason | Replacement | Status |
   |-------------|--------|-------------|--------|
   | `node-fetch@2` | Deprecated in favor of native fetch | native `fetch` or `axios` | Migration in progress |
   | Specific older packages | No longer maintained | Actively maintained fork | Queued for review |

5. **Security Review Checklist for Deprecated Packages**
   - [ ] Check CVE databases (NVD, Snyk, npm audit)
   - [ ] Review open security issues in GitHub
   - [ ] Verify no direct secrets/tokens in deprecation warnings
   - [ ] Document any interim workarounds
   - [ ] Set migration deadline (if package has known exploits)

### Reporting Security Issues

**Do NOT open a public GitHub issue for security vulnerabilities.**

Instead:
1. Email maintainers privately
2. Include proof of concept (if safe to share)
3. Allow 7 days for maintainers to respond before public disclosure

## GitHub Labels and Priority Levels

Every GitHub issue should be labelled at creation time so maintainers can triage
and route it instantly. This section is the single source of truth for the label
taxonomy used across the ScoutOff backend repository.

> **Cross-reference:** The README's [Issue Categories](README.md#issue-categories)
> and [Priority Levels](README.md#priority-levels) tables summarise the same
> information at a glance. This section adds the detail you need when choosing
> the right labels for your issue.

---

### Issue Category Labels

Apply **exactly one** category label when you open an issue. If your issue
genuinely spans two categories, pick the one that best describes the *primary*
work required.

| Label | Description | Example issues |
|-------|-------------|----------------|
| `bug` | Unintended behaviour or a crash in an existing feature. The system did something it should not have done, or failed to do something it should. | IPFS upload times out; SEP-10 challenge returns 500; milestone approval emits duplicate event |
| `feature` | A new capability or a meaningful enhancement to an existing behaviour. No existing code is broken — you are adding something that does not exist yet. | Add player region filter to `/api/players`; support trial-offer logging; expose scout payment history endpoint |
| `performance` | The system works correctly but is too slow, uses too much memory, or makes unnecessary network/database calls. | Cache milestone query results in Redis; reduce indexer latency by batching ledger reads; add DB index on `player_id` |
| `documentation` | Changes to README, CONTRIBUTING.md, API docs, inline code comments, or the `docs/` directory. No production code changes. | Clarify SEP-10 error codes; add SDK usage examples; fix broken links in DEPLOYMENT.md |
| `refactor` | Restructuring existing code **without** changing observable behaviour. Tests should still pass before and after. | Consolidate request-validation middleware; extract retry logic into a shared helper; rename internal variables for clarity |
| `infra` | Deployment pipelines, CI/CD configuration, Docker setup, database migrations, or other DevOps concerns. | Optimise GitHub Actions matrix; add Postgres migration tooling; update `docker-compose.yml` health-check interval |
| `security` | Vulnerability fixes, input hardening, rate-limit tuning, or any change whose primary motivation is reducing attack surface. Always follow the [Security & Dependency Review](#security--dependency-review) process. | Validate JSON payloads with Zod schemas; tighten CORS allowed-origins; add rate limit to `/auth/token` |
| `test` | Additions or improvements to the test suite — new test files, improved assertions, better test isolation, or coverage fixes. No production code changes required. | Add edge-case tests for `tierPromotion.ts`; improve IPFS serialiser coverage; replace fragile integration fixture |

---

### Priority Level Labels

Priority labels are **set by maintainers** after triage. When you open an issue
you should **estimate** the priority and note it in the issue body — maintainers
will confirm or adjust it. Do not add a `P*` label yourself at creation time;
wait for maintainer confirmation.

| Label | Severity | Expected response | Examples |
|-------|----------|-------------------|----------|
| `P0` — Critical | Blocks a production deployment or causes data loss / security breach. Everything else stops until this is resolved. | **Fix immediately** — same day if possible | Contract initialisation fails; database corruption; JWT secret exposed in logs |
| `P1` — High | Breaks a core user flow or affects many users simultaneously. A workaround may exist but it is not acceptable long-term. | **Fix within the current sprint** | Milestone approval returns 500; payment processing hangs indefinitely; scout filter returns wrong results |
| `P2` — Medium | Degrades the experience but a reasonable workaround exists. Users can still complete their core tasks. | **Schedule for the next sprint** | Scout search is noticeably slow; validator list becomes stale after 10 minutes; error messages are misleading |
| `P3` — Low | Nice-to-have improvement or an issue that affects very few users. No workaround needed because the impact is minimal. | **Plan in the backlog** | Improve wording in a rarely-seen error message; refactor an unused module; add an optional query-string alias |

---

### Difficulty Labels

Difficulty labels help new contributors find issues that match their experience
level. They are assigned by maintainers at triage time, not by the reporter.

The repo uses two label naming conventions. The **canonical** set uses the
`difficulty:` prefix (`difficulty: easy`, `difficulty: medium`,
`difficulty: hard`). Bare labels without the prefix (`easy`, `medium`,
`hard`) are legacy aliases and are gradually being migrated to the prefixed
form. When filtering by difficulty, use the prefixed labels for the most
complete results.

An additional `difficulty: extreme` label exists for issues that require
deep, cross-cutting architectural changes — these go beyond `hard` in scope
or risk and are typically reserved for core contributors.

| Label | Canonical form | Description |
|-------|---------------|-------------|
| Easy | `difficulty: easy` | Self-contained change in a single file or module. No deep knowledge of the codebase or Stellar/Soroban required. Good first issues. Examples: add a missing test case, fix a typo in docs, add a helper function. |
| Medium | `difficulty: medium` | Requires understanding two or more modules, or involves a non-trivial algorithm / data-model change. Some prior exposure to the project is helpful. Examples: extend the indexer to handle a new event type, add a new API route with validation. |
| Hard | `difficulty: hard` | Spans multiple layers of the stack (contract + backend + docs), requires deep domain knowledge (Soroban, SEP-10), or has significant performance or security implications. Examples: implement pay-to-contact flow end-to-end; introduce distributed caching; harden auth middleware against timing attacks. |
| Extreme | `difficulty: extreme` | Cross-cutting architectural changes spanning most of the stack. Reserved for core contributors with deep domain expertise. These issues are rare and typically require design discussion before implementation begins. |

---

### Applying Labels — Quick Reference

| Who | When | What |
|-----|------|------|
| **Reporter** (you) | At issue creation | One `category` label (e.g. `bug`, `test`). Estimated priority written in the issue body (not as a label). |
| **Maintainer** | During triage | Confirms or changes the category label; adds the official `P0`–`P3` priority label; adds the `easy`/`medium`/`hard` difficulty label. |

> **Tip:** If you are unsure which category applies, pick the closest one and
> explain your reasoning in the issue body. Maintainers will adjust if needed —
> a labelled issue that needs a small correction is always better than an
> unlabelled issue that sits in the triage queue.

---

## Filing Backend Issues

We track ~125 active issues. Use these guidelines to help us prioritize efficiently.

### Issue Categories

| Category | Description | Examples |
|----------|-------------|----------|
| `bug` | Unintended behavior or crashes | IPFS timeout; SEP-10 auth fails |
| `feature` | New capability or enhancement | Add region filter; support trial offer |
| `performance` | Optimization or speed improvements | Cache milestone queries; reduce latency |
| `documentation` | README, API docs, or code comments | Clarify error codes; add SDK examples |
| `refactor` | Code restructuring without behavior changes | Consolidate validation; reduce middleware |
| `infra` | Deployment, CI/CD, DevOps | GitHub Actions; database migration tools |
| `security` | Vulnerability fixes or hardening | JSON validation; rate limit on auth |
| `test` | Test coverage or reliability | Add contract edge cases; improve isolation |

### Priority Levels

| Priority | Severity | Timeline | Example |
|----------|----------|----------|---------|
| **P0** | Critical | Fix immediately | Contract init fails; data corruption |
| **P1** | High | Fix within sprint | Milestone broken; payment hangs |
| **P2** | Medium | Schedule next sprint | Scout search slow; stale validator list |
| **P3** | Low | Plan in backlog | Error message clarity; refactor unused module |

### How to File a High-Quality Issue

1. **Search Existing Issues First**  
   Avoid duplicates: https://github.com/scout-off/scout-off-backend/issues

2. **Use a Clear Title**  
   ✅ *"Auth token expires before subscription ends"*  
   ❌ *"Bug with tokens"*

3. **Provide Steps to Reproduce** (for bugs)
   ```
   1. Create a scout account
   2. Purchase a 30-day subscription via /api/scouts/subscribe
   3. Wait 25 days
   4. Call /api/scouts/:wallet/subscription
   
   Expected: subscription still active
   Actual: returns 401 NotSubscribed
   ```

4. **Include Environment Context**
   ```
   - OS: macOS 14.1 / Linux 24.04 / Windows 11
   - Node: v18.16.0
   - npm: 9.6.4
   - Key package versions: npm list express @stellar/stellar-sdk
   - Network: testnet / mainnet / local
   ```

5. **Add Labels**
   - Select category: `bug`, `feature`, `security`, etc.
   - Estimate priority: `P0`, `P1`, `P2`, `P3`
   - Maintainers will confirm priority

6. **Link Related Issues**
   ```
   Fixes #123
   Related to #456
   ```

### Issue Templates

Structured issue templates are available at `.github/ISSUE_TEMPLATE/`.
When you click **New issue** on GitHub, choose the appropriate template
— **Bug report** for bugs, **Feature request** for new capabilities.
The templates prompt for the sections outlined above (repro steps,
environment, acceptance criteria, etc.) so issues arrive with
consistent detail.

## Getting Help

- **Questions about an issue?** Comment on the GitHub issue
- **Need design feedback?** Open a draft PR early
- **Stuck debugging?** Reach out on [Stellar Discord](https://discord.gg/stellar)
- **Security concerns?** Email maintainers privately
- **Contributing via Drips?** Visit [Drips contributor portal](https://drips.network)

## Acknowledgments

ScoutOff is part of the Drips funding wave program. Funded contributors receive support through the Drips platform. Visit [drips.network](https://drips.network) to learn about opportunities and register your interest.

---

**Thank you for contributing to ScoutOff!** Your work helps connect talented footballers with opportunities. 🙌

SHA: 22d84cc3bd4ad4e2b033604e4dfc3ac8ee365919
MATCH: True
