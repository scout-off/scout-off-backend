# Feature Flags

Runtime feature flags let an admin turn features on or off without a redeploy.
They are stored in the `feature_flags` table, defined in
[`src/services/featureFlags.ts`](../src/services/featureFlags.ts), and toggled
through the admin API.

> Keep this doc in sync with `FeatureFlags` in `src/services/featureFlags.ts`
> and the seed migrations. In particular, update it when the
> `player_tokens` / `player_tokens_enabled` naming issue is fixed.

## Flags

| Flag | Gates | Default | Where it's checked |
| ---- | ----- | ------- | ------------------ |
| `saved_searches` | Scout saved-search endpoints: `GET/POST /api/scouts/:wallet/saved-searches`, `PUT/DELETE /api/scouts/:wallet/saved-searches/:id`, `GET /api/scouts/:wallet/saved-searches/:id/run` | **on** (seeded `1` by `db/010_feature_flags.sql`) | `requireFeatureFlag(FeatureFlags.SAVED_SEARCHES)` in `src/routes/scout.ts` |
| `player_tokens` | Player token endpoints: `GET /api/players/:playerId/tokens`, `POST /api/players/:playerId/tokens/buy` | off (no seed row, so it reads as disabled) | `featureFlagGuard()` in `src/controllers/playerTokenController.ts` (direct `isFeatureEnabled` call). See caveats. |
| `player_tokens_enabled` | Nothing yet. Seeded as the intended player-token flag. | off (seeded `0` by `db/020_feature_flags_seed.sql`) | Not checked anywhere. See caveats. |
| `saved_search_alerts_enabled` | Nothing yet. Reserved for saved-search alerts. | off (seeded `0` by `db/020_feature_flags_seed.sql`) | Not checked anywhere (tracked separately). |
| `graphql_enabled` | The `/graphql` endpoint. Requests 404 while it is off (#1126). | off (seeded `0`; also `false` in `FLAG_DEFAULTS`) | Synchronous `isEnabled(GRAPHQL_ENABLED)` in the mount guard in `src/graphql/index.ts` |

A disabled flag checked by `requireFeatureFlag` returns:

```json
{ "success": false, "error": "Feature not available", "code": "FEATURE_DISABLED" }
```

with status `404`, so a disabled feature looks the same as a missing route.

### Known caveats

- **`player_tokens` vs `player_tokens_enabled`.** The code checks
  `player_tokens`, but migration 020 seeds `player_tokens_enabled`. Toggling
  `player_tokens_enabled` has no effect. Toggling `player_tokens` returns 404
  from `PUT /api/admin/feature-flags/:name` until a row exists; create it with
  `PUT /api/admin/feature-flags` (body `{ "name": "player_tokens", "enabled": true }`).
  This mismatch is tracked separately.
- **The player-token guard isn't awaited.** `featureFlagGuard()` calls the async
  `isFeatureEnabled()` without `await`. A Promise is always truthy, so the guard
  never blocks and the player-token endpoints are reachable whatever the flag
  says. Don't rely on `player_tokens` to hide these endpoints until this is fixed.
- **`saved_search_alerts_enabled` gates nothing.** No code reads it yet, so
  toggling it changes nothing.

## Toggling flags (admin API)

All endpoints need an admin JWT (`requireRole('admin')`). Every change writes a
`feature_flag_toggled` audit entry (see [Audit trail](#audit-trail)).

**List all flags.** This reads the DB directly and bypasses the cache:

```bash
curl -s "$API/api/admin/feature-flags" \
  -H "Authorization: Bearer $ADMIN_JWT"
```

**Toggle an existing flag.** Returns 404 if the flag hasn't been seeded:

```bash
curl -s -X PUT "$API/api/admin/feature-flags/graphql_enabled" \
  -H "Authorization: Bearer $ADMIN_JWT" \
  -H "Content-Type: application/json" \
  -d '{"enabled": true}'
```

**Create or update a flag by name** (upsert):

```bash
curl -s -X PUT "$API/api/admin/feature-flags" \
  -H "Authorization: Bearer $ADMIN_JWT" \
  -H "Content-Type: application/json" \
  -d '{"name": "saved_searches", "enabled": false}'
```

## Caching and propagation

There are two read paths, each with its own in-process cache:

| Read path | Used by | Cache | Staleness |
| --------- | ------- | ----- | --------- |
| `isFeatureEnabled()` (async) | `requireFeatureFlag`, player-token guard | Unbounded `Map`, no TTL | Updated immediately by `setFeatureFlag()` **on the instance that handled the toggle**. Other instances keep the old value until they restart. |
| `isEnabled()` (sync) | `/graphql` mount guard | `Map` with TTL `FEATURE_FLAG_CACHE_TTL_MS` (default `5000` ms) | Up to one TTL on every instance. Falls back to `FLAG_DEFAULTS` (or `false`) when the DB is unreachable or the driver isn't SQLite. |

**Multi-instance caveat (#658).** Nothing invalidates caches across instances.
With several replicas, a toggle takes effect at once on the replica that served
the `PUT`, within `FEATURE_FLAG_CACHE_TTL_MS` for `graphql_enabled` everywhere,
and **only after a restart** on other replicas for flags read through
`isFeatureEnabled()`. After toggling `saved_searches` or `player_tokens` in a
multi-replica deployment, do a rolling restart.

**Postgres caveat.** `isEnabled()` reads through the better-sqlite3 handle.
Under `DB_DRIVER=postgres` it always returns the default, so `graphql_enabled`
stays off whatever the DB says.

## Audit trail

`setFeatureFlag()` records each change through `logAuditEvent` with action
`feature_flag_toggled` and these `queryParams`:

| Field | Meaning |
| ----- | ------- |
| `flag_name` | The flag that changed |
| `old_value` | Value before the change (`false` when the row didn't exist) |
| `new_value` | Value after the change |
| `admin_wallet` | Admin who made the change (also the row's `updated_by`) |

See [audit-log.md](audit-log.md) for how to query and verify the audit log.
