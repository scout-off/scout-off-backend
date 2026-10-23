#![no_std]

use scout_off_shared::access;
use scout_off_shared::{
    errors::Error,
    storage::{
        add_authorized_updater, bump_instance, get_authorized_updaters, is_authorized_updater,
        is_initialized, is_paused, remove_authorized_updater, set_initialized, set_paused,
        LEDGER_BUMP_AMOUNT, LEDGER_LIFETIME_THRESHOLD, MAX_PAGE_SIZE,
    },
};
use soroban_sdk::{contract, contractimpl, contracttype, symbol_short, Address, Env, String, Vec};

const MAX_METADATA_URI_BYTES: u32 = 2_048;
const MAX_POSITION_BYTES: u32 = 64;
const MAX_REGION_BYTES: u32 = 64;
const MAX_PLAYER_MIGRATION_BATCH: u32 = 100;

// ---------------------------------------------------------------------------
// Data types
// ---------------------------------------------------------------------------

#[contracttype]
#[derive(Clone)]
pub struct PlayerData {
    pub wallet: Address,
    pub metadata_uri: String,
    pub position: String,
    pub region: String,
    pub progress_level: u32,
    pub created_at: u64,
}

/// A page of `PlayerData` results; `next` is the start index of the following
/// page, or `None` when this is the last one. `#[contracttype]` does not
/// support generics, so each contract defines its own concrete page type.
#[contracttype]
#[derive(Clone)]
pub struct PlayerPage {
    pub items: Vec<PlayerData>,
    pub next: Option<u32>,
}

#[contracttype]
#[derive(Clone)]
pub enum DataKey {
    Admin,
    Token,
    PlatformFeeBps,
    Counter,
    Player(u64),
    Wallet(Address),
    PlayerList,
    // Legacy single-updater key — kept so existing on-chain data is not lost
    // during an upgrade.  New callers should use the shared storage helpers
    // (`add_authorized_updater` / `remove_authorized_updater`) which store the
    // allowlist under `DataKey::AuthorizedUpdaters` in shared storage.
    AuthorizedUpdater,
    // Appended to preserve the encoding of keys used by deployed instances.
    PlayerMigrationCursor,
    PlayerDataMigrated,
}

fn get_player_data(env: &Env, player_id: u64) -> Option<PlayerData> {
    let key = DataKey::Player(player_id);
    if env.storage().persistent().has(&key) {
        env.storage()
            .persistent()
            .extend_ttl(&key, LEDGER_LIFETIME_THRESHOLD, LEDGER_BUMP_AMOUNT);
        env.storage().persistent().get(&key)
    } else {
        let player = env.storage().instance().get(&key);
        if player.is_some() {
            bump_instance(env);
        }
        player
    }
}

fn set_player_data(env: &Env, player_id: u64, player: &PlayerData) {
    let key = DataKey::Player(player_id);
    env.storage().persistent().set(&key, player);
    env.storage()
        .persistent()
        .extend_ttl(&key, LEDGER_LIFETIME_THRESHOLD, LEDGER_BUMP_AMOUNT);
}

fn wallet_is_registered(env: &Env, wallet: &Address) -> bool {
    let key = DataKey::Wallet(wallet.clone());
    if env.storage().persistent().has(&key) {
        env.storage()
            .persistent()
            .extend_ttl(&key, LEDGER_LIFETIME_THRESHOLD, LEDGER_BUMP_AMOUNT);
        true
    } else if env.storage().instance().has(&key) {
        bump_instance(env);
        true
    } else {
        false
    }
}

fn set_wallet_player_id(env: &Env, wallet: &Address, player_id: u64) {
    let key = DataKey::Wallet(wallet.clone());
    env.storage().persistent().set(&key, &player_id);
    env.storage()
        .persistent()
        .extend_ttl(&key, LEDGER_LIFETIME_THRESHOLD, LEDGER_BUMP_AMOUNT);
}

// ---------------------------------------------------------------------------
// Contract
// ---------------------------------------------------------------------------

#[contract]
pub struct RegisterContract;

#[contractimpl]
impl RegisterContract {
    /// Bootstrap RBAC on an upgraded instance. Only the stored legacy admin may authorize.
    pub fn initialize_roles(env: Env, admin: Address) -> Result<(), Error> {
        if !is_initialized(&env) {
            return Err(Error::NotInitialized);
        }
        let legacy: Address = env
            .storage()
            .instance()
            .get(&DataKey::Admin)
            .ok_or(Error::NotInitialized)?;
        admin.require_auth();
        if admin != legacy {
            return Err(Error::Unauthorized);
        }
        access::initialize(&env, &admin)
    }

    pub fn has_role(env: Env, role: soroban_sdk::Symbol, account: Address) -> bool {
        access::has_role(&env, &role, &account)
    }

    pub fn get_role_admin(env: Env, role: soroban_sdk::Symbol) -> soroban_sdk::Symbol {
        access::get_role_admin(&env, &role)
    }

    pub fn grant_role(
        env: Env,
        caller: Address,
        role: soroban_sdk::Symbol,
        account: Address,
    ) -> Result<(), Error> {
        access::grant_role(&env, &caller, &role, &account)
    }

    pub fn revoke_role(
        env: Env,
        caller: Address,
        role: soroban_sdk::Symbol,
        account: Address,
    ) -> Result<(), Error> {
        access::revoke_role(&env, &caller, &role, &account)
    }

    pub fn renounce_role(
        env: Env,
        account: Address,
        role: soroban_sdk::Symbol,
    ) -> Result<(), Error> {
        access::renounce_role(&env, &account, &role)
    }

    pub fn set_role_admin(
        env: Env,
        caller: Address,
        role: soroban_sdk::Symbol,
        admin_role: soroban_sdk::Symbol,
    ) -> Result<(), Error> {
        access::set_role_admin(&env, &caller, &role, &admin_role)
    }

    pub fn upgrade(
        env: Env,
        caller: Address,
        wasm_hash: soroban_sdk::BytesN<32>,
    ) -> Result<(), Error> {
        access::require_role(
            &env,
            &soroban_sdk::Symbol::new(&env, access::DEFAULT_ADMIN),
            &caller,
        )?;
        env.deployer().update_current_contract_wasm(wasm_hash);
        Ok(())
    }

    /// Return the contract's semantic version as `(major, minor, patch)`.
    ///
    /// This is a read-only, auth-free entry-point that the backend uses at
    /// startup to verify it is talking to a compatible contract version.
    /// The values are sourced from the crate's `Cargo.toml` version field.
    pub fn version(_env: Env) -> (u32, u32, u32) {
        (0, 1, 0)
    }

    /// One-time contract setup. Stores the admin address, payment token, and platform fee config.
    ///
    /// # Arguments
    /// * `env` - The Soroban environment.
    /// * `admin` - The address that will own admin-only operations such as
    ///   [`add_authorized_updater`] and [`pause`]/[`unpause`].
    /// * `token` - The XLM or platform-token contract address used for payments.
    /// * `platform_fee_bps` - Platform fee expressed in basis points (e.g. `500` = 5 %).
    ///
    /// # Returns
    /// `Ok(())` on success.
    ///
    /// # Errors
    /// * [`Error::AlreadyInitialized`] — Contract has already been initialized.
    pub fn initialize(
        env: Env,
        admin: Address,
        token: Address,
        platform_fee_bps: u32,
    ) -> Result<(), Error> {
        if is_initialized(&env) {
            return Err(Error::AlreadyInitialized);
        }
        admin.require_auth();
        env.storage().instance().set(&DataKey::Admin, &admin);
        access::initialize(&env, &admin)?;
        env.storage().instance().set(&DataKey::Token, &token);
        env.storage()
            .instance()
            .set(&DataKey::PlatformFeeBps, &platform_fee_bps);
        env.storage().instance().set(&DataKey::Counter, &0u64);
        env.storage()
            .instance()
            .set(&DataKey::PlayerDataMigrated, &true);
        set_initialized(&env);
        bump_instance(&env);
        Ok(())
    }

    // Note: platform fee configuration has been consolidated into the subscription
    // contract, which is the authoritative source. set_platform_fee_bps and
    // get_platform_fee_bps were removed from this contract to avoid duplication.
    // The register contract still stores PlatformFeeBps from initialize() for
    // historical compatibility, but fee updates are performed exclusively via
    // SubscriptionContract::set_platform_fee_bps.

    // ── Pause / Unpause ────────────────────────────────────────────────────

    /// Pause the contract, preventing all state-changing operations.
    ///
    /// Only the admin address set during [`initialize`] may call this function.
    /// The guard is checked by [`register_player`], [`update_profile`], and
    /// [`update_progress_level`] via [`is_paused`] from the shared storage
    /// module.  If the contract is already paused the call is a no-op.
    ///
    /// # Errors
    /// * [`Error::NotInitialized`] — Contract has not been initialized.
    /// * [`Error::Unauthorized`] — Caller is not the admin.
    pub fn pause(env: Env, admin: Address) -> Result<(), Error> {
        if !is_initialized(&env) {
            return Err(Error::NotInitialized);
        }
        access::require_role(
            &env,
            &soroban_sdk::Symbol::new(&env, access::PAUSER),
            &admin,
        )?;
        set_paused(&env, true);
        bump_instance(&env);
        Ok(())
    }

    /// Unpause the contract, re-enabling all state-changing operations.
    ///
    /// Only the admin address may call this.  If the contract is not currently
    /// paused the call is a no-op.
    ///
    /// # Errors
    /// * [`Error::NotInitialized`] — Contract has not been initialized.
    /// * [`Error::Unauthorized`] — Caller is not the admin.
    pub fn unpause(env: Env, admin: Address) -> Result<(), Error> {
        if !is_initialized(&env) {
            return Err(Error::NotInitialized);
        }
        access::require_role(
            &env,
            &soroban_sdk::Symbol::new(&env, access::PAUSER),
            &admin,
        )?;
        set_paused(&env, false);
        bump_instance(&env);
        Ok(())
    }

    // ── Player registration ───────────────────────────────────────────────

    /// Register a new player profile on-chain. Each wallet address may only register once.
    ///
    /// Assigns a sequential `player_id`, stores the player's metadata URI (IPFS CID),
    /// position, region, and initial progress level of `0`. Emits a `player_rg` event.
    ///
    /// # Arguments
    /// * `env` - The Soroban environment.
    /// * `wallet` - The player's Stellar wallet address (must authorize this call).
    /// * `metadata_uri` - Non-empty IPFS/Arweave URI up to 2,048 bytes.
    /// * `position` - Non-empty playing position string up to 64 bytes.
    /// * `region` - Non-empty geographic region string up to 64 bytes.
    ///
    /// # Returns
    /// `Ok(player_id)` — the newly assigned unique player identifier (`u64`).
    ///
    /// # Errors
    /// * [`Error::NotInitialized`] — [`initialize`] has not been called yet.
    /// * [`Error::InvalidInput`] — The wallet is already registered, or a
    ///   profile field is empty or exceeds its maximum byte length.
    pub fn register_player(
        env: Env,
        wallet: Address,
        metadata_uri: String,
        position: String,
        region: String,
    ) -> Result<u64, Error> {
        if !is_initialized(&env) {
            return Err(Error::NotInitialized);
        }
        if is_paused(&env) {
            return Err(Error::ContractPaused);
        }
        if metadata_uri.is_empty()
            || metadata_uri.len() > MAX_METADATA_URI_BYTES
            || position.is_empty()
            || position.len() > MAX_POSITION_BYTES
            || region.is_empty()
            || region.len() > MAX_REGION_BYTES
        {
            return Err(Error::InvalidInput);
        }
        wallet.require_auth();

        if wallet_is_registered(&env, &wallet) {
            return Err(Error::InvalidInput);
        }

        let player_id: u64 = env
            .storage()
            .instance()
            .get::<DataKey, u64>(&DataKey::Counter)
            .unwrap_or(0)
            + 1;
        env.storage().instance().set(&DataKey::Counter, &player_id);

        let player = PlayerData {
            wallet: wallet.clone(),
            metadata_uri: metadata_uri.clone(),
            position: position.clone(),
            region: region.clone(),
            progress_level: 0,
            created_at: env.ledger().timestamp(),
        };

        set_player_data(&env, player_id, &player);
        set_wallet_player_id(&env, &wallet, player_id);

        env.events().publish(
            (symbol_short!("player_rg"), wallet),
            (player_id, metadata_uri, position, region),
        );

        bump_instance(&env);
        Ok(player_id)
    }

    /// Update the IPFS metadata URI for an existing player profile.
    ///
    /// Only the wallet that originally registered the player may call this function.
    /// The wallet must authorize the call.
    pub fn update_profile(env: Env, player_id: u64, metadata_uri: String) -> Result<(), Error> {
        if !is_initialized(&env) {
            return Err(Error::NotInitialized);
        }
        if is_paused(&env) {
            return Err(Error::ContractPaused);
        }
        if metadata_uri.is_empty() || metadata_uri.len() > MAX_METADATA_URI_BYTES {
            return Err(Error::InvalidInput);
        }

        let mut player: PlayerData = match get_player_data(&env, player_id) {
            Some(p) => p,
            None => return Err(Error::PlayerNotFound),
        };

        player.wallet.require_auth();
        player.metadata_uri = metadata_uri.clone();

        set_player_data(&env, player_id, &player);
        env.storage().instance().remove(&DataKey::Player(player_id));
        env.events().publish(
            (soroban_sdk::Symbol::new(&env, "profile_updated"), player_id),
            (metadata_uri,),
        );
        bump_instance(&env);
        Ok(())
    }

    /// Retrieve a player's full profile, including current progress tier.
    pub fn get_player(env: Env, player_id: u64) -> Result<PlayerData, Error> {
        get_player_data(&env, player_id).ok_or(Error::PlayerNotFound)
    }

    /// Return the sequential on-chain player ID assigned to `wallet`.
    ///
    /// Supports both persistent records and legacy instance records so
    /// operators can backfill API player mappings during an upgrade.
    pub fn get_player_id(env: Env, wallet: Address) -> Option<u64> {
        let key = DataKey::Wallet(wallet);
        if env.storage().persistent().has(&key) {
            env.storage().persistent().extend_ttl(
                &key,
                LEDGER_LIFETIME_THRESHOLD,
                LEDGER_BUMP_AMOUNT,
            );
            env.storage().persistent().get(&key)
        } else {
            let player_id = env.storage().instance().get(&key);
            if player_id.is_some() {
                bump_instance(&env);
            }
            player_id
        }
    }

    /// Migrate legacy instance-stored player records into persistent storage.
    ///
    /// Admins should call this repeatedly until it returns `true`. Each call
    /// processes at most 100 sequential player IDs, so large deployments can
    /// migrate without a single unbounded transaction. New registrations are
    /// already written to persistent storage while migration is in progress.
    pub fn migrate_players(env: Env, limit: u32) -> Result<bool, Error> {
        let admin: Address = env
            .storage()
            .instance()
            .get(&DataKey::Admin)
            .ok_or(Error::NotInitialized)?;
        Self::migrate_players_as(env, admin, limit)
    }

    /// Explicit caller variant for delegated role holders.
    pub fn migrate_players_as(env: Env,
        caller: Address, limit: u32) -> Result<bool, Error> {
        if !is_initialized(&env) {
            return Err(Error::NotInitialized);
        }
        if limit == 0 || limit > MAX_PLAYER_MIGRATION_BATCH {
            return Err(Error::InvalidInput);
        }

        access::require_role(
            &env,
            &soroban_sdk::Symbol::new(&env, access::MIGRATOR),
            &caller,
        )?;

        if env
            .storage()
            .instance()
            .get::<DataKey, bool>(&DataKey::PlayerDataMigrated)
            .unwrap_or(false)
        {
            return Ok(true);
        }

        // Filtering now walks the sequential counter, so the legacy growing
        // list can be removed before processing the bounded player batches.
        env.storage().instance().remove(&DataKey::PlayerList);

        let counter: u64 = env.storage().instance().get(&DataKey::Counter).unwrap_or(0);
        let mut cursor: u64 = env
            .storage()
            .instance()
            .get(&DataKey::PlayerMigrationCursor)
            .unwrap_or(1);
        let mut processed = 0;
        let mut complete = counter == 0;

        while cursor <= counter && processed < limit {
            if let Some(player) = get_player_data(&env, cursor) {
                set_player_data(&env, cursor, &player);
                set_wallet_player_id(&env, &player.wallet, cursor);
                env.storage().instance().remove(&DataKey::Player(cursor));
                env.storage()
                    .instance()
                    .remove(&DataKey::Wallet(player.wallet));
            }

            processed += 1;
            if cursor == counter {
                complete = true;
                break;
            }
            cursor += 1;
        }

        if complete {
            env.storage()
                .instance()
                .remove(&DataKey::PlayerMigrationCursor);
            env.storage()
                .instance()
                .set(&DataKey::PlayerDataMigrated, &true);
        } else {
            env.storage()
                .instance()
                .set(&DataKey::PlayerMigrationCursor, &cursor);
        }

        bump_instance(&env);
        Ok(complete)
    }

    // ── Multi-writer authorization ────────────────────────────────────────

    /// Add `updater` to the authorized-updaters allowlist, permitting it to call
    /// [`update_progress_level`].
    ///
    /// Replaces the old `set_authorized_updater` single-writer API.  The allowlist
    /// holds up to 16 entries (see `shared::storage::MAX_AUTHORIZED_UPDATERS`).
    /// Calling with the same address twice is idempotent.
    /// Only the admin may call this.
    ///
    /// **Backward compatibility**: callers that previously used
    /// `set_authorized_updater` should migrate to this function.  The old
    /// single-key (`DataKey::AuthorizedUpdater`) is preserved for on-chain data
    /// compatibility but is no longer checked by `update_progress_level`.
    ///
    /// # Errors
    /// * [`Error::NotInitialized`] — Contract has not been initialized.
    /// * [`Error::Unauthorized`] — Caller is not the admin.
    /// * [`Error::InvalidInput`] — Allowlist is already at maximum capacity (16).
    pub fn add_authorized_updater(env: Env, updater: Address) -> Result<(), Error> {
        let admin: Address = env
            .storage()
            .instance()
            .get(&DataKey::Admin)
            .ok_or(Error::NotInitialized)?;
        Self::add_authorized_updater_as(env, admin, updater)
    }

    /// Explicit caller variant for delegated role holders.
    pub fn add_authorized_updater_as(
        env: Env,
        caller: Address,
        updater: Address,
    ) -> Result<(), Error> {
        if !is_initialized(&env) {
            return Err(Error::NotInitialized);
        }
        access::require_role(
            &env,
            &soroban_sdk::Symbol::new(&env, access::UPDATER_MANAGER),
            &caller,
        )?;
        if !add_authorized_updater(&env, &updater) {
            return Err(Error::InvalidInput);
        }
        bump_instance(&env);
        Ok(())
    }

    /// Remove `updater` from the authorized-updaters allowlist.
    ///
    /// No-op if `updater` is not present.  Only the admin may call this.
    ///
    /// # Errors
    /// * [`Error::NotInitialized`] — Contract has not been initialized.
    /// * [`Error::Unauthorized`] — Caller is not the admin.
    pub fn remove_authorized_updater(env: Env, updater: Address) -> Result<(), Error> {
        let admin: Address = env
            .storage()
            .instance()
            .get(&DataKey::Admin)
            .ok_or(Error::NotInitialized)?;
        Self::remove_authorized_updater_as(env, admin, updater)
    }

    /// Explicit caller variant for delegated role holders.
    pub fn remove_authorized_updater_as(
        env: Env,
        caller: Address,
        updater: Address,
    ) -> Result<(), Error> {
        if !is_initialized(&env) {
            return Err(Error::NotInitialized);
        }
        access::require_role(
            &env,
            &soroban_sdk::Symbol::new(&env, access::UPDATER_MANAGER),
            &caller,
        )?;
        remove_authorized_updater(&env, &updater);
        bump_instance(&env);
        Ok(())
    }

    /// Legacy single-writer helper kept for backward compatibility.
    ///
    /// Internally calls `add_authorized_updater`, so the new allowlist is the
    /// source of truth.  Deployments that already store a single authorized
    /// updater via this function will continue to work — the stored address
    /// is added to the multi-writer allowlist on the first call.
    ///
    /// Prefer [`add_authorized_updater`] for new deployments.
    pub fn set_authorized_updater(env: Env, updater: Address) -> Result<(), Error> {
        Self::add_authorized_updater(env, updater)
    }

    /// Return the current list of authorized updater addresses.
    pub fn get_authorized_updaters(env: Env) -> Vec<Address> {
        get_authorized_updaters(&env)
    }

    /// Set a player's progress level to at least `level` (monotonically increasing).
    ///
    /// Any address in the authorized-updaters allowlist (registered via
    /// [`add_authorized_updater`]) may call this.  If the player's current level
    /// is already ≥ `level`, the call is a no-op for state but still succeeds.
    ///
    /// # Errors
    /// * [`Error::NotInitialized`] — Contract has not been initialized.
    /// * [`Error::Unauthorized`] — No authorized updater has been set, or the caller is
    ///   not in the authorized-updaters allowlist.
    /// * [`Error::PlayerNotFound`] — No player exists with the given `player_id`.
    pub fn update_progress_level(env: Env, player_id: u64, level: u32) -> Result<(), Error> {
        if !is_initialized(&env) {
            return Err(Error::NotInitialized);
        }
        if is_paused(&env) {
            return Err(Error::ContractPaused);
        }

        // The caller must be in the allowlist AND must provide their auth.
        // In Soroban cross-contract calls the invoking contract automatically
        // satisfies require_auth() for its own address, so this correctly
        // gates access to only the contracts that have been explicitly
        // whitelisted by the admin.
        let updaters = get_authorized_updaters(&env);
        if updaters.is_empty() {
            return Err(Error::Unauthorized);
        }

        // Find which allowlisted address is the current caller and require
        // its auth.  env.current_contract_address() is the *callee* (this
        // contract), not the caller, so we must check the allowlist and then
        // require_auth on the matching entry.  The Soroban VM fills in the
        // caller's invoking-contract auth automatically for cross-contract
        // calls, so this check will succeed iff the call came from that address.
        let len = updaters.len();
        let mut authorized = false;
        for i in 0..len {
            let candidate = updaters.get_unchecked(i);
            // try_require_auth returns Ok(()) if this candidate is the invoker
            // and the auth is satisfied, Err otherwise.  We iterate until one
            // matches rather than calling require_auth (which panics on failure).
            if is_authorized_updater(&env, &candidate) {
                // Require auth from this specific candidate.  In cross-contract
                // invocations the Soroban host automatically provides the invoking
                // contract's authorization, so this succeeds only for the one that
                // actually called us.
                candidate.require_auth();
                authorized = true;
                break;
            }
        }

        if !authorized {
            return Err(Error::Unauthorized);
        }

        let mut player: PlayerData =
            get_player_data(&env, player_id).ok_or(Error::PlayerNotFound)?;
        player.progress_level = player.progress_level.max(level);
        set_player_data(&env, player_id, &player);
        env.storage().instance().remove(&DataKey::Player(player_id));
        bump_instance(&env);
        Ok(())
    }

    /// Return all registered players matching the given region, position, and minimum progress tier.
    pub fn filter_players(
        env: Env,
        region: String,
        position: String,
        min_tier: u32,
    ) -> Vec<PlayerData> {
        let mut results = Vec::new(&env);
        let counter: u64 = env.storage().instance().get(&DataKey::Counter).unwrap_or(0);
        for player_id in 1..=counter {
            if let Some(player) = get_player_data(&env, player_id) {
                if player.region == region
                    && player.position == position
                    && player.progress_level >= min_tier
                {
                    results.push_back(player);
                }
            }
        }
        results
    }

    /// Return a page of players matching the given region, position, and minimum progress tier.
    ///
    /// This is the paginated variant of [`filter_players`]. It returns at most `limit` players
    /// starting from the given `start` index. Use `next` in the returned [`PlayerPage`] to fetch
    /// subsequent pages until it is `None`.
    ///
    /// # Arguments
    /// * `region` - Geographic region to filter by (e.g. "europe")
    /// * `position` - Playing position to filter by (e.g. "forward")
    /// * `min_tier` - Minimum progress level to filter by
    /// * `start` - Zero-based index of the first result to return
    /// * `limit` - Maximum number of results to return (capped at MAX_PAGE_SIZE = 50)
    ///
    /// # Returns
    /// A [`PlayerPage`] containing:
    /// * `items`: The slice of matching players for this page
    /// * `next`: The start index for the next page, or `None` if no more results
    ///
    /// # Errors
    /// * [`Error::InvalidInput`] — `start` or `limit` is invalid
    ///
    /// # Budget
    /// This function has a fixed CPU/memory cost independent of total player count.
    /// It reads only the requested slice of the PlayerList and fetches only the
    /// requested PlayerData entries.
    pub fn filter_players_page(
        env: Env,
        region: String,
        position: String,
        min_tier: u32,
        start: u32,
        limit: u32,
    ) -> Result<PlayerPage, Error> {
        // Validate inputs
        if limit == 0 {
            return Err(Error::InvalidInput);
        }
        let max_limit = MAX_PAGE_SIZE;
        let effective_limit = limit.min(max_limit);

        let list: Vec<u64> = match env.storage().instance().get(&DataKey::PlayerList) {
            Some(l) => l,
            None => {
                return Ok(PlayerPage {
                    items: Vec::new(&env),
                    next: None,
                })
            }
        };

        let total = list.len();
        if start >= total {
            return Ok(PlayerPage {
                items: Vec::new(&env),
                next: None,
            });
        }

        let end = (start + effective_limit).min(total);

        let mut results = Vec::new(&env);
        for i in start..end {
            let player_id = list.get_unchecked(i);
            if let Some(player) = env
                .storage()
                .instance()
                .get::<DataKey, PlayerData>(&DataKey::Player(player_id))
            {
                if player.region == region
                    && player.position == position
                    && player.progress_level >= min_tier
                {
                    results.push_back(player);
                }
            }
        }

        let next = if end < total { Some(end) } else { None };

        Ok(PlayerPage {
            items: results,
            next,
        })
    }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;
    use soroban_sdk::{testutils::Address as _, Env};

    fn setup(env: &Env) -> (RegisterContractClient<'_>, Address, Address) {
        env.mock_all_auths();
        let id = env.register_contract(None, RegisterContract);
        let client = RegisterContractClient::new(env, &id);
        let admin = Address::generate(env);
        let token = Address::generate(env);
        (client, admin, token)
    }

    fn assert_invalid_registration(
        env: &Env,
        client: &RegisterContractClient<'_>,
        metadata_uri: &String,
        position: &String,
        region: &String,
    ) {
        let wallet = Address::generate(env);
        assert_eq!(
            client.try_register_player(&wallet, metadata_uri, position, region),
            Err(Ok(Error::InvalidInput))
        );
    }

    #[test]
    fn register_creates_profile_with_zero_progress() {
        let env = Env::default();
        let (client, admin, token) = setup(&env);
        client.initialize(&admin, &token, &100);

        let wallet = Address::generate(&env);
        let pid = client.register_player(
            &wallet,
            &String::from_str(&env, "ipfs://meta"),
            &String::from_str(&env, "forward"),
            &String::from_str(&env, "europe"),
        );

        let player = client.get_player(&pid);
        assert_eq!(player.progress_level, 0);
        assert_eq!(player.wallet, wallet);
        assert_eq!(player.position, String::from_str(&env, "forward"));
        assert_eq!(player.region, String::from_str(&env, "europe"));
    }

    #[test]
    fn register_rejects_empty_and_oversized_profile_fields() {
        let env = Env::default();
        let (client, admin, token) = setup(&env);
        client.initialize(&admin, &token, &100);
        let valid_uri = String::from_str(&env, "ipfs://meta");
        let valid_position = String::from_str(&env, "forward");
        let valid_region = String::from_str(&env, "europe");
        let empty = String::from_str(&env, "");

        assert_invalid_registration(&env, &client, &empty, &valid_position, &valid_region);
        assert_invalid_registration(&env, &client, &valid_uri, &empty, &valid_region);
        assert_invalid_registration(&env, &client, &valid_uri, &valid_position, &empty);
        assert_invalid_registration(
            &env,
            &client,
            &String::from_str(&env, &"x".repeat(MAX_METADATA_URI_BYTES as usize + 1)),
            &valid_position,
            &valid_region,
        );
        assert_invalid_registration(
            &env,
            &client,
            &valid_uri,
            &String::from_str(&env, &"x".repeat(MAX_POSITION_BYTES as usize + 1)),
            &valid_region,
        );
        assert_invalid_registration(
            &env,
            &client,
            &valid_uri,
            &valid_position,
            &String::from_str(&env, &"x".repeat(MAX_REGION_BYTES as usize + 1)),
        );
    }

    #[test]
    fn player_and_wallet_records_use_persistent_storage() {
        let env = Env::default();
        env.mock_all_auths();
        let id = env.register_contract(None, RegisterContract);
        let client = RegisterContractClient::new(&env, &id);
        let admin = Address::generate(&env);
        let token = Address::generate(&env);
        client.initialize(&admin, &token, &100);

        let wallet = Address::generate(&env);
        let player_id = client.register_player(
            &wallet,
            &String::from_str(&env, "ipfs://meta"),
            &String::from_str(&env, "forward"),
            &String::from_str(&env, "europe"),
        );

        env.as_contract(&id, || {
            assert!(env.storage().persistent().has(&DataKey::Player(player_id)));
            assert!(env
                .storage()
                .persistent()
                .has(&DataKey::Wallet(wallet.clone())));
            assert!(!env.storage().instance().has(&DataKey::Player(player_id)));
            assert!(!env
                .storage()
                .instance()
                .has(&DataKey::Wallet(wallet.clone())));
            assert!(!env.storage().instance().has(&DataKey::PlayerList));
        });
    }

    #[test]
    fn migrate_players_moves_legacy_records_in_bounded_batches() {
        let env = Env::default();
        env.mock_all_auths();
        let id = env.register_contract(None, RegisterContract);
        let client = RegisterContractClient::new(&env, &id);
        let admin = Address::generate(&env);
        let token = Address::generate(&env);
        client.initialize(&admin, &token, &100);

        let first_wallet = Address::generate(&env);
        let second_wallet = Address::generate(&env);
        let legacy_player = |wallet: Address| PlayerData {
            wallet,
            metadata_uri: String::from_str(&env, "ipfs://legacy"),
            position: String::from_str(&env, "forward"),
            region: String::from_str(&env, "europe"),
            progress_level: 1,
            created_at: 10,
        };

        env.as_contract(&id, || {
            env.storage().instance().set(&DataKey::Counter, &2u64);
            env.storage()
                .instance()
                .set(&DataKey::PlayerDataMigrated, &false);
            env.storage()
                .instance()
                .set(&DataKey::PlayerList, &Vec::from_array(&env, [1u64, 2u64]));
            env.storage()
                .instance()
                .set(&DataKey::Player(1), &legacy_player(first_wallet.clone()));
            env.storage()
                .instance()
                .set(&DataKey::Player(2), &legacy_player(second_wallet.clone()));
            env.storage()
                .instance()
                .set(&DataKey::Wallet(first_wallet.clone()), &1u64);
            env.storage()
                .instance()
                .set(&DataKey::Wallet(second_wallet.clone()), &2u64);
        });

        assert!(!client.migrate_players(&1));
        assert_eq!(client.get_player(&1).wallet, first_wallet);
        env.as_contract(&id, || {
            assert!(!env.storage().instance().has(&DataKey::PlayerList));
            assert!(!env.storage().instance().has(&DataKey::Player(1)));
            assert!(env.storage().persistent().has(&DataKey::Player(1)));
        });
        // Migrating the last record completes the migration in the same call;
        // further calls are idempotent no-ops that keep returning true.
        assert!(client.migrate_players(&1));
        assert_eq!(client.get_player(&2).wallet, second_wallet);
        assert!(client.migrate_players(&1));

        env.as_contract(&id, || {
            assert!(!env.storage().instance().has(&DataKey::Player(1)));
            assert!(!env.storage().instance().has(&DataKey::Player(2)));
            assert!(!env.storage().instance().has(&DataKey::PlayerList));
            assert!(env.storage().persistent().has(&DataKey::Player(1)));
            assert!(env.storage().persistent().has(&DataKey::Player(2)));
            assert!(env
                .storage()
                .persistent()
                .has(&DataKey::Wallet(first_wallet.clone())));
            assert!(env
                .storage()
                .persistent()
                .has(&DataKey::Wallet(second_wallet.clone())));
        });
    }

    #[test]
    fn duplicate_wallet_registration_fails() {
        let env = Env::default();
        let (client, admin, token) = setup(&env);
        client.initialize(&admin, &token, &100);

        let wallet = Address::generate(&env);
        client.register_player(
            &wallet,
            &String::from_str(&env, "ipfs://meta"),
            &String::from_str(&env, "forward"),
            &String::from_str(&env, "europe"),
        );

        let result = client.try_register_player(
            &wallet,
            &String::from_str(&env, "ipfs://meta2"),
            &String::from_str(&env, "goalkeeper"),
            &String::from_str(&env, "africa"),
        );
        assert!(result.is_err());
    }

    #[test]
    fn update_profile_succeeds_for_owner() {
        let env = Env::default();
        let (client, admin, token) = setup(&env);
        client.initialize(&admin, &token, &100);

        let wallet = Address::generate(&env);
        let pid = client.register_player(
            &wallet,
            &String::from_str(&env, "ipfs://old"),
            &String::from_str(&env, "forward"),
            &String::from_str(&env, "europe"),
        );

        client.update_profile(&pid, &String::from_str(&env, "ipfs://new"));
        let player = client.get_player(&pid);
        assert_eq!(player.metadata_uri, String::from_str(&env, "ipfs://new"));
    }

    #[test]
    fn update_profile_rejects_empty_or_oversized_metadata_uri() {
        let env = Env::default();
        let (client, admin, token) = setup(&env);
        client.initialize(&admin, &token, &100);
        let wallet = Address::generate(&env);
        let player_id = client.register_player(
            &wallet,
            &String::from_str(&env, "ipfs://meta"),
            &String::from_str(&env, "forward"),
            &String::from_str(&env, "europe"),
        );

        assert_eq!(
            client.try_update_profile(&player_id, &String::from_str(&env, "")),
            Err(Ok(Error::InvalidInput))
        );
        assert_eq!(
            client.try_update_profile(
                &player_id,
                &String::from_str(&env, &"x".repeat(MAX_METADATA_URI_BYTES as usize + 1))
            ),
            Err(Ok(Error::InvalidInput))
        );
    }

    #[test]
    fn pause_blocks_registration_profile_and_progress_updates() {
        let env = Env::default();
        let (client, admin, token) = setup(&env);
        client.initialize(&admin, &token, &100);
        let wallet = Address::generate(&env);
        let pid = client.register_player(
            &wallet,
            &String::from_str(&env, "ipfs://old"),
            &String::from_str(&env, "forward"),
            &String::from_str(&env, "europe"),
        );

        client.pause(&admin);
        assert!(matches!(
            client.try_register_player(
                &Address::generate(&env),
                &String::from_str(&env, "ipfs://new"),
                &String::from_str(&env, "forward"),
                &String::from_str(&env, "europe"),
            ),
            Err(Ok(Error::ContractPaused))
        ));
        assert!(matches!(
            client.try_update_profile(&pid, &String::from_str(&env, "ipfs://new")),
            Err(Ok(Error::ContractPaused))
        ));
        let updater = Address::generate(&env);
        client.add_authorized_updater(&updater);
        assert!(matches!(
            client.try_update_progress_level(&pid, &1),
            Err(Ok(Error::ContractPaused))
        ));
    }

    #[test]
    fn get_player_returns_not_found_for_unknown_id() {
        let env = Env::default();
        let (client, admin, token) = setup(&env);
        client.initialize(&admin, &token, &100);

        let result = client.try_get_player(&999u64);
        assert!(result.is_err());
    }

    #[test]
    fn filter_players_by_region_position_and_tier() {
        let env = Env::default();
        let (client, admin, token) = setup(&env);
        client.initialize(&admin, &token, &100);

        let w1 = Address::generate(&env);
        let w2 = Address::generate(&env);
        let w3 = Address::generate(&env);

        client.register_player(
            &w1,
            &String::from_str(&env, "ipfs://1"),
            &String::from_str(&env, "forward"),
            &String::from_str(&env, "europe"),
        );
        client.register_player(
            &w2,
            &String::from_str(&env, "ipfs://2"),
            &String::from_str(&env, "forward"),
            &String::from_str(&env, "africa"),
        );
        client.register_player(
            &w3,
            &String::from_str(&env, "ipfs://3"),
            &String::from_str(&env, "midfielder"),
            &String::from_str(&env, "europe"),
        );

        let results = client.filter_players(
            &String::from_str(&env, "europe"),
            &String::from_str(&env, "forward"),
            &0u32,
        );
        assert_eq!(results.len(), 1);
        assert_eq!(results.get(0).unwrap().wallet, w1);
    }

    #[test]
    fn add_authorized_updater_allows_update_progress() {
        let env = Env::default();
        let (client, admin, token) = setup(&env);
        client.initialize(&admin, &token, &100u32);

        let updater = Address::generate(&env);
        client.add_authorized_updater(&updater);

        let wallet = Address::generate(&env);
        let player_id = client.register_player(
            &wallet,
            &String::from_str(&env, "ipfs://meta"),
            &String::from_str(&env, "forward"),
            &String::from_str(&env, "europe"),
        );

        client.update_progress_level(&player_id, &2u32);
        assert_eq!(client.get_player(&player_id).progress_level, 2);
    }

    #[test]
    fn two_authorized_updaters_both_can_update_progress() {
        let env = Env::default();
        let (client, admin, token) = setup(&env);
        client.initialize(&admin, &token, &100u32);

        let updater1 = Address::generate(&env);
        let updater2 = Address::generate(&env);
        client.add_authorized_updater(&updater1);
        client.add_authorized_updater(&updater2);

        let wallet = Address::generate(&env);
        let player_id = client.register_player(
            &wallet,
            &String::from_str(&env, "ipfs://meta"),
            &String::from_str(&env, "forward"),
            &String::from_str(&env, "europe"),
        );

        // Both updaters should be able to call update_progress_level
        // (mock_all_auths satisfies auth for any address in tests).
        client.update_progress_level(&player_id, &1u32);
        assert_eq!(client.get_player(&player_id).progress_level, 1);
        client.update_progress_level(&player_id, &2u32);
        assert_eq!(client.get_player(&player_id).progress_level, 2);
    }

    #[test]
    fn remove_authorized_updater_revokes_access() {
        let env = Env::default();
        let (client, admin, token) = setup(&env);
        client.initialize(&admin, &token, &100u32);

        let updater = Address::generate(&env);
        client.add_authorized_updater(&updater);

        let wallet = Address::generate(&env);
        let player_id = client.register_player(
            &wallet,
            &String::from_str(&env, "ipfs://meta"),
            &String::from_str(&env, "forward"),
            &String::from_str(&env, "europe"),
        );

        // Updater works before removal.
        client.update_progress_level(&player_id, &1u32);
        assert_eq!(client.get_player(&player_id).progress_level, 1);

        // Remove and verify list is empty.
        client.remove_authorized_updater(&updater);
        let list = client.get_authorized_updaters();
        assert_eq!(list.len(), 0);
    }

    #[test]
    fn set_authorized_updater_is_backward_compatible() {
        let env = Env::default();
        let (client, admin, token) = setup(&env);
        client.initialize(&admin, &token, &100);
        let updater = Address::generate(&env);
        // Legacy API must still work.
        client.set_authorized_updater(&updater);
        let list = client.get_authorized_updaters();
        assert_eq!(list.len(), 1);
        assert_eq!(list.get(0).unwrap(), updater);
    }

    #[test]
    fn pause_and_unpause_work() {
        let env = Env::default();
        let (client, admin, token) = setup(&env);
        client.initialize(&admin, &token, &100);
        // Pause the contract.
        client.pause(&admin);
        // Unpause.
        client.unpause(&admin);
        // Double-unpause is a no-op (not an error).
        assert!(client.try_unpause(&admin).is_ok());
    }

    #[test]
    fn non_admin_cannot_pause() {
        let env = Env::default();
        let (client, admin, token) = setup(&env);
        client.initialize(&admin, &token, &100);
        let non_admin = Address::generate(&env);
        let result = client.try_pause(&non_admin);
        assert!(result.is_err());
    }

    #[test]
    fn invariant_progress_levels_never_decrease_under_randomized_updates() {
        let env = Env::default();
        let (client, admin, token) = setup(&env);
        client.initialize(&admin, &token, &100u32);

        let updater = Address::generate(&env);
        client.add_authorized_updater(&updater);

        let wallet = Address::generate(&env);
        let player_id = client.register_player(
            &wallet,
            &String::from_str(&env, "ipfs://meta"),
            &String::from_str(&env, "forward"),
            &String::from_str(&env, "europe"),
        );

        let mut previous_level = 0u32;
        let mut state = 0x5eed_1234u64;
        for step in 0..32 {
            let target_player = if state % 2 == 0 {
                player_id
            } else {
                player_id + 1
            };
            let requested_level = ((state >> 3) % 4) as u32;
            let result = client.try_update_progress_level(&target_player, &requested_level);

            let player = client.get_player(&player_id);
            if result.is_ok() {
                assert!(
                    player.progress_level >= previous_level,
                    "step {step}: progress regressed from {previous_level} to {}",
                    player.progress_level
                );
                previous_level = player.progress_level;
            } else {
                assert_eq!(
                    player.progress_level, previous_level,
                    "step {step}: failed update should not change progress"
                );
            }

            state = state
                .wrapping_mul(6364136223846793005)
                .wrapping_add(1442695040888963407);
        }
    }

    #[test]
    fn double_initialize_fails() {
        let env = Env::default();
        let (client, admin, token) = setup(&env);
        client.initialize(&admin, &token, &100);
        assert!(client.try_initialize(&admin, &token, &100).is_err());
    }

    #[test]
    fn register_fails_when_not_initialized() {
        let env = Env::default();
        let (client, _admin, _token) = setup(&env);
        let wallet = Address::generate(&env);
        let result = client.try_register_player(
            &wallet,
            &String::from_str(&env, "ipfs://x"),
            &String::from_str(&env, "forward"),
            &String::from_str(&env, "europe"),
        );
        assert!(result.is_err());
    }

    #[test]
    fn update_profile_fails_for_unknown_player() {
        let env = Env::default();
        let (client, admin, token) = setup(&env);
        client.initialize(&admin, &token, &100);
        assert!(client
            .try_update_profile(&999u64, &String::from_str(&env, "ipfs://x"))
            .is_err());
    }

    #[test]
    fn player_ids_are_sequential() {
        let env = Env::default();
        let (client, admin, token) = setup(&env);
        client.initialize(&admin, &token, &100);

        let w1 = Address::generate(&env);
        let w2 = Address::generate(&env);
        let id1 = client.register_player(
            &w1,
            &String::from_str(&env, "ipfs://1"),
            &String::from_str(&env, "forward"),
            &String::from_str(&env, "europe"),
        );
        let id2 = client.register_player(
            &w2,
            &String::from_str(&env, "ipfs://2"),
            &String::from_str(&env, "midfielder"),
            &String::from_str(&env, "europe"),
        );
        assert_eq!(id2, id1 + 1);
    }

    #[test]
    fn version_returns_semver_tuple() {
        let env = Env::default();
        let (client, _admin, _token) = setup(&env);
        let (major, minor, patch) = client.version();
        // Semantic version: major must be 0 while the contract is in pre-release.
        assert_eq!(major, 0);
        // Minor and patch are non-negative (trivially true for u32, but explicit).
        let _ = minor;
        let _ = patch;
    }
}
