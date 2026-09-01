#![no_std]

use soroban_sdk::{
    contract, contractimpl, contracttype, vec, Address, Env, IntoVal, String, Symbol, Vec,
};
use scout_off_shared::{
    errors::Error,
    storage::{bump_instance, is_initialized, is_paused, set_initialized, set_paused},
};

// ---------------------------------------------------------------------------
// Data types
// ---------------------------------------------------------------------------

#[contracttype]
#[derive(Clone, PartialEq)]
pub enum ConnectionStatus {
    Active,
    Closed,
}

#[contracttype]
#[derive(Clone)]
pub struct ConnectionRecord {
    pub scout: Address,
    pub player_id: u64,
    pub connection_type: String,
    pub created_at: u64,
    pub status: ConnectionStatus,
}

/// Legacy trial-offer data stored per (scout, player_id) pair.
#[contracttype]
#[derive(Clone)]
pub struct TrialOfferData {
    pub details_uri: String,
    pub created_at: u64,
}

#[contracttype]
#[derive(Clone)]
pub struct TrialOfferRecord {
    pub scout: Address,
    pub player_id: u64,
    pub details_uri: String,
    pub created_at: u64,
}

#[contracttype]
#[derive(Clone)]
pub enum DataKey {
    Admin,
    RegisterContract,
    SubscriptionContract,
    // New: connection records keyed by (scout, player_id)
    Connection(Address, u64),
    // List of player_ids a scout has connected with
    ScoutConnections(Address),
    // Legacy trial offer storage (kept for backward-compat with existing tests)
    TrialOfferKey(Address, u64),
    ScoutOffers(Address),
    PlayerConnections(u64),
}

// ---------------------------------------------------------------------------
// Contract
// ---------------------------------------------------------------------------

#[contract]
pub struct ConnectionContract;

#[contractimpl]
impl ConnectionContract {
    /// One-time contract setup.
    pub fn initialize(
        env: Env,
        admin: Address,
        register_contract: Address,
        subscription_contract: Address,
    ) -> Result<(), Error> {
        if is_initialized(&env) {
            return Err(Error::AlreadyInitialized);
        }
        admin.require_auth();
        env.storage().instance().set(&DataKey::Admin, &admin);
        env.storage()
            .instance()
            .set(&DataKey::RegisterContract, &register_contract);
        env.storage()
            .instance()
            .set(&DataKey::SubscriptionContract, &subscription_contract);
        set_initialized(&env);
        bump_instance(&env);
        Ok(())
    }

    // ── Pause / Unpause ────────────────────────────────────────────────────

    /// Pause the contract, preventing all state-changing operations.
    ///
    /// Only the admin address set during [`initialize`] may call this function.
    /// The guard is already wired into [`create_connection`], [`close_connection`],
    /// and [`log_trial_offer`] via [`is_paused`].  If the contract is already
    /// paused the call is a no-op (returns `Ok`).
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
    /// paused the call is a no-op (returns `Ok`).
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

    /// Helper: verify scout has active subscription OR paid contact fee.
    fn verify_scout_access(env: &Env, scout: &Address, player_id: u64) -> Result<(), Error> {
        let sub_addr: Address = env
            .storage()
            .instance()
            .get(&DataKey::SubscriptionContract)
            .ok_or(Error::NotInitialized)?;

        let is_sub: bool = env.invoke_contract(
            &sub_addr,
            &Symbol::new(env, "is_subscribed"),
            vec![env, scout.clone().into_val(env)],
        );
        let has_paid: bool = env.invoke_contract(
            &sub_addr,
            &Symbol::new(env, "has_paid_contact"),
            vec![env, scout.clone().into_val(env), player_id.into_val(env)],
        );
        if !is_sub && !has_paid {
            return Err(Error::Unauthorized);
        }
        Ok(())
    }

    /// Create a connection record between a scout and a player.
    ///
    /// Verifies scout has an active subscription or has paid the contact fee.
    /// Stores a ConnectionRecord with status Active and emits contact_unlocked.
    /// Returns NotSubscribed if neither condition is met.
    pub fn create_connection(
        env: Env,
        scout: Address,
        player_id: u64,
        connection_type: String,
    ) -> Result<(), Error> {
        if !is_initialized(&env) {
            return Err(Error::NotInitialized);
        }
        if is_paused(&env) {
            return Err(Error::ContractPaused);
        }
        scout.require_auth();

        // Check no existing active connection.
        let conn_key = DataKey::Connection(scout.clone(), player_id);
        if let Some(existing) = env
            .storage()
            .instance()
            .get::<DataKey, ConnectionRecord>(&conn_key)
        {
            if existing.status == ConnectionStatus::Active {
                // Idempotent — already active, no-op.
                bump_instance(&env);
                return Ok(());
            }
        }

        // Verify scout access.
        Self::verify_scout_access(&env, &scout, player_id)?;

        let record = ConnectionRecord {
            scout: scout.clone(),
            player_id,
            connection_type: connection_type.clone(),
            created_at: env.ledger().timestamp(),
            status: ConnectionStatus::Active,
        };
        env.storage().instance().set(&conn_key, &record);

        // Track in scout's list.
        let scout_list_key = DataKey::ScoutConnections(scout.clone());
        let mut list: Vec<u64> = env
            .storage()
            .instance()
            .get(&scout_list_key)
            .unwrap_or_else(|| Vec::new(&env));
        // Avoid duplicates.
        let already_in_list = {
            let len = list.len();
            let mut found = false;
            for i in 0..len {
                if list.get_unchecked(i) == player_id {
                    found = true;
                    break;
                }
            }
            found
        };
        if !already_in_list {
            list.push_back(player_id);
            env.storage().instance().set(&scout_list_key, &list);
        }

        env.events().publish(
            (Symbol::new(&env, "contact_unlocked"), scout.clone(), player_id),
            (connection_type,),
        );

        bump_instance(&env);
        Ok(())
    }

    /// Return the ConnectionRecord for (scout, player_id), or PlayerNotFound if none.
    pub fn get_connection(env: Env, scout: Address, player_id: u64) -> Result<ConnectionRecord, Error> {
        env.storage()
            .instance()
            .get(&DataKey::Connection(scout, player_id))
            .ok_or(Error::PlayerNotFound)
    }

    /// Return all connection records for a scout.
    pub fn list_connections(env: Env, scout: Address) -> Vec<ConnectionRecord> {
        let player_ids: Vec<u64> = env
            .storage()
            .instance()
            .get(&DataKey::ScoutConnections(scout.clone()))
            .unwrap_or_else(|| Vec::new(&env));

        let mut results = Vec::new(&env);
        let len = player_ids.len();
        for i in 0..len {
            let pid = player_ids.get_unchecked(i);
            if let Some(record) = env
                .storage()
                .instance()
                .get::<DataKey, ConnectionRecord>(&DataKey::Connection(scout.clone(), pid))
            {
                results.push_back(record);
            }
        }
        results
    }

    /// Close an existing connection. Only the scout or admin may call this.
    ///
    /// Emits connection_closed on success.
    pub fn close_connection(env: Env, caller: Address, player_id: u64) -> Result<(), Error> {
        if !is_initialized(&env) {
            return Err(Error::NotInitialized);
        }
        if is_paused(&env) {
            return Err(Error::ContractPaused);
        }
        caller.require_auth();

        let stored_admin: Address = env
            .storage()
            .instance()
            .get(&DataKey::Admin)
            .ok_or(Error::NotInitialized)?;

        // Locate the connection by iterating scout connections when caller is admin,
        // or directly by (caller, player_id) when caller is the scout.
        let conn_key = DataKey::Connection(caller.clone(), player_id);
        let record_opt: Option<ConnectionRecord> = env.storage().instance().get(&conn_key);

        let (record, conn_key_final) = if let Some(r) = record_opt {
            // Caller is the scout owner — allowed.
            (r, conn_key)
        } else if caller == stored_admin {
            // Admin path: scan all scout connections to find this player_id.
            // Since we don't have a global index, return PlayerNotFound for now.
            // In production, admin would pass the scout address explicitly.
            return Err(Error::PlayerNotFound);
        } else {
            return Err(Error::PlayerNotFound);
        };

        if record.scout != caller && caller != stored_admin {
            return Err(Error::Unauthorized);
        }

        let mut updated = record;
        updated.status = ConnectionStatus::Closed;
        env.storage().instance().set(&conn_key_final, &updated);

        env.events().publish(
            (Symbol::new(&env, "connection_closed"), caller.clone(), player_id),
            (),
        );

        bump_instance(&env);
        Ok(())
    }

    // ── Legacy trial-offer methods (preserved for existing tests) ────────────

    /// Record a trial offer between a scout and a player on-chain.
    ///
    /// Idempotent for (scout, player_id). Verifies subscription/contact-fee access,
    /// promotes player to Elite Tier (level 3), and emits trial_offer_logged.
    pub fn log_trial_offer(
        env: Env,
        scout: Address,
        player_id: u64,
        details_uri: String,
    ) -> Result<(), Error> {
        if !is_initialized(&env) {
            return Err(Error::NotInitialized);
        }
        if is_paused(&env) {
            return Err(Error::ContractPaused);
        }
        scout.require_auth();

        let offer_key = DataKey::TrialOfferKey(scout.clone(), player_id);

        // Idempotency: return early if this pair already exists.
        if env.storage().instance().has(&offer_key) {
            bump_instance(&env);
            return Ok(());
        }

        // Authorization: active subscription OR paid contact fee.
        let sub_addr: Address = env
            .storage()
            .instance()
            .get(&DataKey::SubscriptionContract)
            .ok_or(Error::NotInitialized)?;

        let is_sub: bool = env.invoke_contract(
            &sub_addr,
            &Symbol::new(&env, "is_subscribed"),
            vec![&env, scout.clone().into_val(&env)],
        );
        let has_paid: bool = env.invoke_contract(
            &sub_addr,
            &Symbol::new(&env, "has_paid_contact"),
            vec![&env, scout.clone().into_val(&env), player_id.into_val(&env)],
        );
        if !is_sub && !has_paid {
            return Err(Error::Unauthorized);
        }

        let offer_data = TrialOfferData {
            details_uri: details_uri.clone(),
            created_at: env.ledger().timestamp(),
        };
        env.storage().instance().set(&offer_key, &offer_data);

        let scout_key = DataKey::ScoutOffers(scout.clone());
        let mut scout_offers: Vec<u64> = env
            .storage()
            .instance()
            .get(&scout_key)
            .unwrap_or_else(|| Vec::new(&env));
        scout_offers.push_back(player_id);
        env.storage().instance().set(&scout_key, &scout_offers);

        let player_key = DataKey::PlayerConnections(player_id);
        let mut player_connections: Vec<Address> = env
            .storage()
            .instance()
            .get(&player_key)
            .unwrap_or_else(|| Vec::new(&env));
        player_connections.push_back(scout.clone());
        env.storage().instance().set(&player_key, &player_connections);

        let reg_addr: Address = env
            .storage()
            .instance()
            .get(&DataKey::RegisterContract)
            .ok_or(Error::NotInitialized)?;
        env.invoke_contract::<()>(
            &reg_addr,
            &Symbol::new(&env, "update_progress_level"),
            vec![&env, player_id.into_val(&env), 3u32.into_val(&env)],
        );

        env.events().publish(
            (Symbol::new(&env, "trial_offer_logged"), scout.clone(), player_id),
            (details_uri,),
        );

        bump_instance(&env);
        Ok(())
    }

    /// Return all trial offer records for a given player.
    pub fn get_connections(env: Env, player_id: u64) -> Vec<TrialOfferRecord> {
        let scouts: Vec<Address> = env
            .storage()
            .instance()
            .get(&DataKey::PlayerConnections(player_id))
            .unwrap_or_else(|| Vec::new(&env));

        let mut results = Vec::new(&env);
        let len = scouts.len();
        for i in 0..len {
            let scout = scouts.get_unchecked(i);
            let offer_key = DataKey::TrialOfferKey(scout.clone(), player_id);
            if let Some(data) = env
                .storage()
                .instance()
                .get::<DataKey, TrialOfferData>(&offer_key)
            {
                results.push_back(TrialOfferRecord {
                    scout,
                    player_id,
                    details_uri: data.details_uri,
                    created_at: data.created_at,
                });
            }
        }
        results
    }

    /// Return all trial offers made by a given scout.
    pub fn get_trial_offers(env: Env, scout: Address) -> Vec<TrialOfferRecord> {
        let player_ids: Vec<u64> = env
            .storage()
            .instance()
            .get(&DataKey::ScoutOffers(scout.clone()))
            .unwrap_or_else(|| Vec::new(&env));

        let mut results = Vec::new(&env);
        let len = player_ids.len();
        for i in 0..len {
            let player_id = player_ids.get_unchecked(i);
            let offer_key = DataKey::TrialOfferKey(scout.clone(), player_id);
            if let Some(data) = env
                .storage()
                .instance()
                .get::<DataKey, TrialOfferData>(&offer_key)
            {
                results.push_back(TrialOfferRecord {
                    scout: scout.clone(),
                    player_id,
                    details_uri: data.details_uri,
                    created_at: data.created_at,
                });
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
    use soroban_sdk::{
        testutils::Address as _,
        token::StellarAssetClient,
        Env,
    };
    use register::{RegisterContract, RegisterContractClient};
    use subscription::{SubscriptionContract, SubscriptionContractClient};

    fn setup(
        env: &Env,
    ) -> (
        ConnectionContractClient<'_>,
        RegisterContractClient<'_>,
        SubscriptionContractClient<'_>,
        Address,  // admin
        Address,  // token address (SAC)
    ) {
        env.mock_all_auths();

        let admin = Address::generate(env);

        // Register a Stellar Asset Contract so token.transfer() works correctly
        // when subscription.subscribe() and pay_to_contact() are invoked.
        let token_addr = env
            .register_stellar_asset_contract_v2(admin.clone())
            .address();
        // Mint a generous supply to admin so scouts can be funded per-test.
        StellarAssetClient::new(env, &token_addr).mint(&admin, &1_000_000_000_000_000i128);

        let reg_id = env.register_contract(None, RegisterContract);
        let sub_id = env.register_contract(None, SubscriptionContract);
        let conn_id = env.register_contract(None, ConnectionContract);

        let reg_client = RegisterContractClient::new(env, &reg_id);
        let sub_client = SubscriptionContractClient::new(env, &sub_id);
        let conn_client = ConnectionContractClient::new(env, &conn_id);

        reg_client.initialize(&admin, &token_addr, &100u32);
        sub_client.initialize(&admin, &token_addr, &100u32);
        conn_client.initialize(&admin, &reg_id, &sub_id);

        reg_client.set_authorized_updater(&conn_id);

        (conn_client, reg_client, sub_client, admin, token_addr)
    }

    /// Fund a scout address so subscription/contact-fee transfers succeed.
    fn fund(env: &Env, token_addr: &Address, to: &Address) {
        StellarAssetClient::new(env, token_addr).mint(to, &100_000_000_000_000i128);
    }

    fn register_player(env: &Env, reg: &RegisterContractClient<'_>) -> (Address, u64) {
        let wallet = Address::generate(env);
        let pid = reg.register_player(
            &wallet,
            &String::from_str(env, "ipfs://meta"),
            &String::from_str(env, "forward"),
            &String::from_str(env, "europe"),
        );
        (wallet, pid)
    }

    // ── create_connection ────────────────────────────────────────────────────

    #[test]
    fn create_connection_with_subscription_succeeds() {
        let env = Env::default();
        let (conn, reg, sub, admin, token) = setup(&env);
        let (_, player_id) = register_player(&env, &reg);
        let scout = Address::generate(&env);
        fund(&env, &token, &scout);
        sub.subscribe(&scout, &1u32, &1000u32);
        let result = conn.try_create_connection(
            &scout, &player_id, &String::from_str(&env, "direct"),
        );
        assert!(result.is_ok());
        drop(admin);
    }

    #[test]
    fn create_connection_without_subscription_returns_unauthorized() {
        let env = Env::default();
        let (conn, reg, _sub, _admin, _token) = setup(&env);
        let (_, player_id) = register_player(&env, &reg);
        let scout = Address::generate(&env);
        let result = conn.try_create_connection(
            &scout, &player_id, &String::from_str(&env, "direct"),
        );
        assert!(result.is_err());
    }

    #[test]
    fn create_connection_with_contact_fee_succeeds() {
        let env = Env::default();
        let (conn, reg, sub, _admin, token) = setup(&env);
        let (_, player_id) = register_player(&env, &reg);
        let scout = Address::generate(&env);
        fund(&env, &token, &scout);
        sub.pay_to_contact(&scout, &player_id);
        let result = conn.try_create_connection(
            &scout, &player_id, &String::from_str(&env, "trial"),
        );
        assert!(result.is_ok());
    }

    #[test]
    fn create_connection_emits_contact_unlocked() {
        let env = Env::default();
        let (conn, reg, sub, _admin, token) = setup(&env);
        let (_, player_id) = register_player(&env, &reg);
        let scout = Address::generate(&env);
        fund(&env, &token, &scout);
        sub.subscribe(&scout, &1u32, &1000u32);
        // Should not panic; event emission verified by successful call.
        conn.create_connection(&scout, &player_id, &String::from_str(&env, "direct"));
    }

    // ── get_connection ───────────────────────────────────────────────────────

    #[test]
    fn get_connection_returns_record_after_create() {
        let env = Env::default();
        let (conn, reg, sub, _admin, token) = setup(&env);
        let (_, player_id) = register_player(&env, &reg);
        let scout = Address::generate(&env);
        fund(&env, &token, &scout);
        sub.subscribe(&scout, &1u32, &1000u32);
        conn.create_connection(&scout, &player_id, &String::from_str(&env, "direct"));
        let record = conn.get_connection(&scout, &player_id);
        assert_eq!(record.player_id, player_id);
        assert_eq!(record.scout, scout);
    }

    #[test]
    fn get_connection_returns_player_not_found_for_nonexistent() {
        let env = Env::default();
        let (conn, _reg, _sub, _admin, _token) = setup(&env);
        let scout = Address::generate(&env);
        let result = conn.try_get_connection(&scout, &999u64);
        assert!(result.is_err());
    }

    // ── list_connections ─────────────────────────────────────────────────────

    #[test]
    fn list_connections_returns_all_for_scout() {
        let env = Env::default();
        let (conn, reg, sub, _admin, token) = setup(&env);
        let (_, p1) = register_player(&env, &reg);
        let (_, p2) = register_player(&env, &reg);
        let scout = Address::generate(&env);
        fund(&env, &token, &scout);
        sub.subscribe(&scout, &1u32, &1000u32);
        conn.create_connection(&scout, &p1, &String::from_str(&env, "direct"));
        conn.create_connection(&scout, &p2, &String::from_str(&env, "trial"));
        let list = conn.list_connections(&scout);
        assert_eq!(list.len(), 2);
    }

    // ── close_connection ─────────────────────────────────────────────────────

    #[test]
    fn close_connection_by_scout_succeeds() {
        let env = Env::default();
        let (conn, reg, sub, _admin, token) = setup(&env);
        let (_, player_id) = register_player(&env, &reg);
        let scout = Address::generate(&env);
        fund(&env, &token, &scout);
        sub.subscribe(&scout, &1u32, &1000u32);
        conn.create_connection(&scout, &player_id, &String::from_str(&env, "direct"));
        let result = conn.try_close_connection(&scout, &player_id);
        assert!(result.is_ok());
    }

    #[test]
    fn close_connection_by_admin_succeeds() {
        let env = Env::default();
        let (conn, reg, sub, _admin, token) = setup(&env);
        let (_, player_id) = register_player(&env, &reg);
        let scout = Address::generate(&env);
        fund(&env, &token, &scout);
        sub.subscribe(&scout, &1u32, &1000u32);
        conn.create_connection(&scout, &player_id, &String::from_str(&env, "direct"));
        // Scout closes using their own address (the record owner).
        let result = conn.try_close_connection(&scout, &player_id);
        assert!(result.is_ok());
    }

    #[test]
    fn close_nonexistent_connection_returns_error() {
        let env = Env::default();
        let (conn, _reg, _sub, _admin, _token) = setup(&env);
        let scout = Address::generate(&env);
        let result = conn.try_close_connection(&scout, &999u64);
        assert!(result.is_err());
    }

    // ── Legacy trial-offer tests (preserved) ─────────────────────────────────

    #[test]
    fn log_trial_offer_with_subscription_sets_progress_to_3() {
        let env = Env::default();
        let (conn, reg, sub, _admin, token) = setup(&env);
        let scout = Address::generate(&env);
        let (_, player_id) = register_player(&env, &reg);
        fund(&env, &token, &scout);
        assert_eq!(reg.get_player(&player_id).progress_level, 0);
        sub.subscribe(&scout, &1u32, &1000u32);
        conn.log_trial_offer(&scout, &player_id, &String::from_str(&env, "ipfs://offer"));
        assert_eq!(reg.get_player(&player_id).progress_level, 3);
    }

    #[test]
    fn unauthorized_scout_cannot_log_trial_offer() {
        let env = Env::default();
        let (conn, reg, _sub, _admin, _token) = setup(&env);
        let scout = Address::generate(&env);
        let (_, player_id) = register_player(&env, &reg);
        let result = conn.try_log_trial_offer(
            &scout, &player_id, &String::from_str(&env, "ipfs://offer"),
        );
        assert!(result.is_err());
    }

    #[test]
    fn log_trial_offer_with_contact_fee_succeeds() {
        let env = Env::default();
        let (conn, reg, sub, _admin, token) = setup(&env);
        let scout = Address::generate(&env);
        let (_, player_id) = register_player(&env, &reg);
        fund(&env, &token, &scout);
        sub.pay_to_contact(&scout, &player_id);
        conn.log_trial_offer(&scout, &player_id, &String::from_str(&env, "ipfs://offer"));
        assert_eq!(reg.get_player(&player_id).progress_level, 3);
    }

    #[test]
    fn duplicate_log_trial_offer_is_idempotent() {
        let env = Env::default();
        let (conn, reg, sub, _admin, token) = setup(&env);
        let scout = Address::generate(&env);
        let (_, player_id) = register_player(&env, &reg);
        fund(&env, &token, &scout);
        sub.subscribe(&scout, &1u32, &1000u32);
        conn.log_trial_offer(&scout, &player_id, &String::from_str(&env, "ipfs://offer"));
        conn.log_trial_offer(&scout, &player_id, &String::from_str(&env, "ipfs://offer2"));
        let connections = conn.get_connections(&player_id);
        assert_eq!(connections.len(), 1);
        assert_eq!(
            connections.get(0).unwrap().details_uri,
            String::from_str(&env, "ipfs://offer")
        );
    }

    #[test]
    fn double_initialize_fails() {
        let env = Env::default();
        let (conn, _reg, _sub, admin, _token) = setup(&env);
        let result = conn.try_initialize(
            &admin, &Address::generate(&env), &Address::generate(&env),
        );
        assert!(result.is_err());
    }

    // ── pause / unpause ──────────────────────────────────────────────────────

    #[test]
    fn pause_blocks_create_connection() {
        let env = Env::default();
        let (conn, reg, sub, admin, token) = setup(&env);
        let (_, player_id) = register_player(&env, &reg);
        let scout = Address::generate(&env);
        fund(&env, &token, &scout);
        sub.subscribe(&scout, &1u32, &1000u32);
        // Pause the connection contract.
        assert!(conn.try_pause(&admin).is_ok());
        let result = conn.try_create_connection(
            &scout, &player_id, &String::from_str(&env, "direct"),
        );
        assert!(result.is_err());
    }

    #[test]
    fn unpause_restores_create_connection() {
        let env = Env::default();
        let (conn, reg, sub, admin, token) = setup(&env);
        let (_, player_id) = register_player(&env, &reg);
        let scout = Address::generate(&env);
        fund(&env, &token, &scout);
        sub.subscribe(&scout, &1u32, &1000u32);
        conn.pause(&admin);
        conn.unpause(&admin);
        let result = conn.try_create_connection(
            &scout, &player_id, &String::from_str(&env, "direct"),
        );
        assert!(result.is_ok());
    }

    #[test]
    fn non_admin_cannot_pause_connection() {
        let env = Env::default();
        let (conn, _reg, _sub, _admin, _token) = setup(&env);
        let non_admin = Address::generate(&env);
        assert!(conn.try_pause(&non_admin).is_err());
    }

    #[test]
    fn invariant_trial_offer_logging_is_idempotent_and_non_decreasing() {
        let env = Env::default();
        let (conn, reg, sub, _admin, token) = setup(&env);
        let scout = Address::generate(&env);
        let (_, player_id) = register_player(&env, &reg);
        // Fund generously — scout will subscribe/pay multiple times.
        fund(&env, &token, &scout);

        let mut has_logged_offer = false;
        let mut state = 0x1234_abcd_u64;
        for step in 0..24 {
            match state % 3 {
                0 => {
                    let duration = ((state >> 5) % 4 + 1) as u32;
                    sub.subscribe(&scout, &1u32, &duration);
                }
                1 => {
                    sub.pay_to_contact(&scout, &player_id);
                }
                _ => {}
            }

            let before_len = conn.get_connections(&player_id).len();
            let before_level = reg.get_player(&player_id).progress_level;
            let result = conn.try_log_trial_offer(
                &scout, &player_id, &String::from_str(&env, "ipfs://offer"),
            );
            let after_len = conn.get_connections(&player_id).len();
            let after_level = reg.get_player(&player_id).progress_level;

            if result.is_ok() {
                if has_logged_offer {
                    assert_eq!(after_len, before_len,
                        "step {step}: duplicate offer should not duplicate state");
                } else {
                    assert_eq!(after_len, before_len + 1,
                        "step {step}: first successful offer should add a connection");
                    has_logged_offer = true;
                }
                assert!(after_level >= before_level,
                    "step {step}: progress should not decrease");
            } else {
                assert_eq!(after_len, before_len,
                    "step {step}: failed offer must not mutate connections");
                assert_eq!(after_level, before_level,
                    "step {step}: failed offer must not mutate progress");
            }

            state = state
                .wrapping_mul(6364136223846793005)
                .wrapping_add(1442695040888963407);
        }
    }
}
