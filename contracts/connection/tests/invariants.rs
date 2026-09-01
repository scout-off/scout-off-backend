/// Property-based invariant tests for the `connection` contract.
///
/// Invariants verified:
///   C1. A scout can never have two active connections to the same player simultaneously —
///       repeated `log_trial_offer` calls for the same (scout, player_id) are idempotent;
///       `get_connections` always returns exactly one record per scout per player.
///   C2. Connection count per scout is bounded by the number of distinct `log_trial_offer`
///       calls that succeeded — it equals the number of *unique* player_ids contacted.
///   C3. A successful `log_trial_offer` always promotes the player's progress_level to
///       exactly 3 (or leaves it at 3 if already there) — it never decreases.
///   C4. `log_trial_offer` with neither a subscription nor a contact fee always fails.
///   C5. The original `details_uri` is preserved on duplicate calls — the second call's
///       URI argument is silently ignored.
///   C6. Player progress_level never decreases across any sequence of valid operations.
///
/// Each proptest! block runs 10 000 cases.
#[cfg(test)]
mod connection_invariants {
    use proptest::prelude::*;
    use connection::{ConnectionContract, ConnectionContractClient};
    use register::{RegisterContract, RegisterContractClient};
    use subscription::{SubscriptionContract, SubscriptionContractClient};
    use soroban_sdk::{
        testutils::Address as _,
        token::StellarAssetClient,
        Address, Env, String,
    };

    // ── helpers ──────────────────────────────────────────────────────────────

    /// Number of cases to run per proptest! block. Defaults to 10 000 (the
    /// project standard) but can be overridden via PROPTEST_CASES — e.g. CI
    /// uses a smaller value for fast PR feedback within its time budget,
    /// while nightly/local runs keep the full 10 000.
    fn proptest_cases() -> u32 {
        std::env::var("PROPTEST_CASES")
            .ok()
            .and_then(|v| v.parse().ok())
            .unwrap_or(10_000)
    }

    /// Any scout balance used in these tests only needs to cover subscribe()/
    /// pay_to_contact() fees, which are small relative to this — one mint per
    /// scout is enough for the whole proptest case.
    const SCOUT_FUNDING: i128 = 1_000_000_000_000_000i128;

    fn setup(
        env: &Env,
    ) -> (
        ConnectionContractClient<'_>,
        RegisterContractClient<'_>,
        SubscriptionContractClient<'_>,
        Address, // admin
        Address, // token
    ) {
        env.mock_all_auths();
        let admin = Address::generate(env);
        // subscribe()/pay_to_contact() transfer real tokens via TokenClient, so
        // the "token" address must be a live Stellar Asset Contract, not a bare
        // generated Address — otherwise every transfer call traps with
        // Error(Storage, MissingValue) (no contract instance to invoke).
        let token = env.register_stellar_asset_contract_v2(admin.clone()).address();

        let reg_id = env.register_contract(None, RegisterContract);
        let sub_id = env.register_contract(None, SubscriptionContract);
        let conn_id = env.register_contract(None, ConnectionContract);

        let reg = RegisterContractClient::new(env, &reg_id);
        let sub = SubscriptionContractClient::new(env, &sub_id);
        let conn = ConnectionContractClient::new(env, &conn_id);

        reg.initialize(&admin, &token, &100u32);
        sub.initialize(&admin, &token, &100u32);
        conn.initialize(&admin, &reg_id, &sub_id);
        reg.set_authorized_updater(&conn_id);

        (conn, reg, sub, admin, token)
    }

    /// Mint `SCOUT_FUNDING` tokens to `scout` so its subscribe()/pay_to_contact()
    /// transfer calls have a sufficient balance.
    fn fund_scout(env: &Env, token: &Address, scout: &Address) {
        StellarAssetClient::new(env, token).mint(scout, &SCOUT_FUNDING);
    }

    fn new_player(env: &Env, reg: &RegisterContractClient<'_>) -> u64 {
        let w = Address::generate(env);
        reg.register_player(
            &w,
            &String::from_str(env, "ipfs://meta"),
            &String::from_str(env, "forward"),
            &String::from_str(env, "europe"),
        )
    }

    fn offer_uri(env: &Env) -> String {
        String::from_str(env, "ipfs://offer")
    }

    // ── C1: no duplicate connections per (scout, player_id) ──────────────────

    proptest! {
        #![proptest_config(ProptestConfig::with_cases(proptest_cases()))]

        /// Calling log_trial_offer n times for the same (scout, player_id) must leave
        /// get_connections returning exactly 1 record for that scout.
        #[test]
        fn prop_no_duplicate_connections(
            n in 2usize..=10,
            use_subscription in any::<bool>(),
        ) {
            let env = Env::default();
            let (conn, reg, sub, _, token) = setup(&env);
            let scout = Address::generate(&env);
            fund_scout(&env, &token, &scout);
            let player_id = new_player(&env, &reg);

            if use_subscription {
                sub.subscribe(&scout, &1u32, &10_000u32);
            } else {
                sub.pay_to_contact(&scout, &player_id);
            }

            for i in 0..n {
                let uri = if i == 0 {
                    String::from_str(&env, "ipfs://first")
                } else {
                    String::from_str(&env, "ipfs://subsequent")
                };
                let result = conn.try_log_trial_offer(&scout, &player_id, &uri);
                prop_assert!(result.is_ok(), "log_trial_offer call {} must succeed", i);
            }

            let connections = conn.get_connections(&player_id);
            prop_assert_eq!(
                connections.len(), 1,
                "get_connections must return exactly 1 record after {} calls for the same pair",
                n
            );
            // Original URI is preserved.
            prop_assert_eq!(
                connections.get(0).unwrap().details_uri,
                String::from_str(&env, "ipfs://first"),
                "original URI must be preserved on duplicate calls"
            );
        }
    }

    // ── C2: connection count equals number of distinct player_ids contacted ───

    proptest! {
        #![proptest_config(ProptestConfig::with_cases(proptest_cases()))]

        /// After contacting n distinct players, get_trial_offers must return exactly n records.
        #[test]
        fn prop_connection_count_bounded_by_unique_players(
            n in 1usize..=10,
        ) {
            let env = Env::default();
            let (conn, reg, sub, _, token) = setup(&env);
            let scout = Address::generate(&env);
            fund_scout(&env, &token, &scout);

            // Single subscription covers all players.
            sub.subscribe(&scout, &1u32, &100_000u32);

            let mut player_ids: Vec<u64> = Vec::new();
            for _ in 0..n {
                let pid = new_player(&env, &reg);
                player_ids.push(pid);
                conn.log_trial_offer(&scout, &pid, &offer_uri(&env));
            }

            let offers = conn.get_trial_offers(&scout);
            prop_assert_eq!(
                offers.len() as usize, n,
                "get_trial_offers must return {} records for {} distinct players, got {}",
                n, n, offers.len()
            );
        }
    }

    // ── C3: successful log_trial_offer always sets player level to exactly 3 ──

    proptest! {
        #![proptest_config(ProptestConfig::with_cases(proptest_cases()))]

        /// For any starting level in [0, 3], a successful log_trial_offer must leave
        /// the player's progress_level at exactly 3.
        #[test]
        fn prop_trial_offer_promotes_to_level_3(
            starting_level in 0u32..=3u32,
        ) {
            let env = Env::default();
            let (conn, reg, sub, _, token) = setup(&env);
            let scout = Address::generate(&env);
            fund_scout(&env, &token, &scout);
            let player_id = new_player(&env, &reg);

            // Set the starting level directly via the register contract.
            reg.update_progress_level(&player_id, &starting_level);
            prop_assert_eq!(reg.get_player(&player_id).progress_level, starting_level);

            sub.subscribe(&scout, &1u32, &10_000u32);
            conn.log_trial_offer(&scout, &player_id, &offer_uri(&env));

            let level = reg.get_player(&player_id).progress_level;
            prop_assert_eq!(
                level, 3,
                "progress_level must be 3 after log_trial_offer, starting from {}; got {}",
                starting_level, level
            );
        }
    }

    // ── C4: unauthorized scouts are always rejected ───────────────────────────

    proptest! {
        #![proptest_config(ProptestConfig::with_cases(proptest_cases()))]

        /// A scout with neither a subscription nor a paid contact fee must always
        /// receive an error, and the player's progress_level must remain unchanged.
        #[test]
        fn prop_unauthorized_scout_always_rejected(_seed in 0u64..u64::MAX) {
            let env = Env::default();
            let (conn, reg, _sub, _, _token) = setup(&env);
            let scout = Address::generate(&env);
            let player_id = new_player(&env, &reg);

            let before_level = reg.get_player(&player_id).progress_level;

            let result = conn.try_log_trial_offer(&scout, &player_id, &offer_uri(&env));
            prop_assert!(result.is_err(), "unauthorized scout must be rejected");

            let after_level = reg.get_player(&player_id).progress_level;
            prop_assert_eq!(
                after_level, before_level,
                "player level must not change after a rejected log_trial_offer"
            );

            let connections = conn.get_connections(&player_id);
            prop_assert_eq!(connections.len(), 0, "connection count must remain 0");
        }
    }

    // ── C5: original URI is preserved on duplicate calls ─────────────────────

    proptest! {
        #![proptest_config(ProptestConfig::with_cases(proptest_cases()))]

        /// No matter how many times log_trial_offer is called with different URIs,
        /// get_connections always returns the URI from the very first successful call.
        #[test]
        fn prop_original_uri_preserved_on_duplicates(
            n_extra in 1usize..=8,
        ) {
            let env = Env::default();
            let (conn, reg, sub, _, token) = setup(&env);
            let scout = Address::generate(&env);
            fund_scout(&env, &token, &scout);
            let player_id = new_player(&env, &reg);

            sub.subscribe(&scout, &1u32, &100_000u32);

            let first_uri = String::from_str(&env, "ipfs://original");
            conn.log_trial_offer(&scout, &player_id, &first_uri);

            for i in 0..n_extra {
                let other = format!("ipfs://attempt-{}", i);
                let u = String::from_str(&env, &other);
                conn.log_trial_offer(&scout, &player_id, &u);
            }

            let records = conn.get_connections(&player_id);
            prop_assert_eq!(records.len(), 1);
            prop_assert_eq!(
                records.get(0).unwrap().details_uri,
                first_uri,
                "original URI must be preserved after {} extra calls",
                n_extra
            );
        }
    }

    // ── C6: player progress_level never decreases across valid operations ─────

    proptest! {
        #![proptest_config(ProptestConfig::with_cases(proptest_cases()))]

        /// A mixed sequence of subscription, contact-fee, and log_trial_offer operations
        /// for multiple scouts targeting the same player must never decrease the player's
        /// progress_level.
        #[test]
        fn prop_player_level_never_decreases(
            // (use_subscription, player_index)  player_index selects from a pool of 3
            ops in proptest::collection::vec(
                (any::<bool>(), 0usize..3),
                1..=20,
            ),
        ) {
            let env = Env::default();
            let (conn, reg, sub, _, token) = setup(&env);

            // Pool of 3 players.
            let player_ids: Vec<u64> = (0..3).map(|_| new_player(&env, &reg)).collect();
            let scout = Address::generate(&env);
            fund_scout(&env, &token, &scout);
            // duration_days * LEDGERS_PER_DAY must fit in a u32 — subscribe()
            // correctly rejects anything larger with Error::Overflow, so this
            // needs to stay well under u32::MAX / LEDGERS_PER_DAY (~248 000).
            sub.subscribe(&scout, &1u32, &100_000u32);

            let mut min_levels = vec![0u32; 3];

            for (use_subscription, pidx) in &ops {
                let player_id = player_ids[*pidx];
                let before = reg.get_player(&player_id).progress_level;

                if *use_subscription {
                    let result = conn.try_log_trial_offer(
                        &scout, &player_id, &offer_uri(&env),
                    );
                    let after = reg.get_player(&player_id).progress_level;

                    if result.is_ok() {
                        min_levels[*pidx] = min_levels[*pidx].max(3);
                    }
                    prop_assert!(
                        after >= before,
                        "player {} level decreased from {} to {}",
                        player_id, before, after
                    );
                } else {
                    // Just pay the contact fee — does not change progress level.
                    sub.pay_to_contact(&scout, &player_id);
                    let after = reg.get_player(&player_id).progress_level;
                    prop_assert_eq!(
                        after, before,
                        "pay_to_contact must not change player progress_level"
                    );
                }
            }

            // Final check: every player's level must be ≥ its tracked minimum.
            for (i, &pid) in player_ids.iter().enumerate() {
                let level = reg.get_player(&pid).progress_level;
                prop_assert!(
                    level >= min_levels[i],
                    "player {} final level {} is below tracked minimum {}",
                    pid, level, min_levels[i]
                );
            }
        }
    }
}
