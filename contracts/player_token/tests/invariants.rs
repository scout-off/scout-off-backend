/// Property-based invariant tests for the `player_token` contract.
///
/// Invariants verified:
///   T1. `issue_tokens` with `total_supply = 0` always returns an error.
///   T2. After any sequence of `buy_token` calls, `sold ≤ total_supply`.
///   T3. The sum of all holder balances always equals `meta.sold`.
///   T4. `distribute_fee` computes correct pro-rata shares for 3 holders with
///       u128::MAX-range fee amounts — total payouts must never exceed the fee.
///   T5. Fee distribution rounding: for any (n_holders, fee) the sum of floor
///       shares is always ≤ fee (no rounding up beyond the available amount).
///   T6. A buyer's balance is monotonically non-decreasing across successive purchases.
///   T7. `get_balance` returns 0 for an address that has never purchased.
///   T8. Paging: `distribute_fee` with `page` beyond the holder count returns 0.
///
/// Each proptest! block runs 10 000 cases.
#[cfg(test)]
mod player_token_invariants {
    use proptest::prelude::*;
    use player_token::{PlayerTokenContract, PlayerTokenContractClient};
    use soroban_sdk::{testutils::Address as _, Address, Env};

    // ── helpers ───────────────────────────────────────────────────────────────

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

    fn setup(env: &Env) -> (PlayerTokenContractClient<'_>, Address) {
        env.mock_all_auths();
        let id = env.register_contract(None, PlayerTokenContract);
        let client = PlayerTokenContractClient::new(env, &id);
        let admin = Address::generate(env);
        client.initialize(&admin);
        (client, admin)
    }

    // ── T1: zero total_supply is always rejected ──────────────────────────────

    proptest! {
        #![proptest_config(ProptestConfig::with_cases(proptest_cases()))]

        #[test]
        fn prop_issue_tokens_zero_supply_always_fails(player_id in 1u64..=1_000u64) {
            let env = Env::default();
            let (client, _) = setup(&env);
            let result = client.try_issue_tokens(&player_id, &0u64);
            prop_assert!(result.is_err(), "issue_tokens(supply=0) must fail");
        }
    }

    // ── T2: sold never exceeds total_supply ───────────────────────────────────

    proptest! {
        #![proptest_config(ProptestConfig::with_cases(proptest_cases()))]

        /// For any sequence of buy_token calls, meta.sold must always be ≤ total_supply.
        #[test]
        fn prop_sold_never_exceeds_total_supply(
            total_supply in 1u64..=1_000u64,
            purchases in proptest::collection::vec(1u64..=100u64, 1..=20),
        ) {
            let env = Env::default();
            let (client, _) = setup(&env);
            let player_id = 1u64;
            client.issue_tokens(&player_id, &total_supply);

            for amount in purchases {
                let buyer = Address::generate(&env);
                let _ = client.try_buy_token(&player_id, &amount, &buyer);

                let meta = client.get_token_meta(&player_id);
                prop_assert!(
                    meta.sold <= meta.total_supply,
                    "sold {} exceeds total_supply {}",
                    meta.sold, meta.total_supply
                );
            }
        }
    }

    // ── T3: sum of balances equals meta.sold ──────────────────────────────────

    proptest! {
        #![proptest_config(ProptestConfig::with_cases(proptest_cases()))]

        /// After n distinct buyers each purchase exactly `amount` tokens, the sum of all
        /// their balances must equal meta.sold.
        #[test]
        fn prop_sum_of_balances_equals_sold(
            n      in 1usize..=10,
            amount in 1u64..=50u64,
        ) {
            let env = Env::default();
            let (client, _) = setup(&env);
            let total_supply = (n as u64) * amount + 100; // generous headroom
            let player_id = 1u64;
            client.issue_tokens(&player_id, &total_supply);

            let mut buyers: Vec<Address> = Vec::new();
            for _ in 0..n {
                let buyer = Address::generate(&env);
                client.buy_token(&player_id, &amount, &buyer);
                buyers.push(buyer);
            }

            let balance_sum: u64 = buyers
                .iter()
                .map(|b| client.get_balance(&player_id, b))
                .sum();

            let meta = client.get_token_meta(&player_id);
            prop_assert_eq!(
                balance_sum, meta.sold,
                "sum of balances {} must equal meta.sold {}",
                balance_sum, meta.sold
            );
        }
    }

    // ── T4: distribute_fee total payouts never exceed the fee (u128::MAX range) ─

    proptest! {
        #![proptest_config(ProptestConfig::with_cases(proptest_cases()))]

        /// For any transfer_fee_xlm in [1, u128::MAX/100], total holder payouts ≤ fee.
        /// Uses 3 holders with proportions 50/30/20 to match the unit test scenario.
        #[test]
        fn prop_distribute_fee_total_never_exceeds_fee(
            fee in 1u128..=(u128::MAX / 100),
        ) {
            let env = Env::default();
            let (client, _) = setup(&env);

            let b1 = Address::generate(&env);
            let b2 = Address::generate(&env);
            let b3 = Address::generate(&env);

            client.issue_tokens(&1u64, &100u64);
            client.buy_token(&1u64, &50u64, &b1);
            client.buy_token(&1u64, &30u64, &b2);
            client.buy_token(&1u64, &20u64, &b3);

            let queued = client.distribute_fee(&1u64, &fee, &1u128, &0u32);
            prop_assert_eq!(queued, 3);

            let payouts = client.get_pending_payouts(&1u64, &0u32);
            let total: u128 = payouts.iter().map(|p| p.amount_stroops).sum();
            prop_assert!(
                total <= fee,
                "total payouts {} must not exceed fee {}",
                total, fee
            );
        }
    }

    // ── T5: rounding — floor shares never overshoot the available fee ─────────

    proptest! {
        #![proptest_config(ProptestConfig::with_cases(proptest_cases()))]

        /// For any number of equal-share holders (1–20) and any fee amount, the sum
        /// of integer floor shares must be ≤ fee.
        #[test]
        fn prop_floor_shares_never_exceed_fee(
            n_holders in 1usize..=20,
            fee       in 1u128..=1_000_000_000u128,
        ) {
            let env = Env::default();
            let (client, _) = setup(&env);
            let player_id = 42u64;
            let total_supply = (n_holders as u64) * 10 + 10;
            client.issue_tokens(&player_id, &total_supply);

            let mut buyers = Vec::new();
            for _ in 0..n_holders {
                let b = Address::generate(&env);
                client.buy_token(&player_id, &10u64, &b);
                buyers.push(b);
            }

            let queued = client.distribute_fee(&player_id, &fee, &1u128, &0u32);
            prop_assert!(queued as usize <= n_holders);

            let payouts = client.get_pending_payouts(&player_id, &0u32);
            let total: u128 = payouts.iter().map(|p| p.amount_stroops).sum();
            prop_assert!(
                total <= fee,
                "total payouts {} must not exceed fee {} for {} holders",
                total, fee, n_holders
            );
        }
    }

    // ── T6: buyer balance is monotonically non-decreasing ─────────────────────

    proptest! {
        #![proptest_config(ProptestConfig::with_cases(proptest_cases()))]

        /// Successive purchases by the same buyer must always increase or maintain
        /// (never decrease) their stored balance.
        #[test]
        fn prop_buyer_balance_monotonically_nondecreasing(
            amounts in proptest::collection::vec(1u64..=20u64, 1..=10),
        ) {
            let env = Env::default();
            let (client, _) = setup(&env);
            let total: u64 = amounts.iter().sum::<u64>() + 1;
            client.issue_tokens(&7u64, &total);

            let buyer = Address::generate(&env);
            let mut prev_balance: u64 = 0;

            for amount in amounts {
                client.buy_token(&7u64, &amount, &buyer);
                let new_balance = client.get_balance(&7u64, &buyer);
                prop_assert!(
                    new_balance >= prev_balance,
                    "balance decreased from {} to {} after buying {}",
                    prev_balance, new_balance, amount
                );
                prev_balance = new_balance;
            }
        }
    }

    // ── T7: unknown holder returns balance 0 ─────────────────────────────────

    proptest! {
        #![proptest_config(ProptestConfig::with_cases(proptest_cases()))]

        #[test]
        fn prop_unknown_holder_balance_is_zero(
            player_id in 1u64..=1_000u64,
        ) {
            let env = Env::default();
            let (client, _) = setup(&env);
            let stranger = Address::generate(&env);
            let balance = client.get_balance(&player_id, &stranger);
            prop_assert_eq!(balance, 0, "stranger balance must be 0");
        }
    }

    // ── T8: out-of-range page returns 0 queued ────────────────────────────────

    proptest! {
        #![proptest_config(ProptestConfig::with_cases(proptest_cases()))]

        /// Requesting a page whose start index exceeds holder count must return 0.
        #[test]
        fn prop_paging_beyond_holders_returns_zero(
            n_holders in 1usize..=5,
            page      in 10u32..=50u32, // well beyond MAX_HOLDERS_PER_PAGE boundary
        ) {
            let env = Env::default();
            let (client, _) = setup(&env);
            let player_id = 99u64;
            client.issue_tokens(&player_id, &((n_holders as u64) * 5 + 10));

            for _ in 0..n_holders {
                let b = Address::generate(&env);
                client.buy_token(&player_id, &5u64, &b);
            }

            let queued = client.distribute_fee(&player_id, &1_000u128, &1u128, &page);
            prop_assert_eq!(queued, 0, "page {} beyond holder count must return 0 queued", page);
        }
    }
}
