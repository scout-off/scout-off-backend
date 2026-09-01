# Data Model

This document provides a reference for all application tables, their purposes, and how they are populated. A contributor writing a query should consult this to determine which table is authoritative for a given concept.

## Core Player & Indexer Tables

| Table | Purpose | Populated By |
|-------|---------|--------------|
| **players** | Core player profiles with position, region, tier. Canonical source for player metadata. | API write (`POST /api/players/register`), indexer (progress updates from contract events) |
| **events** | Append-only ledger of Soroban contract events. Deduped by `(tx_hash, event_index)`. Ordered by `(ledger, tx_application_order, event_index, contract_id)`. | Indexer (polls Soroban RPC every 5s) |
| **tx_correlations** | Off-chain bridge from `tx_hash` → request `correlation_id` for end-to-end tracing (#1113). | Written on Soroban submit; read by indexer |
| **indexer_state** | Tracks indexer progress (last_ledger indexed, reorg detection state). | Indexer on startup and after each sync cycle |
| **player_profile_history** | Versioned snapshots of player metadata_uri updates (append-only history). Used for audit and rollback queries. | Indexer when a PlayerMetadataUpdated event is indexed |

## Chain-Mirror Tables (Events-Driven)

| Table | Purpose | Populated By |
|-------|---------|--------------|
| **trial_offer_events** | On-chain trial offer records indexed from contract events (deduped by tx_hash). Separate from trial_offers (see API-Owned below). | Indexer (ingests TrialOfferCreated contract events) |
| **validators** | Registry of Stellar wallets authorized as validators; tracks revocation state. | Indexer (ingests ValidatorRegistered / ValidatorRevoked events) |
| **contact_unlocks** | Scout-player contact unlock events indexed from chain. Composite PK (scout_wallet, player_id) ensures one record per pair. | Indexer (ingests ContactUnlocked contract events) |
| **subscriptions** | Scout subscription tiers and expiry times mirrored from on-chain state. | Indexer (ingests SubscriptionCreated / SubscriptionCancelled events) |

## API-Owned Tables

| Table | Purpose | Populated By |
|-------|---------|--------------|
| **trial_offers** | API-level workflow tracking (accept/reject status, reject_reason, responded_at). Distinct from trial_offer_events (on-chain). | API write (`POST /api/scouts/:wallet/trial-offers/:offerId/accept`, etc.) |
| **scout_bookmarks** & **scout_bookmark_folders** | Player bookmarks organized by scouts into folders, with optional per-bookmark notes. | API write (`POST /api/scouts/:wallet/bookmarks`) |
| **scout_saved_searches** | Named filter presets stored as JSON; used for quick re-filtering and notifications. | API write (`POST /api/scouts/:wallet/saved-searches`) |
| **scout_player_notes** & **scout_player_notes_v2** | Private notes scouts attach to players; v2 supports multiple notes per player. v1 is read-only; new writes use v2. | API write (`POST /api/scouts/:wallet/players/:playerId/notes`) |
| **api_keys** | Long-lived API keys (key_hash only; plaintext returned once at issuance) for server-to-server integrations. | API write (`POST /api/api-keys`); updates on last_used_at tracking |

## Auth & Validation Tables

| Table | Purpose | Populated By |
|-------|---------|--------------|
| **revoked_tokens** | Blocklist of revoked JWT tokens (jti claim) to prevent reuse after logout. Entries expire after 24h. | Auth service on token revocation; pruned periodically |
| **wallet_blocklist** | Wallets whose SSE/real-time access is revoked (e.g., after Terms violations). Blocks new connections. | Admin API write (`POST /api/admin/wallet-blocklist`); manual or automated policy enforcement |

## IPFS & Caching Tables

| Table | Purpose | Populated By |
|-------|---------|--------------|
| **pending_pins** | Distributed mutex & dedup cache for IPFS pin operations. Stores JSON payload and resolved CID to avoid duplicate uploads. Entries expire after configured TTL. | API write (`POST /api/players/register` pins metadata); pinning service updates resolved_cid |

## Audit & Admin Tables

| Table | Purpose | Populated By |
|-------|---------|--------------|
| **audit_log** | Immutable audit trail of admin actions (query params, action, signer wallet, timestamp). Hash-chain verified. | Admin service on query mutations (`POST`, `PUT`, `DELETE`); app-wide via `recordAudit()` |
| **pending_admin_actions** & **admin_action_signatures** | Multi-signature workflow for high-value admin operations (pause contract, withdraw fees, etc.). Requires M-of-N signatures. | Admin API (`POST /api/admin/actions`); signature collection via `POST /api/admin/actions/:id/sign` |
| **pending_milestones** | Pending milestone submissions awaiting validator review. References validator wallet and evidence URI. | Indexer (ingests MilestoneSubmitted events) |
| **validator_stats** | Aggregate statistics (milestones_approved, milestones_rejected) per validator. | Background job or computed on-demand from pending_milestones + approved events |

## Feature & Configuration Tables

| Table | Purpose | Populated By |
|-------|---------|--------------|
| **feature_flags** | Runtime feature toggles (e.g., `player_tokens`, `saved_searches`) toggled via admin API without redeployment. | Migration seed (010); admin API write (`POST /api/admin/feature-flags`) |
| **idempotency_keys** | Request deduplication cache for safe retries (e.g., subscription webhooks). Stores status_code, cached response, and fingerprint. Entries expire after 24h. | API middleware on first request; checked before duplicate retries |

## Event & Notification Tables

| Table | Purpose | Populated By |
|-------|---------|--------------|
| **profile_views** | Analytics table tracking scout profile views with 5-minute dedup window to prevent artificial inflation. | API write (`GET /api/players/:playerId` with auth); dedup logic prevents rapid repeated views |
| **saved_search_notifications** | Dedup cache to prevent duplicate notifications for the same player matching the same saved search. | Notification service after sending; checked to avoid resending. |
| **webhook_subscriptions** | Webhook endpoint subscriptions (URL, encrypted secret, optional scout_wallet scope, optional event_types filter). | API write (`POST /api/webhooks/subscriptions`); mutation events trigger deliveries |
| **webhook_dead_letters** | Failed webhook deliveries queued for retry/replay. Tracks delivery_id, failure_reason, attempts, lock state. | Webhook dispatch service on delivery failure; replayed manually or automatically |

## Financial Tables

| Table | Purpose | Populated By |
|-------|---------|--------------|
| **fee_withdrawals** | Record of platform fee withdrawals to treasury address. Includes idempotency_key for safe replay, tx_hash for on-chain confirmation. | Admin API (`POST /api/admin/fee-withdrawals`); idempotency prevents duplicate withdrawals |

---

## Data Population Patterns

### 1. **Indexer-Driven** (On-Chain Mirror)
```
Soroban Contract → Event Emitted
  ↓
Indexer polls Soroban RPC (every 5s)
  ↓
INSERT events (deduped by tx_hash + event_index, ordered by ledger/tx/event)
  ↓
Normalize payload (camelCase → snake_case)
  ↓
Reorg detection (compare ledger_hash)
  ↓
Dispatch async: INSERT/UPDATE players, subscriptions, validators, etc.
  ↓
Trigger webhooks for approved milestones
```

### 2. **API-Driven** (Direct Writes)
```
POST /api/endpoint
  ↓
Validate body (schema, auth)
  ↓
Normalize input (e.g., position aliases: 'CB' → 'defender')
  ↓
INSERT/UPDATE table
  ↓
Return response
```

### 3. **Background Job**
```
Periodic job (e.g., token pruning, notification dispatch)
  ↓
Query table
  ↓
Perform action (send webhook, prune expired entries)
  ↓
UPDATE status or DELETE row
```

---

## Chain vs. API Ownership

**Chain-Mirror Tables** (indexer-only writes):
- `events`, `indexer_state`, `validators`, `subscriptions`, `contact_unlocks`, `trial_offer_events`, `player_profile_history`
- Source of truth is the Soroban contract; database is a read cache.
- Write conflicts are impossible; reorg detection handles chain rollbacks.

**API-Owned Tables** (API-only writes):
- `trial_offers`, `scout_bookmarks`, `scout_saved_searches`, `scout_player_notes*`, `api_keys`, `audit_log`, `pending_admin_actions`
- Source of truth is the database; no on-chain mirror.
- Business logic owns the write pattern.

**Hybrid Tables** (Indexer + API writes):
- `players` (indexer writes progress_level; API writes initial profile)
- `idempotency_keys` (API writes on first request; pruning job deletes expired)
- Requires careful serialization to avoid conflicts.
