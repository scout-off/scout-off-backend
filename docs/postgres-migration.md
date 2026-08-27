# PostgreSQL Migration Guide

This guide documents the process for migrating a Scout-Off backend deployment from SQLite to PostgreSQL.

## Overview

Scout-Off supports two database drivers:
- **SQLite** (default): Fast, simple, file-based. Suitable for single-instance deployments.
- **PostgreSQL** (opt-in): Network-accessible, supports horizontal scaling, concurrent connections.

The migration is reversible within a maintenance window.

## Configuration Reference

The following environment variables control the database driver and connection
behaviour. All four must be correctly configured when switching from SQLite to
PostgreSQL.

| Variable | Accepted values | Default | Description |
| -------- | --------------- | ------- | ----------- |
| `DB_DRIVER` | `sqlite`, `postgres` | `sqlite` | Database driver. **No silent fallback**: a typo (e.g. `postgresql`, `pgsql`) causes the process to exit with a configuration error on startup rather than silently falling back to SQLite. Case-insensitive. |
| `DATABASE_URL` | PostgreSQL connection string | *(required when `DB_DRIVER=postgres`)* | Full connection URI: `postgresql://user:password@host:5432/database`. Optional when `DB_DRIVER=sqlite`. When using connection pooling (PgBouncer), point this at the pooler's port. |
| `DATABASE_SSL` | `true`, `1`, `yes`, `no-verify`, `false`, *(unset)* | `false` | TLS mode for PostgreSQL connections. See [SSL / TLS Configuration](#ssl--tls-configuration) below for per-provider guidance. `true` = full certificate verification (recommended for production). `no-verify` = encrypt but skip cert check (dev/staging with self-signed certs). `false` = no TLS (local or private-network Postgres). |
| `DATABASE_POOL_SIZE` | Integer 1-100 | `10` | Maximum concurrent connections per backend instance. Set this based on your PostgreSQL server's `max_connections` minus overhead for admin tools and other services. A pool of 10 works for most single-instance deployments; 25-50 for high-traffic multi-replica setups. Values outside 1-100 are clamped. |

### Applying configuration changes

After changing any of these variables, restart the backend. The driver and pool
are initialised once at startup; runtime changes are not picked up without a
restart.

### DB_DRIVER validation

On startup, `config.ts` reads `DB_DRIVER`, lowercases it, and checks it against
the known set (`sqlite`, `postgres`). An unrecognised value — including common
typos like `postgresql`, `pgsql`, or `PostgreSQL` — halts the process
immediately with a clear error message rather than silently defaulting to
SQLite:

```
Invalid DB_DRIVER: "postgresql". Expected "sqlite" or "postgres".
```

This strict validation prevents the scenario where an operator believes they
are running against PostgreSQL but the backend has fallen back to a local
SQLite file — a configuration error that is extremely hard to diagnose from
application behaviour alone.



> **Helm chart default:** the `helm/scout-off-backend` chart ships with a
> single-replica, SQLite-backed default topology (`replicaCount: 1`, HPA and
> PDB disabled). Horizontal scaling (multiple replicas or the HPA) requires
> PostgreSQL — switch `env.DB_DRIVER` to `postgres` and provide
> `env.DATABASE_URL` **before** scaling. The chart loudly warns in its
> NOTES.txt output if you scale while still on SQLite. See DEPLOYMENT.md.

## Prerequisites

- PostgreSQL 12 or later
- `pg_dump` utility (included with PostgreSQL)
- Network connectivity between backend instances and PostgreSQL server
- Admin access to create databases and users

## Pre-Migration Checklist

- [ ] Back up current SQLite database file
- [ ] Plan maintenance window (expected downtime: 10-30 minutes depending on data size)
- [ ] Notify stakeholders of maintenance
- [ ] Test procedure in staging environment
- [ ] Verify PostgreSQL server capacity and connectivity

## Step 1: Set Up PostgreSQL

### Local Development (Docker Compose)

If using `docker-compose.yml`, the PostgreSQL service is already configured:

```bash
docker-compose up -d postgres
```

Verify connectivity:

```bash
docker-compose exec postgres psql -U scout_user -d scout_off -c "SELECT 1"
```

### Production Setup

Create a dedicated database and user:

```sql
-- Connect to PostgreSQL as admin
CREATE USER scout_user WITH PASSWORD '[strong-password]';
CREATE DATABASE scout_off OWNER scout_user;
GRANT ALL PRIVILEGES ON DATABASE scout_off TO scout_user;
```

## Step 2: Export Data from SQLite

While the backend is running, export the SQLite database:

```bash
# SQLite to CSV export (example - adjust based on your needs)
sqlite3 scout-off.db <<'EOF'
.mode csv
.output events.csv
SELECT * FROM events;

.output players.csv
SELECT * FROM players;

-- Export all tables similarly
.output events.csv
SELECT * FROM events;
EOF
```

Or use `sqlite3` dump format:

```bash
sqlite3 scout-off.db ".dump" > scout-off-dump.sql
```

## Step 3: Run Migrations

The Scout-Off backend automatically runs migrations on startup. To switch to PostgreSQL:

1. Set the `DB_DRIVER` environment variable to `postgres`:

```bash
export DB_DRIVER=postgres
export DATABASE_URL="postgresql://scout_user:[password]@postgres-host:5432/scout_off"
```

2. Start the backend:

```bash
npm run build
npm start
```

The backend will:
- Connect to PostgreSQL
- Detect any unapplied migrations
- Create schema using PostgreSQL-specific migration files (`*_postgres.sql`)
- Apply all pending migrations in order

## Step 4: Verify Data Integrity

After migration, verify that all data has been transferred:

```sql
-- Connect to PostgreSQL
SELECT COUNT(*) FROM events;
SELECT COUNT(*) FROM players;
SELECT COUNT(*) FROM subscriptions;
-- ... verify counts match SQLite exports
```

Check application logs for any errors during migration or startup.

## Step 5: Configure for Production

Update your deployment configuration:

### Docker Compose

```yaml
services:
  backend:
    environment:
      DB_DRIVER: postgres
      DATABASE_URL: "postgresql://scout_user:${DB_PASSWORD}@postgres:5432/scout_off"
```

### Kubernetes / Other Orchestration

Set environment variables in your deployment manifest:

```yaml
env:
  - name: DB_DRIVER
    value: "postgres"
  - name: DATABASE_URL
    valueFrom:
      secretKeyRef:
        name: db-credentials
        key: connection-url
```

## Step 6: Enable Horizontal Scaling

With PostgreSQL, multiple backend replicas can safely share the same database.
This section describes exactly what "safely" means here (#1014) — concretely,
not as a general promise.

> **Helm chart:** scaling is a two-step change — first set `env.DB_DRIVER: postgres`
> and provide `env.DATABASE_URL` (plus `DATABASE_SSL` for managed providers), then
> raise `replicaCount` and/or enable `hpa.enabled`. Doing it in the opposite order
> (scaling while still on SQLite) is exactly the broken combination the chart's
> default topology guards against:

```yaml
# Example: 3 backend replicas
replicas: 3
```

### What every instance actually does

- **Connects to the same PostgreSQL database** through its own connection
  pool (`pg.Pool`, default size 10, configurable via `DATABASE_POOL_SIZE`
  (1-100) — see `PostgresDriver`'s constructor in
  `src/db/postgres-driver.ts`). Every query is genuinely `await`-ed against
  that pool; there is no busy-waiting or blocking of the Node event loop, so
  concurrent requests within and across replicas are served in parallel
  (bounded by pool size), not serialized.
- **Every application code path goes through the same `DbDriver` abstraction**
  on both SQLite and PostgreSQL (`src/db/driver.ts`) — the raw
  `better-sqlite3` handle (`getDb()`) is no longer reachable from application
  code outside the driver implementations themselves, so behavior (return
  shapes, error semantics, transactional guarantees) is the same regardless
  of which driver a given deployment runs.
- **Multi-statement writes run inside a real transaction**
  (`driver.transaction(fn)`), which on PostgreSQL is a genuine
  `BEGIN`/`COMMIT`/`ROLLBACK` on one dedicated pooled connection per call —
  not row-level locking in the general sense, and not automatic protection
  against every possible race. A transaction only prevents another
  transaction from observing its uncommitted writes; it does **not** by
  itself stop two concurrent transactions from both reading the same "last
  row" under PostgreSQL's default READ COMMITTED isolation and then both
  writing based on that stale read.
- **The one place in this codebase where that specific race matters — the
  audit-log hash chain's "read the previous hash, then insert" sequence
  (`insertAuditLog` in `src/db/index.ts`) — is closed explicitly**, via
  `tx.lockForWrite('audit_log')` (`DbTxHandle.lockForWrite`,
  `src/db/driver.ts`). On PostgreSQL this takes a transaction-scoped
  advisory lock (`pg_advisory_xact_lock`) before the read, so concurrent
  `insertAuditLog` calls across every replica linearize instead of racing;
  on SQLite it's a no-op because `SqliteDriver` already serializes all
  transactions on its single connection. This is what makes the hash chain
  provably unbroken under concurrent load — verified by a live-Postgres test
  that fires 120 simultaneous inserts and checks the resulting chain has no
  gaps (`tests/db/postgresIntegration.test.ts`).
- **`audit_log.hash` and `audit_log.event_source` are `NOT NULL` on both
  drivers** (`db/012_audit_log_hash_chain_postgres.sql`,
  `db/014_audit_log_hash_not_null_postgres.sql`) — a previous version of the
  PostgreSQL schema allowed `NULL` in both columns, silently weakening the
  tamper-evidence guarantee the hash chain exists to provide. A write that
  fails now throws (`insertAuditLog` propagates the error;
  `logAuditEvent` logs it at `critical` severity and rethrows) rather than
  being silently dropped.
- **SQLite's single-writer connection uses WAL mode and a 5-second
  `busy_timeout`** (`src/db/index.ts`) so readers and a writer can proceed
  concurrently instead of blocking on the default rollback journal, and a
  write under transient lock contention waits and retries at the SQLite
  engine level instead of failing immediately with `SQLITE_BUSY`.
- **No general row-level locking is applied outside the audit-log path
  described above.** Other multi-statement writes in this codebase (player
  upserts, feature-flag toggles, saved-search CRUD, etc.) are each scoped to
  a single logical resource keyed by its own primary key, so ordinary
  PostgreSQL MVCC/row-versioning semantics under READ COMMITTED are
  sufficient — there is no other "read stale value across two connections,
  then write" sequence in the current codebase. If you add one, it needs the
  same `lockForWrite`-style treatment; a transaction alone does not
  guarantee it's race-free.
- **Connection pooling via PgBouncer or pgpool2 remains optional** — see
  [PostgreSQL Connection Pooling](#postgresql-connection-pooling-optional)
  below. `pg.Pool`'s own per-process pooling is sufficient for most
  deployment sizes; an external pooler helps once you're running many
  replicas against a database with a limited `max_connections`.

## Rollback Procedure

If issues arise, rollback to SQLite:

1. Stop all backend instances
2. Verify SQLite database file still exists and is backed up
3. Set environment variables back to SQLite:

```bash
export DB_DRIVER=sqlite
export DB_PATH=scout-off.db
```

4. Restart backend instances

**Note:** If you made changes to data in PostgreSQL after switching, those changes will not be reflected in SQLite. Only rollback if the migration completed but you encounter unexpected issues during testing.

## SSL / TLS Configuration

Most managed PostgreSQL providers — including **AWS RDS**, **Heroku Postgres**, **Supabase**,
**Neon**, and **Railway** — require or strongly recommend SSL for external connections.  The
backend exposes the `DATABASE_SSL` environment variable to control TLS behaviour.

### DATABASE_SSL values

| Value | Effect |
|---|---|
| `true` (or `1`, `yes`) | Enable SSL with full certificate verification (**recommended for production**) |
| `no-verify` | Enable SSL transport but skip certificate verification (dev/staging with self-signed certs) |
| `false` / unset | Disable SSL entirely (local or private-network Postgres without TLS) |

### Provider-specific examples

#### AWS RDS / Aurora

RDS requires SSL and provides a CA bundle.  For simple setups, `DATABASE_SSL=true` is enough
because the RDS CA is in the system trust store used by the `pg` library.

```bash
DATABASE_SSL=true
DATABASE_URL="postgresql://scout_user:password@your-rds-host.region.rds.amazonaws.com:5432/scout_off"
```

If you need to specify the CA bundle explicitly, do so via `PGSSLROOTCERT` (a standard `libpq`
environment variable respected by the underlying `pg` library):

```bash
DATABASE_SSL=true
PGSSLROOTCERT=/path/to/rds-combined-ca-bundle.pem
```

#### Heroku Postgres

Heroku Postgres runs on AWS and uses a self-signed CA that is not in the system trust store.
Use `no-verify` in review apps and `true` with `PGSSLROOTCERT` in production:

```bash
# Review apps / staging — acceptable shortcut
DATABASE_SSL=no-verify
DATABASE_URL="$DATABASE_URL"   # Heroku auto-sets this

# Production — download the CA cert from the Heroku dashboard
DATABASE_SSL=true
PGSSLROOTCERT=/path/to/heroku-server-ca.pem
```

> **Note**: Heroku recommends disabling `rejectUnauthorized` only in ephemeral environments.
> Use a pinned CA cert in production.

#### Supabase

Supabase uses a valid certificate signed by a trusted CA.  `DATABASE_SSL=true` works out of the
box:

```bash
DATABASE_SSL=true
DATABASE_URL="postgresql://postgres:password@db.your-project-ref.supabase.co:5432/postgres"
```

#### Neon / Railway

Both Neon and Railway provision certificates through Let's Encrypt (trusted by default):

```bash
DATABASE_SSL=true
DATABASE_URL="postgresql://user:password@your-host/dbname?sslmode=require"
```

#### Local development (no TLS)

When running Postgres locally or inside a private Docker network with no TLS configured:

```bash
DATABASE_SSL=false   # or leave unset
DATABASE_URL="postgresql://scout_user:password@localhost:5432/scout_off"
```

### How it works internally

`DATABASE_SSL` is parsed in `src/config.ts` and passed to `PostgresDriver` in
`src/db/postgres-driver.ts`:

- `DATABASE_SSL=true` → `{ rejectUnauthorized: true }` (full verification)
- `DATABASE_SSL=no-verify` → `{ rejectUnauthorized: false }` (transport only)
- `DATABASE_SSL=false` / unset → no `ssl` option passed (plaintext)

## PostgreSQL Connection Pooling (Optional)

For high-concurrency deployments, use PgBouncer or pgpool2:

### PgBouncer Example

```ini
[databases]
scout_off = host=postgres port=5432 dbname=scout_off user=scout_user password=password

[pgbouncer]
pool_mode = transaction
max_client_conn = 1000
default_pool_size = 25
```

Then connect backend to PgBouncer:

```bash
DATABASE_URL="postgresql://scout_user:password@pgbouncer:6432/scout_off"
```

## Performance Tuning

### PostgreSQL Configuration (`postgresql.conf`)

For typical Scout-Off workloads:

```ini
# Connection limits
max_connections = 200
superuser_reserved_connections = 3

# Memory
shared_buffers = 256MB
effective_cache_size = 1GB
work_mem = 4MB
maintenance_work_mem = 64MB

# WAL
wal_buffers = 16MB
checkpoint_completion_target = 0.9

# Query planning
random_page_cost = 1.1  # For SSD storage
```

### Create Indexes for Common Queries

Indexes are created by migrations, but monitor slow query log:

```bash
# Enable slow query logging
ALTER SYSTEM SET log_min_duration_statement = 100;  -- Log queries >100ms
SELECT pg_reload_conf();
```

## Troubleshooting

### Connection Refused

Verify PostgreSQL is running and accessible:

```bash
psql -h postgres-host -U scout_user -d scout_off -c "SELECT 1"
```

### Migration Fails

Check the backend logs for specific error messages. Common issues:

- **Permission denied**: User lacks permissions on the database
- **Disk full**: PostgreSQL server out of disk space
- **Timezone issues**: Ensure PostgreSQL and backend use compatible timezone settings

### Performance Issues Post-Migration

- Run `ANALYZE` to update table statistics:

```sql
ANALYZE;
```

- Check for missing indexes:

```sql
SELECT * FROM pg_stat_user_indexes WHERE idx_scan = 0;
```

## FAQ

**Q: Can I keep SQLite for backups?**

A: Yes. Continue to back up PostgreSQL using `pg_dump`:

```bash
pg_dump -h postgres-host -U scout_user scout_off | gzip > backup-$(date +%Y%m%d).sql.gz
```

**Q: What about read replicas?**

A: PostgreSQL streaming replication is outside the scope of this guide. Refer to PostgreSQL documentation for setting up standby replicas.

**Q: How do I monitor PostgreSQL?**

A: Use tools like:
- `pg_stat_statements` (query performance)
- `pgAdmin` (web UI)
- `Prometheus + postgres_exporter` (metrics)

**Q: How is the PostgreSQL driver actually tested — is it just mocked?**

A: No. `.github/workflows/ci.yml`'s `postgres` job runs the application test
suite against a real `postgres:16-alpine` service container on every push
and pull request (excluding only the test files that exercise the
events/indexer, admin-multisig, and webhook-delivery subsystems, which are
owned by separate issues and still use SQLite directly by design). You can
run the same thing locally with `npm run test:postgres` against a Postgres
instance reachable at `DATABASE_URL` (`docker-compose up -d postgres` starts
one). Separately, `tests/db/postgresIntegration.test.ts` runs against a live
instance too (set `POSTGRES_TEST_URL` or `DATABASE_URL`) and specifically
proves: 60+ concurrent queries complete in pool-bounded parallel time (not
serialized), a slow in-flight query never blocks the Node event loop, `NULL`
inserts into `audit_log.hash`/`event_source` are rejected, and 120
simultaneous audit-log writes produce zero silent loss with an unbroken hash
chain.

## Support

For issues with the migration or PostgreSQL driver support, open an issue on the project repository with:

- Error messages from backend logs
- PostgreSQL version
- Data size (approx. table row counts)
- Deployment environment (Docker, Kubernetes, etc.)
