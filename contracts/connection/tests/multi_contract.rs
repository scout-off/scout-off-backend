/// Multi-contract integration tests for progress-update authorization.
///
/// These tests verify the acceptance criterion from issue #1016:
///   "A new integration test that initializes register, progress, and
///    connection in one test harness and proves both progress and connection
///    can successfully call into register's progress-update path after both
///    have registered as authorized updaters."
///
/// The key regression guarded here: before the allowlist redesign, the second
/// call to `set_authorized_updater` silently overwrote the first, so whichever
/// of `progress` or `connection` was registered last would lock the other out
/// at runtime with no compile-time warning.
#[cfg(test)]
mod multi_contract_progress_update {
    use connection::{ConnectionContract, ConnectionContractClient};
    use progress::{ProgressContract, ProgressContractClient};
    use register::{RegisterContract, RegisterContractClient};
    use soroban_sdk::{
        testutils::Address as _,
        token::StellarAssetClient,
        Address, Env, String,
    };
    use subscription::{SubscriptionContract, SubscriptionContractClient};

    // ── helpers ──────────────────────────────────────────────────────────────

    /// Deploy and wire all four contracts together.
    ///
    /// Returns `(reg, prog, conn, sub, admin, token_addr)`.
    fn setup(
        env: &Env,
    ) -> (
        RegisterContractClient<'_>,
        ProgressContractClient<'_>,
        ConnectionContractClient<'_>,
        SubscriptionContractClient<'_>,
        Address,
        Address,
    ) {
        env.mock_all_auths();

        let admin = Address::generate(env);

        // Real SAC so token transfers work inside subscribe / pay_to_contact.
        let token_addr = env
            .register_stellar_asset_contract_v2(admin.clone())
            .address();
        StellarAssetClient::new(env, &token_addr).mint(&admin, &1_000_000_000_000_000i128);

        let reg_id   = env.register_contract(None, RegisterContract);
        let prog_id  = env.register_contract(None, ProgressContract);
        let sub_id   = env.register_contract(None, SubscriptionContract);
        let conn_id  = env.register_contract(None, ConnectionContract);

        let reg  = RegisterContractClient::new(env, &reg_id);
        let prog = ProgressContractClient::new(env, &prog_id);
        let sub  = SubscriptionContractClient::new(env, &sub_id);
        let conn = ConnectionContractClient::new(env, &conn_id);

        reg.initialize(&admin, &token_addr, &100u32);
        prog.initialize(&admin, &reg_id);
        sub.initialize(&admin, &token_addr, &100u32);
        conn.initialize(&admin, &reg_id, &sub_id);

        // Register BOTH progress and connection as authorized updaters —
        // the critical operation that the old single-writer design couldn't support.
        reg.add_authorized_updater(&prog_id);
        reg.add_authorized_updater(&conn_id);

        (reg, prog, conn, sub, admin, token_addr)
    }

    fn fund(env: &Env, token_addr: &Address, to: &Address) {
        StellarAssetClient::new(env, token_addr).mint(to, &100_000_000_000_000i128);
    }

    fn register_player(env: &Env, reg: &RegisterContractClient<'_>) -> u64 {
        let wallet = Address::generate(env);
        reg.register_player(
            &wallet,
            &String::from_str(env, "ipfs://meta"),
            &String::from_str(env, "forward"),
            &String::from_str(env, "europe"),
        )
    }

    // ── Core multi-writer test ────────────────────────────────────────────────

    /// Both progress and connection are in the allowlist.
    /// A milestone approval (via progress) raises level to 2;
    /// a trial offer (via connection) raises it further to 3.
    /// Neither call evicts the other from the allowlist.
    #[test]
    fn progress_and_connection_both_update_register_independently() {
        let env = Env::default();
        let (reg, prog, conn, sub, _admin, token) = setup(&env);
        let player_id = register_player(&env, &reg);

        assert_eq!(reg.get_player(&player_id).progress_level, 0);

        // Step 1 — progress contract: identity milestone → level 1.
        let validator = Address::generate(&env);
        prog.register_validator(&validator);

        let mid = prog.submit_milestone(
            &validator,
            &player_id,
            &String::from_str(&env, "identity"),
            &String::from_str(&env, "ipfs://ev1"),
        );
        prog.approve_milestone(&validator, &mid);
        assert_eq!(
            reg.get_player(&player_id).progress_level,
            1,
            "progress contract must raise level to 1 via update_progress_level"
        );

        // Step 2 — progress contract: performance milestone → level 2.
        let mid2 = prog.submit_milestone(
            &validator,
            &player_id,
            &String::from_str(&env, "performance"),
            &String::from_str(&env, "ipfs://ev2"),
        );
        prog.approve_milestone(&validator, &mid2);
        assert_eq!(
            reg.get_player(&player_id).progress_level,
            2,
            "progress contract must raise level to 2"
        );

        // Step 3 — connection contract: trial offer → level 3.
        let scout = Address::generate(&env);
        fund(&env, &token, &scout);
        sub.subscribe(&scout, &1u32, &1000u32);
        conn.log_trial_offer(&scout, &player_id, &String::from_str(&env, "ipfs://offer"));
        assert_eq!(
            reg.get_player(&player_id).progress_level,
            3,
            "connection contract must raise level to 3 via update_progress_level"
        );
    }

    /// Adding progress then connection leaves both in the allowlist (no eviction).
    #[test]
    fn both_updaters_are_present_in_allowlist_after_setup() {
        let env = Env::default();
        let (reg, _prog, _conn, _sub, _admin, _token) = setup(&env);
        assert_eq!(
            reg.get_authorized_updaters().len(),
            2,
            "allowlist must contain exactly two entries after setup"
        );
    }

    /// remove_authorized_updater evicts only the specified address; the other remains.
    #[test]
    fn remove_authorized_updater_evicts_only_the_target() {
        let env = Env::default();
        let (reg, prog, conn, _sub, _admin, _token) = setup(&env);

        reg.remove_authorized_updater(&conn.address);

        let remaining = reg.get_authorized_updaters();
        assert_eq!(remaining.len(), 1);
        assert_eq!(remaining.get(0).unwrap(), prog.address);
    }

    /// After removing connection, the progress contract can still update progress.
    #[test]
    fn progress_still_works_after_connection_is_removed() {
        let env = Env::default();
        let (reg, prog, conn, _sub, _admin, _token) = setup(&env);
        let player_id = register_player(&env, &reg);

        reg.remove_authorized_updater(&conn.address);

        let validator = Address::generate(&env);
        prog.register_validator(&validator);
        let mid = prog.submit_milestone(
            &validator,
            &player_id,
            &String::from_str(&env, "identity"),
            &String::from_str(&env, "ipfs://id"),
        );
        prog.approve_milestone(&validator, &mid);
        assert_eq!(reg.get_player(&player_id).progress_level, 1);
    }

    /// Legacy `set_authorized_updater` appends to the allowlist rather than
    /// replacing it — backward compatibility for one-updater deployments.
    #[test]
    fn set_authorized_updater_appends_not_replaces() {
        let env = Env::default();
        let (reg, _prog, _conn, _sub, _admin, _token) = setup(&env);

        let before_len = reg.get_authorized_updaters().len(); // 2

        let extra = Address::generate(&env);
        reg.set_authorized_updater(&extra);

        assert_eq!(
            reg.get_authorized_updaters().len(),
            before_len + 1,
            "set_authorized_updater must append, not replace"
        );
    }

    /// Idempotent: adding the same address twice doesn't create a duplicate entry.
    #[test]
    fn add_authorized_updater_is_idempotent() {
        let env = Env::default();
        let (reg, prog, _conn, _sub, _admin, _token) = setup(&env);

        let before_len = reg.get_authorized_updaters().len();
        reg.add_authorized_updater(&prog.address); // already there
        assert_eq!(
            reg.get_authorized_updaters().len(),
            before_len,
            "duplicate add must not grow the allowlist"
        );
    }

    /// Pause + unpause on the register contract round-trips cleanly.
    #[test]
    fn register_pause_unpause_round_trip() {
        let env = Env::default();
        let (reg, _prog, _conn, _sub, admin, _token) = setup(&env);
        assert!(reg.try_pause(&admin).is_ok());
        assert!(reg.try_unpause(&admin).is_ok());
    }
}
