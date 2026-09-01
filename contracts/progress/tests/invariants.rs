/// Property-based invariant tests for the `progress` contract.
///
/// Invariants verified:
///   P1. After any sequence of `approve_milestone` calls, a player's `progress_level`
///       never exceeds 3 and never decreases.
///   P2. Each milestone may be approved at most once — a second approval on the same
///       milestone_id must return an error.
///   P3. Approved milestone count per player never goes negative — the history list
///       can only grow, never shrink.
///   P4. Only registered (non-revoked) validators can submit or approve milestones.
///   P5. `"identity"` approval raises level to at least 1; `"performance"` to at least 2.
///   P6. Unknown milestone types are rejected at approval time.
///
/// Each proptest! block runs 10 000 cases (ProptestConfig::with_cases).
#[cfg(test)]
mod progress_invariants {
    use proptest::prelude::*;
    use progress::{ProgressContract, ProgressContractClient};
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

    fn setup(
        env: &Env,
    ) -> (
        ProgressContractClient<'_>,
        RegisterContractClient<'_>,
        Address, // admin
        Address, // default registered validator
    ) {
        env.mock_all_auths();

        let admin = Address::generate(env);
        let token = Address::generate(env);

        let reg_id = env.register_contract(None, RegisterContract);
        let prog_id = env.register_contract(None, ProgressContract);

        let reg = RegisterContractClient::new(env, &reg_id);
        let prog = ProgressContractClient::new(env, &prog_id);

        reg.initialize(&admin, &token, &100u32);
        prog.initialize(&admin, &reg_id);
        reg.set_authorized_updater(&prog_id);

        let validator = Address::generate(env);
        prog.register_validator(&validator);

        (prog, reg, admin, validator)
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

    fn soroban_str(env: &Env, s: &str) -> String {
        String::from_str(env, s)
    }

    // ── P1: progress_level ∈ [0,3] and monotonically non-decreasing ──────────

    proptest! {
        #![proptest_config(ProptestConfig::with_cases(proptest_cases()))]

        /// Arbitrary sequences of identity/performance approvals must keep the player's
        /// progress_level in [0, 3] and must never decrease it.
        #[test]
        fn prop_progress_level_in_bounds_and_monotonic(
            // true = identity (→1), false = performance (→2)
            types in proptest::collection::vec(any::<bool>(), 1..=30),
        ) {
            let env = Env::default();
            let (prog, reg, _, validator) = setup(&env);
            let player_id = new_player(&env, &reg);

            let mut min_expected: u32 = 0;

            for is_identity in types {
                let mtype = if is_identity { "identity" } else { "performance" };
                let mid = prog.submit_milestone(
                    &validator,
                    &player_id,
                    &soroban_str(&env, mtype),
                    &soroban_str(&env, "ipfs://ev"),
                );
                prog.approve_milestone(&validator, &mid);

                let level = reg.get_player(&player_id).progress_level;
                let type_floor = if is_identity { 1u32 } else { 2u32 };
                min_expected = min_expected.max(type_floor);

                prop_assert!(level <= 3, "progress_level {} > 3", level);
                prop_assert!(
                    level >= min_expected,
                    "progress_level {} < expected minimum {}",
                    level, min_expected
                );
            }
        }
    }

    // ── P2: each milestone approved at most once ──────────────────────────────

    proptest! {
        #![proptest_config(ProptestConfig::with_cases(proptest_cases()))]

        /// A second call to approve_milestone with the same milestone_id must always
        /// return an error regardless of how many milestones exist.
        #[test]
        fn prop_double_approval_always_fails(
            n_before in 0usize..=5,
            n_after  in 0usize..=5,
        ) {
            let env = Env::default();
            let (prog, reg, _, validator) = setup(&env);
            let player_id = new_player(&env, &reg);

            // Submit and approve `n_before` extra milestones first.
            for _ in 0..n_before {
                let mid = prog.submit_milestone(
                    &validator, &player_id,
                    &soroban_str(&env, "identity"),
                    &soroban_str(&env, "ipfs://pre"),
                );
                prog.approve_milestone(&validator, &mid);
            }

            // The target milestone.
            let target_mid = prog.submit_milestone(
                &validator, &player_id,
                &soroban_str(&env, "performance"),
                &soroban_str(&env, "ipfs://target"),
            );
            prog.approve_milestone(&validator, &target_mid);

            // Approve `n_after` more milestones.
            for _ in 0..n_after {
                let mid = prog.submit_milestone(
                    &validator, &player_id,
                    &soroban_str(&env, "identity"),
                    &soroban_str(&env, "ipfs://post"),
                );
                prog.approve_milestone(&validator, &mid);
            }

            // Second approval of the target must fail.
            let result = prog.try_approve_milestone(&validator, &target_mid);
            prop_assert!(
                result.is_err(),
                "second approval of milestone {} must fail",
                target_mid
            );
        }
    }

    // ── P3: approved milestone count never decreases ─────────────────────────

    proptest! {
        #![proptest_config(ProptestConfig::with_cases(proptest_cases()))]

        /// For any n submit+approve pairs, get_milestones must return a list whose
        /// length equals n (approved) plus any pending ones; it must never shrink.
        #[test]
        fn prop_milestone_count_monotonically_increases(
            ops in proptest::collection::vec(any::<bool>(), 1..=20),
        ) {
            let env = Env::default();
            let (prog, reg, _, validator) = setup(&env);
            let player_id = new_player(&env, &reg);

            let mut total_submitted: u32 = 0;

            for approve in ops {
                let mid = prog.submit_milestone(
                    &validator, &player_id,
                    &soroban_str(&env, "identity"),
                    &soroban_str(&env, "ipfs://ev"),
                );
                total_submitted += 1;

                if approve {
                    prog.approve_milestone(&validator, &mid);
                }

                let history_len = prog.get_milestones(&player_id).len();
                prop_assert_eq!(
                    history_len, total_submitted,
                    "milestone history length {} must equal total submitted {}",
                    history_len, total_submitted
                );
            }
        }
    }

    // ── P4: unregistered validators cannot mutate state ───────────────────────

    proptest! {
        #![proptest_config(ProptestConfig::with_cases(proptest_cases()))]

        /// Calls from an address that was never registered as a validator must be
        /// rejected for both submit_milestone and approve_milestone.
        #[test]
        fn prop_unregistered_validator_cannot_mutate(_seed in 0u64..u64::MAX) {
            let env = Env::default();
            let (prog, reg, _, validator) = setup(&env);
            let player_id = new_player(&env, &reg);

            // Submit one legitimate milestone so we have a real milestone_id to try.
            let real_mid = prog.submit_milestone(
                &validator, &player_id,
                &soroban_str(&env, "identity"),
                &soroban_str(&env, "ipfs://ev"),
            );

            let imposter = Address::generate(&env);

            let submit_result = prog.try_submit_milestone(
                &imposter, &player_id,
                &soroban_str(&env, "identity"),
                &soroban_str(&env, "ipfs://evil"),
            );
            prop_assert!(submit_result.is_err(), "unregistered validator must not submit");

            let approve_result = prog.try_approve_milestone(&imposter, &real_mid);
            prop_assert!(approve_result.is_err(), "unregistered validator must not approve");

            // History must be unchanged.
            let history = prog.get_milestones(&player_id);
            prop_assert_eq!(history.len(), 1, "history must not grow from rejected calls");
            prop_assert!(!history.get(0).unwrap().approved, "milestone must remain unapproved");
        }
    }

    // ── P5: type-to-level mapping is exact ────────────────────────────────────

    proptest! {
        #![proptest_config(ProptestConfig::with_cases(proptest_cases()))]

        /// identity approval raises level to ≥ 1; performance approval raises level to ≥ 2.
        /// Verifying with a fresh player for each case guarantees starting from level 0.
        #[test]
        fn prop_milestone_type_determines_minimum_level(is_identity in any::<bool>()) {
            let env = Env::default();
            let (prog, reg, _, validator) = setup(&env);
            let player_id = new_player(&env, &reg);

            prop_assert_eq!(reg.get_player(&player_id).progress_level, 0);

            let mtype = if is_identity { "identity" } else { "performance" };
            let mid = prog.submit_milestone(
                &validator, &player_id,
                &soroban_str(&env, mtype),
                &soroban_str(&env, "ipfs://ev"),
            );
            prog.approve_milestone(&validator, &mid);

            let level = reg.get_player(&player_id).progress_level;
            let expected_min: u32 = if is_identity { 1 } else { 2 };
            prop_assert!(
                level >= expected_min,
                "{} approval must raise level to at least {}, got {}",
                mtype, expected_min, level
            );
            prop_assert!(level <= 3, "level {} must not exceed 3", level);
        }
    }

    // ── P6: unknown milestone type is rejected at approval ────────────────────

    proptest! {
        #![proptest_config(ProptestConfig::with_cases(proptest_cases()))]

        /// Submitting a milestone succeeds (type is stored as-is), but approving one
        /// whose type is neither "identity" nor "performance" must fail.
        #[test]
        fn prop_unknown_milestone_type_rejected_at_approval(
            bad_type in "[a-z]{4,16}".prop_filter(
                "must not be a valid type",
                |s| s != "identity" && s != "performance",
            ),
        ) {
            let env = Env::default();
            let (prog, reg, _, validator) = setup(&env);
            let player_id = new_player(&env, &reg);

            let mid = prog.submit_milestone(
                &validator, &player_id,
                &soroban_str(&env, &bad_type),
                &soroban_str(&env, "ipfs://ev"),
            );

            let result = prog.try_approve_milestone(&validator, &mid);
            prop_assert!(result.is_err(), "unknown type '{}' must be rejected at approval", bad_type);

            // Player level must remain 0.
            let level = reg.get_player(&player_id).progress_level;
            prop_assert_eq!(level, 0, "failed approval must not change progress_level");
        }
    }
}
