# Register Contract Player Storage Migration

Player profiles and wallet-to-player mappings are stored in persistent storage as individual ledger entries. Each read and write extends the corresponding entry's TTL. The instance storage retains only fixed-size configuration and the player counter; new registrations do not append to `PlayerList`.

## Existing deployments

After upgrading the contract WASM, the admin should call `migrate_players(100)` repeatedly until it returns `true`. The batch limit is 100 IDs; values outside `1..=100` are rejected. Migration walks the existing sequential counter, copies each legacy profile and wallet mapping into persistent storage, and removes their instance entries. The obsolete `PlayerList` is removed on the first migration call because filtering now walks the counter directly.

During migration, reads can still find legacy profiles, while profile and progress updates promote the touched profile to persistent storage. New registrations are written directly to persistent storage and remain compatible with migration in progress. The migration endpoint requires the stored admin's authorization.

Persistent entries receive a 30-day TTL bump when written or read. Integrators should ensure active profiles are accessed often enough to keep their entries alive; inactive persistent entries can expire under Soroban TTL rules.
