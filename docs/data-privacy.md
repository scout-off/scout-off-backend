# Data Privacy — Erasure and Anonymization

This document explains which player data the ScoutOff backend can erase on
request and which data is permanently retained due to on-chain immutability.

---

## Erasable Data (Off-Chain)

The backend controls the following off-chain stores and can scrub identifying
information when a player invokes `POST /api/players/:playerId/anonymize`:

| Store | PII fields | Action | Legal basis |
|-------|------------|--------|-------------|
| `players` | wallet, position, region, metadata_uri | Nullify / placeholder wallet; deactivate | GDPR Art. 17 — erasure |
| `player_profile_history` | metadata_uri, tx_hash | Delete all rows for player | Erasure |
| `pending_milestones` | evidence_uri, validator_wallet | Delete rows | Erasure |
| `profile_views` | scout→player linkage | Delete rows | Erasure (behavioral) |
| `contact_unlocks` | player reference | Delete rows | Erasure |
| `trial_offers` | offer details referencing player | Delete rows | Erasure |
| `trial_offer_events` | details_uri, scout_wallet linkage | Delete rows | Erasure |
| `scout_bookmarks` | player reference | Delete rows | Erasure |
| `scout_player_notes` / `scout_player_notes_v2` | note_text / content (encrypted at rest under `NOTES_ENCRYPTION_KEY`) | Delete rows | Erasure |
| `events` | payload JSON (wallet, metadata_uri, region, evidence_uri, free text) | Redact PII fields in-place; keep type/ledger/tx_hash/player_id structure | Legitimate interest — immutable indexer log with PII minimized |
| `webhook_dead_letters` | payload JSON referencing player | Redact payload fields | Erasure / minimization |
| `webhook_deliveries` | error_message may echo player data | Replace with `[anonymized]` when matched | Minimization |
| `idempotency_keys` | cached HTTP response bodies | Delete rows whose `response` references player | Erasure |
| `saved_search_notifications` | player_id | Delete rows | Erasure |
| `audit_log_pii` | optional side-table JSON linked to hash-chained `audit_log` | Delete rows referencing player (does **not** mutate `audit_log`) | Erasure without breaking audit chain |
| IPFS pins (Pinata) | metadata / evidence CIDs | Unpin (best-effort) | Erasure |

### Scout notes encryption (#1328)

Private scout notes are encrypted at rest with AES-256-GCM (`src/utils/fieldCipher.ts`,
purpose `notes`, env `NOTES_ENCRYPTION_KEY`). Plaintext exists only in memory on
read/write paths in `src/db/index.ts`. Legacy plaintext rows are still readable
until `npm run migrate-encrypt-notes` is run once in each environment.

After anonymization, the player will:

- **Not** appear in search results (`GET /api/players?...`) with any identifying data
- **Not** return PII from the profile endpoint (`GET /api/players/:playerId`)
- **Not** have recoverable profile history or scout notes
- **Not** have IPFS metadata pinned by this backend's Pinata account

The `player_id` surrogate key is retained so aggregate statistics (total player
count, progress_level distribution) remain valid.

---

## Non-Erasable Data (On-Chain)

ScoutOff records player registration and milestone events on the **Soroban
smart contract** (Stellar network). This data is architecturally immutable:

| Data | Why it cannot be erased |
|------|------------------------|
| `player_registered` event (wallet, metadata_uri, position, region) | Soroban ledger entries are append-only; the contract has no `delete` or `update_player` function |
| Milestone approval/rejection events (player_id, evidence_uri) | Same — on-chain events are permanent |
| Transaction hashes referencing the player | Stellar ledger is immutable |

**This is by design.** The platform's value proposition is tamper-proof,
verifiable scouting data. On-chain immutability is explicitly documented here
so both users and compliance/support staff understand the boundary.

### IPFS Content on Other Gateways

When this backend unpins a CID from Pinata, the content may still be cached or
re-pinned by third-party IPFS gateways or nodes. The backend does not control
the broader IPFS network — unpinning is the strongest action available.

---

## Audit Trail

Every anonymization request is recorded in the append-only `audit_log` table:

```json
{
  "action": "player_anonymized",
  "player_id": "<surrogate key>",
  "cids_unpinned": 3,
  "requester": "<wallet or player_id>",
  "store_summary": { "...": "per-table counts only" },
  "timestamp": "2026-07-29T12:00:00.000Z"
}
```

The audit entry intentionally contains **no free-text PII** — only the
player_id surrogate, operational counts, and metadata. Hash-chained `audit_log`
rows are never updated in place. Optional operational PII that must be stored
alongside an audit row lives in `audit_log_pii` and is deleted on anonymization
(crypto-shredding of notes uses deletion of ciphertext plus optional key
rotation rather than mutating the chain).

---

## How to Request Anonymization

An authenticated player sends:

```
POST /api/players/:playerId/anonymize
Authorization: Bearer <player JWT>
```

No request body is required. The endpoint:

1. Verifies the caller owns the profile (JWT `sub` matches `playerId`)
2. Scrubs all off-chain PII listed above inside a DB transaction (idempotent)
3. Unpins IPFS CIDs (best-effort, non-blocking)
4. Invalidates player and milestone caches
5. Logs the event to the audit trail (counts only)
6. Returns a confirmation with per-store counts

Admin users cannot anonymize on behalf of a player — this is a self-service
action only. For admin-initiated deactivation (without full PII scrub), use
`POST /api/admin/players/:playerId/deactivate`.
