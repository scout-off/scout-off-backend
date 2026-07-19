# Runbook: External Dependency Outages (Stellar RPC & IPFS/Pinata)

This document provides detection, mitigation, recovery, and communication instructions for on-call engineers managing outages of external dependencies in the ScoutOff platform.

The ScoutOff backend relies on two major external systems:

1. **Stellar Network / Soroban RPC**: For indexing contract events, verifying milestones, registrations, and pay-to-contact settlements.
2. **IPFS / Pinata Gateway**: For pinning and storing player profile metadata, photos, highlight reels, and validator evidence.

---

## 1. Stellar RPC Outage

> [!WARNING]
> During a Stellar RPC outage, write operations (player registration, milestone submissions, contact payments) will fail. However, read operations (browsing profiles, filtering, search caching) will continue to work normally because they read from the local SQLite index.

### Detection Signals

#### Health & Readiness Endpoints

- **Liveness probe (`GET /health`)**:
  Returns HTTP `200 OK` but contains `"stellar": "error"` in the response body.
  ```json
  {
    "status": "ok",
    "healthStatus": {
      "stellar": "error"
    }
  }
  ```
- **Readiness probe (`GET /ready` or `GET /health/readiness`)**:
  Returns HTTP `503 Service Unavailable` with `status: "degraded"`.
  ```json
  {
    "status": "degraded",
    "services": {
      "ipfs": "ok",
      "stellar": "unavailable"
    }
  }
  ```

#### Log Patterns

Check system logs (`stderr`/`stdout`) for the following patterns:

- **Event Indexer errors** (emitted every 5 seconds by the indexer loop):
  `[error] Indexer error: <reason>`
  Common messages:
  - `[error] Indexer error: fetch failed`
  - `[error] Indexer error: request failed with status code 503`
  - `[error] Indexer error: getaddrinfo ENOTFOUND soroban-testnet.stellar.org`
- **Route / Controller errors** (logged by global Express error handler):
  `console.error` logs from failed transactions or signature checks:
  - `[error] network error` or `PaymentError: NETWORK_ERROR`

### Immediate Mitigation Options

#### Option A: Bypass Stellar Health Check (Keep service marked ready)

By default, an RPC outage causes `/ready` to return `503`, which may cause Kubernetes or your cloud load balancer to kill/route traffic away from the backend container, resulting in a full service outage.
To keep the server marked healthy for read-only traffic (non-chain features):

1. Locate the environment variables or `.env` file on the server.
2. Set or update:
   ```env
   STELLAR_HEALTH_CHECK=false
   ```
3. Restart the backend process:
   ```bash
   # If running via PM2:
   pm2 restart scout-off-backend
   # If running via systemd:
   systemctl restart scout-off-backend
   # If running in Docker:
   docker restart <container_id>
   ```
4. Verify `/ready` now returns `200 OK` with `"stellar": "disabled"`:
   ```json
   {
     "status": "ok",
     "services": {
       "ipfs": "ok",
       "stellar": "disabled"
     }
   }
   ```

#### Option B: Failover to Backup RPC Nodes

If the public SDF RPC endpoint (`https://soroban-testnet.stellar.org`) is offline but other RPC endpoints are healthy (e.g., QuickNode or a private node):

1. Update `.env` with a backup URL:
   ```env
   SOROBAN_RPC_URL=https://<backup-stellar-rpc-provider-url>
   # Update Horizon if Horizon is also down
   HORIZON_URL=https://<backup-horizon-url>
   ```
2. Restart the backend process.
3. Check the startup health logs:
   `[info] Startup health: {"ipfs":"ok","stellar":"ok"}`

### Recovery Verification

Before reverting any mitigation (like setting `STELLAR_HEALTH_CHECK` back to `true`), verify the RPC network has fully recovered:

1. Manually query the configured RPC url using curl:
   ```bash
   curl -X POST -H "Content-Type: application/json" \
     -d '{"jsonrpc":"2.0","id":1,"method":"getLatestLedger"}' \
     https://soroban-testnet.stellar.org
   ```
   Verify you receive a valid JSON response containing `sequence` and `protocolVersion`.
2. Once the RPC responds, restore the config in `.env`:
   ```env
   STELLAR_HEALTH_CHECK=true
   ```
3. Restart the backend process and verify `GET /ready` returns:
   ```json
   {
     "status": "ok",
     "services": {
       "ipfs": "ok",
       "stellar": "ok"
     }
   }
   ```

---

## 2. IPFS / Pinata Outage

> [!IMPORTANT]
> When IPFS/Pinata is down, players cannot complete registration because metadata JSON pinning fails, and validators cannot submit new milestones (evidence upload fails).

### Detection Signals

#### Health & Readiness Endpoints

- **Readiness probe (`GET /ready` or `GET /health/readiness`)**:
  Returns HTTP `503 Service Unavailable` with `status: "degraded"` and `services.ipfs` marked `unavailable`.
  ```json
  {
    "status": "degraded",
    "services": {
      "ipfs": "unavailable",
      "stellar": "ok"
    }
  }
  ```

#### Log Patterns

Check system logs for errors thrown during pinning:

- **Axios error logs** from IPFS service:
  - `console.error` logs with messages:
    - `request failed with status code 503` (or 502/504 Bad Gateway from Pinata API)
    - `getaddrinfo ENOTFOUND api.pinata.cloud`
    - `Error: IPFS connection refused`

### Immediate Mitigation Options

#### Option A: Enable IPFS Mock/Stub Mode

If Pinata is experiencing a genuine prolonged outage, you can temporarily enable **IPFS Stub Mode**. This bypasses Axios network requests to Pinata and returns a valid static CID (`QmYwAPJzv5CZsnA625s3Xf2nemtYgPpHdWEz79ojWnPbdG`), allowing registrations and milestone submissions to proceed (using stubbed data).

1. Open the server's `.env` configuration file.
2. Add or update the following environment variable:
   ```env
   IPFS_STUB_MODE=true
   ```
3. Restart the backend process:
   ```bash
   pm2 restart scout-off-backend
   ```
4. Verify `/ready` now returns `200 OK` (with `"ipfs": "ok"` mocked):
   ```json
   {
     "status": "ok",
     "services": {
       "ipfs": "ok",
       "stellar": "ok"
     }
   }
   ```
5. Test a registration or milestone submission. It should succeed immediately, returning the mock CID.

### Recovery Verification

1. To check if the Pinata service is back, manually test the authentication API endpoint using curl:
   ```bash
   curl -H "pinata_api_key: <YOUR_PINATA_API_KEY>" \
        -H "pinata_secret_api_key: <YOUR_PINATA_SECRET>" \
        https://api.pinata.cloud/data/testAuthentication
   ```
   If it returns `{"message":"Congratulations! You are communicating with the Pinata API!"}`, Pinata has recovered.
2. Disable the IPFS stub mode in `.env`:
   ```env
   IPFS_STUB_MODE=false
   ```
3. Restart the backend process.
4. Verify `GET /ready` returns HTTP `200 OK` with all actual services listed as `"ok"`.

---

## 3. Communication Playbook

In the event of an outage, communicate the status promptly to platform users and stakeholders:

### Pre-written Notification Templates

#### For Stellar RPC Outage (Degraded/Read-Only Mode)

- **Channel**: Twitter/X, Discord Announcement, or Banner in Frontend
- **Message**:
  > **ScoutOff Infrastructure Notice** ⚠️
  > The Stellar network node we use is currently experiencing connection issues.
  >
  > - **What is working**: You can still log in, browse player profiles, view validator history, and search positions.
  > - **What is paused**: New player registrations, validator approvals, and pay-to-contact transactions are temporarily unavailable.
  >
  > Our engineers are monitoring the situation and will restore full transaction capability as soon as the RPC node is back online. Thank you for your patience!

#### For IPFS/Pinata Outage (Degraded Mode)

- **Channel**: Twitter/X, Discord Announcement, or Banner in Frontend
- **Message**:
  > **ScoutOff Storage Service Interruption** ⚠️
  > Our media storage provider (Pinata/IPFS) is currently experiencing an outage.
  >
  > - **What is working**: You can search profiles, view existing cached vitals, and initiate scout contacts.
  > - **What is paused**: Uploading new highlight videos, pinning profile updates, and submitting new milestone evidence.
  >
  > We have enabled a temporary fallback service so player registration forms can still submit, but files/images will not preview until our storage partner recovers.
