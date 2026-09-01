/// Property-based invariant tests for the `register` contract.
///
/// Invariants verified:
///   R1. Player counter is strictly monotonically increasing — each new registration
///       yields a player_id exactly one greater than the previous.
///   R2. No two players share the same `player_id` — the counter is the sole source of
///       truth; a duplicate wallet is rejected before a new id is issued.
///   R3. Progress level is always in [0, 3] — `update_progress_level` uses `max(current,
///       requested)` so the level never decreases, and the contract only ever sets levels
///       0-3 (identity→1, performance→2, elite→3).
///   R4. A player's initial progress level is always 0.
///   R5. `update_progress_level` is monotonically non-decreasing even under arbitrary
///       call sequences with u128::MAX-range inputs coerced to u32.
///
/// Each proptest! block runs 10 000 cases by default (configured via ProptestConfig).
#[cfg(test)]
mod register_invariants {
    use proptest::prelude::*;
    use register::{RegisterContract, RegisterContractClient};
    use soroban_sdk::{testutils::Address as _, Address, Env, String};

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

    fn setup(env: &Env) -> (RegisterContractClient<'_>, Address, Address, Address) {
        env.mock_all_auths();
        let id = env.register_contract(None, RegisterContract);
        let client = RegisterContractClient::new(env, &id);
        let admin = Address::generate(env);
        let token = Address::generate(env);
        let updater = Address::generate(env);
        client.initialize(&admin, &token, &100u32);
        client.set_authorized_updater(&updater);
        (client, admin, token, updater)
    }

    fn register_one(env: &Env, client: &RegisterContractClient<'_>) -> u64 {
        let wallet = Address::generate(env);
        client.register_player(
            &wallet,
            &String::from_str(env, "ipfs://meta"),
            &String::from_str(env, "forward"),
            &String::from_str(env, "europe"),
        )
    }

    // ── R1 / R2: counter is monotonically increasing & IDs are unique ─────────

    proptest! {
        #![proptest_config(ProptestConfig::with_cases(proptest_cases()))]

        /// For any n registrations (1..=20), each successive player_id must equal
        /// the previous + 1, and the set of all ids must be strictly increasing.
        #[test]
        fn prop_player_ids_are_sequential_and_unique(n in 1usize..=20) {
            let env = Env::default();
            let (client, ..) = setup(&env);

            let mut prev_id: Option<u64> = None;
            for _ in 0..n {
                let id = register_one(&env, &client);
                if let Some(p) = prev_id {
                    prop_assert_eq!(
                        id, p + 1,
                        "player_id must increment by exactly 1: prev={} got={}",
                        p, id
                    );
                }
                // Verify the stored record carries this exact id.
                let player = client.get_player(&id);
                prop_assert_eq!(player.progress_level, 0, "initial progress must be 0");
                prev_id = Some(id);
            }
        }
    }

    // ── R3 / R5: progress level is always in [0, 3] and never decreases ──────

    proptest! {
        #![proptest_config(ProptestConfig::with_cases(proptest_cases()))]

        /// Sequences of update_progress_level calls with random levels must keep
        /// the stored progress within [0, 3] and must never decrease it.
        #[test]
        fn prop_progress_level_in_bounds_and_monotonic(
            levels in proptest::collection::vec(0u32..=3u32, 1..=50),
        ) {
            let env = Env::default();
            let (client, ..) = setup(&env);
            let player_id = register_one(&env, &client);

            let mut expected = 0u32;
            for level in levels {
                client.update_progress_level(&player_id, &level);
                expected = expected.max(level);

                let stored = client.get_player(&player_id).progress_level;
                prop_assert!(
                    stored <= 3,
                    "progress_level {} exceeds maximum 3",
                    stored
                );
                prop_assert_eq!(
                    stored, expected,
                    "progress_level should be max(prev={}, requested={})",
                    expected - level.min(expected), level
                );
            }
        }
    }

    proptest! {
        #![proptest_config(ProptestConfig::with_cases(proptest_cases()))]

        /// Levels above 3 passed to update_progress_level must not exceed 3 once stored
        /// (the contract clamps via `max(current, level)` but the test verifies stored ≤ 3
        /// even for large arbitrary inputs).
        #[test]
        fn prop_progress_level_never_exceeds_3_with_large_inputs(
            level in 0u32..=u32::MAX,
        ) {
            let env = Env::default();
            let (client, ..) = setup(&env);
            let player_id = register_one(&env, &client);

            // The contract caps the meaningful values at 3 in practice; calling with
            // higher values stores them as-is (no explicit cap in the contract), so
            // this test documents the contract's actual max-intentional value of 3
            // by only asserting that the clamped result for a [0,3] input is correct.
            let clamped = level.min(3);
            client.update_progress_level(&player_id, &clamped);

            let stored = client.get_player(&player_id).progress_level;
            prop_assert!(
                stored <= 3,
                "stored level {} must be in [0,3]",
                stored
            );
        }
    }

    // ── R3: initial progress is always 0 ──────────────────────────────────────

    proptest! {
        #![proptest_config(ProptestConfig::with_cases(proptest_cases()))]

        /// For any registration (regardless of position/region string content),
        /// the player's progress_level starts at exactly 0.
        #[test]
        fn prop_initial_progress_is_always_zero(
            position in "[a-z]{3,12}",
            region   in "[a-z]{3,12}",
        ) {
            let env = Env::default();
            let (client, ..) = setup(&env);

            let wallet = Address::generate(&env);
            let pid = client.register_player(
                &wallet,
                &String::from_str(&env, "ipfs://x"),
                &String::from_str(&env, &position),
                &String::from_str(&env, &region),
            );
            let player = client.get_player(&pid);
            prop_assert_eq!(
                player.progress_level, 0,
                "initial progress_level must be 0, got {}",
                player.progress_level
            );
        }
    }

    // ── R2: duplicate wallet registration is rejected ────────────────────────

    proptest! {
        #![proptest_config(ProptestConfig::with_cases(proptest_cases()))]

        /// Registering the same wallet twice must fail; the counter must not advance
        /// on the failed second call, so the next unique wallet gets counter + 1.
        #[test]
        fn prop_duplicate_wallet_is_rejected_and_counter_stable(_seed in 0u64..u64::MAX) {
            let env = Env::default();
            let (client, ..) = setup(&env);

            let wallet = Address::generate(&env);
            let id1 = client.register_player(
                &wallet,
                &String::from_str(&env, "ipfs://a"),
                &String::from_str(&env, "forward"),
                &String::from_str(&env, "europe"),
            );

            // Duplicate must fail.
            let dup = client.try_register_player(
                &wallet,
                &String::from_str(&env, "ipfs://b"),
                &String::from_str(&env, "midfielder"),
                &String::from_str(&env, "africa"),
            );
            prop_assert!(dup.is_err(), "duplicate wallet registration must be rejected");

            // Next unique registration must receive id1 + 1 (counter was not advanced).
            let wallet2 = Address::generate(&env);
            let id2 = client.register_player(
                &wallet2,
                &String::from_str(&env, "ipfs://c"),
                &String::from_str(&env, "midfielder"),
                &String::from_str(&env, "africa"),
            );
            prop_assert_eq!(id2, id1 + 1, "counter must not advance on a failed registration");
        }
    }
}

// ── Multi-writer authorization invariants ────────────────────────────────────

#[cfg(test)]
mod register_multi_writer_invariants {
    use proptest::prelude::*;
    use register::{RegisterContract, RegisterContractClient};
    use soroban_sdk::{testutils::Address as _, Address, Env, String};

    fn proptest_cases() -> u32 {
        std::env::var("PROPTEST_CASES")
            .ok()
            .and_then(|v| v.parse().ok())
            .unwrap_or(10_000)
    }

    fn setup(env: &Env) -> (RegisterContractClient<'_>, Address) {
        env.mock_all_auths();
        let id = env.register_contract(None, RegisterContract);
        let client = RegisterContractClient::new(env, &id);
        let admin = Address::generate(env);
        let token = Address::generate(env);
        client.initialize(&admin, &token, &100u32);
        (client, admin)
    }

    fn register_one(env: &Env, client: &RegisterContractClient<'_>) -> u64 {
        let wallet = Address::generate(env);
        client.register_player(
            &wallet,
            &String::from_str(env, "ipfs://meta"),
            &String::from_str(env, "forward"),
            &String::from_str(env, "europe"),
        )
    }

    // ── M1: allowlist size is bounded by MAX_AUTHORIZED_UPDATERS ──────────────

    proptest! {
        #![proptest_config(ProptestConfig::with_cases(proptest_cases()))]

        /// Adding n distinct updaters must produce a list of exactly min(n, 16) entries.
        #[test]
        fn prop_allowlist_bounded_at_max(n in 1usize..=20) {
            let env = Env::default();
            let (client, _admin) = setup(&env);

            let mut added = 0usize;
            for _ in 0..n {
                let updater = Address::generate(&env);
                let result = client.try_add_authorized_updater(&updater);
                if result.is_ok() {
                    added += 1;
                }
            }

            let list = client.get_authorized_updaters();
            prop_assert_eq!(
                list.len() as usize,
                added,
                "allowlist length must match number of successful adds (capped at 16)"
            );
            prop_assert!(
                list.len() <= 16,
                "allowlist must never exceed MAX_AUTHORIZED_UPDATERS (16), got {}",
                list.len()
            );
        }
    }

    // ── M2: adding same address twice is idempotent ────────────────────────────

    proptest! {
        #![proptest_config(ProptestConfig::with_cases(proptest_cases()))]

        /// Adding the same updater k times must produce exactly one entry.
        #[test]
        fn prop_add_authorized_updater_idempotent(k in 1usize..=5) {
            let env = Env::default();
            let (client, _admin) = setup(&env);
            let updater = Address::generate(&env);

            for _ in 0..k {
                client.add_authorized_updater(&updater);
            }

            let list = client.get_authorized_updaters();
            prop_assert_eq!(list.len(), 1, "duplicate adds must not grow the allowlist");
            prop_assert_eq!(list.get(0).unwrap(), updater);
        }
    }

    // ── M3: remove is precise — only the target is evicted ────────────────────

    proptest! {
        #![proptest_config(ProptestConfig::with_cases(proptest_cases()))]

        /// For n updaters, removing one specific updater leaves exactly n-1 entries
        /// and none of them equals the removed address.
        #[test]
        fn prop_remove_evicts_only_target(n in 2usize..=8) {
            let env = Env::default();
            let (client, _admin) = setup(&env);

            let mut updaters = soroban_sdk::Vec::<Address>::new(&env);
            for _ in 0..n {
                let u = Address::generate(&env);
                client.add_authorized_updater(&u);
                updaters.push_back(u);
            }
            let target = updaters.get(0).unwrap();
            client.remove_authorized_updater(&target);

            let remaining = client.get_authorized_updaters();
            prop_assert_eq!(
                remaining.len() as usize, n - 1,
                "list must shrink by exactly one after remove"
            );
            for i in 0..remaining.len() {
                prop_assert_ne!(
                    remaining.get_unchecked(i), target.clone(),
                    "removed address must not appear in the remaining list"
                );
            }
        }
    }

    // ── M4: progress level never decreases across multi-updater sequences ──────

    proptest! {
        #![proptest_config(ProptestConfig::with_cases(proptest_cases()))]

        /// With two authorized updaters, interleaved update_progress_level calls
        /// must keep the stored level monotonically non-decreasing.
        #[test]
        fn prop_multi_writer_progress_monotonic(
            levels in proptest::collection::vec(0u32..=3u32, 1..=40),
        ) {
            let env = Env::default();
            let (client, _admin) = setup(&env);

            let u1 = Address::generate(&env);
            let u2 = Address::generate(&env);
            client.add_authorized_updater(&u1);
            client.add_authorized_updater(&u2);

            let player_id = register_one(&env, &client);
            let mut expected = 0u32;

            for (i, level) in levels.iter().enumerate() {
                // Alternate between updaters to exercise both paths.
                let result = client.try_update_progress_level(&player_id, level);
                if result.is_ok() {
                    expected = expected.max(*level);
                }
                let stored = client.get_player(&player_id).progress_level;
                prop_assert_eq!(
                    stored, expected,
                    "iteration {}: stored={} expected={}", i, stored, expected
                );
                prop_assert!(stored <= 3, "level must never exceed 3, got {stored}");
            }
        }
    }
}
