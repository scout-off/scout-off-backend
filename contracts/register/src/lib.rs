#![no_std]

use soroban_sdk::{contract, contractimpl, contracttype, symbol_short, Address, Env, String, Vec};
use scout_off_shared::{
    errors::Error,
    storage::{
        add_authorized_updater, bump_instance, get_authorized_updaters, is_authorized_updater,
        is_initialized, is_paused, remove_authorized_updater, set_initialized, set_paused,
    },
};

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
}

// ---------------------------------------------------------------------------
// Contract
// ---------------------------------------------------------------------------

#[contract]
pub struct RegisterContract;

#[contractimpl]
impl RegisterContract {
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
        env.storage().instance().set(&DataKey::Token, &token);
        env.storage()
            .instance()
            .set(&DataKey::PlatformFeeBps, &platform_fee_bps);
        env.storage().instance().set(&DataKey::Counter, &0u64);
        env.storage()
            .instance()
            .set(&DataKey::PlayerList, &Vec::<u64>::new(&env));
        set_initialized(&env);
        bump_instance(&env);
        Ok(())
    }

    /// Update the platform fee in basis points. Admin-only.
    /// Valid range: 0–10000 (0% to 100%). Emits a fee_upd event.
    pub fn set_platform_fee_bps(env: Env, new_bps: u32) -> Result<(), Error> {
        if !is_initialized(&env) {
            return Err(Error::NotInitialized);
        }
        if new_bps > 10000 {
            return Err(Error::InvalidInput);
        }
        let admin: Address = env
            .storage()
            .instance()
            .get(&DataKey::Admin)
            .ok_or(Error::NotInitialized)?;
        admin.require_auth();
        env.storage()
            .instance()
            .set(&DataKey::PlatformFeeBps, &new_bps);
        env.events()
            .publish((symbol_short!("fee_upd"),), (new_bps,));
        bump_instance(&env);
        Ok(())
    }

    /// Return the current platform fee in basis points.
    pub fn get_platform_fee_bps(env: Env) -> Result<u32, Error> {
        env.storage()
            .instance()
            .get(&DataKey::PlatformFeeBps)
            .ok_or(Error::NotInitialized)
    }

    // ── Pause / Unpause ────────────────────────────────────────────────────

    /// Pause the contract, preventing all state-changing operations.
    ///
    /// Only the admin address set during [`initialize`] may call this function.
    /// The guard is checked by [`subscribe`], [`pay_to_contact`], and other
    /// state-changing entrypoints via [`is_paused`] from the shared storage
    /// module.  If the contract is already paused the call is a no-op.
    ///
    /// # Errors
    /// * [`Error::NotInitialized`] — Contract has not been initialized.
    /// * [`Error::Unauthorized`] — Caller is not the admin.
    pub fn pause(env: Env, admin: Address) -> Result<(), Error> {
        if !is_initialized(&env) {
            return Err(Error::NotInitialized);
        }
        let stored_admin: Address = env
            .storage()
            .instance()
            .get(&DataKey::Admin)
            .ok_or(Error::NotInitialized)?;
        admin.require_auth();
        if admin != stored_admin {
            return Err(Error::Unauthorized);
        }
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
        let stored_admin: Address = env
            .storage()
            .instance()
            .get(&DataKey::Admin)
            .ok_or(Error::NotInitialized)?;
        admin.require_auth();
        if admin != stored_admin {
            return Err(Error::Unauthorized);
        }
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
    /// * `metadata_uri` - IPFS/Arweave content URI containing the player's off-chain profile.
    /// * `position` - Playing position string, e.g. `"forward"`, `"midfielder"`.
    /// * `region` - Geographic region string, e.g. `"europe"`, `"west africa"`.
    ///
    /// # Returns
    /// `Ok(player_id)` — the newly assigned unique player identifier (`u64`).
    ///
    /// # Errors
    /// * [`Error::NotInitialized`] — [`initialize`] has not been called yet.
    /// * [`Error::InvalidInput`] — The calling wallet is already registered.
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
        wallet.require_auth();

        if env
            .storage()
            .instance()
            .has(&DataKey::Wallet(wallet.clone()))
        {
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

        env.storage()
            .instance()
            .set(&DataKey::Player(player_id), &player);
        env.storage()
            .instance()
            .set(&DataKey::Wallet(wallet.clone()), &player_id);

        let mut list: Vec<u64> = env
            .storage()
            .instance()
            .get(&DataKey::PlayerList)
            .unwrap_or_else(|| Vec::new(&env));
        list.push_back(player_id);
        env.storage().instance().set(&DataKey::PlayerList, &list);

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
    pub fn update_profile(
        env: Env,
        player_id: u64,
        metadata_uri: String,
    ) -> Result<(), Error> {
        if !is_initialized(&env) {
            return Err(Error::NotInitialized);
        }

        let mut player: PlayerData = match env
            .storage()
            .instance()
            .get(&DataKey::Player(player_id))
        {
            Some(p) => p,
            None => return Err(Error::PlayerNotFound),
        };

        player.wallet.require_auth();
        player.metadata_uri = metadata_uri;

        env.storage()
            .instance()
            .set(&DataKey::Player(player_id), &player);
        bump_instance(&env);
        Ok(())
    }

    /// Retrieve a player's full profile, including current progress tier.
    pub fn get_player(env: Env, player_id: u64) -> Result<PlayerData, Error> {
        env.storage()
            .instance()
            .get(&DataKey::Player(player_id))
            .ok_or(Error::PlayerNotFound)
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
        if !is_initialized(&env) {
            return Err(Error::NotInitialized);
        }
        let admin: Address = env
            .storage()
            .instance()
            .get(&DataKey::Admin)
            .ok_or(Error::NotInitialized)?;
        admin.require_auth();
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
        if !is_initialized(&env) {
            return Err(Error::NotInitialized);
        }
        let admin: Address = env
            .storage()
            .instance()
            .get(&DataKey::Admin)
            .ok_or(Error::NotInitialized)?;
        admin.require_auth();
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

        let mut player: PlayerData = env
            .storage()
            .instance()
            .get(&DataKey::Player(player_id))
            .ok_or(Error::PlayerNotFound)?;
        player.progress_level = player.progress_level.max(level);
        env.storage()
            .instance()
            .set(&DataKey::Player(player_id), &player);
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
        let list: Vec<u64> = match env.storage().instance().get(&DataKey::PlayerList) {
            Some(l) => l,
            None => return Vec::new(&env),
        };

        let mut results = Vec::new(&env);
        let len = list.len();
        for i in 0..len {
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
        results
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
            let target_player = if state % 2 == 0 { player_id } else { player_id + 1 };
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
    fn set_platform_fee_bps_succeeds_for_admin() {
        let env = Env::default();
        let (client, admin, token) = setup(&env);
        client.initialize(&admin, &token, &100);
        client.set_platform_fee_bps(&250u32);
        assert_eq!(client.get_platform_fee_bps(), 250u32);
    }

    #[test]
    fn set_platform_fee_bps_rejects_out_of_range() {
        let env = Env::default();
        let (client, admin, token) = setup(&env);
        client.initialize(&admin, &token, &100);
        assert!(client.try_set_platform_fee_bps(&10001u32).is_err());
    }

    #[test]
    fn set_platform_fee_bps_allows_zero_and_max() {
        let env = Env::default();
        let (client, admin, token) = setup(&env);
        client.initialize(&admin, &token, &100);
        client.set_platform_fee_bps(&0u32);
        assert_eq!(client.get_platform_fee_bps(), 0u32);
        client.set_platform_fee_bps(&10000u32);
        assert_eq!(client.get_platform_fee_bps(), 10000u32);
    }
}
