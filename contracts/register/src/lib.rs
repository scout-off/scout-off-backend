#![no_std]

use soroban_sdk::{contract, contractimpl, contracttype, symbol_short, Address, Env, String, Vec};
use scout_off_shared::{
    errors::Error,
    storage::{bump_instance, is_initialized, set_initialized},
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
    AuthorizedUpdater,
}

// ---------------------------------------------------------------------------
// Contract
// ---------------------------------------------------------------------------

#[contract]
pub struct RegisterContract;

#[contractimpl]
impl RegisterContract {
    /// One-time setup. Stores admin, payment token, and platform fee config.
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

    /// Register a new player. Each wallet may only register once.
    /// Returns the generated player_id.
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

    /// Update the IPFS metadata URI for an existing player.
    /// Only the wallet that originally registered may call this.
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

    /// Fetch a player's full profile. Returns PlayerNotFound(3) if unknown.
    pub fn get_player(env: Env, player_id: u64) -> Result<PlayerData, Error> {
        env.storage()
            .instance()
            .get(&DataKey::Player(player_id))
            .ok_or(Error::PlayerNotFound)
    }

    /// Authorize an external contract (e.g. connection) to update player progress levels.
    /// Admin-only.
    pub fn set_authorized_updater(env: Env, updater: Address) -> Result<(), Error> {
        if !is_initialized(&env) {
            return Err(Error::NotInitialized);
        }
        let admin: Address = env
            .storage()
            .instance()
            .get(&DataKey::Admin)
            .ok_or(Error::NotInitialized)?;
        admin.require_auth();
        env.storage()
            .instance()
            .set(&DataKey::AuthorizedUpdater, &updater);
        bump_instance(&env);
        Ok(())
    }

    /// Set a player's progress level. Only the authorized updater contract may call this.
    pub fn update_progress_level(env: Env, player_id: u64, level: u32) -> Result<(), Error> {
        if !is_initialized(&env) {
            return Err(Error::NotInitialized);
        }
        let updater: Address = env
            .storage()
            .instance()
            .get(&DataKey::AuthorizedUpdater)
            .ok_or(Error::Unauthorized)?;
        updater.require_auth();

        let mut player: PlayerData = env
            .storage()
            .instance()
            .get(&DataKey::Player(player_id))
            .ok_or(Error::PlayerNotFound)?;
        player.progress_level = level;
        env.storage()
            .instance()
            .set(&DataKey::Player(player_id), &player);
        bump_instance(&env);
        Ok(())
    }

    /// Return all players matching region, position, and minimum progress tier.
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
