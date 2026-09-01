# Admin Multi-Sig Documentation

## Overview

The admin multi-sig system governs all high-value operations in the ScoutOff backend via M-of-N approval workflows. Every admin action (pause contract, withdraw fees, update configuration) requires a configured threshold of distinct admin signatures before execution.

**Configuration:**
- `ADMIN_WALLETS`: Comma-separated list of admin Stellar addresses (e.g., `GABC...,GDEF...`)
- `ADMIN_THRESHOLD`: Minimum number of distinct signatures required (default: 1)
- `ADMIN_ACTION_TTL_MS`: How long pending approvals remain valid (default: 1 hour = 3600000 ms)

**Immediate execution:** When `ADMIN_THRESHOLD=1`, operations execute instantly without multi-sig ceremony.

**Multi-sig enforcement:** When `ADMIN_THRESHOLD > 1`, operations require explicit co-signing from distinct admin wallets up to the threshold.

## Admin Action Types

Each admin action is identified by a type string. The following action types are currently supported:

| Action Type | Purpose | Used By |
|---|---|---|
| `pause_contract` | Pause the main Soroban contract | `POST /api/admin/contract/pause` |
| `unpause_contract` | Unpause the main Soroban contract | `POST /api/admin/contract/unpause` |
| `withdraw_fees` | Withdraw accumulated platform fees | `POST /api/admin/fees` (withdraw endpoint) |
| `update_platform_fee` | Modify the platform fee percentage | (Reserved for future fee config endpoint) |

Additional action types may be added as new high-value operations are implemented. The enum is defined in `src/services/adminMultiSig.ts` as `AdminActionType`.

## State Machine

An admin action follows this lifecycle:

### Single-Threshold Execution (ADMIN_THRESHOLD = 1)

```
Propose
  ↓
[Immediate Execution]
  ↓
Audit Log Entry (outcome: "immediate")
  ↓
Operation completes
```

When the threshold is 1, the proposing admin's signature alone is sufficient, and the action executes immediately without persisting any pending state.

### Multi-Threshold Approval (ADMIN_THRESHOLD > 1)

```
Propose
  ↓
[Pending State Created]
  Proposer becomes first signer
  Entry created in pending_admin_actions table
  Audit log: "{action}_proposed"
  ↓
Co-Sign Loop (each admin signer):
  Approve endpoint called
    ↓
    [Signature Validated]
    Check signer is in ADMIN_WALLETS
    Check signer hasn't already signed (idempotent)
    Check proposal hasn't expired
    ↓
    [Signature Recorded]
    Insert row in admin_action_signatures table
    Increment collected_signatures counter
    ↓
    [Check Threshold]
    If collected >= required:
      Update pending_admin_actions.status = "executed"
      Audit log: "{action}_approved" (outcome: "threshold_met")
      ↓
      Operation executes
    Else:
      Audit log: "{action}_approved" (outcome: "partially_signed")
      Return and wait for next signer
  ↓
Threshold Reached → Operation Executes
```

### Expiry & Cleanup

Pending actions expire automatically after `ADMIN_ACTION_TTL_MS` (default: 1 hour). The expiry sweep runs on every `propose` and `approve` call:

- Any pending action with `expires_at <= now()` is marked as `expired`
- Attempting to approve an expired action returns 410 Gone
- The operation does NOT execute if expiry is reached before threshold

## Endpoints

All endpoints require Bearer JWT authentication with `admin` role.

### POST /api/admin/{action}/propose

Initiates a new admin action. If `ADMIN_THRESHOLD=1`, executes immediately.

**Path Parameters:**
- `action`: One of the [supported action types](#admin-action-types) (e.g., `pause_contract`)

**Request Body:**
```json
{
  "payload": {
    "reason": "Emergency pause due to exploit"
  }
}
```

Payload shape depends on the action type; some actions may require no payload.

**Response (Immediate Execution, threshold=1):**
```json
{
  "success": true,
  "data": {
    "actionId": "",
    "status": "immediate"
  }
}
```

**Response (Multi-Sig Pending, threshold>1):**
```json
{
  "success": true,
  "data": {
    "actionId": "ckt9p4q0000001a6y8z8h7p8",
    "status": "proposed"
  }
}
```

The `actionId` is a unique identifier used in subsequent approve calls.

**Errors:**
- `400`: Invalid payload schema
- `403`: Insufficient admin role
- `500`: Database or system error

### POST /api/admin/actions/{actionId}/approve

Co-signs an existing pending action with the authenticated admin wallet.

**Path Parameters:**
- `actionId`: The unique ID returned by propose

**Request Body:**
```json
{}
```

An empty body is acceptable; no additional payload is needed for approval.

**Response:**
```json
{
  "success": true,
  "data": {
    "actionId": "ckt9p4q0000001a6y8z8h7p8",
    "collected": 2,
    "required": 3,
    "status": "pending"
  }
}
```

Fields:
- `collected`: Number of distinct signatures collected so far
- `required`: Threshold (from `ADMIN_THRESHOLD`)
- `status`: One of:
  - `pending`: Threshold not yet reached; waiting for more signers
  - `approved`: Threshold reached; operation executed
  - `duplicate`: This wallet already signed this action (no-op, returns current state)
  - `expired`: Action has expired; cannot sign

**Errors:**
- `400`: Invalid action ID format or request body
- `403`: Signer wallet not in `ADMIN_WALLETS`
- `404`: Action not found
- `409`: Action already executed
- `410`: Action has expired

### GET /api/admin/actions/pending

Lists all pending (not yet expired or executed) admin actions.

**Request Body:** None

**Response:**
```json
{
  "success": true,
  "data": [
    {
      "id": "ckt9p4q0000001a6y8z8h7p8",
      "action_type": "pause_contract",
      "proposer": "GABC123...",
      "payload": {
        "reason": "Emergency pause"
      },
      "required_signatures": 3,
      "collected_signatures": 2,
      "status": "pending",
      "created_at": 1725004800000,
      "expires_at": 1725008400000
    }
  ]
}
```

Only returns actions with `status="pending"` (expired and executed actions are omitted).

### GET /api/admin/actions/{actionId}

Retrieves detailed information about a specific action, including all signatures collected so far.

**Path Parameters:**
- `actionId`: The unique ID

**Response:**
```json
{
  "success": true,
  "data": {
    "action": {
      "id": "ckt9p4q0000001a6y8z8h7p8",
      "action_type": "pause_contract",
      "proposer": "GABC123...",
      "payload": {
        "reason": "Emergency pause"
      },
      "required_signatures": 3,
      "collected_signatures": 2,
      "status": "pending",
      "created_at": 1725004800000,
      "expires_at": 1725008400000
    },
    "signatures": [
      {
        "signer": "GABC123...",
        "signed_at": 1725004800000
      },
      {
        "signer": "GDEF456...",
        "signed_at": 1725004802000
      }
    ]
  }
}
```

Returns both action metadata and a list of signers with timestamps.

**Errors:**
- `404`: Action not found

## Threshold & TTL Configuration

### ADMIN_THRESHOLD

The minimum number of distinct admin signatures required for high-value operations.

**Default:** `1` (single admin can execute immediately)

**Example (2-of-3 multi-sig):**
```env
ADMIN_WALLETS=GABC...,GDEF...,GHIJ...
ADMIN_THRESHOLD=2
```
With 3 admins and a threshold of 2, any 2 distinct admins can approve an action.

**Example (3-of-3 multi-sig, strict):**
```env
ADMIN_WALLETS=GABC...,GDEF...,GHIJ...
ADMIN_THRESHOLD=3
```
All 3 admins must sign. If one is unavailable, operations are blocked until the action expires or the config is changed.

### ADMIN_ACTION_TTL_MS

How long (in milliseconds) a pending action remains valid before it expires and can no longer be signed.

**Default:** `3600000` (1 hour)

**Use cases:**

- **Short TTL (e.g., 60000 = 1 minute):** For rapid, low-risk operations or testing; forces quick coordination.
- **Medium TTL (e.g., 1800000 = 30 minutes):** Typical for production 2-of-3 setups; balances urgency and availability.
- **Long TTL (e.g., 7200000 = 2 hours):** For distributed teams across time zones; be aware this increases the window for compromised keys.

Once a proposed action expires, it cannot be approved. A new proposal must be started.

## Immediate vs. Multi-Sig Execution

### Immediate (ADMIN_THRESHOLD = 1)

```env
ADMIN_WALLETS=GABC123...
ADMIN_THRESHOLD=1
```

When any admin calls a high-value endpoint, the operation executes immediately:

```bash
curl -X POST https://backend.example.com/api/admin/contract/pause \
  -H "Authorization: Bearer $ADMIN_JWT" \
  -H "Content-Type: application/json" \
  -d '{ "payload": {} }'

# Response: immediate execution
{
  "success": true,
  "data": { "actionId": "", "status": "immediate" }
}
```

**Trade-off:** Fast but offers no protection against a single compromised key. All security depends on JWT secret and auth system.

### Multi-Sig (ADMIN_THRESHOLD > 1)

```env
ADMIN_WALLETS=GABC123...,GDEF456...,GHIJ789...
ADMIN_THRESHOLD=2
```

A single admin proposes, and at least one additional admin must co-sign:

**Step 1: Propose**
```bash
curl -X POST https://backend.example.com/api/admin/contract/pause \
  -H "Authorization: Bearer $ADMIN1_JWT" \
  -H "Content-Type: application/json" \
  -d '{ "payload": { "reason": "Emergency" } }'

# Response: pending
{
  "success": true,
  "data": {
    "actionId": "ckt9p4q0000001a6y8z8h7p8",
    "status": "proposed"
  }
}
```

**Step 2: Check pending actions**
```bash
curl https://backend.example.com/api/admin/actions/pending \
  -H "Authorization: Bearer $ADMIN2_JWT"

# Shows all pending actions with signer counts
```

**Step 3: Co-sign**
```bash
curl -X POST https://backend.example.com/api/admin/actions/ckt9p4q0000001a6y8z8h7p8/approve \
  -H "Authorization: Bearer $ADMIN2_JWT"

# Response: executed (threshold met)
{
  "success": true,
  "data": {
    "actionId": "ckt9p4q0000001a6y8z8h7p8",
    "collected": 2,
    "required": 2,
    "status": "approved"
  }
}
```

**Trade-off:** Requires coordination between admins but protects against single key compromise. Operations can be blocked if required signers are unavailable or the threshold is too strict.

## Database Schema

### pending_admin_actions

Stores proposed admin actions awaiting signature collection.

```sql
CREATE TABLE pending_admin_actions (
  id TEXT PRIMARY KEY,
  action_type TEXT NOT NULL,
  proposer TEXT NOT NULL,
  payload TEXT NOT NULL,           -- JSON
  required_signatures INTEGER NOT NULL,
  collected_signatures INTEGER NOT NULL DEFAULT 1,
  status TEXT NOT NULL,             -- 'pending', 'executed', 'expired'
  created_at INTEGER NOT NULL,      -- milliseconds since epoch
  expires_at INTEGER NOT NULL,      -- milliseconds since epoch
  UNIQUE(id)
);
```

### admin_action_signatures

Records each admin's signature on an action.

```sql
CREATE TABLE admin_action_signatures (
  id TEXT PRIMARY KEY,
  action_id TEXT NOT NULL REFERENCES pending_admin_actions(id),
  signer TEXT NOT NULL,
  signed_at INTEGER NOT NULL,       -- milliseconds since epoch
  UNIQUE(action_id, signer)         -- one signature per signer per action
);
```

The `UNIQUE(action_id, signer)` constraint ensures idempotency: if the same wallet tries to sign twice, the second attempt is rejected as a duplicate.

## Audit Trail

Every admin action is logged in the `audit_log` table with action-specific entries:

### Propose Entry
```json
{
  "action": "{actionType}_proposed",
  "admin_wallet": "GABC...",
  "query_params": {
    "actionType": "pause_contract",
    "threshold": 2,
    "outcome": "immediate" | "multisig_pending",
    "actionId": "ckt9p4q0000001a6y8z8h7p8" (if multisig)
  },
  "timestamp": "2025-08-29T12:00:00Z"
}
```

### Approve Entry
```json
{
  "action": "{actionType}_approved",
  "admin_wallet": "GDEF...",
  "query_params": {
    "actionId": "ckt9p4q0000001a6y8z8h7p8",
    "actionType": "pause_contract",
    "collected": 2,
    "required": 2,
    "outcome": "threshold_met" | "partially_signed" | "duplicate"
  },
  "timestamp": "2025-08-29T12:00:15Z"
}
```

Use audit logs to:
- Trace who proposed and approved each action
- Verify the full chain of signatures
- Detect unusual approval patterns or attacks

## Error Responses

### Action Not Found (404)
```json
{
  "success": false,
  "error": "Pending action not found",
  "code": "ACTION_NOT_FOUND"
}
```

### Action Expired (410)
```json
{
  "success": false,
  "error": "Action proposal has expired",
  "code": "EXPIRED_ACTION"
}
```

### Action Already Executed (409)
```json
{
  "success": false,
  "error": "Action has already been executed",
  "code": "ACTION_EXECUTED"
}
```

### Duplicate Signature (200 OK, but status: 'duplicate')
```json
{
  "success": true,
  "data": {
    "actionId": "ckt9p4q0000001a6y8z8h7p8",
    "collected": 2,
    "required": 3,
    "status": "duplicate"
  }
}
```

Idempotent — the same admin can safely re-sign without side effects.

### Insufficient Permissions (403)
```json
{
  "success": false,
  "error": "Insufficient permissions",
  "code": "FORBIDDEN"
}
```

Signer wallet not in `ADMIN_WALLETS`, or missing admin JWT.

## Operations Affected

The following high-value operations are governed by the multi-sig system:

### POST /api/admin/contract/pause

Pauses the main Soroban contract, blocking new player registrations and submissions.

**Multi-sig:** Yes (action type: `pause_contract`)

### POST /api/admin/contract/unpause

Resumes the contract after a pause.

**Multi-sig:** Yes (action type: `unpause_contract`)

### POST /api/admin/fees (withdraw endpoint)

Withdraws accumulated platform fees to the admin wallet.

**Multi-sig:** Yes (action type: `withdraw_fees`)

### Other Admin Endpoints

Not all admin endpoints require multi-sig. Only the above and any future high-value operations should enforce the threshold. Regular admin queries (listing validators, viewing audit logs, etc.) do not go through the multi-sig flow.

## Best Practices

1. **Distribute admin wallets**: Use independent, hardware-backed keys for each admin.
2. **Test the workflow**: In staging, practice proposing and approving with multiple test wallets before production deployment.
3. **Monitor pending actions**: Regularly poll `GET /api/admin/actions/pending` in your monitoring system to alert if actions are stuck (no co-signer coming forward).
4. **Use audit logs**: Periodically review `GET /api/admin/audit-log` to detect unauthorized approval attempts.
5. **Set appropriate TTL**: Balance responsiveness (short TTL) with availability (long TTL) based on your team's time zones.
6. **Keep threshold realistic**: If 3 of 5 admins are typically unavailable, a threshold of 4 will block operations. Aim for a threshold achievable with normally available signers.

## References

- [Admin Multi-Sig Implementation](../src/services/adminMultiSig.ts)
- [Admin Multi-Sig Routes](../src/routes/admin.ts)
- [DEPLOYMENT.md: Multi-Sig Admin Operations Section](../DEPLOYMENT.md#multi-sig-admin-operations)
