# ScoutOff

[![Soroban Contract CI](https://github.com/your-org/scout-off/actions/workflows/contract-ci.yml/badge.svg)](https://github.com/your-org/scout-off/actions/workflows/contract-ci.yml)

Decentralized football scouting platform on Stellar — tamper-proof player profiles, on-chain progress verification, and direct scout-to-player connections powered by Soroban smart contracts.

## Overview

ScoutOff solves the visibility problem for talented footballers in underserved regions. Players build dynamic on-chain profiles backed by verified milestones — confirmed by coaches, academy directors, and certified trainers — giving scouts the confidence to act on what they see.

Stellar is the backbone: sub-cent transaction fees mean a scout in Europe can pay to contact a player in South America or Africa without hefty banking overhead, transactions settle in 3–5 seconds for a smooth mobile experience, and Soroban smart contracts make every progress update tamper-proof and auditable.

## Features

- **Dynamic Player Profiles**: On-chain identity linked to off-chain vitals, highlight reels (IPFS/Arweave), and verified stats
- **Verifiable Progress Bar**: Milestones confirmed by approved validators are written to the blockchain — no faking a progress level
- **Tiered Verification**: Four levels from unverified profile through elite tier, each requiring real-world confirmation
- **Scout Discovery**: Filter players by region, position, and verified progress tier
- **Pay-to-Contact**: Scouts pay micro-fees in XLM or a platform token to unlock premium data or initiate contact
- **Subscription Model**: Scouts can hold an active subscription for unlimited browsing within a tier
- **SEP-10 Auth**: Players and scouts log in securely with a Stellar wallet (Freighter, Albedo, or Lobstr)
- **Decentralized Storage**: Highlight reels and photos stored on IPFS; content hashes saved on-chain in the player's profile

## Architecture

```mermaid
graph TB
    subgraph Users
        P[Player]
        V[Validator — Coach / Academy]
        S[Scout]
        ADM[Platform Admin]
    end

    subgraph Frontend["Frontend (Next.js / Flutter)"]
        PP[Player Profile Dashboard]
        SB[Scout Browse & Filter]
        VP[Validator Approval Panel]
        AUTH[Auth — SEP-10 / Stellar Wallet]
    end

    subgraph Contract["Smart Contracts (Soroban / Rust)"]
        REG[register.rs — Player registration]
        PROG[progress.rs — Milestone verification]
        SUB[subscription.rs — Scout access & payments]
        CONN[connection.rs — Secure contact agreements]
    end

    subgraph Backend["Backend (Node.js)"]
        IDX[Event Indexer]
        CACHE[Search Cache]
        API[REST API]
    end

    subgraph Storage["Decentralized Storage"]
        IPFS[IPFS / Arweave via Pinata]
    end

    subgraph Stellar["Stellar Network"]
        LEDGER[Ledger]
        XLM[XLM / Platform Token]
    end

    P -->|upload video + stats| PP
    PP -->|store media| IPFS
    IPFS -->|content hash| REG
    REG -->|register profile| LEDGER

    V -->|approve milestone| VP
    VP --> PROG
    PROG -->|update progress level| LEDGER

    S -->|browse & filter| SB
    SB -->|query| API
    API -->|indexed data| CACHE
    CACHE -->|on-chain events| IDX
    IDX --> LEDGER

    S -->|pay to contact| SUB
    SUB -->|XLM / token transfer| XLM
    XLM --> LEDGER

    AUTH -->|wallet auth| LEDGER
    ADM -->|manage validators| Contract
```

### Core Components

- **register.rs**: Handles player profile creation, stores IPFS content hashes, assigns initial verification level
- **progress.rs**: Validates milestone submissions from approved validators and increments a player's progress tier
- **subscription.rs**: Manages scout subscriptions and pay-to-contact payments in XLM or platform token
- **connection.rs**: Records secure contact agreements between scouts and players on-chain
- **storage.rs**: Persistent storage for player metadata, validator registry, and scout access records
- **events.rs**: Event emission for off-chain indexing (new profiles, milestone updates, scout contacts)

### Progress Tier Model

Tiers are gated by real-world verification and enforced on-chain:

| Level | Name                  | Requirement                                                  |
|-------|-----------------------|--------------------------------------------------------------|
| 0     | Unverified            | Player creates profile and uploads data                      |
| 1     | Verified Identity     | KYC passed or academy confirms active club membership        |
| 2     | Performance Milestones| Match footage or physical stats verified by approved third party |
| 3     | Elite Tier            | Scout feedback or trial offer logged on-chain                |

Example: A validator submits "Scored 5 goals in Local Cup" → Soroban contract writes the milestone → player's progress bar updates → scouts see a tamper-proof history of when and how the player progressed.

## Tech Stack

| Layer            | Technology                        | Purpose                                                                 |
|------------------|-----------------------------------|-------------------------------------------------------------------------|
| Smart Contracts  | Rust + Soroban (Stellar)          | Player registration, progress verification, scout subscriptions, contact agreements |
| Frontend         | Next.js / Flutter                 | Player upload dashboard, scout browse interface, validator approval panel |
| Backend          | Node.js + Express                 | Event indexing, search caching, REST API for heavy queries              |
| File Storage     | IPFS / Arweave (via Pinata)       | Highlight reels, photos, and documents; hashes stored on-chain          |
| Auth             | SEP-10 (Stellar)                  | Secure wallet-based login for players and scouts                        |
| Payments         | XLM / Platform Token              | Scout subscriptions, pay-to-contact micro-fees                          |

## Smart Contract Functions

### Player Functions

- `register_player(wallet, metadata_uri, position, region)` — Create a new player profile with IPFS content hash
- `update_profile(player_id, metadata_uri)` — Update profile metadata (player auth required)
- `get_profile(player_id)` — Retrieve player profile and current progress tier

### Validator Functions

- `submit_milestone(player_id, milestone_type, evidence_uri)` — Submit a verified milestone for a player
- `approve_milestone(milestone_id)` — Approve a pending milestone, incrementing the player's progress level (validator auth required)

### Scout Functions

- `subscribe(scout, tier, duration)` — Purchase a scout subscription (XLM/token payment required)
- `pay_to_contact(scout, player_id)` — Unlock direct contact with a player (micro-fee required)
- `log_trial_offer(scout, player_id, details_uri)` — Record a trial offer on-chain, advancing player to Elite Tier

### Admin Functions

- `initialize(admin, token, platform_fee_bps)` — One-time contract setup
- `register_validator(validator_address)` — Approve a new validator (admin only)
- `revoke_validator(validator_address)` — Remove a validator (admin only)
- `pause_contract()` / `unpause_contract()` — Emergency circuit breaker (admin only)

### Query Functions

- `get_player(player_id)` — Full player profile with progress history
- `filter_players(region, position, min_tier)` — Scout discovery query
- `get_milestones(player_id)` — Tamper-proof milestone history
- `is_subscribed(scout)` — Check active scout subscription
- `health()` — On-chain health check

## Backend API Endpoints

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| `GET` | `/health` | — | Liveness check |
| `GET` | `/auth/challenge?account=G...` | — | Get SEP-10 challenge XDR to sign |
| `POST` | `/auth/token` | — | Submit signed XDR, receive JWT |
| `POST` | `/api/players/register` | — | Pin metadata to IPFS, return CID |
| `GET` | `/api/players` | — | Filter players (`region`, `position`, `minTier`) |
| `GET` | `/api/players/:playerId` | — | Single player profile |
| `GET` | `/api/players/:playerId/milestones` | — | Milestone history |
| `GET` | `/api/scouts/:wallet/subscription` | Bearer | Subscription status |
| `GET` | `/api/scouts/:wallet/contacts` | Bearer | Unlocked contacts |
| `POST` | `/api/validators/milestone` | Bearer | Pin evidence, return CID |
| `GET` | `/api/validators/milestones/pending` | Bearer | Pending milestone approvals |
| `GET` | `/api/admin/stats` | Bearer (admin) | Platform counts: players, milestones, subscriptions, events |
| `GET` | `/api/admin/events` | Bearer | All indexed contract events |
| `GET` | `/api/admin/fees` | Bearer | Fee withdrawal history |

## Player Progress Flow

```
[ Player Uploads Video ]
           │
           ▼
[ Local Coach / Validator Approves ]
           │
           ▼
[ Soroban Smart Contract Updates Progress Level ] ──► [ Reflects on Scout Dashboard ]
```

### Milestone Sequence

```mermaid
sequenceDiagram
    actor Player
    actor Validator
    actor Scout
    participant Contract as ScoutOff Contract
    participant Storage as IPFS / Arweave

    rect rgb(235, 245, 255)
        Note over Player,Storage: Profile creation
        Player->>Storage: upload highlight reel + stats
        Storage-->>Player: content_hash (CID)
        Player->>Contract: register_player(metadata_uri)
        Contract-->>Player: player_id, Level 0
    end

    rect rgb(240, 255, 240)
        Note over Validator,Contract: Milestone verification
        Validator->>Contract: submit_milestone(player_id, "Scored 5 goals")
        Contract->>Contract: validate — is caller an approved validator?
        Contract-->>Validator: milestone_id
        Validator->>Contract: approve_milestone(milestone_id)
        Contract-->>Player: progress level incremented
    end

    rect rgb(245, 235, 255)
        Note over Scout,Contract: Scout discovery & contact
        Scout->>Contract: filter_players(region, position, min_tier=2)
        Contract-->>Scout: matching player list
        Scout->>Contract: pay_to_contact(player_id) + XLM fee
        Contract-->>Scout: contact details unlocked
    end
```

## Progress State Machine

```
┌──────────────┐
│  Level 0     │  ← Profile created, data uploaded (Unverified)
└──────┬───────┘
       │
       ▼
┌──────────────┐
│  Level 1     │  ← Identity verified by academy or KYC
└──────┬───────┘
       │
       ▼
┌──────────────┐
│  Level 2     │  ← Performance milestones verified by approved third party
└──────┬───────┘
       │
       ▼
┌──────────────┐
│  Level 3     │  ← Scout feedback or trial offer logged (Elite Tier)
└──────────────┘
```

### Valid Transitions

| From    | To      | Trigger                                                        |
|---------|---------|----------------------------------------------------------------|
| Level 0 | Level 1 | Academy or KYC provider calls `approve_milestone` (identity)  |
| Level 1 | Level 2 | Approved validator submits and approves performance milestone  |
| Level 2 | Level 3 | Scout calls `log_trial_offer` — offer recorded on-chain       |

## Security Features

1. **Tamper-Proof History**: Every milestone is a blockchain transaction — scouts see exactly when and how a player progressed
2. **Validator Registry**: Only admin-approved validators can confirm milestones, preventing self-reporting abuse
3. **Atomic Payments**: Scout contact fees and subscription payments settle in a single transaction
4. **Authorization Checks**: All state-changing operations require proper Stellar account authorization
5. **Immutable Milestone Records**: Approved milestones cannot be altered or deleted post-confirmation
6. **Circuit Breaker**: Admin can pause the contract in an emergency without losing state

## Quick Start

### 1. Install Dependencies

```bash
npm install
```

### 2. Build Smart Contracts

```bash
cd contracts
cargo build --target wasm32-unknown-unknown --release
stellar contract optimize --wasm target/wasm32-unknown-unknown/release/scout_off.wasm
```

### 3. Deploy to Testnet

```bash
stellar contract deploy \
  --wasm target/wasm32-unknown-unknown/release/scout_off.optimized.wasm \
  --source deployer \
  --network testnet
```

### 4. Initialize Contract

```bash
stellar contract invoke \
  --id <CONTRACT_ID> \
  --source deployer \
  --network testnet \
  -- \
  initialize \
  --admin <ADMIN_ADDRESS> \
  --token <XLM_OR_TOKEN_ADDRESS> \
  --platform_fee_bps 500
```

### 5. Run the Backend

```bash
cp .env.example .env
# fill in CONTRACT_ID, JWT_SECRET, HORIZON_URL, SOROBAN_RPC_URL, PINATA_API_KEY, etc.
npm install
npm run dev
```

**Available npm scripts:**

| Script | Command | Description |
|--------|---------|-------------|
| `npm run dev` | `ts-node-dev --respawn --transpile-only src/index.ts` | Start with hot-reload for development |
| `npm run build` | `tsc` | Compile TypeScript to `dist/` |
| `npm start` | `node dist/index.js` | Run the compiled server (run `build` first) |
| `npm test` | `jest --runInBand` | Run the test suite |
| `npm run lint` | `eslint 'src/**/*.ts' 'tests/**/*.ts' --ext .ts` | Run TypeScript linting |

On startup the server will:
- Open (or create) a SQLite database at `DB_PATH` (default: `scout-off.db`)
- Begin polling Soroban for contract events every 5 seconds
- Fail fast if `CONTRACT_ID` or `JWT_SECRET` are missing

See [DEPLOYMENT.md](DEPLOYMENT.md) for complete deployment instructions.

## Health Endpoints

The backend exposes two health check endpoints for monitoring and orchestration probes. For detailed instructions on handling external dependency outages (Stellar RPC or IPFS/Pinata), refer to the [Dependency Outages Runbook](docs/runbooks/dependency-outages.md).

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| `GET` | `/health` | — | Liveness check — always returns `200 ok` with optional Stellar RPC status |
| `GET` | `/ready` | — | Readiness probe — returns `200` when all dependencies are reachable, `503` when degraded |

### GET /health

Liveness check. Returns `200` as long as the process is running.

Optionally includes a Stellar RPC connectivity check, controlled by the `STELLAR_HEALTH_CHECK_ENABLED` env var (default: `true`).

**Middleware module:** `src/services/stellar.ts` (`stellarHealth`)

**Example response (healthy):**
```json
{
  "status": "ok",
  "healthStatus": {
    "stellar": "ok"
  }
}
```

**Example response (Stellar disabled):**
```json
{
  "status": "ok",
  "healthStatus": {
    "stellar": "disabled"
  }
}
```

> **Monitoring note:** Use `/health` as a liveness probe. A non-`200` response indicates the process has crashed and should be restarted.

### GET /ready

Readiness probe. Returns `200` when all service dependencies are reachable. Returns `503` when any dependency is unavailable.

Currently checks: **IPFS (Pinata)** storage connectivity.

**Middleware module:** `src/services/ipfs.ts` (`checkHealth`)

**Example response (ready):**
```json
{
  "status": "ok",
  "services": {
    "ipfs": "ok"
  }
}
```

**Example response (degraded):**
```json
{
  "status": "degraded",
  "services": {
    "ipfs": "unavailable"
  }
}
```

> **Monitoring note:** Use `/ready` as a readiness probe. A `503` response means the service should be temporarily removed from the load balancer until dependencies recover.

### Dependencies

| Endpoint | Dependency | Stub / Module |
|----------|-----------|---------------|
| `/health` | Stellar RPC (`SOROBAN_RPC_URL`) | `src/services/stellar.ts` — `stellarHealth()` |
| `/ready` | IPFS / Pinata (`PINATA_API_KEY`) | `src/services/ipfs.ts` — `checkHealth()` |

Both dependency checks are stubbed in tests — see `tests/routes/health.test.ts`.

## How It Works

1. **Player Onboarding**
   - Connect Freighter wallet (SEP-10 auth)
   - Fill out profile: position, region, age, club
   - Upload highlight reels → stored on IPFS via Pinata
   - Call `register_player` — profile minted on Stellar ledger at Level 0

2. **Milestone Verification**
   - Coach or academy director submits a milestone (e.g., "Top speed 32 km/h")
   - Approved validator calls `approve_milestone` on-chain
   - Player's progress tier increments — visible immediately on scout dashboard

3. **Scout Discovery**
   - Scout subscribes or pays per contact in XLM
   - Filters players by region, position, and minimum verified tier
   - Views tamper-proof milestone history before deciding to reach out
   - Calls `pay_to_contact` — micro-fee settles in seconds, contact details unlocked

4. **Trial Offer Logging**
   - Scout submits a trial offer via `log_trial_offer`
   - Contract records the offer on-chain, advancing player to Elite Tier (Level 3)
   - Both parties have an immutable record of the agreement

5. **Admin / Validator Management**
   - Admin registers trusted validators (coaches, academies, certified trainers)
   - Admin monitors platform fees and calls `withdraw_fees` to collect revenue
   - Emergency `pause_contract` available as a circuit breaker

## Configuration

### Key Environment Variables

| Variable                  | Description                                         |
|---------------------------|-----------------------------------------------------|
| `CONTRACT_ID`             | Deployed ScoutOff contract address (**required**)   |
| `JWT_SECRET`              | Secret used to sign SEP-10 JWT tokens (**required**)|
| `HORIZON_URL`             | Stellar Horizon endpoint                            |
| `SOROBAN_RPC_URL`         | Soroban RPC endpoint                                |
| `NETWORK`                 | `testnet` or `mainnet`                              |
| `PINATA_API_KEY`          | Pinata API key for IPFS uploads                     |
| `PINATA_SECRET`           | Pinata secret                                       |
| `PLATFORM_FEE_BPS`        | Platform fee in basis points (default: 500)         |
| `PORT`                    | Backend API port (default: 4000)                    |
| `DB_PATH`                 | SQLite database file path (default: `scout-off.db`) |
| `LOG_LEVEL`               | Log verbosity: `debug`, `info`, `warn`, `error` (default: `info`) |
| `STELLAR_HEALTH_CHECK_ENABLED` | Include Stellar RPC in `/health` response (default: `true`; set `false` to disable in staging) |

## Testing

```bash
# Smart contract tests
cd contracts && cargo test

# Backend tests
npm run test
```

Contract test coverage includes:
- ✅ Player registration and metadata storage
- ✅ Milestone submission and approval by validators
- ✅ Progress tier increments and tamper-proof history
- ✅ Scout subscription and pay-to-contact payments
- ✅ Trial offer logging and Elite Tier promotion
- ✅ Validator registry — add and revoke
- ✅ Authorization enforcement on all state-changing calls
- ✅ Pause / unpause circuit breaker
- ✅ Edge cases: duplicate milestones, unauthorized validators, zero-fee configs

## MVP Scope

The initial testnet MVP focuses on a single end-to-end flow:

1. One player registers a profile and uploads a highlight reel → IPFS hash stored on-chain
2. One validator approves a milestone → player progress increments to Level 2
3. One scout pays a micro-fee → contact details unlocked

Everything else (subscriptions, trial offer logging, fractionalized sponsorship) ships in subsequent milestones.

## Roadmap

- [x] Player profile registration on Stellar testnet
- [x] Validator-approved milestone system
- [ ] Scout discovery filters (region, position, tier)
- [ ] Pay-to-contact micro-fee flow
- [ ] Scout subscription model
- [ ] Trial offer logging (Elite Tier promotion)
- [ ] Mobile frontend (Flutter)
- [ ] Fractionalized player sponsorship via Player Tokens
- [ ] Mainnet launch

## Why Stellar

- **Microtransactions**: Scouts pay fractions of a cent to unlock data or contact players — no banking fees across borders
- **Speed**: Transactions settle in 3–5 seconds, critical for players on low-end mobile devices
- **Future Expansion**: Fractionalized sponsorship — fans buy "Player Tokens" to fund a young player's training; if the player turns professional, a percentage of their transfer fee routes back to token holders via Soroban

## Error Codes

| Code | Error               | Description                              | Resolution                                      |
|------|---------------------|------------------------------------------|-------------------------------------------------|
| 1    | AlreadyInitialized  | Contract already initialized             | No action needed; contract is ready             |
| 2    | NotInitialized      | Contract not initialized                 | Admin must call `initialize` first              |
| 3    | PlayerNotFound      | Player ID does not exist                 | Verify player_id from registration transaction  |
| 4    | InvalidValidator    | Caller is not a registered validator     | Admin must register the validator first         |
| 5    | MilestoneNotFound   | Milestone ID does not exist              | Refresh milestone list                          |
| 6    | AlreadyVerified     | Milestone already approved               | No duplicate approvals needed                   |
| 7    | InsufficientFee     | Payment below required contact fee       | Check current fee via `get_contact_fee()`       |
| 8    | NotSubscribed       | Scout has no active subscription         | Call `subscribe` before browsing premium data   |
| 9    | Unauthorized        | Caller is not authorized for this action | Confirm you are using the correct Stellar account |
| 10   | ContractPaused      | Contract is paused                       | Wait for admin to unpause                       |
| 11   | Overflow            | Arithmetic overflow in fee calculation   | Use amounts within safe u128 range              |

## Events

| Event               | Emitted When                                              |
|---------------------|-----------------------------------------------------------|
| `player_registered` | New player profile created on-chain                       |
| `milestone_submitted` | Validator submits a new milestone for review            |
| `milestone_approved`  | Validator approves milestone; progress tier incremented |
| `scout_subscribed`    | Scout purchases an active subscription                  |
| `contact_unlocked`    | Scout pays to unlock player contact details             |
| `trial_offer_logged`  | Scout logs a trial offer; player promoted to Elite Tier |
| `fees_withdrawn`      | Admin withdraws accumulated platform fees               |

## Dependencies

- `soroban-sdk = "25.3.1"` — Soroban smart contract SDK
- `next = "14.2.3"` — React framework
- `@stellar/stellar-sdk = "12.1.0"` — Stellar JS SDK
- `@stellar/freighter-api = "2.0.0"` — Freighter wallet integration
- `express = "4.18.2"` — Backend API server
- `node-fetch = "3.3.2"` — HTTP client for IPFS/Pinata

## License

MIT

## Support

- GitHub Issues: [Create an issue](https://github.com/your-org/scout-off/issues)
- Stellar Discord: https://discord.gg/stellar
- Stellar Developers: https://developers.stellar.org

## Contributing

Contributions are welcome! Please see [CONTRIBUTING.md](CONTRIBUTING.md) for guidelines.

Quick checklist:
- All contract tests pass: `cargo test`
- All backend tests pass: `npm run test`
- New features include tests and updated documentation
- Milestone verification logic changes require explicit review
