# Documentation Index

This directory holds the operator-facing and contributor-facing documentation
for the ScoutOff backend. It exists so that finding the right doc is a lookup,
not a directory listing.

> **For contributors:** when you add a new `docs/*.md` file, add it to this
> index — pick the right group below and keep the one-line description
> accurate. A doc that isn't indexed effectively doesn't exist.

## API

| Doc | Audience | Description |
| --- | -------- | ----------- |
| [API_DOCUMENTATION.md](API_DOCUMENTATION.md) | Contributor | How the OpenAPI spec is generated from route JSDoc comments, and the annotation format to keep it accurate when adding or changing routes |
| [api-versioning.md](api-versioning.md) | Contributor | The API versioning policy: `/api/v1`, `/api/v2`, and the `API-Version` header semantics |
| [events.md](events.md) | Operator & client developer | The SSE event stream (`/api/events/stream`): how to connect, filter parameters, frame format, wallet-relevance rules, and reconnection limitations |
| [ipfs-pinata-gateway.md](ipfs-pinata-gateway.md) | Operator | IPFS gateway configuration: `PINATA_GATEWAY` vs `IPFS_GATEWAYS`, default fallback order, HTTPS validation, and retrieval retry behavior |
| [webhooks.md](webhooks.md) | Operator & subscriber | Outbound event webhooks: subscribing, HMAC signature verification, delivery/retry, the dead-letter queue, and admin replay |
| [trace-correlation.md](trace-correlation.md) | Contributor | End-to-end correlation lifecycle across HTTP → Soroban tx → indexer → webhook/SSE (#1113) |
| [event-ordering.md](event-ordering.md) | Contributor | Deterministic indexer event total order and co-transaction atomicity (#1111) |

## Auth & Security

| Doc | Audience | Description |
| --- | -------- | ----------- |
| [auth.md](auth.md) | Contributor | SEP-10 challenge/response, JWT issuance and claims, refresh, logout, API keys, admin wallets, and live SSE revocation |
| [audit-log.md](audit-log.md) | Operator | Tamper-evident audit trail: schema, hash-chain construction, what actions are logged, verification procedures, and tamper detection |
| [secrets-rotation.md](secrets-rotation.md) | Operator | Rotation policy and step-by-step procedures for every long-lived secret (JWT, Pinata, Stellar keys, webhook secrets) |
| [ip-reputation.md](ip-reputation.md) | Operator | The IP reputation scoring model (0–100, tiers, decay, bad user-agents) and the admin whitelist/blacklist endpoints |

## Data

| Doc | Audience | Description |
| --- | -------- | ----------- |
| [data-model.md](data-model.md) | Contributor | All application tables, their purposes, and how they are populated (indexer, API writes, migrations) — consult this before writing queries |
| [data-privacy.md](data-privacy.md) | Operator | GDPR right-to-erasure: what the backend can erase, and the immutable on-chain boundary |
| [postgres-migration.md](postgres-migration.md) | Operator | Migrating a deployment from SQLite to PostgreSQL |
| [tier-promotion.md](tier-promotion.md) | Contributor | How a player's progress tier (0–3) is derived from approved milestones |

## Operations

| Doc | Audience | Description |
| --- | -------- | ----------- |
| [runbook.md](runbook.md) | Operator | Incident → action runbook: indexer lag, wrong tiers, webhook failures, RPC/IPFS outages, DB slowness, reindex/replay, dead-letter drain, cache flush, circuit breaker, pause/unpause |
| [performance.md](performance.md) | Contributor | Latency budgets for key endpoints and how to run the load-test suites |
| [soroban-sandbox-e2e.md](soroban-sandbox-e2e.md) | Contributor | Local + CI Soroban sandbox that deploys all five contracts and runs live backend E2E (#1117) |

## History

Dated implementation notes kept for historical record; not living documentation.

| Doc | Audience | Description |
| --- | -------- | ----------- |
| [history/2026-07-25-bulk-validator-import.md](history/2026-07-25-bulk-validator-import.md) | Contributor | Implementation notes for the bulk validator import endpoint (multi-sig gating, concurrency limiting) |
| [history/2026-07-27-pagination-versioning-payments-mutex.md](history/2026-07-27-pagination-versioning-payments-mutex.md) | Contributor | Implementation notes for player pagination, API versioning, payment history filters, and the withdrawal mutex |

## Not in this directory

- [../DEPLOYMENT.md](../DEPLOYMENT.md) — deployment environment variables, Kubernetes/Helm, backups, blue-green topology
- [../BACKEND_API_DOCS.md](../BACKEND_API_DOCS.md) — endpoint reference that links to the generated OpenAPI spec (served live at `GET /api/docs`)
