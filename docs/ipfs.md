# IPFS Gateway Configuration

ScoutOff uses IPFS (InterPlanetary File System) for decentralised content
storage. Player profiles, media, and evidence files are uploaded to IPFS via
Pinata and retrieved through a configurable gateway list with automatic
fallback.

## Gateway Architecture

### Primary Gateway

A single primary gateway is configured via the `PINATA_GATEWAY` (or
`config.pinata.gateway`) setting. This is the first gateway used for every
content retrieval request.

```env
PINATA_GATEWAY=https://gateway.pinata.cloud
```

Defaults to `https://gateway.pinata.cloud` when not set.

### Fallback Gateway List

When the primary gateway fails (timeout, DNS error, HTTP 5xx), the backend
automatically retries through a list of fallback gateways configured in
`IPFS_GATEWAYS` (or `config.pinata.gateways`).

```env
IPFS_GATEWAYS=https://gateway.pinata.cloud,https://cloudflare-ipfs.com,https://ipfs.io
```

Default fallback list (when `IPFS_GATEWAYS` is unset):
1. `https://gateway.pinata.cloud`
2. `https://cloudflare-ipfs.com`
3. `https://ipfs.io`

### Retrieval Flow

```
Client request (CID)
        │
        ▼
  Primary gateway ──success──▶ Return content
        │
        │ failure (timeout / error)
        ▼
  Fallback #1 ──success──▶ Return content
        │
        │ failure
        ▼
  Fallback #2 ──success──▶ Return content
        │
        │ failure (all exhausted)
        ▼
  502 Bad Gateway error to client
```

### Configuration Reference

| Variable | Default | Description |
| -------- | ------- | ----------- |
| `PINATA_GATEWAY` | `https://gateway.pinata.cloud` | Primary IPFS gateway URL. Must be a valid HTTPS URL. |
| `IPFS_GATEWAYS` | Pinata → Cloudflare → ipfs.io | Comma-separated list of fallback gateway URLs. |
| `IPFS_GATEWAY_TIMEOUT_MS` | `10000` | Per-gateway request timeout in milliseconds. |
| `IPFS_MAX_RETRIES` | `3` | Maximum number of gateway attempts before returning an error. |
| `IPFS_CACHE_TTL_SECONDS` | `3600` | How long resolved IPFS content is cached (1 hour). |

## Upload (Pinata)

Content is uploaded to IPFS through Pinata. The upload credentials are
configured separately from the retrieval gateways:

| Variable | Required | Description |
| -------- | -------- | ----------- |
| `PINATA_API_KEY` | ✅ | Pinata API key for upload authentication |
| `PINATA_SECRET` | ✅ | Pinata API secret for upload authentication |

These credentials are used only for writes (pinning content). Reads go
through the public gateways configured above — a Pinata subscription is
not required for content retrieval.

## Troubleshooting

### Primary gateway is down

If the primary gateway (`PINATA_GATEWAY`) is unavailable, the fallback
list takes over automatically. Check the server logs for messages like:

```
IPFS gateway https://gateway.pinata.cloud failed (ETIMEDOUT), trying fallback
IPFS content resolved via fallback https://cloudflare-ipfs.com (attempt 2)
```

### All gateways exhausted

If no gateway in the primary + fallback list responds, the client receives
a `502 Bad Gateway` response and the server logs:

```
IPFS resolution failed after 4 attempts across 4 gateways
```

To fix:
1. Verify your `IPFS_GATEWAYS` list includes at least 2-3 diverse providers.
2. Check network connectivity from the server to the gateway hosts.
3. Increase `IPFS_GATEWAY_TIMEOUT_MS` if gateways are slow but not down.
4. Increase `IPFS_MAX_RETRIES` to allow more fallback attempts.

### Cached stale content

IPFS content is cached for `IPFS_CACHE_TTL_SECONDS` (default 1 hour).
If content is updated on IPFS but the old version is still being served,
either wait for the cache TTL to expire or restart the server to clear
the in-memory cache.

## Adding a Custom Gateway

To use a self-hosted IPFS gateway or a third-party provider:

```env
PINATA_GATEWAY=https://my-ipfs-gateway.example.com
IPFS_GATEWAYS=https://my-ipfs-gateway.example.com,https://gateway.pinata.cloud,https://cloudflare-ipfs.com
```

Set your gateway as both the primary and the first fallback, with
public gateways as backups. This ensures your gateway handles most
traffic while providing resilience if it goes down.
