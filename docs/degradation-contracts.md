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

## Circuit Breakers

Circuit breakers isolate dependency failures to prevent cascading latency spikes and connection exhaustion. When open, requests fast-fail immediately rather than waiting for network timeouts.

### Generic Outbound Circuit Breaker

Configured in `src/utils/circuitBreaker.ts` and used as the default for outbound services:

- `CIRCUIT_BREAKER_FAILURE_THRESHOLD`
  - **Default:** `5`
  - **Unit:** Count (integer >= 1) of consecutive failures
  - **Effect:** Consecutive failures before the breaker trips to `OPEN`. Once open, calls immediately throw `CircuitBreakerOpenError` and fail fast.
  - **Safe values:** `3`–`10`. Lower values fail faster during outages; higher values tolerate transient network jitter.
- `CIRCUIT_BREAKER_RESET_TIMEOUT_MS`
  - **Default:** `30000` (30 seconds)
  - **Unit:** Milliseconds (integer >= 1)
  - **Effect:** Cooldown duration in milliseconds before moving from `OPEN` to `HALF_OPEN` to permit a single probe request to check if the dependency has recovered.
  - **Safe values:** `10000`–`60000` ms. Shorter windows detect recovery faster; longer windows reduce load on struggling upstream services.

### IPFS / Pinata Circuit Breaker

Dedicated circuit breaker for Pinata API uploads and health probes (`src/services/ipfs.ts`):

- `IPFS_BREAKER_FAILURE_THRESHOLD`
  - **Default:** `5`
  - **Unit:** Count (integer >= 1) of consecutive failures
  - **Effect:** Number of consecutive Pinata request failures before `ipfsBreaker` opens. When open, upload/pin requests fail immediately, JSON payloads are queued in `pending_pins` for background reconciliation, and `/ready` reports `ipfs: unavailable`.
  - **Safe values:** `3`–`10`.
- `IPFS_BREAKER_RESET_TIMEOUT_MS`
  - **Default:** `30000` (30 seconds)
  - **Unit:** Milliseconds (integer >= 1)
  - **Effect:** Cooldown duration in milliseconds while the breaker remains `OPEN` before allowing a trial request to Pinata.
  - **Safe values:** `10000`–`60000` ms.

