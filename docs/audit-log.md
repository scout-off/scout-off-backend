# Audit Log Documentation

The audit log is a tamper-evident, append-only record of all admin actions, authentication events, and system operations on the platform. Every entry is protected by a cryptographic hash chain that detects retroactive tampering or deletion.

## Overview

Audit logs support two critical use cases:

1. **Compliance:** Regulators and security teams can verify that all sensitive operations were properly authorized and executed
2. **Incident response:** When a security or data incident occurs, the audit trail helps determine what changed, when, and by whom

The audit_log table and its verification system are described across multiple files:

- `db/002_audit_log.sql` — Initial audit_log table schema (SQLite)
- `db/002_audit_log_postgres.sql` — PostgreSQL equivalent
- `db/012_audit_log_hash_chain.sql` — Adds tamper-evidence via hash chains
- `src/services/audit.ts` — Event recording interface
- `src/utils/hashChain.ts` — Hash chain computation
- `src/utils/auditVerify.ts` — Chain verification logic

This document centralizes the contract, design, and verification procedures.

## Audit Log Schema

### Column definitions

| Column | Type | Purpose |
|--------|------|---------|
| `id` | BIGINT (primary key) | Insertion order identifier (immutable once written) |
| `action` | TEXT | Event type (e.g., `validator_registration`, `auth_failed`) |
| `admin_wallet` | TEXT | Stellar wallet address of the actor, or NULL for system events (e.g., auth failures) |
| `query_params` | TEXT (JSON) | Additional context as a JSON object (e.g., IP address, scope name, validation errors) |
| `created_at` | TEXT (ISO 8601) | Timestamp when the event occurred |
| `prev_hash` | TEXT (64 hex chars) | Hash of the previous row (GENESIS_HASH for the first row) |
| `hash` | TEXT (64 hex chars, NOT NULL) | SHA256 hash of this row's content plus the previous row's hash |
| `event_source` | TEXT (NOT NULL) | Source of the event (`admin_action` or `app_event`) |

### NOT NULL constraints

Both `hash` and `event_source` columns have `NOT NULL` constraints enforced in migrations:
- `db/012_audit_log_hash_chain.sql` (SQLite) — adds both with NOT NULL defaults
- `db/014_audit_log_hash_not_null_postgres.sql` (PostgreSQL) — backfills and tightens

This ensures the hash chain cannot have gaps (a NULL hash breaks the chain without detection).

## Audited Actions

The following actions are automatically logged:

### Admin operations

| Action | Trigger | Context |
|--------|---------|---------|
| `validator_registration` | `POST /api/admin/validators/register` | Validator wallet added to platform; includes state change (attempt/success/failure) |
| `validator_revocation` | `POST /api/admin/validators/revoke` | Validator wallet removed; includes state change |
| `contract_state_change` | `POST /api/admin/contract/pause`, `POST /api/admin/contract/unpause` | On-chain contract paused or unpaused |
| `fee_withdrawal_attempt` | `POST /api/admin/fees/withdraw` or `POST /api/admin/fees` | Fee withdrawal attempt; includes outcome (success/failure reason) |
| `platform_fee_update_attempt` | `POST /api/admin/fees/{action}` | Platform fee basis points updated; includes old/new values |
| `feature_flag_toggled` | `POST /api/admin/feature-flags/{flag}` | Feature flag enabled or disabled |
| `bulk_player_import` | `POST /api/admin/players/import` | Bulk player import; includes rows attempted/inserted/failed |
| `bulk_validator_import` | `POST /api/admin/validators/import` | Bulk validator import; similar to player import |
| `player_deactivated` | `POST /api/admin/players/{playerId}/deactivate` | Player account deactivated |
| `player_reactivated` | `POST /api/admin/players/{playerId}/reactivate` | Player account reactivated |
| `fee_history_query` | `GET /api/admin/fees` | Admin queried fee history (for audit purposes) |

### Authentication events

| Action | Trigger | Reason |
|--------|---------|--------|
| `auth_failed` | Any protected endpoint | Missing auth header, invalid/expired token, invalid API key |
| `auth_forbidden` | Any protected endpoint | Valid auth, but insufficient role or API key scope |

**Note:** Authentication failures are logged best-effort (errors are silently caught) so that a DB failure never blocks a 401/403 response.

### Application events

| Action | Trigger | Context |
|--------|---------|---------|
| `player_anonymized` | `POST /api/admin/players/{playerId}/anonymize` | Player PII removed; includes anonymization timestamp |
| `reindex_triggered` | `POST /api/admin/reindex` | On-chain event reindexing started |

## Hash Chain Construction

### Deterministic hashing

Each audit log row's hash is computed from:

1. **Canonical JSON of the row's content** — all keys are sorted (recursively, at every level) so the same logical data always produces the same hash regardless of insertion order
2. **The previous row's hash** — ensuring an unbroken chain from the first row

**Formula:**

```
hash[N] = SHA256(canonicalJSON(fields) + prev_hash[N-1])
```

Where `canonicalJSON` sorts object keys and uses a stable JSON representation.

### GENESIS_HASH

The first row in the chain uses a special sentinel value as its `prev_hash`:

```
GENESIS_HASH = '0' * 64  // 64 zero characters
```

This fixed value (rather than NULL) allows every row — including the first — to be verified independently: you can always re-derive what the hash should be, with no special case for the first entry.

### Example chain

```
Row 1:
  action: 'validator_registration'
  admin_wallet: 'GADMIN1'
  created_at: '2025-01-01T12:00:00Z'
  prev_hash: GENESIS_HASH (64 zeros)
  hash: SHA256(canonicalJSON({action, admin_wallet, ...}) + GENESIS_HASH)
       → 'abc123...' (64 hex chars)

Row 2:
  action: 'contract_paused'
  admin_wallet: 'GADMIN1'
  created_at: '2025-01-01T12:05:00Z'
  prev_hash: 'abc123...'  (Row 1's hash)
  hash: SHA256(canonicalJSON({action, admin_wallet, ...}) + 'abc123...')
       → 'def456...' (64 hex chars)

Row 3:
  ...
  prev_hash: 'def456...'  (Row 2's hash)
  hash: ...
```

If an attacker deletes Row 2 or modifies Row 1's content, Row 3's `prev_hash` no longer matches Row 2's actual hash, breaking the chain and signaling tampering.

## Verification

### Verification endpoint

**`GET /api/admin/audit/verify`**

**Authentication:** Bearer JWT (admin role required)

**Response 200:**

```json
{
  "success": true,
  "data": {
    "status": "ok",
    "chain_length": 1250,
    "violations": [],
    "rows_checked": 1250
  }
}
```

**Response when tampered:**

```json
{
  "success": true,
  "data": {
    "status": "tampered",
    "chain_length": 1250,
    "violations": [
      {
        "id": 847,
        "expected_hash": "abc123...",
        "stored_hash": "wronghash...",
        "audit_event_type": "validator_registration",
        "created_at": "2025-01-15T08:32:00Z"
      }
    ],
    "rows_checked": 1250
  }
}
```

**Response if verification times out:**

```json
{
  "success": true,
  "data": {
    "status": "timeout",
    "chain_length": 50000,
    "violations": [...partial results up to timeout...],
    "rows_checked": 25000
  }
}
```

### Verification algorithm

The verification process (`verifyAuditChainFull()` in `src/utils/auditVerify.ts`):

1. Fetches all audit_log rows in `id ASC` order (insertion order)
2. Initializes `expectedPrevHash = GENESIS_HASH`
3. For each row:
   - Recomputes the expected hash: `SHA256(canonicalJSON(fields) + expectedPrevHash)`
   - Compares the stored hash against the computed hash
   - Records any mismatch as a violation
   - Sets `expectedPrevHash = row.hash` (stored value) for the next row
4. Checks the verification deadline after each batch (1,000 rows) to respect request timeouts
5. Returns all violations found and the final status

**Note:** Verification continues past the first violation, collecting ALL mismatches rather than stopping at the first break. This gives the fullest picture of the damage.

### Interpreting verification failures

A `status: "tampered"` response with one or more violations means:

- **Modification:** A field in the audit log row was changed after insertion (e.g., admin_wallet tampered with)
- **Deletion:** A previous row was deleted, breaking the chain for all subsequent rows
- **Reordering:** Rows were reordered (though this is unlikely given the immutable primary key)

**Example interpretation:**

```json
{
  "id": 847,
  "expected_hash": "abc123...",
  "stored_hash": "wronghash...",
  "audit_event_type": "validator_registration",
  "created_at": "2025-01-15T08:32:00Z"
}
```

This violation means:
- Row 847 (validator_registration on 2025-01-15 08:32:00) was tampered with
- The row's content no longer matches the stored hash
- All rows inserted after row 847 now have invalid `prev_hash` values
- This is a **critical security incident** requiring immediate investigation

## Integration with horizontal scaling

When running multiple backend replicas connected to a shared PostgreSQL database, the audit log hash chain remains provably unbroken:

- The `insertAuditLog` function uses a transaction-scoped advisory lock (`pg_advisory_xact_lock`) on the `audit_log` table
- This ensures concurrent inserts from multiple replicas are linearized
- The hash chain is never split or disordered, even under high concurrency
- See `db/012_audit_log_hash_chain_postgres.sql` and `docs/postgres-migration.md` for details

## Related documentation

- [SECURITY.md](SECURITY.md) — Security posture and incident response procedures
- [docs/README.md](docs/README.md) — Developer guide overview
- [docs/auth.md](docs/auth.md) — Authentication and authorization model
- [docs/postgres-migration.md](docs/postgres-migration.md) — Audit log under PostgreSQL's concurrent load

## Compliance and auditing

The audit log is designed for:

1. **SOC 2 Type II compliance** — immutable action history with tamper detection
2. **GDPR incident response** — determining what data was accessed / modified during an incident
3. **Regulatory investigations** — providing a complete, verifiable timeline of admin actions
4. **Post-incident forensics** — correlating audit entries with application logs via X-Correlation-ID

Always include a copy of the audit log in incident reports. The `GET /api/admin/audit` endpoint supports filtering and pagination for compliance queries.

