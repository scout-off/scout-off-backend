# GraphQL API

GraphQL is a first-class, read-only API surface alongside REST. It is
intended for clients that want to select the fields they need in one request.

## Endpoint

Send GraphQL requests as JSON `POST` requests to:

```text
https://<api-host>/graphql
```

The request body uses the usual GraphQL shape:

```json
{
  "query": "query PlayerList($region: String) { players(region: $region) { nodes { player_id wallet position tierName } pageInfo { total page pageSize pages } } }",
  "variables": { "region": "europe" }
}
```

The endpoint is mounted at `/graphql`, not under the versioned REST path
`/api/v1`.

## Schema

The complete current schema is:

```graphql
type Player {
  player_id: ID!
  wallet: String!
  position: String
  region: String
  metadataUri: String
  progress_level: Int!
  created_at: Int
  is_active: Int!
  tierName: String!
  tierDescription: String!
  progress_tier_name: String!
  milestones: [Milestone!]!
}

type PageInfo {
  total: Int!
  page: Int!
  pageSize: Int!
  pages: Int!
}

type PlayerConnection {
  nodes: [Player!]!
  pageInfo: PageInfo!
}

type Milestone {
  milestoneId: String
  playerId: String!
  milestoneType: String
  evidenceUri: String
  approved: Boolean
  approvedBy: String
  submittedAt: Int
  approvedAt: Int
}

type ScoutSubscription {
  active: Boolean!
  tier: String
  expiresAt: Int
  remainingDays: Int!
  gracePeriodActive: Boolean!
}

type ContactUnlock {
  scout_wallet: String!
  player_id: String!
  tx_hash: String!
  unlocked_at: Int!
}

type TrialOffer {
  offer_id: String!
  scout_wallet: String!
  player_id: String!
  details_uri: String!
  status: String!
  reject_reason: String
  responded_at: Int
  created_at: Int!
}

type Query {
  player(id: ID!): Player
  players(
    region: String
    position: String
    minTier: Int
    page: Int
    pageSize: Int
  ): PlayerConnection!
  milestones(playerId: ID!): [Milestone!]!
  scoutSubscription(wallet: String!): ScoutSubscription
}
```

`ContactUnlock` and `TrialOffer` are schema types reserved for the API
surface but are not currently returned by a root query. There are no
mutations.

### Example query

```graphql
query PlayerProfile($id: ID!) {
  player(id: $id) {
    player_id
    wallet
    position
    region
    progress_level
    tierName
    milestones {
      milestoneId
      milestoneType
      approved
      submittedAt
    }
  }
}
```

`player` returns `null` when the ID does not exist or when a deactivated
player is hidden from the caller. `players` defaults to page 1 with 20 items
and clamps `pageSize` to 1 through 100.

## Authentication and scopes

GraphQL uses the same credentials as REST:

| Credential | Header | GraphQL context |
| --- | --- | --- |
| JWT | `Authorization: Bearer <jwt>` | Uses the JWT subject as the account and preserves its role (`player`, `scout`, or `admin`). |
| API key | `X-API-Key: <key>` | Resolves to the key's scout wallet and the `scout` role. |

When both headers are present, the API key is tried first, matching REST.
Invalid, expired, or revoked credentials are treated as anonymous for
GraphQL. This means public operations can still be queried, while an
operation that requires authentication returns `UNAUTHENTICATED`.

API-key scopes apply only to keys with an explicit restricted scope list.
JWT requests and legacy/unrestricted API keys are not scope-limited. A
missing required scope returns `UNAUTHORIZED` and includes
`extensions.requiredScope`.

| Operation or field | Authentication | Restricted API-key scope |
| --- | --- | --- |
| `Query.player` | Public for active players | None |
| `Query.players` | Public | None |
| `Query.milestones` | Public for active players; owner or admin may access deactivated players | `read:milestones` |
| `Query.player.milestones` | Public for active players; owner or admin may access deactivated players | `read:milestones` |
| `Query.scoutSubscription` | Required; a scout may query only its own wallet, an admin may query any wallet | `read:subscription` |

The milestone access decision matches REST: an inaccessible deactivated
player produces `NOT_FOUND` for the root `milestones` query, and is hidden by
`player` (which returns `null`). A player owner is identified by the JWT
account matching the player's wallet; API keys represent scout accounts.

## Query depth and cost

Every operation is checked before execution.

### Depth

The maximum nesting depth is **5**. Fields increase depth as selection sets
are nested; inline and named fragments are counted as well. Introspection
meta-fields are excluded from depth measurement. An operation deeper than 5
is rejected with a validation error.

Passing example, depth 4:

```graphql
query {
  players {
    nodes {
      milestones {
        milestoneId
      }
    }
  }
}
```

With the current schema, the deepest valid selection is the passing example
above: `players -> nodes -> milestones -> milestoneId` is depth 4. The
depth-5 guard is nevertheless enforced for future schema additions and for
fragments that introduce deeper valid selections. For example, if a future
`Milestone` field exposed another object, a query shaped like this would fail
at depth 6:

```graphql
query {
  players {
    nodes {
      milestones {
        futureObject {
          futureObject {
            value
          }
        }
      }
    }
  }
}
```

`futureObject` is intentionally not part of the current schema, so this
snippet is a depth-limit illustration rather than a query clients can submit
today. Current-schema queries are still subject to the same depth rule.

### Cost

The maximum calculated cost is **135**. The operation is rejected when its
cost is greater than or equal to 135.

- Every field node costs 1, including aliased fields.
- `player`, `players`, `milestones`, and `scoutSubscription` cost 5 each,
  plus the cost of their selected sub-fields.
- Introspection meta-fields are free.
- Fragment selections are counted when used.

This passes validation: one `milestones` call with two leaf fields costs
$5 + 2 = 7$.

```graphql
query {
  milestones(playerId: "player-1") {
    milestoneId
    playerId
  }
}
```

This fails: 20 aliases cost $20 \\times (5 + 2) = 140$, which is at least 135.

```graphql
query {
  m01: milestones(playerId: "player-01") { milestoneId playerId }
  m02: milestones(playerId: "player-02") { milestoneId playerId }
  m03: milestones(playerId: "player-03") { milestoneId playerId }
  # Repeat through m20.
}
```

The error has `extensions.code: "QUERY_COST_EXCEEDED"`.

## Introspection

Introspection is enabled outside production, including development and test
environments. When `NODE_ENV=production`, `__schema` and `__type` are blocked
before resolver execution. The response contains the error code
`INTROSPECTION_DISABLED`.

## Error codes

GraphQL responses use HTTP 200 for many application and validation errors;
clients must inspect the response's `errors[].extensions.code` value. The
codes exposed by this surface are:

| Code | Meaning |
| --- | --- |
| `UNAUTHENTICATED` | The operation requires a valid JWT or API key, but the request has no valid authenticated context. |
| `UNAUTHORIZED` | The caller is authenticated but lacks the required role, wallet ownership, or restricted API-key scope. |
| `NOT_FOUND` | The requested player does not exist or is intentionally hidden because it is deactivated and inaccessible. |
| `QUERY_COST_EXCEEDED` | The calculated operation cost is 135 or greater. |
| `INTROSPECTION_DISABLED` | Production rejected a `__schema` or `__type` introspection field. |

Other standard GraphQL parse and validation errors can also be returned for
malformed queries or invalid field selections.

## Read-only decision

GraphQL is deliberately read-only. The current layer exposes read-heavy
player discovery, player profiles, milestones, and subscription status while
REST remains the surface for state-changing workflows such as profile
updates, contact unlocks, subscriptions, trial offers, and administrative
actions. Keeping mutations out of GraphQL prevents a second write contract
from diverging from REST authorization, idempotency, auditing, and payment
behavior. Clients should use the corresponding REST endpoints for writes.
