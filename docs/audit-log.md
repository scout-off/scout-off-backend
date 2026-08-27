# Audit Log

The ScoutOff backend maintains an append-only, hash-chained audit log that
records every security-sensitive or administrative action. This document
describes the data model, hash-chain construction, verification, and
operational interpretation.

## Purpose

The audit log serves three goals:

1. **Compliance** — provide an immutable record of who did what and when.
2. **Incident response** — enable operators to trace the actions leading up
   to a security event.
3. **Integrity verification** — detect tampering via cryptographic hash
   chaining.

## Data Model

### `AuditEvent` shape

Every audit entry is a row in the `audit_log` table (migration `002_audit_log`)
with the following columns:

| Column | Type | Description |
| ------ | ---- | ----------- |
| `id` | INTEGER PRIMARY KEY | Auto-incrementing entry ID |
| `timestamp` | TEXT (ISO 8601) | When the action occurred |
| `actor` | TEXT | Stellar wallet address of the actor (or `system` for automated actions) |
| `action` | TEXT | Machine-readable action type (see below) |
| `target` | TEXT | Resource affected (player ID, wallet address, feature-flag key, …) |
| `details` | TEXT (JSON) | Free-form payload with action-specific metadata |
| `prev_hash` | TEXT | SHA-256 hash of the **previous** entry (NULL for the genesis entry) |
| `hash` | TEXT NOT NULL | SHA-256 hash of this entry (computed from all fields above + `prev_hash`) |
| `correlation_id` | TEXT | Optional request correlation ID for linking to HTTP logs |

### `hash` constraint

The `hash` column has a `NOT NULL` constraint. Every insert must compute and
supply the correct hash; the database rejects entries with a missing hash.

## Audited Action Types

The following actions are written to the audit log:

| Action | Trigger | `target` | `details` (JSON keys) |
| ------ | ------- | -------- | --------------------- |
| `admin.pause_contract` | Admin calls pause | Contract address | `contractId` |
| `admin.unpause_contract` | Admin calls unpause | Contract address | `contractId` |
| `admin.withdraw_fees` | Admin calls withdraw | Admin wallet | `amount`, `txHash` |
| `auth.failure` | SEP-10 or JWT validation fails | Client IP or wallet | `reason`, `ip` |
| `auth.token_refresh` | JWT refresh succeeds | Wallet address | `tokenFingerprint` |
| `reindex.start` | POST `/api/admin/reindex` | — | `ledgerRange`, `requestedBy` |
| `reindex.complete` | Reindex job finishes | — | `ledgersProcessed`, `eventsInserted` |
| `reindex.cancelled` | Reindex job cancelled | — | `errorMessage` (if any) |
| `feature_flag.toggle` | Admin toggles a flag | Feature flag key | `oldValue`, `newValue` |
| `api_key.create` | Scout creates an API key | Scout wallet | `keyFingerprint`, `scopes` |
| `api_key.revoke` | Scout revokes an API key | Scout wallet | `keyFingerprint` |
| `wallet.blocklist` | Admin blocklists a wallet | Blocklisted wallet | `reason` |
| `wallet.unblocklist` | Admin removes blocklist | Unblocklisted wallet | — |
| `system.startup` | Server starts | — | `nodeVersion`, `env` |
| `system.shutdown` | Server shuts down | — | `uptimeSeconds` |

## Hash-Chain Construction

The audit log uses a **linear hash chain** (similar to a Git commit chain):

```
entry[0].prev_hash = NULL
entry[0].hash      = SHA-256(entry[0].fields…)

entry[1].prev_hash = entry[0].hash
entry[1].hash      = SHA-256(entry[1].fields… || entry[1].prev_hash)

entry[n].prev_hash = entry[n-1].hash
entry[n].hash      = SHA-256(entry[n].fields… || entry[n].prev_hash)
```

The hash input for entry `n` consists of:

```
SHA-256(
  id || timestamp || actor || action || target || details || prev_hash
)
```

All fields are serialised as UTF-8 strings, concatenated without separators
in the column order shown above, with `NULL` represented as the literal
string `"NULL"`.

### Properties

- **Append-only**: entries are never deleted or updated (the `audit_log` table
  has no `UPDATE` or `DELETE` privileges for the application role).
- **Tamper-evident**: altering any field in entry `k` changes `entry[k].hash`,
  which breaks the `prev_hash` link in `entry[k+1]`, which in turn breaks
  every subsequent entry.
- **Genesis entry**: the first entry (`id = 1`) has `prev_hash = NULL`. It is
  written by the `001_initial` migration and records the contract deployment.

## Verification Endpoint

`GET /api/admin/audit/verify` (requires admin JWT) validates the entire chain.

### Request

```bash
curl http://localhost:4000/api/admin/audit/verify \
  -H "Authorization: Bearer <admin-token>"
```

### Success response

```json
{
  "status": "valid",
  "entriesChecked": 1542,
  "firstEntryId": 1,
  "lastEntryId": 1542,
  "lastEntryTimestamp": "2026-08-27T10:15:00.000Z"
}
```

### Failure response

```json
{
  "status": "compromised",
  "entriesChecked": 1542,
  "brokenAtEntryId": 847,
  "expectedHash": "a1b2c3...",
  "actualHash": "d4e5f6...",
  "message": "Hash mismatch at entry 847. Entries 847–1542 are untrusted."
}
```

### What a verification failure means

A `compromised` result means the database has been tampered with **or** a
software bug produced an incorrect hash at entry `brokenAtEntryId`.

**Steps to take:**

1. **Do not restart the server.** The audit log is in-memory cached; a
   restart loses the current state before you can snapshot it.
2. **Export the full audit log** for forensic analysis:
   ```bash
   sqlite3 scout-off.db "SELECT * FROM audit_log ORDER BY id" > audit-export.csv
   ```
3. **Check the application logs** around the timestamp of the broken entry
   for errors or unexpected restarts.
4. **Escalate to the security team.** Entries from `brokenAtEntryId` onward
   are not trustworthy for compliance or incident-response purposes.
5. **Do not delete or repair** the audit log until the root cause is
   determined — a false-positive `compromised` from a hash bug is itself a
   bug worth fixing.

### In-database-only limitation

The audit log exists **only inside the database**. There is no off-chain
replication, no blockchain anchoring, and no remote witness. A sufficiently
privileged database operator can rewrite entries and recompute the chain.
The hash chain makes tampering **detectable** (via verification) but not
**preventable** — it raises the bar from trivial to requiring deliberate,
skilled effort.

For production deployments with high compliance requirements, consider
periodic exports signed with an offline key and stored in a separate
integrity-protected bucket.

## Retention

Audit log entries are never automatically pruned. Operators should define
a retention policy based on their jurisdiction's requirements (typically
1–7 years for financial services). A manual archival procedure is:

```bash
# Archive entries older than a cutoff date
sqlite3 scout-off.db "SELECT * FROM audit_log WHERE timestamp < '2025-01-01'" > archive-2024.csv
# Then delete (requires stopping the server, removing the rows, and re-seeding
# the genesis entry — contact maintainers before doing this)
```

## Related Documents

- [SECURITY.md](SECURITY.md) — vulnerability reporting and supported versions
- [DEPLOYMENT.md](DEPLOYMENT.md) — environment configuration
- [docs/auth.md](auth.md) — authentication flow (SEP-10, JWT)
- Migration `002_audit_log.sql` — table DDL
- `src/services/audit.ts` — application-level audit service
