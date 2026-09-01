# Data Privacy — Erasure and Anonymization

This document explains which player data the ScoutOff backend can erase on
request and which data is permanently retained due to on-chain immutability.

---

## Erasable Data (Off-Chain)

The backend controls the following off-chain stores and can scrub identifying
information when a player invokes `POST /api/players/:playerId/anonymize`:

| Store | Action |
|-------|--------|
| `players` row (SQLite/Postgres) | Wallet, position, region, metadata_uri nullified; is_active set to 0 |
| `player_profile_history` | All rows deleted (metadata_uri + tx_hash) |
| `pending_milestones` | All rows cancelled/deleted |
| `profile_views` | Rows referencing the player deleted |
| `contact_unlocks` | Rows referencing the player deleted |
| `trial_offers` | Rows referencing the player deleted |
| `scout_bookmarks` | Bookmarks referencing the player deleted |
| IPFS pins (Pinata) | Current and historical metadata CIDs unpinned (best-effort) |

After anonymization, the player will:

- **Not** appear in search results (`GET /api/players?...`) with any identifying data
- **Not** return PII from the profile endpoint (`GET /api/players/:playerId`)
- **Not** have recoverable profile history
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
  "timestamp": "2026-07-29T12:00:00.000Z"
}
```

The audit entry intentionally contains **no PII** — only the player_id
surrogate and operational metadata. Audit rows are hash-chained and cannot be
deleted without breaking the chain, so the fact that anonymization occurred is
permanently recorded for compliance purposes.

---

## How to Request Anonymization

An authenticated player sends:

```
POST /api/players/:playerId/anonymize
Authorization: Bearer <player JWT>
```

No request body is required. The endpoint:

1. Verifies the caller owns the profile (JWT `sub` matches `playerId`)
2. Scrubs all off-chain PII listed above inside a DB transaction
3. Unpins IPFS CIDs (best-effort, non-blocking)
4. Logs the event to the audit trail
5. Returns a confirmation with counts of scrubbed items

Admin users cannot anonymize on behalf of a player — this is a self-service
action only. For admin-initiated deactivation (without full PII scrub), use
`POST /api/admin/players/:playerId/deactivate`.
