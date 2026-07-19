# ScoutOff Backend API Documentation

All endpoints are served from the base URL configured via `PORT` (default: `4000`).

---

## Authentication

Most protected routes require a **Bearer JWT** obtained from `POST /auth/token`.

```
Authorization: Bearer <token>
```

Tokens are issued after a successful SEP-10 Stellar wallet challenge/response flow.

---

## Endpoints

### Health

#### `GET /health`

Liveness check. No auth required.

**Response `200`**

```json
{
  "status": "ok",
  "healthStatus": {
    "stellar": "ok"
  }
}
```

---

### Auth

#### `GET /auth/challenge?account=G...`

Returns a SEP-10 challenge XDR for the given Stellar account. No auth required.

**Query params**

| Param     | Type   | Required | Description             |
| --------- | ------ | -------- | ----------------------- |
| `account` | string | ✅       | Stellar public key (G…) |

**Response `200`**

```json
{
  "challenge": "<XDR string>",
  "networkPassphrase": "Test SDF Network ; September 2015"
}
```

---

#### `POST /auth/token`

Submit a signed SEP-10 XDR to receive a JWT. No auth required.

**Request body**

```json
{
  "signedXdr": "<signed XDR string>",
  "account": "GABC...XYZ"
}
```

**Response `200`**

```json
{
  "token": "<JWT>",
  "account": "GABC...XYZ",
  "expiresAt": 1700000000
}
```

---

### Players

#### `POST /api/players/register`

Pin player metadata to IPFS and return the content ID. No auth required.

**Request body**

```json
{
  "wallet": "GABC...XYZ",
  "position": "Midfielder",
  "region": "West Africa",
  "metadata": {
    "name": "Kwame Asante",
    "age": 19,
    "club": "Accra Lions FC",
    "highlightReels": ["QmXyz..."],
    "stats": { "topSpeed": "32 km/h" }
  }
}
```

**Response `201`**

```json
{
  "success": true,
  "data": {
    "metadataUri": "QmXyz...",
    "gatewayUrl": "https://gateway.pinata.cloud/ipfs/QmXyz..."
  }
}
```

---

#### `GET /api/players`

Filter players by region, position, and minimum verified tier. No auth required.

**Query params**

| Param      | Type    | Required | Description                              |
| ---------- | ------- | -------- | ---------------------------------------- |
| `region`   | string  | ❌       | Filter by region                         |
| `position` | string  | ❌       | Filter by position                       |
| `minTier`  | integer | ❌       | Minimum progress level (0–3)             |
| `page`     | integer | ❌       | Page number (default: 1)                 |
| `pageSize` | integer | ❌       | Results per page (default: 20, max: 100) |

**Response `200`**

```json
{
  "success": true,
  "data": [
    {
      "player_id": "abc123",
      "wallet": "GABC...XYZ",
      "position": "Midfielder",
      "region": "West Africa",
      "progress_level": 2
    }
  ],
  "total": 1,
  "page": 1,
  "pageSize": 20
}
```

**Error `400`** — invalid `minTier`

```json
{
  "success": false,
  "error": "minTier 5 is out of range. Valid values: 0, 1, 2, 3."
}
```

---

#### `GET /api/players/:playerId`

Retrieve a single player profile. No auth required.

**Response `200`**

```json
{
  "success": true,
  "data": {
    "player_id": "abc123",
    "wallet": "GABC...XYZ",
    "position": "Midfielder",
    "region": "West Africa",
    "progress_level": 2,
    "tierName": "tier.2.name",
    "tierDescription": "tier.2.description"
  }
}
```

**Error `404`**

```json
{ "success": false, "error": "Player not found" }
```

---

#### `GET /api/players/:playerId/milestones`

Tamper-proof milestone history for a player. No auth required.

**Response `200`**

```json
{
  "success": true,
  "data": [
    {
      "type": "milestone_approved",
      "ledger": 12345,
      "txHash": "abc...",
      "payload": {
        "player_id": "abc123",
        "milestone_type": "performance",
        "evidence_uri": "QmEvidence..."
      }
    }
  ]
}
```

---

### Scouts

#### `GET /api/scouts/:wallet/subscription`

Check active subscription status for a scout. **Requires Bearer auth.**

**Response `200`**

```json
{
  "success": true,
  "data": {
    "active": true,
    "expiresAt": 1700000000
  }
}
```

> ⚠️ **Stubbed** — subscription data is read from indexed contract events; no write endpoint yet.

---

#### `GET /api/scouts/:wallet/contacts`

List players unlocked by a scout. **Requires Bearer auth.**

**Response `200`**

```json
{
  "success": true,
  "data": [{ "playerId": "abc123", "unlockedAt": 1700000000 }]
}
```

> ⚠️ **Stubbed** — contact data is read from indexed contract events; no write endpoint yet.

---

### Validators

#### `POST /api/validators/milestone`

Pin milestone evidence to IPFS and return the CID. **Requires Bearer auth (validator role).**

**Request body**

```json
{
  "playerId": "abc123",
  "milestoneType": "performance",
  "evidence": {
    "description": "Scored 5 goals in Local Cup",
    "date": "2024-03-15"
  }
}
```

**Response `201`**

```json
{
  "success": true,
  "data": {
    "evidenceUri": "QmEvidence...",
    "gatewayUrl": "https://gateway.pinata.cloud/ipfs/QmEvidence..."
  }
}
```

---

#### `GET /api/validators/milestones/pending`

List pending milestone approvals. **Requires Bearer auth (validator role).**

**Response `200`**

```json
{
  "success": true,
  "data": [
    {
      "milestoneId": "m001",
      "playerId": "abc123",
      "milestoneType": "performance",
      "evidenceUri": "QmEvidence...",
      "submittedAt": 1700000000
    }
  ]
}
```

> ⚠️ **Stubbed** — returns events indexed from the contract; approval must be submitted on-chain.

---

### Admin

#### `GET /api/admin/stats`

Platform-wide counts. **Requires Bearer auth (admin role).**

**Response `200`**

```json
{
  "success": true,
  "data": {
    "players": 42,
    "milestones": 130,
    "subscriptions": 17,
    "events": 500
  }
}
```

---

#### `GET /api/admin/events`

All indexed contract events. **Requires Bearer auth.**

**Response `200`**

```json
{
  "success": true,
  "data": [
    {
      "type": "player_registered",
      "ledger": 12345,
      "txHash": "abc...",
      "payload": {}
    }
  ]
}
```

---

#### `GET /api/admin/fees`

Fee withdrawal history. **Requires Bearer auth.**

**Response `200`**

```json
{
  "success": true,
  "data": [
    {
      "type": "fees_withdrawn",
      "ledger": 12399,
      "txHash": "def...",
      "payload": { "amount": "5000000", "recipient": "GADMIN..." }
    }
  ]
}
```

---

## Stubbed Routes

The following routes currently return data sourced entirely from indexed on-chain events and have no corresponding write/mutation endpoint in the backend:

| Route                                    | Reason                                                                        |
| ---------------------------------------- | ----------------------------------------------------------------------------- |
| `GET /api/scouts/:wallet/subscription`   | Subscription state managed on-chain via `subscribe()`; backend is read-only   |
| `GET /api/scouts/:wallet/contacts`       | Contact unlocks managed on-chain via `pay_to_contact()`; backend is read-only |
| `GET /api/validators/milestones/pending` | Milestone approval is an on-chain transaction; backend only indexes events    |

---

## Error Format

All error responses follow this shape:

```json
{
  "success": false,
  "error": "<human-readable message>"
}
```

Common HTTP status codes:

| Code | Meaning                       |
| ---- | ----------------------------- |
| 400  | Validation error              |
| 401  | Missing or invalid auth token |
| 403  | Insufficient permissions      |
| 404  | Resource not found            |
| 500  | Internal server error         |
