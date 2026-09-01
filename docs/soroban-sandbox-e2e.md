# Soroban sandbox E2E (CI + local)

This job stands up a local Soroban network, deploys all five contracts,
initializes them, and runs a backend E2E suite against the live contracts
(#1117). It is intentionally separate from the fast unit CI — expect 15–30
minutes.

## What it covers

End-to-end against **really deployed** contracts (not mocks):

1. **Register → milestone → tier promotion**
2. **Subscribe → pay-to-contact**
3. **Admin pause / unpause**
4. Assertions that event topic shapes and contract error codes the backend
   consumes still match the deployed WASM (ABI / event / error drift).

## Contracts deployed

| Crate | Env var |
| --- | --- |
| `register` | `REGISTER_CONTRACT_ID` |
| `progress` | `PROGRESS_CONTRACT_ID` |
| `subscription` | `SUBSCRIPTION_CONTRACT_ID` |
| `connection` | `CONNECTION_CONTRACT_ID` |
| `player_token` | `PLAYER_TOKEN_CONTRACT_ID` (deployed for completeness; not all paths wired) |

## Local reproduction

### Prerequisites

- Docker
- Rust toolchain with `wasm32-unknown-unknown`
- [Stellar CLI](https://developers.stellar.org/docs/tools/cli) (`stellar`)
- Node 20+

### 1. Start the sandbox network

```bash
docker compose -f scripts/soroban-sandbox/docker-compose.yml up -d
# Wait until RPC is ready (friendbot + RPC on localhost)
./scripts/soroban-sandbox/wait-for-rpc.sh
```

### 2. Build, deploy, initialize

```bash
./scripts/soroban-sandbox/deploy.sh
# Writes scripts/soroban-sandbox/.env.contracts with the five contract IDs
# and a funded PLATFORM_SECRET_KEY.
```

### 3. Run the backend E2E suite

```bash
set -a && source scripts/soroban-sandbox/.env.contracts && set +a
export SOROBAN_E2E=1
export JWT_SECRET=dev-jwt-secret-for-soroban-e2e
export NETWORK_PASSPHRASE="Standalone Network ; February 2017"
export SOROBAN_RPC_URL=http://localhost:8000/soroban/rpc
export HORIZON_URL=http://localhost:8000
npm test -- --runInBand --testPathPattern=tests/e2e/soroban
```

## CI

Workflow: `.github/workflows/soroban-e2e.yml`

- Triggers: `workflow_dispatch` and nightly cron
- Spins up `stellar/quickstart` (local network)
- Installs Stellar CLI + Rust, runs `deploy.sh`, then the E2E Jest project

## Skipping

Tests under `tests/e2e/soroban/` no-op unless `SOROBAN_E2E=1`, so they never
block the fast unit CI.

## Acceptance vehicle

This suite is the acceptance test for the open "wire the backend to the real
Soroban call" issues — if a contract event topic or error variant drifts, the
assertions here fail before production.
