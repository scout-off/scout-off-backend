# Glossary

A quick reference for terms used across the ScoutOff codebase and documentation.

## Roles

| Term | Definition |
|------|------------|
| **Scout** | A person or organisation that searches for talented football players. In ScoutOff, scouts purchase subscriptions to access player profiles, contact information, and performance data. |
| **Player** | A footballer registered in the ScoutOff system. Players submit milestones (match footage, trial offers, identity verification) for validator approval to advance through progress tiers. |
| **Validator** | An authorised reviewer who assesses player-submitted milestones. Validators approve or reject milestone submissions, determining a player's progress tier. |

## Progress & Tiers

| Term | Definition |
|------|------------|
| **Milestone** | A verifiable achievement submitted by a player (e.g. match footage, identity document, trial offer acceptance). Validators approve or reject each milestone; approved milestones count toward the player's tier. |
| **Progress tier** | A level (0–3) that reflects a player's verified achievements. Derived from the count of approved milestones. See [docs/tier-promotion.md](docs/tier-promotion.md) for the full model. |

## Blockchain & Stellar

| Term | Definition |
|------|------------|
| **Stellar** | An open-source blockchain network for payments and asset issuance. ScoutOff uses Stellar for wallet-based authentication, on-chain subscriptions, and fee collection. [stellar.org](https://stellar.org) |
| **Soroban** | Stellar's smart contract platform. ScoutOff's on-chain logic (player registration, milestone tracking, scout subscriptions, contact unlocking) runs as Soroban contracts written in Rust. |
| **SEP-10** | Stellar Ecosystem Proposal 10 — a wallet-based authentication standard. The backend issues a challenge transaction, the client signs it with their Stellar secret key, and the server verifies the signature to issue a JWT. See [docs/auth.md](docs/auth.md). |
| **Horizon** | Stellar's HTTP API for querying ledger state and submitting transactions. The backend reads account state and transaction history via Horizon. |
| **Ledger** | Stellar's append-only record of all transactions. Every ~5 seconds a new ledger closes with the latest batch of transactions. The indexer processes events from each new ledger. |
| **Stroop** | The smallest unit of XLM. 1 XLM = 10,000,000 stroops. Fee calculations and balance checks use stroop-precision integers. |
| **Strkey** | A Stellar address encoding. Account addresses start with `G` (public) or `S` (secret). ScoutOff validates all wallet inputs against the strkey format. |

## IPFS & Content

| Term | Definition |
|------|------------|
| **IPFS** | InterPlanetary File System — a decentralised content-addressed storage network. ScoutOff stores player media and evidence files on IPFS via Pinata. |
| **CID** | Content Identifier — a hash that uniquely addresses a file on IPFS. CIDs are used to retrieve stored player media. See [docs/ipfs.md](docs/ipfs.md). |
| **Pinata** | An IPFS pinning service. ScoutOff uses Pinata for uploading and pinning player content. The PINATA_API_KEY and PINATA_SECRET environment variables authenticate uploads. |

## Infrastructure

| Term | Definition |
|------|------------|
| **Indexer** | A backend service (`src/services/indexer.ts`) that listens for new Soroban contract events (milestone approvals, subscription changes, etc.) and writes them to the local database. The indexer is the bridge between on-chain state and the API's database. |
| **Reindex** | A manual operation that replays historical Soroban ledger ranges to rebuild or backfill the local database. See [docs/reindexing.md](docs/reindexing.md). |
| **SSE** | Server-Sent Events — a unidirectional HTTP streaming protocol. ScoutOff uses SSE to push real-time event notifications to connected clients. |
| **JWT** | JSON Web Token — a signed token issued after SEP-10 authentication. JWTs are included in the `Authorization: Bearer <token>` header for all authenticated API requests. See [docs/auth.md](docs/auth.md). |
| **Audit log** | An append-only, hash-chained record of every security-sensitive and administrative action. See [docs/audit-log.md](docs/audit-log.md). |

## Related Documents

- [docs/auth.md](docs/auth.md) — authentication flow
- [docs/tier-promotion.md](docs/tier-promotion.md) — player progress tiers
- [docs/ipfs.md](docs/ipfs.md) — IPFS gateway configuration
- [docs/audit-log.md](docs/audit-log.md) — audit log schema and verification
- [docs/reindexing.md](docs/reindexing.md) — reindex operations
- [DEPLOYMENT.md](DEPLOYMENT.md) — deployment and environment configuration
- [CONTRIBUTING.md](CONTRIBUTING.md) — contribution guidelines
