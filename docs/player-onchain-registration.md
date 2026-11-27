# Player ID Mapping

The API keeps its cuid2 `player_id` as the stable public identifier. The register contract assigns a separate sequential `u64`; `players.on_chain_player_id` stores that value as decimal text. A null chain ID means the wallet has not completed contract registration.

`POST /api/players/register` creates the API profile immediately and returns `registrationStatus: "pending"` with the register contract ID, method, and arguments. The player wallet must authorize and submit that call. Once the indexer observes the `player_rg` event, it maps the wallet and sequential ID onto the existing API row. API endpoints that call player-aware contracts resolve the cuid2 through this mapping; transactions requiring an on-chain ID remain unavailable until registration is confirmed.

## Existing Rows

Migration 030 backfills rows only from unambiguous stored registration events. To check older rows against current register-contract state (including legacy wallet entries), deploy the register contract version exposing `get_player_id`, then run:

```sh
npx ts-node --project tsconfig.scripts.json scripts/backfill-player-on-chain-ids.ts
```

The script checks each unmapped wallet and persists only confirmed contract results. Rows without an on-chain registration remain pending; no IDs are inferred from CUIDs, timestamps, or row order.
