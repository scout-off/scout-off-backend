# PostgreSQL Migration Guide

This document covers configuring ScoutOff to use PostgreSQL instead of (or alongside) SQLite.

## Environment Variables

Add these to your `.env` file:

```env
# Connection string (required for PostgreSQL mode)
DATABASE_URL=postgresql://user:password@localhost:5432/scoutoff

# SSL mode: 'true', 'no-verify', or 'false' (default)
DATABASE_SSL=false

# Pool sizing — tune for your workload
DB_POOL_MIN=2
DB_POOL_MAX=10
```

## Pool Sizing

| Environment | `DB_POOL_MIN` | `DB_POOL_MAX` | Rationale |
|---|---|---|---|
| Development | 0 | 2 | Minimal footprint |
| Staging | 2 | 10 | Moderate load |
| Production | 5 | 20 | High-concurrency API |

The pool will queue requests beyond `DB_POOL_MAX` rather than rejecting them. If a connection cannot be acquired within 5 seconds (`connectionTimeoutMillis`), the query fails with a timeout error.

## Connection Health

- **Idle timeout**: connections idle for 30 seconds are automatically released back to the pool.
- **Connection timeout**: acquiring a connection times out after 5 seconds under load.
- **Error handling**: pool error events increment the `db_pool_error_total` Prometheus counter and are logged.

## PgBouncer Compatibility

The driver is compatible with PgBouncer in **statement mode**:

- Uses `options: '--client_encoding=UTF8'` instead of `SET client_encoding` statements.
- No `SET` commands are issued within transaction scope.
- Connect via PgBouncer on port 6432 (default) instead of PostgreSQL directly.

### Docker Compose Setup

```bash
docker-compose up -d
# PostgreSQL on localhost:5432
# PgBouncer on localhost:6432 (statement mode)
```

Update `DATABASE_URL` to point to PgBouncer:

```env
DATABASE_URL=postgresql://test:test@localhost:6432/scoutoff_test
```

## SSL Modes

| `DATABASE_SSL` | Behavior |
|---|---|
| `false` | No SSL (local development) |
| `true` | SSL with certificate verification |
| `no-verify` | SSL without certificate verification (testing) |

## Health Checks

### Readiness Probe (`GET /ready`)

When `DATABASE_URL` is set, the readiness probe checks PostgreSQL connectivity:

```json
{
  "status": "ok",
  "services": {
    "ipfs": "ok",
    "postgres": "ok",
    "stellar": "ok"
  }
}
```

Returns `503` with `"postgres": "unavailable"` if the database is unreachable.

### Prometheus Metrics

Exposed at `GET /metrics`:

| Metric | Type | Description |
|---|---|---|
| `db_pool_active_connections` | Gauge | Currently checked-out connections |
| `db_pool_idle_connections` | Gauge | Connections available in the pool |
| `db_pool_error_total` | Counter | Total pool error events |

## Migrating from SQLite

1. Install PostgreSQL and create the database.
2. Run the SQL migrations in `db/` against the new database (adapt `AUTOINCREMENT` → `SERIAL`, etc.).
3. Set `DATABASE_URL` in `.env`.
4. The readiness probe will automatically include PostgreSQL checks.

## Running Tests

Unit tests mock the `pg` library via `__mocks__/pg.js` — no real database connection is needed:

```bash
npm run test
```

For integration testing with a real database:

```bash
docker-compose up -d
DATABASE_URL=postgresql://test:test@localhost:5432/scoutoff_test npm run test
```
