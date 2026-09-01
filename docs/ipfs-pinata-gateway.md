# IPFS & Pinata Gateway Configuration

This document explains how the backend retrieves content from IPFS using configurable gateways, with fallback behavior when the primary gateway is unavailable.

## Configuration Keys

### `PINATA_GATEWAY` (Optional, Single Gateway)

A custom **primary** IPFS gateway URL used to resolve pinned content. When set:
- Must be a valid HTTPS URL (e.g., `https://custom-gateway.example.com`)
- Validated at startup; invalid URLs cause immediate startup failure
- Used as the **only** gateway when `IPFS_GATEWAYS` is unset

**Default:** `https://gateway.pinata.cloud`

**Validation:** Startup validation checks that the URL is valid HTTPS. Non-HTTPS or malformed URLs will throw:
```
Error: Invalid PINATA_GATEWAY: "..." Must be a valid HTTPS URL.
```

**Example:**
```bash
PINATA_GATEWAY=https://custom-gateway.example.com
```

### `IPFS_GATEWAYS` (Optional, Fallback List)

A comma-separated list of **fallback** IPFS gateway URLs tried in order when retrieving content. When set:
- Overrides the default fallback list entirely
- Each URL is trimmed and must be valid HTTPS
- Tried sequentially if earlier gateways time out or return errors

**Default (when unset):**
```
https://gateway.pinata.cloud
https://cloudflare-ipfs.com
https://ipfs.io
```

**Example with Custom Gateways:**
```bash
IPFS_GATEWAYS=https://my-gateway-1.example.com,https://my-gateway-2.example.com,https://cloudflare-ipfs.com
```

## Retrieval Fallback Behavior

When fetching content from IPFS:

1. **First Attempt:** Use `PINATA_GATEWAY` (if set)
   - If available and successful, return the content
   - If times out or returns error, proceed to step 2

2. **Fallback Attempts:** Try each gateway in `IPFS_GATEWAYS` in order
   - Stop at the first successful response
   - If all fail, return error to the caller

**Example Retrieval Flow:**
```
Fetch /ipfs/QmExample from PINATA_GATEWAY
  ↓
[Timeout or Error]
  ↓
Try gateway #1 from IPFS_GATEWAYS
  ↓
[Success]
  ↓
Return content
```

## Operational Notes

### Setting Only `PINATA_GATEWAY` (Single Gateway, No Fallback)

When `IPFS_GATEWAYS` is **not** set, `PINATA_GATEWAY` is used as the **only** gateway:
```bash
PINATA_GATEWAY=https://gateway.pinata.cloud
IPFS_GATEWAYS=  # unset
```
→ Retrieval will **only** try `https://gateway.pinata.cloud`; no fallback.

This is useful when operators trust a specific gateway and want to avoid cascading failures across multiple services.

### Setting `IPFS_GATEWAYS` (Multiple Fallbacks)

When `IPFS_GATEWAYS` is set, `PINATA_GATEWAY` is **ignored** for fallback purposes, but its startup validation still applies:
```bash
PINATA_GATEWAY=https://gateway.pinata.cloud  # validated; ignored for retrieval
IPFS_GATEWAYS=https://gateway-a.example.com,https://gateway-b.example.com,https://ipfs.io
```
→ Retrieval will try gateways A, B, then ipfs.io; **not** Pinata Cloud.

### Default Behavior (Both Unset)

When both are unset, the default fallback order is used:
1. `https://gateway.pinata.cloud` (Pinata)
2. `https://cloudflare-ipfs.com` (Cloudflare IPFS)
3. `https://ipfs.io` (Public IPFS)

## Historical Context

In earlier versions, the fallback-gateway logic was present but unreachable dead code (after the first gateway succeeded). This was fixed in [commit/PR reference] to properly continue to fallback gateways on timeout/error. The current behavior ensures operators can tune IPFS reliability by supplying custom gateway lists.

## Configuration Examples

### Scenario 1: Single Custom Gateway
```env
PINATA_GATEWAY=https://my-ipfs.example.com
IPFS_GATEWAYS=  # unset
```
→ All retrievals go through `https://my-ipfs.example.com` only; no fallback.

### Scenario 2: Multiple Custom Gateways with Fallback
```env
PINATA_GATEWAY=https://gateway.pinata.cloud
IPFS_GATEWAYS=https://my-ipfs-1.example.com,https://my-ipfs-2.example.com,https://ipfs.io
```
→ Retrieval tries my-ipfs-1 → my-ipfs-2 → ipfs.io (Pinata is ignored for fallback).

### Scenario 3: Default Behavior
```env
# Both unset
```
→ Retrieval tries Pinata → Cloudflare → ipfs.io.

## Troubleshooting

**Startup Error: "Invalid PINATA_GATEWAY"**
- Ensure `PINATA_GATEWAY` is a valid HTTPS URL (not HTTP, not malformed).
- Example fix: `PINATA_GATEWAY=https://gateway.pinata.cloud` (was `http://...`?)

**All Gateways Timing Out**
- Check network connectivity to configured gateways.
- Add a different, known-reliable gateway to `IPFS_GATEWAYS` (e.g., `https://ipfs.io`).
- Verify that the CID exists on IPFS (check with `ipfs cat` locally).

**Specific Gateway Not Being Used**
- If `IPFS_GATEWAYS` is set, `PINATA_GATEWAY` is **ignored** for retrieval (only validated).
- To use a specific gateway, ensure it's in `IPFS_GATEWAYS` or set it as `PINATA_GATEWAY` with `IPFS_GATEWAYS` unset.
