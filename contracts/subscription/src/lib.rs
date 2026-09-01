#![no_std]

use soroban_sdk::{
    contract, contractimpl, contracttype, Address, Env, Symbol,
    token::Client as TokenClient,
};
use scout_off_shared::{
    errors::Error,
    events::{emit_contact_unlocked, emit_scout_subscribed},
    storage::{bump_instance, is_initialized, is_paused, set_initialized},
};

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/// Approximate number of Soroban ledgers per day (5-second close time).
const LEDGERS_PER_DAY: u32 = 17_280;

/// Base fee in stroops (1 XLM = 10_000_000 stroops). 0.1 XLM baseline.
const BASE_FEE_STROOPS: i128 = 1_000_000;

/// Fee multiplier for premium tier (tier 2) relative to basic (tier 1).
const PREMIUM_TIER_MULTIPLIER: i128 = 2;

// ---------------------------------------------------------------------------
// Data types
// ---------------------------------------------------------------------------

#[contracttype]
#[derive(Clone)]
pub struct SubscriptionRecord {
    pub tier: u32,
    pub expires_at: u32,
    pub tx_hash: u64, // Using u64 as a ledger-sequence proxy for the "tx reference"
}

#[contracttype]
#[derive(Clone)]
pub enum DataKey {
    Admin,
    Token,
    PlatformFeeBps,
    PlatformFeeBalance,
    Subscription(Address),
    ContactFee(Address, u64),
}

// ---------------------------------------------------------------------------
// Contract
// ---------------------------------------------------------------------------

#[contract]
pub struct SubscriptionContract;

#[contractimpl]
impl SubscriptionContract {
    /// One-time contract setup. Stores the admin, payment token, and platform fee config.
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
        env.storage()
            .instance()
            .set(&DataKey::PlatformFeeBalance, &0i128);
        set_initialized(&env);
        bump_instance(&env);
        Ok(())
    }

    /// Calculate the subscription fee in stroops.
    ///
    /// fee = BASE_FEE * tier_multiplier * duration_days
    /// Uses checked arithmetic to prevent overflow (Error::Overflow on failure).
    fn calculate_subscription_fee(tier: u32, duration_days: u32) -> Result<i128, Error> {
        let tier_multiplier: i128 = if tier <= 1 { 1 } else { PREMIUM_TIER_MULTIPLIER };
        let duration = duration_days as i128;

        BASE_FEE_STROOPS
            .checked_mul(tier_multiplier)
            .and_then(|v| v.checked_mul(duration))
            .ok_or(Error::Overflow)
    }

    /// Calculate the contact fee in stroops using PLATFORM_FEE_BPS.
    ///
    /// contact_fee = BASE_FEE * platform_fee_bps / 10_000
    fn calculate_contact_fee(env: &Env) -> Result<i128, Error> {
        let fee_bps: u32 = env
            .storage()
            .instance()
            .get(&DataKey::PlatformFeeBps)
            .unwrap_or(500);

        BASE_FEE_STROOPS
            .checked_mul(fee_bps as i128)
            .and_then(|v| v.checked_div(10_000))
            .ok_or(Error::Overflow)
    }

    /// Purchase or renew a scout subscription.
    ///
    /// Calculates fee = BASE_FEE * tier_multiplier * duration_days, transfers XLM from
    /// scout to this contract via the token interface, stores expires_at as
    /// current_ledger + duration * LEDGERS_PER_DAY, and emits scout_subscribed.
    ///
    /// Returns the expiry ledger sequence on success.
    pub fn subscribe(
        env: Env,
        scout: Address,
        tier: u32,
        duration_days: u32,
    ) -> Result<u32, Error> {
        if !is_initialized(&env) {
            return Err(Error::NotInitialized);
        }
        if is_paused(&env) {
            return Err(Error::ContractPaused);
        }
        scout.require_auth();

        let fee = Self::calculate_subscription_fee(tier, duration_days)?;
        if fee <= 0 {
            return Err(Error::InsufficientFee);
        }

        // Transfer fee from scout to this contract.
        let token_addr: Address = env
            .storage()
            .instance()
            .get(&DataKey::Token)
            .ok_or(Error::NotInitialized)?;
        let token = TokenClient::new(&env, &token_addr);
        token.transfer(&scout, &env.current_contract_address(), &fee);

        // Accumulate platform fee balance.
        let current_balance: i128 = env
            .storage()
            .instance()
            .get(&DataKey::PlatformFeeBalance)
            .unwrap_or(0);
        let new_balance = current_balance.checked_add(fee).ok_or(Error::Overflow)?;
        env.storage()
            .instance()
            .set(&DataKey::PlatformFeeBalance, &new_balance);

        // Store subscription record.
        let duration_ledgers = duration_days
            .checked_mul(LEDGERS_PER_DAY)
            .ok_or(Error::Overflow)?;
        let expires_at = env
            .ledger()
            .sequence()
            .checked_add(duration_ledgers)
            .ok_or(Error::Overflow)?;

        let record = SubscriptionRecord {
            tier,
            expires_at,
            tx_hash: env.ledger().sequence() as u64,
        };
        env.storage()
            .instance()
            .set(&DataKey::Subscription(scout.clone()), &record);

        bump_instance(&env);
        emit_scout_subscribed(&env, &scout, tier, duration_ledgers, expires_at);
        Ok(expires_at)
    }

    /// Return true if the scout has an active (non-expired) subscription.
    pub fn is_subscribed(env: Env, scout: Address) -> bool {
        let record: SubscriptionRecord = match env
            .storage()
            .instance()
            .get(&DataKey::Subscription(scout))
        {
            Some(r) => r,
            None => return false,
        };
        env.ledger().sequence() < record.expires_at
    }

    /// Pay per-player contact fee and unlock direct contact with a specific player.
    ///
    /// Verifies no existing contact record exists for (scout, player_id), transfers
    /// contact_fee_xlm from scout to platform, stores the ContactFee flag, and
    /// emits contact_unlocked.
    pub fn pay_to_contact(env: Env, scout: Address, player_id: u64) -> Result<(), Error> {
        if !is_initialized(&env) {
            return Err(Error::NotInitialized);
        }
        if is_paused(&env) {
            return Err(Error::ContractPaused);
        }
        scout.require_auth();

        // Idempotency: if already unlocked, return early without charging again.
        let contact_key = DataKey::ContactFee(scout.clone(), player_id);
        if env.storage().instance().has(&contact_key) {
            bump_instance(&env);
            return Ok(());
        }

        // Calculate and transfer contact fee.
        let fee = Self::calculate_contact_fee(&env)?;
        if fee > 0 {
            let token_addr: Address = env
                .storage()
                .instance()
                .get(&DataKey::Token)
                .ok_or(Error::NotInitialized)?;
            let token = TokenClient::new(&env, &token_addr);
            token.transfer(&scout, &env.current_contract_address(), &fee);

            // Accumulate platform fee balance.
            let current_balance: i128 = env
                .storage()
                .instance()
                .get(&DataKey::PlatformFeeBalance)
                .unwrap_or(0);
            let new_balance = current_balance.checked_add(fee).ok_or(Error::Overflow)?;
            env.storage()
                .instance()
                .set(&DataKey::PlatformFeeBalance, &new_balance);
        }

        env.storage().instance().set(&contact_key, &true);
        bump_instance(&env);
        emit_contact_unlocked(&env, &scout, player_id);
        Ok(())
    }

    /// Return true if the scout has paid the contact fee for the given player.
    pub fn has_paid_contact(env: Env, scout: Address, player_id: u64) -> bool {
        env.storage()
            .instance()
            .has(&DataKey::ContactFee(scout, player_id))
    }

    /// Return the current contact fee in stroops, calculated from PLATFORM_FEE_BPS.
    pub fn get_contact_fee(env: Env) -> Result<i128, Error> {
        if !is_initialized(&env) {
            return Err(Error::NotInitialized);
        }
        Self::calculate_contact_fee(&env)
    }

    /// Return the accumulated platform fee balance in stroops.
    ///
    /// View-only (no auth required). Returns 0 when no fees have accrued.
    /// The backend reads this via `get_fee_balance()` before proposing a
    /// withdrawal so it can reject over-balance requests client-side too.
    pub fn get_fee_balance(env: Env) -> i128 {
        env.storage()
            .instance()
            .get(&DataKey::PlatformFeeBalance)
            .unwrap_or(0)
    }

    /// Withdraw accumulated platform fees to the admin address.
    ///
    /// Requires admin auth. Transfers exactly `amount` stroops from this
    /// contract to the admin, decrements the stored balance by that amount,
    /// and emits fees_withdrawn with the actually-withdrawn amount (the
    /// return value), so a caller-specified partial withdrawal is enforced
    /// on-chain rather than silently draining the whole vault.
    ///
    /// Rejects with Error::InvalidInput when `amount <= 0` and with
    /// Error::InsufficientFee when `amount` exceeds the available balance —
    /// this balance check is authoritative: the backend re-checks it via
    /// get_fee_balance() before submitting, but the contract is the final
    /// guard against withdrawing more than it holds.
    pub fn withdraw_fees(env: Env, admin: Address, amount: i128) -> Result<i128, Error> {
        if !is_initialized(&env) {
            return Err(Error::NotInitialized);
        }
        if is_paused(&env) {
            return Err(Error::ContractPaused);
        }

        if amount <= 0 {
            return Err(Error::InvalidInput);
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

        let balance: i128 = env
            .storage()
            .instance()
            .get(&DataKey::PlatformFeeBalance)
            .unwrap_or(0);

        if amount > balance {
            return Err(Error::InsufficientFee);
        }

        let token_addr: Address = env
            .storage()
            .instance()
            .get(&DataKey::Token)
            .ok_or(Error::NotInitialized)?;
        let token = TokenClient::new(&env, &token_addr);
        token.transfer(&env.current_contract_address(), &admin, &amount);

        let remaining = balance - amount;
        env.storage()
            .instance()
            .set(&DataKey::PlatformFeeBalance, &remaining);

        env.events().publish(
            (Symbol::new(&env, "fees_withdrawn"),),
            (admin.clone(), amount),
        );

        bump_instance(&env);
        Ok(amount)
    }

    /// Update the platform fee in basis points. Only the admin may call this.
    pub fn set_platform_fee_bps(env: Env, admin: Address, platform_fee_bps: u32) -> Result<(), Error> {
        if !is_initialized(&env) {
            return Err(Error::NotInitialized);
        }
        let stored_admin: Address = env.storage().instance().get(&DataKey::Admin).unwrap();
        admin.require_auth();
        if admin != stored_admin {
            return Err(Error::Unauthorized);
        }
        env.storage()
            .instance()
            .set(&DataKey::PlatformFeeBps, &platform_fee_bps);
        bump_instance(&env);
        Ok(())
    }

    // ── Pause / Unpause ────────────────────────────────────────────────────

    /// Pause the contract, preventing all state-changing operations.
    ///
    /// Only the admin address set during [`initialize`] may call this function.
    /// The guard is already wired into [`subscribe`], [`pay_to_contact`], and
    /// [`withdraw_fees`] via [`is_paused`].  If the contract is already paused
    /// the call is a no-op (returns `Ok`).
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
        scout_off_shared::storage::set_paused(&env, true);
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
        scout_off_shared::storage::set_paused(&env, false);
        bump_instance(&env);
        Ok(())
    }

    // ── cancel_subscription ────────────────────────────────────────────────

    /// Cancel the caller's active subscription, marking it as immediately expired.
    ///
    /// Semantics:
    /// * The scout must have an active (non-expired) subscription; otherwise
    ///   [`Error::NotSubscribed`] (code 8) is returned.
    /// * No fee refund is issued — the scout forfeits the remaining subscription
    ///   period.  This matches the documented no-refund policy.
    /// * After cancellation [`is_subscribed`] returns `false` for this scout.
    ///
    /// The backend's `cancelSubscriptionOnChain` already maps error code 8 to
    /// `SubscriptionError('NOT_SUBSCRIBED')`, so no backend change is needed
    /// for the error path.
    ///
    /// # Errors
    /// * [`Error::NotInitialized`] — Contract has not been initialized.
    /// * [`Error::ContractPaused`] — Contract is paused.
    /// * [`Error::NotSubscribed`] — Scout has no active subscription or it has
    ///   already expired/been cancelled.
    pub fn cancel_subscription(env: Env, scout: Address) -> Result<(), Error> {
        if !is_initialized(&env) {
            return Err(Error::NotInitialized);
        }
        if is_paused(&env) {
            return Err(Error::ContractPaused);
        }
        scout.require_auth();

        let sub_key = DataKey::Subscription(scout.clone());
        let record: SubscriptionRecord = env
            .storage()
            .instance()
            .get(&sub_key)
            .ok_or(Error::NotSubscribed)?;

        // Reject if the subscription is already expired or previously cancelled
        // (expires_at == 0 is the sentinel we write below).
        if env.ledger().sequence() >= record.expires_at || record.expires_at == 0 {
            return Err(Error::NotSubscribed);
        }

        // Mark as cancelled by setting expires_at to the current ledger (= expired now).
        let cancelled = SubscriptionRecord {
            tier: record.tier,
            expires_at: env.ledger().sequence(),
            tx_hash: record.tx_hash,
        };
        env.storage().instance().set(&sub_key, &cancelled);

        env.events().publish(
            (Symbol::new(&env, "sub_cancelled"), scout.clone()),
            (record.tier,),
        );

        bump_instance(&env);
        Ok(())
    }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;
    use soroban_sdk::{
        testutils::{Address as _, Ledger},
        token::{Client as TokenClient, StellarAssetClient},
        Env,
    };

    /// Deploy a Stellar Asset Contract (native SAC) and mint tokens to `to`.
    fn create_token<'a>(env: &'a Env, admin: &Address) -> (TokenClient<'a>, Address) {
        let token_addr = env.register_stellar_asset_contract_v2(admin.clone()).address();
        let sac = StellarAssetClient::new(env, &token_addr);
        // Mint a large balance to the admin so scouts can be funded.
        sac.mint(admin, &1_000_000_000_000_000i128);
        (TokenClient::new(env, &token_addr), token_addr)
    }

    fn setup(env: &Env) -> (SubscriptionContractClient<'_>, Address, Address) {
        env.mock_all_auths();
        let id = env.register_contract(None, SubscriptionContract);
        let client = SubscriptionContractClient::new(env, &id);
        let admin = Address::generate(env);
        let (_token_client, token_addr) = create_token(env, &admin);
        // Fund a generic scout address so transfer calls don't fail balance checks.
        let sac = StellarAssetClient::new(env, &token_addr);
        // Pre-fund any address that will call subscribe — done per test where needed.
        drop(sac);
        (client, admin, token_addr)
    }

    /// Mint `amount` tokens to `to` from the SAC.
    fn fund(env: &Env, token_addr: &Address, _admin: &Address, to: &Address, amount: i128) {
        let sac = StellarAssetClient::new(env, token_addr);
        sac.mint(to, &amount);
    }

    #[test]
    fn subscribe_transfers_fee_and_marks_subscribed() {
        let env = Env::default();
        let (client, admin, token) = setup(&env);
        client.initialize(&admin, &token, &500u32);
        let scout = Address::generate(&env);
        fund(&env, &token, &admin, &scout, 1_000_000_000_000i128);
        let expiry = client.subscribe(&scout, &1u32, &30u32);
        assert!(expiry > env.ledger().sequence());
        assert!(client.is_subscribed(&scout));
    }

    #[test]
    fn subscribe_fails_when_not_initialized() {
        let env = Env::default();
        let (client, _admin, _token) = setup(&env);
        let scout = Address::generate(&env);
        let result = client.try_subscribe(&scout, &1u32, &30u32);
        assert!(result.is_err());
    }

    #[test]
    fn subscribe_fails_when_paused() {
        let env = Env::default();
        let (client, admin, token) = setup(&env);
        client.initialize(&admin, &token, &500u32);
        // Storage access is only permitted from within a contract's own
        // execution context — wrap the direct storage write accordingly.
        env.as_contract(&client.address, || {
            scout_off_shared::storage::set_paused(&env, true);
        });
        let scout = Address::generate(&env);
        fund(&env, &token, &admin, &scout, 1_000_000_000_000i128);
        let result = client.try_subscribe(&scout, &1u32, &10u32);
        assert!(result.is_err());
    }

    #[test]
    fn is_subscribed_false_before_any_subscription() {
        let env = Env::default();
        let (client, admin, token) = setup(&env);
        client.initialize(&admin, &token, &500u32);
        let scout = Address::generate(&env);
        assert!(!client.is_subscribed(&scout));
    }

    #[test]
    fn subscription_expires_after_duration_elapses() {
        let env = Env::default();
        let (client, admin, token) = setup(&env);
        client.initialize(&admin, &token, &500u32);
        let scout = Address::generate(&env);
        fund(&env, &token, &admin, &scout, 1_000_000_000_000i128);
        client.subscribe(&scout, &1u32, &1u32);
        assert!(client.is_subscribed(&scout));
        env.ledger().with_mut(|li| { li.sequence_number += LEDGERS_PER_DAY + 1; });
        assert!(!client.is_subscribed(&scout));
    }

    #[test]
    fn resubscribing_while_active_extends_expiry() {
        let env = Env::default();
        let (client, admin, token) = setup(&env);
        client.initialize(&admin, &token, &500u32);
        let scout = Address::generate(&env);
        fund(&env, &token, &admin, &scout, 1_000_000_000_000i128);
        client.subscribe(&scout, &1u32, &30u32);
        assert!(client.is_subscribed(&scout));
        client.subscribe(&scout, &1u32, &60u32);
        assert!(client.is_subscribed(&scout));
    }

    #[test]
    fn pay_to_contact_succeeds_and_is_recorded() {
        let env = Env::default();
        let (client, admin, token) = setup(&env);
        client.initialize(&admin, &token, &500u32);
        let scout = Address::generate(&env);
        fund(&env, &token, &admin, &scout, 1_000_000_000_000i128);
        let player_id = 42u64;
        assert!(!client.has_paid_contact(&scout, &player_id));
        client.pay_to_contact(&scout, &player_id);
        assert!(client.has_paid_contact(&scout, &player_id));
    }

    #[test]
    fn pay_to_contact_is_idempotent() {
        let env = Env::default();
        let (client, admin, token) = setup(&env);
        client.initialize(&admin, &token, &500u32);
        let scout = Address::generate(&env);
        fund(&env, &token, &admin, &scout, 1_000_000_000_000i128);
        let player_id = 7u64;
        client.pay_to_contact(&scout, &player_id);
        let result = client.try_pay_to_contact(&scout, &player_id);
        assert!(result.is_ok());
        assert!(client.has_paid_contact(&scout, &player_id));
    }

    #[test]
    fn pay_to_contact_fails_when_not_initialized() {
        let env = Env::default();
        let (client, _admin, _token) = setup(&env);
        let scout = Address::generate(&env);
        let result = client.try_pay_to_contact(&scout, &42u64);
        assert!(result.is_err());
    }

    #[test]
    fn get_contact_fee_returns_nonzero_after_init() {
        let env = Env::default();
        let (client, admin, token) = setup(&env);
        client.initialize(&admin, &token, &500u32);
        let fee = client.get_contact_fee();
        assert!(fee > 0);
    }

    #[test]
    fn withdraw_fees_succeeds_for_admin() {
        let env = Env::default();
        let (client, admin, token) = setup(&env);
        client.initialize(&admin, &token, &500u32);
        let scout = Address::generate(&env);
        fund(&env, &token, &admin, &scout, 1_000_000_000_000i128);
        client.subscribe(&scout, &1u32, &30u32);
        // fee = 1_000_000 × 1 × 30 = 30_000_000 stroops
        let withdrawn = client.withdraw_fees(&admin, &30_000_000i128);
        assert_eq!(withdrawn, 30_000_000);
        assert_eq!(client.get_fee_balance(), 0);
    }

    #[test]
    fn withdraw_fees_fails_for_non_admin() {
        let env = Env::default();
        let (client, admin, token) = setup(&env);
        client.initialize(&admin, &token, &500u32);
        let scout = Address::generate(&env);
        fund(&env, &token, &admin, &scout, 1_000_000_000_000i128);
        client.subscribe(&scout, &1u32, &30u32);
        let non_admin = Address::generate(&env);
        let result = client.try_withdraw_fees(&non_admin, &30_000_000i128);
        assert!(result.is_err());
    }

    #[test]
    fn withdraw_fees_partial_amount_withdraws_only_requested() {
        let env = Env::default();
        let (client, admin, token) = setup(&env);
        client.initialize(&admin, &token, &500u32);
        let scout = Address::generate(&env);
        fund(&env, &token, &admin, &scout, 1_000_000_000_000i128);
        client.subscribe(&scout, &1u32, &30u32);

        // Subscription fee: BASE_FEE_STROOPS (1_000_000) × tier-1 multiplier × 30 days.
        let total: i128 = 30_000_000;
        let partial: i128 = 10_000_000;

        let token_client = TokenClient::new(&env, &token);
        assert_eq!(token_client.balance(&client.address), total);

        // A partial withdrawal moves only the requested amount on-chain —
        // not the full balance.
        let withdrawn = client.withdraw_fees(&admin, &partial);
        assert_eq!(withdrawn, partial);
        assert_eq!(token_client.balance(&client.address), total - partial);
        assert_eq!(client.get_fee_balance(), total - partial);

        // The remainder can be withdrawn afterwards — the vault drains to zero.
        let withdrawn_rest = client.withdraw_fees(&admin, &(total - partial));
        assert_eq!(withdrawn_rest, total - partial);
        assert_eq!(client.get_fee_balance(), 0);
        assert_eq!(token_client.balance(&client.address), 0);
    }

    #[test]
    fn withdraw_fees_rejects_amount_exceeding_balance() {
        let env = Env::default();
        let (client, admin, token) = setup(&env);
        client.initialize(&admin, &token, &500u32);
        let scout = Address::generate(&env);
        fund(&env, &token, &admin, &scout, 1_000_000_000_000i128);
        client.subscribe(&scout, &1u32, &30u32);

        let result = client.try_withdraw_fees(&admin, &30_000_001i128);
        assert_eq!(result, Err(Ok(Error::InsufficientFee)));
        // The rejected call leaves the vault untouched.
        assert_eq!(client.get_fee_balance(), 30_000_000);
    }

    #[test]
    fn withdraw_fees_rejects_zero_and_negative_amounts() {
        let env = Env::default();
        let (client, admin, token) = setup(&env);
        client.initialize(&admin, &token, &500u32);

        assert!(client.try_withdraw_fees(&admin, &0i128).is_err());
        assert!(client.try_withdraw_fees(&admin, &-1i128).is_err());
    }

    #[test]
    fn get_fee_balance_tracks_accrued_fees() {
        let env = Env::default();
        let (client, admin, token) = setup(&env);
        client.initialize(&admin, &token, &500u32);
        assert_eq!(client.get_fee_balance(), 0);

        let scout = Address::generate(&env);
        fund(&env, &token, &admin, &scout, 1_000_000_000_000i128);
        client.subscribe(&scout, &1u32, &30u32);
        assert_eq!(client.get_fee_balance(), 30_000_000);
    }

    #[test]
    fn double_initialize_fails() {
        let env = Env::default();
        let (client, admin, token) = setup(&env);
        client.initialize(&admin, &token, &100);
        assert!(client.try_initialize(&admin, &token, &100).is_err());
    }

    #[test]
    fn set_platform_fee_bps_succeeds_for_admin() {
        let env = Env::default();
        let (client, admin, token) = setup(&env);
        client.initialize(&admin, &token, &100);
        client.set_platform_fee_bps(&admin, &250u32);
        let fee = client.get_contact_fee();
        assert!(fee > 0);
    }

    #[test]
    fn set_platform_fee_bps_fails_for_non_admin() {
        let env = Env::default();
        let (client, admin, token) = setup(&env);
        client.initialize(&admin, &token, &100);
        let not_admin = Address::generate(&env);
        let result = client.try_set_platform_fee_bps(&not_admin, &250u32);
        assert!(result.is_err());
    }

    // ── pause / unpause ──────────────────────────────────────────────────────

    #[test]
    fn pause_and_unpause_round_trip() {
        let env = Env::default();
        let (client, admin, token) = setup(&env);
        client.initialize(&admin, &token, &500u32);
        // Pause.
        assert!(client.try_pause(&admin).is_ok());
        // Operations should fail while paused.
        let scout = Address::generate(&env);
        fund(&env, &token, &admin, &scout, 1_000_000_000_000i128);
        assert!(client.try_subscribe(&scout, &1u32, &30u32).is_err());
        // Unpause.
        assert!(client.try_unpause(&admin).is_ok());
        // Operations should succeed again.
        assert!(client.try_subscribe(&scout, &1u32, &30u32).is_ok());
    }

    #[test]
    fn non_admin_cannot_pause() {
        let env = Env::default();
        let (client, admin, token) = setup(&env);
        client.initialize(&admin, &token, &500u32);
        let non_admin = Address::generate(&env);
        assert!(client.try_pause(&non_admin).is_err());
    }

    #[test]
    fn non_admin_cannot_unpause() {
        let env = Env::default();
        let (client, admin, token) = setup(&env);
        client.initialize(&admin, &token, &500u32);
        assert!(client.try_pause(&admin).is_ok());
        let non_admin = Address::generate(&env);
        assert!(client.try_unpause(&non_admin).is_err());
    }

    // ── cancel_subscription ──────────────────────────────────────────────────

    #[test]
    fn cancel_subscription_makes_scout_inactive() {
        let env = Env::default();
        let (client, admin, token) = setup(&env);
        client.initialize(&admin, &token, &500u32);
        let scout = Address::generate(&env);
        fund(&env, &token, &admin, &scout, 1_000_000_000_000i128);
        client.subscribe(&scout, &1u32, &30u32);
        assert!(client.is_subscribed(&scout));
        // Cancel.
        assert!(client.try_cancel_subscription(&scout).is_ok());
        assert!(!client.is_subscribed(&scout));
    }

    #[test]
    fn cancel_subscription_on_no_subscription_returns_not_subscribed() {
        let env = Env::default();
        let (client, admin, token) = setup(&env);
        client.initialize(&admin, &token, &500u32);
        let scout = Address::generate(&env);
        let result = client.try_cancel_subscription(&scout);
        assert!(result.is_err());
    }

    #[test]
    fn cancel_already_expired_subscription_returns_not_subscribed() {
        let env = Env::default();
        let (client, admin, token) = setup(&env);
        client.initialize(&admin, &token, &500u32);
        let scout = Address::generate(&env);
        fund(&env, &token, &admin, &scout, 1_000_000_000_000i128);
        client.subscribe(&scout, &1u32, &1u32);
        // Advance past expiry.
        env.ledger().with_mut(|li| { li.sequence_number += LEDGERS_PER_DAY + 10; });
        // Subscription is expired; cancel should return NotSubscribed.
        let result = client.try_cancel_subscription(&scout);
        assert!(result.is_err());
    }

    #[test]
    fn cancel_subscription_when_paused_returns_paused_error() {
        let env = Env::default();
        let (client, admin, token) = setup(&env);
        client.initialize(&admin, &token, &500u32);
        let scout = Address::generate(&env);
        fund(&env, &token, &admin, &scout, 1_000_000_000_000i128);
        client.subscribe(&scout, &1u32, &30u32);
        client.pause(&admin);
        let result = client.try_cancel_subscription(&scout);
        assert!(result.is_err());
    }

    // ── get_fee_balance ──────────────────────────────────────────────────────

    #[test]
    fn get_fee_balance_returns_zero_before_any_payment() {
        let env = Env::default();
        let (client, admin, token) = setup(&env);
        client.initialize(&admin, &token, &500u32);
        assert_eq!(client.get_fee_balance(), 0i128);
    }

    #[test]
    fn get_fee_balance_increases_after_subscription() {
        let env = Env::default();
        let (client, admin, token) = setup(&env);
        client.initialize(&admin, &token, &500u32);
        let scout = Address::generate(&env);
        fund(&env, &token, &admin, &scout, 1_000_000_000_000i128);
        client.subscribe(&scout, &1u32, &30u32);
        let balance = client.get_fee_balance();
        assert!(balance > 0, "fee balance must be positive after subscription");
    }

    #[test]
    fn get_fee_balance_resets_to_zero_after_withdraw() {
        let env = Env::default();
        let (client, admin, token) = setup(&env);
        client.initialize(&admin, &token, &500u32);
        let scout = Address::generate(&env);
        fund(&env, &token, &admin, &scout, 1_000_000_000_000i128);
        client.subscribe(&scout, &1u32, &30u32);
        let balance = client.get_fee_balance();
        assert!(balance > 0);
        client.withdraw_fees(&admin, &balance);
        assert_eq!(client.get_fee_balance(), 0i128);
    }

    #[test]
    fn invariant_subscription_expiry_is_checked_after_each_sequence_step() {
        let env = Env::default();
        let (client, admin, token) = setup(&env);
        client.initialize(&admin, &token, &100);
        let scout = Address::generate(&env);
        // Fund generously so repeated subscriptions never fail on balance.
        fund(&env, &token, &admin, &scout, 100_000_000_000_000i128);
        let mut expected_expiry: Option<u32> = None;
        let mut state = 0xfeed_1234u64;
        for step in 0..24 {
            if state % 2 == 0 {
                let duration = ((state >> 5) % 6 + 1) as u32;
                let expiry = client.subscribe(&scout, &1u32, &duration);
                expected_expiry = Some(expiry);
            } else {
                let advance_by = ((state >> 2) % 4 + 1) as u32;
                env.ledger().with_mut(|li| { li.sequence_number += advance_by; });
            }
            let active = client.is_subscribed(&scout);
            let expected_active = expected_expiry.map_or(false, |expiry| env.ledger().sequence() < expiry);
            assert_eq!(active, expected_active, "step {step}");
            state = state.wrapping_mul(6364136223846793005).wrapping_add(1442695040888963407);
        }
    }
}
