# Server-Sent Events (SSE) Event Stream

The backend pushes newly indexed contract events to authenticated clients over a
long-lived **Server-Sent Events** connection at `GET /api/events/stream`. This is
how frontends and integrations learn about `player_registered`,
`milestone_approved`, `scout_subscribed`, and the other platform events in
real time without polling.

The stream is backed by `EventBroadcaster` in `src/services/eventBroadcaster.ts`
and the route handler in `src/routes/events.ts`.

## Endpoint

| Method | Path                        | Auth          | Content-Type            |
| ------ | --------------------------- | ------------- | ----------------------- |
| `GET`  | `/api/events/stream`        | Bearer JWT    | `text/event-stream`     |

The stream is also mounted under the versioned prefixes:

- `/api/v1/events/stream`
- `/api/v2/events/stream`

All three paths behave identically (the v2 mount is currently the same handler
set as v1; this note will be updated once v1/v2 path mounting is made
consistent).

## Authentication

The stream uses the same `requireAuth` middleware as every other protected
route: send a `Bearer` JWT in the `Authorization` header (an `X-API-Key` header
is also accepted).

> **Browser caveat:** the native `EventSource` API cannot set request headers,
> so it cannot send a `Bearer` token directly. Use a headers-capable SSE client
> (e.g. the `eventsource` npm package, or an HTTP client that streams the
> response body) so you can attach the `Authorization` header. See the examples
> below.

Response codes:

| Status | Meaning                                                                 |
| ------ | ----------------------------------------------------------------------- |
| `200`  | Stream opened; frames start arriving                                    |
| `401`  | Missing or invalid token (`{ success: false, error }`)                  |
| `403`  | Wallet is blocklisted — stream access revoked                           |
| `503`  | Connection limit reached (`SSE_MAX_CONNECTIONS`) — retry later          |

## Connecting

```js
// Node.js — headers-capable SSE client
const EventSource = require('eventsource');

const es = new EventSource('https://api.scoutoff.example/api/events/stream', {
  headers: { Authorization: `Bearer ${jwt}` },
});

es.addEventListener('connected', (e) => {
  console.log('stream open for wallet:', JSON.parse(e.data).wallet);
});

es.addEventListener('milestone_approved', (e) => {
  console.log('milestone approved:', e.data);
});

es.onerror = (err) => {
  console.error('stream error (will reconnect per EventSource spec):', err);
};
```

Browser `EventSource` example (only works if the token can be supplied by the
environment, e.g. via a service worker or a short-lived session cookie):

```js
const es = new EventSource('/api/events/stream');
es.onopen = () => console.log('stream open');
es.onmessage = (e) => console.log('event:', e.data);
```

On connect the server immediately sends an initial frame so the client knows
the stream is live:

```
event: connected
data: {"wallet":"GABCDEF..."}

```

## Filtering

All query parameters are optional and combinable. **Wallet-relevance filtering
is always applied** (see below); the query parameters only narrow the stream
further on top of it.

| Parameter   | Type   | Behaviour                                                                                                                              |
| ----------- | ------ | -------------------------------------------------------------------------------------------------------------------------------------- |
| `eventType` | string | Subscribe to a single event type, e.g. `?eventType=milestone_approved`. Omitted = receive all event types that pass the relevance filter. Unknown values are ignored. |
| `playerId`  | string | Only deliver events whose payload contains this player identifier. Omitted = no additional player-level narrowing.                       |

Examples:

```text
# Only my milestone approvals
GET /api/events/stream?eventType=milestone_approved

# Only events about one player (any type)
GET /api/events/stream?playerId=player-001

# Both
GET /api/events/stream?eventType=contact_unlocked&playerId=player-001
```

Filterable `eventType` values (validated against this exact list):

- `player_registered`
- `milestone_submitted`
- `milestone_approved`
- `scout_subscribed`
- `contact_unlocked`
- `trial_offer_logged`
- `fees_withdrawn`

> **Note:** the stream can also carry `player_deactivated`, `player_reactivated`,
> `trial_offer_accepted`, and `trial_offer_rejected` frames (they pass the
> relevance filter), but those types are **not** currently accepted as
> `eventType` filter values — an unknown filter value is silently ignored, so a
> filter for them behaves like no filter at all.

## Frame format

Every event is a standard SSE frame:

```
event: <event_type>
data: {"type":"<event_type>","payload":{...}}

```

Concretely:

```
event: milestone_approved
data: {"type":"milestone_approved","payload":{"player_id":"player-001","wallet":"GABCDEF...","scout":"G123456..."}}

```

Other frames you may see:

| Frame type     | When                                            | Payload                                   |
| -------------- | ----------------------------------------------- | ----------------------------------------- |
| `connected`    | Once, immediately after the stream opens        | `{ "wallet": "<your wallet>" }`           |
| `session_ended`| The stream is being closed (see live auth below)| `{ "reason": "token_revoked" \| "wallet_blocklisted" }` |
| `: ping`       | Keep-alive comment every `SSE_KEEPALIVE_INTERVAL_MS` (default 15 s) | — (comment only, ignored by EventSource) |

The `data` field is JSON; parse it with `JSON.parse(e.data)`.

## Wallet-relevance rules

Every event is checked against the authenticated wallet before delivery — this
is the tenant-isolation boundary and **cannot be disabled or overridden with
query parameters**. The rules (from `isEventRelevantToWallet` in
`src/services/eventBroadcaster.ts`) are:

| Event type             | Delivered to the wallet when…                                                       |
| ---------------------- | ----------------------------------------------------------------------------------- |
| `milestone_approved`   | `payload.player_id`, `payload.wallet`, or `payload.scout` matches                    |
| `scout_subscribed`     | `payload.scout` or `payload.wallet` matches                                          |
| `contact_unlocked`     | `payload.scout` or `payload.wallet` matches                                          |
| `trial_offer_logged`   | `payload.scout` matches (scout) or `payload.player_id` matches (player)              |
| `trial_offer_accepted` | `payload.scout` matches (scout who offered) or `payload.player_id` matches (player)  |
| `trial_offer_rejected` | `payload.scout` matches (scout who offered) or `payload.player_id` matches (player)  |
| `player_registered`    | `payload.wallet` or `payload.player_id` matches                                      |
| `milestone_submitted`  | `payload.player_id` matches (player) or `payload.validator` matches (validator)      |
| `fees_withdrawn`       | `payload.recipient` or `payload.wallet` matches (admin)                               |
| `player_deactivated`   | `payload.player_id`, `payload.wallet`, or `payload.scout_wallet` matches              |
| `player_reactivated`   | `payload.player_id` or `payload.wallet` matches                                       |

In practice most clients only need `milestone_approved`, `scout_subscribed`, and
`contact_unlocked`, but all event types are handled so the stream is
self-documenting and future-proof.

### How filters interact with relevance

The two filter layers compose with **AND** semantics:

1. `isEventRelevantToWallet` — wallet isolation, always enforced.
2. `isEventMatchingFilter` — the optional `eventType` / `playerId` narrowing.

A `playerId` filter matches if any payload field that carries a player identity
(`player_id`, `wallet`, `scout`, `recipient`, `validator`) equals the value.
With no filter at all, the client receives every event that passes the
relevance check (wildcard behaviour).

## Keep-alive and compression

- **Keep-alive:** a `: ping` comment frame is written every
  `SSE_KEEPALIVE_INTERVAL_MS` (default `15000` ms) so proxies and load balancers
  don't time out idle connections. The comment is ignored by `EventSource`.
- **Compression:** gzip/br compression is **disabled** for the SSE paths
  (`/api/events/stream`, `/api/v1/events/stream`, `/api/v2/events/stream`) —
  SSE responses are written incrementally and compression would buffer them.
- **Connection limit:** `SSE_MAX_CONNECTIONS` caps concurrent streams
  (default `0` = unlimited). Exceeding it returns `503`.

## Reconnection and replay behaviour (known limitations)

- There is **no `id:` field in event frames and no `Last-Event-ID` replay**.
  If the connection drops, the server does not buffer missed events and cannot
  resume the stream from a client-supplied offset.
- When a client reconnects it simply opens a **fresh stream from "now"** —
  events indexed while the client was disconnected are not replayed.
- Therefore a reconnecting client must rebuild any state it might have missed
  from the REST API (e.g. `GET /api/players/:playerId/milestones`,
  `GET /api/admin/events`, or the webhook archive) rather than relying on the
  stream for backfill.

## Live authorization enforcement

Once a stream is open, authorization is re-checked continuously (issue #1019):

- If the JWT is revoked (`POST /auth/logout` or admin token revocation), the
  server sends a terminal `session_ended` frame with reason `token_revoked` and
  closes the connection.
- If the wallet is blocklisted, the same happens with reason
  `wallet_blocklisted`.
- Detection is immediate for revocations/blocklists processed in the same
  process, and within `SSE_AUTH_SWEEP_INTERVAL_MS` (default 30 s) for changes
  persisted by another backend instance. A blocklisted wallet also cannot open
  a new connection (403).

See [docs/auth.md § SSE live revocation & wallet blocklisting](auth.md#sse-live-revocation--wallet-blocklisting-1019)
for the full model.

## Related configuration

| Variable                    | Default | Description                                             |
| --------------------------- | ------- | ------------------------------------------------------- |
| `SSE_KEEPALIVE_INTERVAL_MS` | `15000` | Interval between keep-alive `: ping` comments (ms)      |
| `SSE_MAX_CONNECTIONS`       | `0`     | Max concurrent streams; `0` = unlimited                 |
| `SSE_AUTH_SWEEP_INTERVAL_MS`| `30000` | Cross-process auth sweep interval (ms)                  |

## Troubleshooting

| Symptom                                  | Likely cause / check                                                        |
| ---------------------------------------- | --------------------------------------------------------------------------- |
| `401` on connect                         | Missing/expired `Authorization: Bearer` header                              |
| `403` on connect                         | Wallet is blocklisted                                                       |
| `503` on connect                         | `SSE_MAX_CONNECTIONS` reached — raise it or check for leaked connections     |
| Stream opens but no events arrive        | Filter too narrow, or the events simply aren't relevant to your wallet      |
| Events missed after a reconnect          | Expected — there is no `Last-Event-ID` replay; re-fetch state from REST      |
| Keep-alives stop and connection dies     | Proxy buffering — ensure `X-Accel-Buffering: no` is honoured (set by the backend) |
