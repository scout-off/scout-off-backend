# Database Migrations

This directory contains the project's SQL migrations, applied in order by the
migration runner in [`src/db/migrate.ts`](../src/db/migrate.ts). See
[CONTRIBUTING.md](../CONTRIBUTING.md#database-migrations) for how to check
status and apply pending migrations, and
[docs/postgres-migration.md](../docs/postgres-migration.md) for running
migrations against PostgreSQL.

## Running Migrations

### Check Status

To see which migrations have been applied and which are pending:

```bash
npm run db:migrate:status
```

This command exits with code 0 if the database is up-to-date, or code 2 if
migrations are pending. Use this in CI/CD to gate deployments or in readiness checks.

### Apply Migrations

To apply all pending migrations:

```bash
npm run db:migrate
```

This is safe to run multiple times (migrations are idempotent). It can also be
run as a one-off container command or Kubernetes Job (see **Deployment** below).

### Get Current Version

To see which migration was last applied:

```bash
npm run db:migrate:version
```

This prints the filename ID of the last applied migration, plus metadata about
the expected vs. current schema version.

## Naming convention

Each migration is a pair of files:

```
NNN_description.sql            # SQLite (default dialect)
NNN_description_postgres.sql   # PostgreSQL counterpart
```

`NNN` is a zero-padded, three-digit prefix. Every SQLite migration must have a
matching `_postgres.sql` file with the same `NNN_description` base name — the
runner uses this pairing (`getDialectCounterpart`) to run the hand-written
file for the driver actually in use instead of relying on its best-effort
`convertSqlToPostgres` / `convertPostgresToSqlite` syntax converter, which
only handles simple substitutions and cannot translate real dialect-specific
logic (e.g. SQLite's `json_extract()` vs Postgres's `->>` operator).

## Ordering

The runner reads all files in the directory and sorts them with a plain
alphabetical `Array.sort()` — there is no separate sequencing metadata.
Two things follow from that:

- **Repeated prefixes** (e.g. multiple `002_*.sql` files) run in alphabetical
  order of the part after the prefix, not creation order. For example
  `002_audit_log.sql`, `002_player_profile_history.sql`,
  `002_trial_offer_events.sql`, and `002_validators.sql` all share prefix
  `002` and run in that alphabetical sequence. Only give two migrations the
  same prefix when their relative order genuinely doesn't matter (no shared
  table/column dependency between them).
- **A SQLite file always sorts before its own `_postgres` counterpart**,
  because `.` (`.sql`) sorts before `_` (`_postgres.sql`) — e.g.
  `002_audit_log.sql` before `002_audit_log_postgres.sql`. This is incidental
  to the pairing mechanism above, not something migration authors need to
  manage by hand.

## Adding a new migration

1. Pick the next unused `NNN` prefix (check the highest existing prefix
   across both dialects).
2. Add `NNN_description.sql` (SQLite) and `NNN_description_postgres.sql`
   (PostgreSQL) with equivalent schema changes.
3. If the migration needs to be reversible, add matching `.down.sql` files
   (see existing `*.down.sql` files for examples) — these are excluded from
   the forward-migration file list and only read when rolling back.
4. Run `npm run migration:status` to confirm the forward-migration files are
   listed (rollback `.down.sql` files are excluded), then apply them locally
   to verify they succeed against both drivers before opening a PR.
