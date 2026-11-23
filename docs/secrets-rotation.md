# Secrets Rotation Policy and Procedures

This document outlines the rotation policy, cadence, and step-by-step procedures for every long-lived secret used by the ScoutOff backend. Managing and rotating these secrets on a defined schedule is critical to preserving the security and integrity of the platform.

---

## Documented Secrets Summary

| Secret | Cadence | Zero-Downtime? | Responsibility |
|---|---|---|---|
| `JWT_SECRET` | Quarterly (90 days) | Yes (via dual-key; provider values refresh live) | Security Administrator |
| `PINATA_API_KEY` / `PINATA_SECRET` | Semi-Annually (180 days) | Yes (provider values refresh live) | DevOps / IPFS Administrator |
| `PLATFORM_SECRET_KEY` / `PLATFORM_SECRET` / `STELLAR_SECRET_KEY` | Semi-Annually (180 days) | Yes (keypair refreshes on use) | Key Custodian / Soroban Admin |
| `SEP10_SERVER_SECRET` | Per key-custody policy | Yes (with `SEP10_SERVER_SECRET_PREVIOUS`) | Security Administrator |
| `ADMIN_WALLET` / `ADMIN_WALLETS` | Annually (365 days) | No (Requires Restart) | Platform Owner / Multi-Sig Signers |
| `REDIS_URL` (with password) | Annually (365 days) | No (Requires Restart) | Database / DevOps Engineer |
| `WEBHOOK_SECRET_ENCRYPTION_KEY` | Semi-Annually (180 days), or on suspected compromise | Yes (with previous-key decryption; re-encrypt before removing it) | Security Administrator |

---

## Secret Provider

The backend defaults to `SECRETS_PROVIDER=env`, which reads secret values from
environment variables. Set `SECRETS_PROVIDER=file` to read each supported
secret from a file named exactly after its variable in `SECRETS_DIR`
(`/run/secrets` by default). File mode watches the mounted directory and polls
for projected-volume updates; secret values are never included in audit logs.

For Docker Swarm, mount secrets under `/run/secrets/<SECRET_NAME>`. For
Kubernetes, mount the Secret as a directory; do not use `subPath`, which does
not receive projected Secret updates:

```yaml
env:
  SECRETS_PROVIDER: file
  SECRETS_DIR: /run/secrets
extraVolumes:
  - name: backend-secret-files
    secret:
      secretName: scout-off-secrets
extraVolumeMounts:
  - name: backend-secret-files
    mountPath: /run/secrets
    readOnly: true
```

The Secret keys must use the exact names from `src/secrets/types.ts`. The Helm
chart supports `extraVolumes` and `extraVolumeMounts`; environment mode remains
the default.

## 1. JWT Signer Secret (`JWT_SECRET`)

The backend issues JSON Web Tokens (JWTs) to authenticate players, scouts, validators, and administrators. 

* **Recommended Cadence**: Quarterly (every 90 days), or immediately upon suspected compromise.
* **Responsible Party**: Security Administrator.
* **Downtime Impact**: **Zero-Downtime Supported.** A dual-key mechanism is supported natively by the authentication middleware to transition active sessions.

### Rotation Procedure

To rotate the JWT secret without disrupting active users:

1. **Staging the Transition**:
   - Copy the current value of `JWT_SECRET` into `JWT_SECRET_PREVIOUS`.
   - Set `JWT_SECRET_PREVIOUS_UNTIL` to an absolute deadline covering the
     maximum token lifetime (**7 days** for refresh tokens — not 24 hours).
     Accepts Unix seconds or an ISO-8601 datetime.
   - Generate a new cryptographically secure secret (minimum 32 characters).
     ```bash
     openssl rand -hex 32
     ```
   - Update `JWT_SECRET` to the new generated value.
2. **First Deployment**:
   - Deploy the new configuration and perform a rolling update of the service.
   - The server signs all **new** JWTs with `JWT_SECRET`, but continues to
     accept tokens signed with `JWT_SECRET_PREVIOUS` until
     `JWT_SECRET_PREVIOUS_UNTIL`.
3. **Transition Window**:
   - Leave both secrets active until the grace deadline (or until all old
     sessions expire — whichever you choose operationally).
4. **Final Deprecation**:
   - Once the window ends, clear `JWT_SECRET_PREVIOUS` and
     `JWT_SECRET_PREVIOUS_UNTIL` from the environment.
   - Perform a final rolling update. Tokens signed with the old secret are
     rejected. Use the token blocklist to revoke a specific compromised token
     immediately without rotating the secret.

See also the Kubernetes runbook in [DEPLOYMENT.md](../DEPLOYMENT.md#jwt-secret-rotation-runbook-zero-downtime-dual-key).

---

## 2. Pinata IPFS Credentials (`PINATA_API_KEY` / `PINATA_SECRET`)

Used by the backend to pin player and metadata files to IPFS via Pinata's API.

* **Recommended Cadence**: Semi-Annually (every 180 days), or immediately upon suspected compromise.
* **Responsible Party**: DevOps / IPFS Administrator.
* **Downtime Impact**: No restart is required when the selected provider exposes
  refreshed values. File-provider credentials are read on use and file updates
  are detected automatically.

> [!WARNING]
> While a rolling update minimizes service interruption, any file-upload or pinning requests that occur during the environment update may fail until the new credentials take effect.

### Rotation Procedure

1. **Generate New Keypair**:
   - Log in to the [Pinata Dashboard](https://app.pinata.cloud/).
   - Navigate to the **API Keys** section.
   - Click **New Key** and grant the required permissions (typically `pinFileToIPFS`, `pinJSONToIPFS`, and `unpin`).
   - Copy the newly generated **API Key** and **Secret API Key**.
2. **Apply Configuration**:
   - Update the `PINATA_API_KEY` and `PINATA_SECRET` environment variables in your deployment hosting provider (e.g. AWS, Render, Heroku).
3. **Verify Connectivity**:
   - Check the `/ready` endpoint, which triggers an IPFS readiness check.
   - Verify that log entries do not report IPFS service connection warnings.
5. **Revoke Old Keypair**:
   - Go back to the Pinata Dashboard and delete/revoke the old API Key.

---

## 3. Platform Signing Keypairs (`PLATFORM_SECRET_KEY` / `PLATFORM_SECRET`)

Stellar secret keys used by the backend to sign transactions/messages and execute Soroban contract invocations (such as subscription cancellations or contract pausing).

* **Recommended Cadence**: Semi-Annually (every 180 days), or immediately upon suspected compromise.
* **Responsible Party**: Key Custodian / Soroban Admin.
* **Downtime Impact**: No restart is required. `getPlatformKeypair()` rebuilds
  its cached keypair when the provider value changes; the next signing operation
  uses the new key.

> [!IMPORTANT]
> Because these keys submit transactions directly to the Stellar network, the newly generated key must be funded with native XLM before deployment to prevent transaction execution failures.

### Rotation Procedure

1. **Generate a New Keypair**:
   - Generate a new Stellar account using the Stellar CLI:
     ```bash
     stellar keys generate --network testnet platform-new
     ```
     *(Or use standard BIP-39 generators for mainnet).*
   - Note the public key (starts with `G`) and secret seed (starts with `S`).
2. **Fund the Account**:
   - **Testnet**: Fund the public key via Friendbot:
     ```bash
     curl "https://friendbot.stellar.org?addr=<NEW_PUBLIC_KEY>"
     ```
   - **Mainnet**: Manually transfer sufficient native token (XLM) to the new public key to cover gas/transaction fees.
3. **Update Configuration**:
   - Update `PLATFORM_SECRET_KEY` and `PLATFORM_SECRET` in the environment variables with the new Stellar secret seed.
4. **Verify Submissions**:
   - Monitor the logs for successful indexer updates and verify that on-chain contract actions succeed without throwing signature or fee errors.

---

## 4. Admin Wallet Configuration (`ADMIN_WALLET` / `ADMIN_WALLETS`)

Stellar public addresses configured on the backend to authorize high-value administrative commands (e.g., fee withdrawals or pausing the contract). Note that the backend only holds the public addresses; the corresponding private keys remain secure on the administrators' personal devices.

* **Recommended Cadence**: Annually (365 days), or immediately if any admin key is suspected to be compromised.
* **Responsible Party**: Platform Owner / Multi-Sig Signers.
* **Downtime Impact**: **Downtime Required.** A service restart is required to load the updated admin list.

### Rotation Procedure

1. **Obtain New Admin Addresses**:
   - Identify the new administrator public keys (Stellar G-addresses).
2. **Update Environment**:
   - Update `ADMIN_WALLET` and `ADMIN_WALLETS` in the environment configuration.
   - For multi-sig deployment, specify multiple comma-separated addresses and adjust `ADMIN_THRESHOLD` accordingly.
3. **Restart the Application**:
   - Apply the changes and restart the backend service.
4. **Verify Authorization**:
   - Verify that new admins can authenticate using SEP-10 and access admin routes (e.g. `GET /api/admin/fees`).
   - Confirm that revoked admin addresses are rejected with `403` or `401` on those endpoints.

---

## 5. Redis Database URL (`REDIS_URL`)

The connection string for the optional Redis cache, which may contain sensitive credentials (e.g., `redis://:password@host:port`).

* **Recommended Cadence**: Annually (365 days), or immediately upon suspected compromise.
* **Responsible Party**: Database / DevOps Engineer.
* **Downtime Impact**: **Downtime Required (Brief).** A server restart is required to update the connection pool config.

### Rotation Procedure

1. **Generate New Redis Credentials**:
   - Log in to your Redis provider and generate a new password or access credential.
2. **Update Environment**:
   - Construct the new connection URL:
     `redis://:<NEW_PASSWORD>@<HOST>:<PORT>`
   - Update the `REDIS_URL` environment variable.
3. **Restart the Service**:
   - Perform a rolling restart of the backend application.
4. **Verify Connectivity**:
   - Ensure no Redis connection errors are logged during startup.
5. **Deprecate Old Credentials**:
   - Revoke the old password on the Redis database server.

---

## 6. Webhook Secret Encryption Key (`WEBHOOK_SECRET_ENCRYPTION_KEY`)

Each row in `webhook_subscriptions` stores a per-subscriber HMAC signing secret used to sign
outbound webhook deliveries (`X-Webhook-Signature`). Since #686, that secret is encrypted at rest
with AES-256-GCM using this key — held only in the environment, never in the database — via
`src/utils/webhookSecretCipher.ts`. The secret is decrypted in memory only at the point of signing
a delivery (`src/db/index.ts`'s `listWebhookSubscriptions`) and the decrypted value is never
written back to storage.

* **Recommended Cadence**: Semi-Annually (every 180 days), or immediately upon suspected compromise
  (e.g. a database backup or read-replica leak).
* **Responsible Party**: Security Administrator.
* **Downtime Impact**: No restart is required when rotating with
  `WEBHOOK_SECRET_ENCRYPTION_KEY_PREVIOUS`. Decryption tries the current key and
  then the previous key; encryption always uses the current key. Re-encrypt
  existing rows with the new key before removing the previous key.

### Rotation Procedure

1. **Generate a New Key**:
   ```bash
   openssl rand -hex 32
   ```
2. **Re-encrypt Existing Rows Under the Old Key First**: if you're rotating (not setting the key
   for the first time), every existing row must already be in the encrypted `v1:...` format. Run
   the migration script once under the *current* key if you haven't already:
   ```bash
   WEBHOOK_SECRET_ENCRYPTION_KEY=<current-key> npm run reencrypt-webhook-secrets
   ```
   With mounted secret files, select the file provider instead:
   ```bash
   SECRETS_PROVIDER=file SECRETS_DIR=/run/secrets npm run reencrypt-webhook-secrets
   ```
3. **Stage the New Key**: set `WEBHOOK_SECRET_ENCRYPTION_KEY_PREVIOUS` to the old key, then update
   `WEBHOOK_SECRET_ENCRYPTION_KEY` to the new key in the provider. New writes use the new key;
   existing rows remain decryptable using the previous key.
4. **Re-encrypt Existing Rows**: re-encrypt stored values under the new key before clearing the
   previous key. With both keys configured, run the migration with `--rotate`:
   ```bash
   npm run reencrypt-webhook-secrets -- --rotate
   ```
   For mounted secret files, use `SECRETS_PROVIDER=file` and `SECRETS_DIR` as above.
5. **Verify**: confirm webhook deliveries continue to sign and deliver successfully (check
   `webhook_dead_letters` for a spike in new failures after the restart).

### Migrating existing plaintext secrets (one-time, pre-#686 deployments)

Deployments that created webhook subscriptions before #686 shipped have plaintext secrets stored
in `webhook_subscriptions.secret`. `decryptWebhookSecret()` transparently passes these through
unchanged (identified by the absence of the `v1:` prefix), so nothing breaks — but they remain
unencrypted at rest until migrated. Run once, after setting `WEBHOOK_SECRET_ENCRYPTION_KEY` and
building the project:

```bash
WEBHOOK_SECRET_ENCRYPTION_KEY=<key> npm run reencrypt-webhook-secrets
```

For mounted secret files, use `SECRETS_PROVIDER=file` and set `SECRETS_DIR` if
the files are not under `/run/secrets`.

This is idempotent — rows already in the encrypted format are left untouched, so it's safe to run
repeatedly (e.g. as a post-deploy health check).

---

## Known Gaps and Limitations

### Webhook Signing Secrets
The backend's webhook dispatcher **does** sign outgoing payloads with an HMAC-SHA256 signature
sent in the `X-Webhook-Signature` header.  Each subscription row in `webhook_subscriptions` holds
its own per-subscriber secret generated at creation, and (since #686) that secret is encrypted at
rest under `WEBHOOK_SECRET_ENCRYPTION_KEY` — see § 6 above.

**Current limitations**:
- There is no dedicated API endpoint to rotate a subscription's secret without deleting and
  re-creating the subscription. See
  [docs/webhooks.md § Secret Rotation](webhooks.md#secret-rotation) for the current workaround and
  the planned `POST /api/admin/webhooks/:id/rotate-secret` improvement.
- The webhook encryption-key previous slot is a transition mechanism, not a permanent keyring.
  Re-encrypt all stored secrets before clearing `WEBHOOK_SECRET_ENCRYPTION_KEY_PREVIOUS`.

* **Follow-up Action**: Once the rotation endpoint ships, update both this document and
  `docs/webhooks.md` to document zero-downtime per-subscriber secret rotation.
