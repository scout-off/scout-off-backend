# Degradation contracts (#1116)
#
# When a dependency fails, each route group must respond as specified below.
# The chaos harness asserts these contracts.

## Dependencies
- **redis** — rate limit / cache / token blocklist
- **db** — primary datastore (sqlite or postgres)
- **rpc** — Soroban RPC (Stellar)
- **ipfs** — Pinata / gateway health

## Route groups

| Group | Paths | redis down | db down | rpc down | ipfs down |
|---|---|---|---|---|---|
| liveness | `/health`, `/health/liveness`, `/version` | 200 | 200 | 200 | 200 |
| readiness | `/ready`, `/health/readiness` | 200 or 503 degraded | **503** degraded | **503** if stellar enabled | **503** degraded |
| auth | `/api/auth/*` | 200/4xx (fail-open rate limit) | 503/5xx avoided where possible; challenge may 503 | SEP-10 may 503 | N/A |
| players read | `GET /api/players*` | 200 (cache miss) | 503 | 200 (DB-backed) | 200 |
| admin | `/api/admin/*` | 200/4xx | 503 | reindex/RPC ops may 502/503 | N/A |
| webhooks dispatch | (internal) | N/A | dead-letter path | N/A | N/A |

## Combinations (critical paths)
- redis + rpc down → `/ready` 503; `/health/liveness` 200; rate limit fail-open
- db + ipfs down → `/ready` 503; liveness 200
