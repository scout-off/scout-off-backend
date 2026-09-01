#![no_std]
//! # PlayerToken contract
//!
//! Scaffold for the fractionalized player-sponsorship feature. Fans purchase
//! **Player Tokens** to fund a young player's training. If the player turns
//! professional a percentage of their transfer fee is distributed back to
//! token holders proportionally via this contract.
//!
//! ## Design constraints (stub stage)
//! * Full mainnet deployment and real XLM transfers are **out of scope**; this
//!   contract provides the storage model and arithmetic so the backend and future
//!   on-chain integrations have a stable interface to build against.
//! * `distribute_fee` processes at most **20 holders per call** to stay within
//!   Soroban execution limits; callers must page through holders using the `page`
//!   argument.
//! * All token amounts are stored as `u64` (stroops-equivalent precision).

use soroban_sdk::{
    contract, contractimpl, contracttype, symbol_short, Address, Env, Symbol, Vec,
};
use scout_off_shared::{
    errors::Error,
    storage::{bump_instance, is_initialized, set_initialized},
};

// ── Constants ──────────────────────────────────────────────────────────────

/// Maximum number of holders processed per `distribute_fee` call.
pub const MAX_HOLDERS_PER_PAGE: u32 = 20;

// ── Data types ─────────────────────────────────────────────────────────────

/// Top-level metadata stored for each player's token issuance.
#[contracttype]
#[derive(Clone)]
pub struct TokenMeta {
    /// Total supply of tokens issued for this player (must be > 0).
    pub total_supply: u64,
    /// Tokens that have been sold so far (≤ total_supply).
    pub sold: u64,
    /// Cumulative XLM (in stroops) distributed to all holders to date.
    pub total_distributed: u128,
    /// Number of holder pages currently stored for this player.
    pub holder_pages: u32,
}

/// A single holder's balance entry stored under `HolderBalance(player_id, holder)`.
#[contracttype]
#[derive(Clone)]
pub struct HolderBalance {
    pub tokens: u64,
}

/// A queued XLM transfer produced by `distribute_fee` (stub: no real token
/// transfer is executed; the queue is stored in contract state for an off-chain
/// relayer or a follow-up contract call to execute).
#[contracttype]
#[derive(Clone)]
pub struct PendingPayout {
    pub holder: Address,
    pub amount_stroops: u128,
}

#[contracttype]
#[derive(Clone)]
pub struct TransferInfo {
    pub total_fee: u128,
    pub accumulated: u128,
}

#[contracttype]
#[derive(Clone)]
pub enum DataKey {
    Admin,
    /// TokenMeta for a given player.
    TokenMeta(u64),
    /// A paginated list page of holder addresses for a given player.
    HolderPage(u64, u32),
    /// Record of a transfer distribution: total fee and accumulated per-page totals.
    TransferInfo(u64, u128),
    /// Marker that a given (player, transfer_id, page) has been processed.
    ProcessedTransferPage(u64, u128, u32),
    /// Legacy monolithic holder list stored in instance storage (used only for migration).
    LegacyHolderList(u64),
    /// Balance entry for a specific (player, holder) pair.
    HolderBalance(u64, Address),
    /// Pending payouts queued by `distribute_fee` for a player (page-keyed).
    PendingPayouts(u64, u32),
}

// ── Contract ───────────────────────────────────────────────────────────────

#[contract]
pub struct PlayerTokenContract;

#[contractimpl]
impl PlayerTokenContract {
    // ── Admin setup ────────────────────────────────────────────────────────

    /// One-time initialisation. Stores the admin address.
    ///
    /// # Errors
    /// * [`Error::AlreadyInitialized`] — already called.
    pub fn initialize(env: Env, admin: Address) -> Result<(), Error> {
        if is_initialized(&env) {
            return Err(Error::AlreadyInitialized);
        }
        admin.require_auth();
        env.storage().instance().set(&DataKey::Admin, &admin);
        set_initialized(&env);
        bump_instance(&env);
        Ok(())
    }

    // ── Token issuance ─────────────────────────────────────────────────────

    /// Issue a fixed supply of Player Tokens for `player_id`.
    ///
    /// Can only be called once per player. The admin authorises this call.
    ///
    /// # Arguments
    /// * `player_id`    — on-chain player identifier from the register contract.
    /// * `total_supply` — number of tokens to create. Must be ≥ 1.
    ///
    /// # Errors
    /// * [`Error::NotInitialized`]    — contract not yet initialised.
    /// * [`Error::Unauthorized`]      — caller is not the admin.
    /// * [`Error::AlreadyVerified`]   — tokens already issued for this player.
    /// * [`Error::InvalidInput`]      — `total_supply` is zero.
    pub fn issue_tokens(env: Env, player_id: u64, total_supply: u64) -> Result<(), Error> {
        if !is_initialized(&env) {
            return Err(Error::NotInitialized);
        }
        let admin: Address = env
            .storage()
            .instance()
            .get(&DataKey::Admin)
            .ok_or(Error::NotInitialized)?;
        admin.require_auth();

        if total_supply == 0 {
            return Err(Error::InvalidInput);
        }
        if env.storage().persistent().has(&DataKey::TokenMeta(player_id)) {
            return Err(Error::AlreadyVerified); // already issued
        }

        let meta = TokenMeta {
            total_supply,
            sold: 0,
            total_distributed: 0,
            holder_pages: 0,
        };
        env.storage()
            .persistent()
            .set(&DataKey::TokenMeta(player_id), &meta);

        env.events().publish(
            (symbol_short!("tok_iss"), player_id),
            (total_supply,),
        );
        bump_instance(&env);
        Ok(())
    }

    // ── Token purchase ─────────────────────────────────────────────────────

    /// Purchase `amount` tokens for `player_id` on behalf of `buyer`.
    ///
    /// Stub: no XLM transfer is executed; the balance is updated in contract
    /// storage only. A real implementation would call the XLM token contract here.
    ///
    /// # Arguments
    /// * `player_id` — target player.
    /// * `amount`    — number of tokens to buy (≥ 1).
    /// * `buyer`     — purchasing address (must authorise this call).
    ///
    /// # Errors
    /// * [`Error::NotInitialized`]     — contract not initialised.
    /// * [`Error::InvalidInput`]       — no tokens issued for this player, or
    ///                                   `amount` is zero.
    /// * [`Error::InsufficientSupply`] — `amount` exceeds the player's remaining
    ///                                   unsold supply.
    pub fn buy_token(env: Env, player_id: u64, amount: u64, buyer: Address) -> Result<(), Error> {
        if !is_initialized(&env) {
            return Err(Error::NotInitialized);
        }
        buyer.require_auth();

        if amount == 0 {
            return Err(Error::InvalidInput);
        }

        let mut meta: TokenMeta = env
            .storage()
            .persistent()
            .get(&DataKey::TokenMeta(player_id))
            .ok_or(Error::InvalidInput)?; // no tokens issued

        let remaining = meta.total_supply.checked_sub(meta.sold).unwrap_or(0);
        if amount > remaining {
            return Err(Error::InsufficientSupply);
        }

        // Update or create holder balance.
        let balance_key = DataKey::HolderBalance(player_id, buyer.clone());
        let prev: u64 = env
            .storage()
            .persistent()
            .get::<DataKey, HolderBalance>(&balance_key)
            .map(|b| b.tokens)
            .unwrap_or(0);

        let new_balance = prev
            .checked_add(amount)
            .ok_or(Error::Overflow)?;

        env.storage()
            .persistent()
            .set(&balance_key, &HolderBalance { tokens: new_balance });

        // Append to holder list only on first purchase.
        if prev == 0 {
            // Append to the last holder page, creating a new page when needed.
            let mut last_page_index: u32 = if meta.holder_pages == 0 {
                0
            } else {
                meta.holder_pages - 1
            };

            // If there are no pages yet, create first page.
            if meta.holder_pages == 0 {
                let mut pv: Vec<Address> = Vec::new(&env);
                pv.push_back(buyer.clone());
                env.storage()
                    .persistent()
                    .set(&DataKey::HolderPage(player_id, 0u32), &pv);
                meta.holder_pages = 1;
            } else {
                let mut pv: Vec<Address> = env
                    .storage()
                    .persistent()
                    .get(&DataKey::HolderPage(player_id, last_page_index))
                    .unwrap_or_else(|| Vec::new(&env));
                if pv.len() as u32 >= MAX_HOLDERS_PER_PAGE {
                    // create a new page
                    last_page_index = meta.holder_pages;
                    let mut newp: Vec<Address> = Vec::new(&env);
                    newp.push_back(buyer.clone());
                    env.storage()
                        .persistent()
                        .set(&DataKey::HolderPage(player_id, last_page_index), &newp);
                    meta.holder_pages = meta.holder_pages.checked_add(1).ok_or(Error::Overflow)?;
                } else {
                    pv.push_back(buyer.clone());
                    env.storage()
                        .persistent()
                        .set(&DataKey::HolderPage(player_id, last_page_index), &pv);
                }
            }
            // persist updated meta (holder_pages may have changed below)
            env.storage()
                .persistent()
                .set(&DataKey::TokenMeta(player_id), &meta);
        }

        meta.sold = meta.sold.checked_add(amount).ok_or(Error::Overflow)?;
        env.storage()
            .persistent()
            .set(&DataKey::TokenMeta(player_id), &meta);

        env.events().publish(
            (symbol_short!("tok_buy"), player_id),
            (buyer, amount),
        );
        // No instance growth — changes are persisted per-key.
        Ok(())
    }

    // ── Fee distribution ───────────────────────────────────────────────────

    /// Calculate and queue pro-rata XLM payouts to token holders.
    ///
    /// Processes at most [`MAX_HOLDERS_PER_PAGE`] (20) holders per call. Callers
    /// must increment `page` (0-indexed) to process subsequent batches.
    ///
    /// Stub: XLM transfers are not executed. Each holder's payout is stored as a
    /// [`PendingPayout`] entry under `DataKey::PendingPayouts(player_id, page)`.
    /// An off-chain relayer or follow-up contract call is responsible for execution.
    ///
    /// # Arguments
    /// * `player_id`        — target player.
    /// * `transfer_fee_xlm` — total transfer fee in stroops to distribute.
    /// * `page`             — 0-indexed page of holders to process this call.
    ///
    /// # Returns
    /// `Ok(payouts_queued)` — number of holder payouts queued in this call.
    ///
    /// # Errors
    /// * [`Error::NotInitialized`]  — contract not initialised.
    /// * [`Error::InvalidInput`]    — no tokens issued, sold is zero, or
    ///                                 `transfer_fee_xlm` is zero.
    /// * [`Error::Overflow`]        — arithmetic overflow in pagination or payout calculation.
    pub fn distribute_fee(
        env: Env,
        player_id: u64,
        transfer_fee_xlm: u128,
        transfer_id: u128,
        page: u32,
    ) -> Result<u32, Error> {
        if !is_initialized(&env) {
            return Err(Error::NotInitialized);
        }

        let admin: Address = env
            .storage()
            .instance()
            .get(&DataKey::Admin)
            .ok_or(Error::NotInitialized)?;
        admin.require_auth();

        if transfer_fee_xlm == 0 {
            return Err(Error::InvalidInput);
        }

        let meta: TokenMeta = env
            .storage()
            .persistent()
            .get(&DataKey::TokenMeta(player_id))
            .ok_or(Error::InvalidInput)?;

        if meta.sold == 0 {
            return Err(Error::InvalidInput);
        }

        // Ensure transfer record exists and is consistent across pages.
        let mut tinfo: TransferInfo = if let Some(t) = env
            .storage()
            .persistent()
            .get::<DataKey, TransferInfo>(&DataKey::TransferInfo(player_id, transfer_id))
        {
            if t.total_fee != transfer_fee_xlm {
                return Err(Error::InvalidInput);
            }
            t
        } else {
            let ti = TransferInfo {
                total_fee: transfer_fee_xlm,
                accumulated: 0u128,
            };
            env.storage()
                .persistent()
                .set(&DataKey::TransferInfo(player_id, transfer_id), &ti);
            ti
        };

        // If this (player, transfer_id, page) has already been processed,
        // treat it as an explicit no-op and return 0.
        if env
            .storage()
            .persistent()
            .has(&DataKey::ProcessedTransferPage(player_id, transfer_id, page))
        {
            return Ok(0);
        }

        // Read the requested holder page from persistent storage.
        // The page index is directly used to fetch a specific page of holders.
        // Guard against page overflow: page * MAX_HOLDERS_PER_PAGE must not overflow u32.
        let _start_check = (page as u32)
            .checked_mul(MAX_HOLDERS_PER_PAGE)
            .ok_or(Error::Overflow)?;

        let holders: Vec<Address> = env
            .storage()
            .persistent()
            .get(&DataKey::HolderPage(player_id, page))
            .unwrap_or_else(|| Vec::new(&env));

        let mut payouts: Vec<PendingPayout> = Vec::new(&env);
        let total_sold = meta.sold as u128;

        for i in 0..holders.len() {
            let holder = holders.get_unchecked(i as u32);
            let balance_key = DataKey::HolderBalance(player_id, holder.clone());
            let tokens: u64 = env
                .storage()
                .persistent()
                .get::<DataKey, HolderBalance>(&balance_key)
                .map(|b| b.tokens)
                .unwrap_or(0);

            if tokens == 0 {
                continue;
            }

            // pro-rata share = transfer_fee_xlm * tokens / total_sold
            let numerator = transfer_fee_xlm
                .checked_mul(tokens as u128)
                .ok_or(Error::Overflow)?;
            let share = numerator / total_sold; // integer division (floor)

            if share > 0 {
                payouts.push_back(PendingPayout {
                    holder: holder.clone(),
                    amount_stroops: share,
                });
            }
        }

        let queued = payouts.len();
        if queued > 0 {
            env.storage()
                .persistent()
                .set(&DataKey::PendingPayouts(player_id, page), &payouts);
        }

        // Sum page total and validate against transfer total.
        let page_total: u128 = payouts
            .iter()
            .fold(0u128, |acc, p| acc.saturating_add(p.amount_stroops));

        // Prevent processing pages that would cause accumulated > total_fee.
        if tinfo.accumulated.checked_add(page_total).unwrap_or(u128::MAX) > tinfo.total_fee {
            return Err(Error::InvalidInput);
        }

        // Persist processed-page marker and updated transfer info.
        env.storage()
            .persistent()
            .set(&DataKey::ProcessedTransferPage(player_id, transfer_id, page), &1u32);

        tinfo.accumulated = tinfo.accumulated.saturating_add(page_total);
        env.storage()
            .persistent()
            .set(&DataKey::TransferInfo(player_id, transfer_id), &tinfo);

        // Update cumulative distributed amount (best-effort; skip on overflow).
        let mut updated_meta = meta;
        updated_meta.total_distributed = updated_meta
            .total_distributed
            .saturating_add(page_total);
        env.storage()
            .persistent()
            .set(&DataKey::TokenMeta(player_id), &updated_meta);
        env.events().publish(
            (Symbol::new(&env, "fee_dist"), player_id, page, transfer_id),
            (transfer_fee_xlm, queued),
        );
        // No instance bump required — persistent storage used for large data.
        Ok(queued)
    }

    /// Migrate a batch of holders from a legacy per-player monolithic holder
    /// list (stored in instance storage under `LegacyHolderList(player_id)`) into
    /// the new persistent paginated `HolderPage(player_id, page)` layout.
    ///
    /// This is an admin-only helper intended to be called iteratively to avoid
    /// gas exhaustion when migrating very large holder lists.
    ///
    /// Arguments:
    /// * `player_id` — target player whose legacy list will be migrated.
    /// * `start`     — 0-indexed starting index in the legacy list for this step.
    /// * `count`     — maximum number of holders to migrate in this call.
    ///
    /// Returns the number of holders migrated in this step.
    pub fn migrate_player_step(env: Env, player_id: u64, start: u32, count: u32) -> Result<u32, Error> {
        // Only admin may perform migration.
        let admin: Address = env
            .storage()
            .instance()
            .get(&DataKey::Admin)
            .ok_or(Error::NotInitialized)?;
        admin.require_auth();

        // Read legacy list from instance storage.
        let legacy: Vec<Address> = env
            .storage()
            .instance()
            .get(&DataKey::LegacyHolderList(player_id))
            .unwrap_or_else(|| Vec::new(&env));

        let total: u32 = legacy.len();
        if total == 0 || start >= total {
            return Ok(0);
        }

        let end = core::cmp::min(total, start.saturating_add(count));
        let mut migrated: u32 = 0;

        // Ensure TokenMeta exists (migration assumes tokens were issued previously).
        let mut meta: TokenMeta = env
            .storage()
            .persistent()
            .get(&DataKey::TokenMeta(player_id))
            .ok_or(Error::InvalidInput)?;

        // Append each legacy holder to persistent pages.
        for i in start..end {
            let addr = legacy.get_unchecked(i);

            // Append to last page or create a new one when full.
            let mut last_page_index: u32 = if meta.holder_pages == 0 { 0 } else { meta.holder_pages - 1 };
            if meta.holder_pages == 0 {
                let mut pv: Vec<Address> = Vec::new(&env);
                pv.push_back(addr.clone());
                env.storage()
                    .persistent()
                    .set(&DataKey::HolderPage(player_id, 0u32), &pv);
                meta.holder_pages = 1;
            } else {
                let mut pv: Vec<Address> = env
                    .storage()
                    .persistent()
                    .get(&DataKey::HolderPage(player_id, last_page_index))
                    .unwrap_or_else(|| Vec::new(&env));
                if pv.len() as u32 >= MAX_HOLDERS_PER_PAGE {
                    last_page_index = meta.holder_pages;
                    let mut newp: Vec<Address> = Vec::new(&env);
                    newp.push_back(addr.clone());
                    env.storage()
                        .persistent()
                        .set(&DataKey::HolderPage(player_id, last_page_index), &newp);
                    meta.holder_pages = meta.holder_pages.checked_add(1).ok_or(Error::Overflow)?;
                } else {
                    pv.push_back(addr.clone());
                    env.storage()
                        .persistent()
                        .set(&DataKey::HolderPage(player_id, last_page_index), &pv);
                }
            }

            migrated = migrated.checked_add(1).ok_or(Error::Overflow)?;
        }

        // Persist updated meta.
        env.storage()
            .persistent()
            .set(&DataKey::TokenMeta(player_id), &meta);

        // Rebuild leftover legacy list (elements before `start`, and after `end`).
        let mut new_legacy: Vec<Address> = Vec::new(&env);
        for i in 0..start {
            new_legacy.push_back(legacy.get_unchecked(i).clone());
        }
        for i in end..total {
            new_legacy.push_back(legacy.get_unchecked(i).clone());
        }

        env.storage()
            .instance()
            .set(&DataKey::LegacyHolderList(player_id), &new_legacy);

        Ok(migrated)
    }

    // ── Queries ────────────────────────────────────────────────────────────

    /// Return the token balance for a given `(player_id, holder)` pair.
    ///
    /// Returns 0 if no tokens have been purchased.
    pub fn get_balance(env: Env, player_id: u64, holder: Address) -> u64 {
        env.storage()
            .persistent()
            .get::<DataKey, HolderBalance>(&DataKey::HolderBalance(player_id, holder))
            .map(|b| b.tokens)
            .unwrap_or(0)
    }

    /// Return the [`TokenMeta`] for a player, or an error if no tokens were issued.
    ///
    /// # Errors
    /// * [`Error::InvalidInput`] — no tokens issued for this player.
    pub fn get_token_meta(env: Env, player_id: u64) -> Result<TokenMeta, Error> {
        env.storage()
            .persistent()
            .get(&DataKey::TokenMeta(player_id))
            .ok_or(Error::InvalidInput)
    }

    /// Return the ordered list of holder addresses for a player.
    pub fn get_holders(env: Env, player_id: u64) -> Vec<Address> {
        // Reconstruct full holder list by concatenating stored pages.
        let mut out: Vec<Address> = Vec::new(&env);
        if let Some(meta) = env.storage().persistent().get::<DataKey, TokenMeta>(&DataKey::TokenMeta(player_id)) {
            for i in 0..meta.holder_pages {
                let page: Vec<Address> = env
                    .storage()
                    .persistent()
                    .get(&DataKey::HolderPage(player_id, i))
                    .unwrap_or_else(|| Vec::new(&env));
                for j in 0..page.len() {
                    out.push_back(page.get_unchecked(j).clone());
                }
            }
        }
        out
    }

    /// Return the pending payouts queued for a given `(player_id, page)`.
    pub fn get_pending_payouts(env: Env, player_id: u64, page: u32) -> Vec<PendingPayout> {
        env.storage()
            .persistent()
            .get(&DataKey::PendingPayouts(player_id, page))
            .unwrap_or_else(|| Vec::new(&env))
    }
}

// ── Unit tests ─────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;
    use soroban_sdk::{testutils::Address as _, Env};

    fn setup(env: &Env) -> (PlayerTokenContractClient<'_>, Address) {
        env.mock_all_auths();
        let id = env.register_contract(None, PlayerTokenContract);
        let client = PlayerTokenContractClient::new(env, &id);
        let admin = Address::generate(env);
        client.initialize(&admin);
        (client, admin)
    }

    #[test]
    fn issue_tokens_with_zero_supply_fails() {
        let env = Env::default();
        let (client, _admin) = setup(&env);
        assert!(client.try_issue_tokens(&1u64, &0u64).is_err());
    }

    #[test]
    fn issue_tokens_succeeds_and_is_idempotent_via_error() {
        let env = Env::default();
        let (client, _admin) = setup(&env);
        client.issue_tokens(&1u64, &1000u64);
        // Second issue for same player must fail.
        assert!(client.try_issue_tokens(&1u64, &500u64).is_err());
    }

    #[test]
    fn buy_token_updates_balance_and_sold_count() {
        let env = Env::default();
        let (client, _admin) = setup(&env);
        let buyer = Address::generate(&env);

        client.issue_tokens(&1u64, &100u64);
        client.buy_token(&1u64, &30u64, &buyer);

        assert_eq!(client.get_balance(&1u64, &buyer), 30);
        let meta = client.get_token_meta(&1u64);
        assert_eq!(meta.sold, 30);
    }

    #[test]
    fn buy_token_exceeding_supply_fails() {
        let env = Env::default();
        let (client, _admin) = setup(&env);
        let buyer = Address::generate(&env);
        client.issue_tokens(&1u64, &10u64);
        assert_eq!(
            client.try_buy_token(&1u64, &11u64, &buyer),
            Err(Ok(Error::InsufficientSupply))
        );
    }

    #[test]
    fn buy_token_exactly_exhausts_supply_succeeds() {
        let env = Env::default();
        let (client, _admin) = setup(&env);
        let buyer = Address::generate(&env);
        client.issue_tokens(&1u64, &10u64);
        // Buying exactly the remaining supply must succeed.
        assert!(client.try_buy_token(&1u64, &10u64, &buyer).is_ok());
        assert_eq!(client.get_balance(&1u64, &buyer), 10);
        // Any further purchase is rejected with InsufficientSupply.
        assert_eq!(
            client.try_buy_token(&1u64, &1u64, &buyer),
            Err(Ok(Error::InsufficientSupply))
        );
    }

    #[test]
    fn distribute_fee_pro_rata_three_holders() {
        let env = Env::default();
        let (client, _admin) = setup(&env);

        let b1 = Address::generate(&env);
        let b2 = Address::generate(&env);
        let b3 = Address::generate(&env);

        client.issue_tokens(&1u64, &100u64);
        client.buy_token(&1u64, &50u64, &b1); // 50%
        client.buy_token(&1u64, &30u64, &b2); // 30%
        client.buy_token(&1u64, &20u64, &b3); // 20%

        // Distribute 1_000_000 stroops (1 XLM) across page 0 with transfer id 1.
        let transfer_id = 1u128;
        let queued = client.distribute_fee(&1u64, &1_000_000u128, &transfer_id, &0u32);
        assert_eq!(queued, 3);

        let payouts = client.get_pending_payouts(&1u64, &0u32);
        assert_eq!(payouts.len(), 3);

        // Verify pro-rata amounts (integer division).
        let p0 = payouts.get(0).unwrap();
        let p1 = payouts.get(1).unwrap();
        let p2 = payouts.get(2).unwrap();
        assert_eq!(p0.amount_stroops, 500_000); // 50%
        assert_eq!(p1.amount_stroops, 300_000); // 30%
        assert_eq!(p2.amount_stroops, 200_000); // 20%

        // Total distributed must not exceed the fee.
        let total: u128 = payouts.iter().map(|p| p.amount_stroops).sum();
        assert!(total <= 1_000_000);
    }

    #[test]
    fn distribute_fee_rounding_for_non_integer_shares() {
        let env = Env::default();
        let (client, _admin) = setup(&env);

        let b1 = Address::generate(&env);
        let b2 = Address::generate(&env);
        let b3 = Address::generate(&env);

        // 3 holders with equal 1-token balances; fee = 10 (not divisible by 3).
        client.issue_tokens(&2u64, &3u64);
        client.buy_token(&2u64, &1u64, &b1);
        client.buy_token(&2u64, &1u64, &b2);
        client.buy_token(&2u64, &1u64, &b3);

        let transfer_id = 2u128;
        let queued = client.distribute_fee(&2u64, &10u128, &transfer_id, &0u32);
        assert_eq!(queued, 3);

        let payouts = client.get_pending_payouts(&2u64, &0u32);
        let total: u128 = payouts.iter().map(|p| p.amount_stroops).sum();
        // Floor division: each gets 3, total = 9 (≤ 10 — rounding remainder stays in contract).
        assert!(total <= 10, "total payouts {} must not exceed fee 10", total);
        for p in payouts.iter() {
            assert_eq!(p.amount_stroops, 3);
        }
    }

    #[test]
    fn distribute_fee_zero_transfer_fee_fails() {
        let env = Env::default();
        let (client, _admin) = setup(&env);
        let buyer = Address::generate(&env);
        client.issue_tokens(&3u64, &100u64);
        client.buy_token(&3u64, &1u64, &buyer);
        assert!(client.try_distribute_fee(&3u64, &0u128, &1u128, &0u32).is_err());
    }

    #[test]
    fn distribute_fee_with_no_sold_tokens_fails() {
        let env = Env::default();
        let (client, _admin) = setup(&env);
        client.issue_tokens(&4u64, &100u64);
        // No buyers yet — sold = 0.
        assert!(client.try_distribute_fee(&4u64, &1_000u128, &1u128, &0u32).is_err());
    }

    #[test]
    fn distribute_fee_paging_returns_zero_beyond_holder_count() {
        let env = Env::default();
        let (client, _admin) = setup(&env);
        let buyer = Address::generate(&env);
        client.issue_tokens(&5u64, &100u64);
        client.buy_token(&5u64, &1u64, &buyer);
        // Only 1 holder; page 1 should return 0.
        let queued = client.distribute_fee(&5u64, &1_000u128, &5u128, &1u32);
        assert_eq!(queued, 0);
    }

    #[test]
    fn get_holders_returns_all_buyers() {
        let env = Env::default();
        let (client, _admin) = setup(&env);
        let b1 = Address::generate(&env);
        let b2 = Address::generate(&env);
        client.issue_tokens(&6u64, &100u64);
        client.buy_token(&6u64, &10u64, &b1);
        client.buy_token(&6u64, &10u64, &b2);
        let holders = client.get_holders(&6u64);
        assert_eq!(holders.len(), 2);
    }

    #[test]
    fn storage_growth_mitigation_pages_and_persistent_storage() {
        let env = Env::default();
        let (client, _admin) = setup(&env);

        let player_id = 42u64;
        client.issue_tokens(&player_id, &100_000u64);

        // Create 200 unique buyers (10 pages at MAX_HOLDERS_PER_PAGE=20)
        let mut buyers: Vec<Address> = Vec::new(&env);
        for _ in 0..200 {
            buyers.push_back(Address::generate(&env));
        }

        for i in 0..buyers.len() {
            client.buy_token(&player_id, &1u64, &buyers.get_unchecked(i).clone());
        }

        // Distribute fees across several pages
        for p in 0u32..10u32 {
            let transfer_id = 1000u128 + (p as u128);
            let queued = client.distribute_fee(&player_id, &1_000_000u128, &transfer_id, &p);
            assert!(queued <= MAX_HOLDERS_PER_PAGE);
        }

        // Ensure we do not have a monolithic HolderList stored in instance storage
        assert!(!env.storage().instance().has(&DataKey::HolderPage(player_id, 0u32)));

        // TokenMeta should be in persistent storage, not instance storage.
        assert!(!env.storage().instance().has(&DataKey::TokenMeta(player_id)));

        // Pending payouts should be stored in persistent storage per page.
        let p0: Vec<PendingPayout> = env
            .storage()
            .persistent()
            .get(&DataKey::PendingPayouts(player_id, 0u32))
            .unwrap_or_else(|| Vec::new(&env));
        assert!(p0.len() > 0);
    }

    #[test]
    fn migrate_player_step_batches_and_finalises() {
        let env = Env::default();
        let (client, admin) = setup(&env);

        let player_id = 99u64;
        client.issue_tokens(&player_id, &1_000u64);

        // Create a legacy in-instance holder list of 45 addresses.
        let mut legacy: Vec<Address> = Vec::new(&env);
        for _ in 0..45 {
            legacy.push_back(Address::generate(&env));
        }
        env.storage()
            .instance()
            .set(&DataKey::LegacyHolderList(player_id), &legacy);

        // Admin calls migrate in batches of 20.
        let first = client.migrate_player_step(&player_id, &0u32, &20u32);
        assert_eq!(first, 20);

        let second = client.migrate_player_step(&player_id, &20u32, &20u32);
        assert_eq!(second, 20);

        let third = client.migrate_player_step(&player_id, &40u32, &20u32);
        assert_eq!(third, 5);

        // Legacy list should now be empty.
        let rem: Vec<Address> = env
            .storage()
            .instance()
            .get(&DataKey::LegacyHolderList(player_id))
            .unwrap_or_else(|| Vec::new(&env));
        assert_eq!(rem.len(), 0);

        // TokenMeta holder_pages should reflect the stored pages (45/20 => 3 pages).
        let meta = client.get_token_meta(&player_id);
        assert_eq!(meta.holder_pages, 3);
    }

    #[test]
    fn distribute_fee_idempotent_replay_prevented() {
        let env = Env::default();
        let (client, _admin) = setup(&env);

        let pid = 3001u64;
        client.issue_tokens(&pid, &100u64);
        let b1 = Address::generate(&env);
        let b2 = Address::generate(&env);
        let b3 = Address::generate(&env);
        client.buy_token(&pid, &50u64, &b1);
        client.buy_token(&pid, &30u64, &b2);
        client.buy_token(&pid, &20u64, &b3);

        let transfer_id = 4001u128;
        let queued1 = client.distribute_fee(&pid, &1_000_000u128, &transfer_id, &0u32);
        assert_eq!(queued1, 3);
        let meta1 = client.get_token_meta(&pid);
        let total1 = meta1.total_distributed;

        // Replay same page -> must be no-op
        let queued2 = client.distribute_fee(&pid, &1_000_000u128, &transfer_id, &0u32);
        assert_eq!(queued2, 0);
        let meta2 = client.get_token_meta(&pid);
        assert_eq!(meta2.total_distributed, total1);
    }

    #[test]
    fn distribute_fee_multi_page_same_transfer() {
        let env = Env::default();
        let (client, _admin) = setup(&env);

        let pid = 4001u64;
        client.issue_tokens(&pid, &1_000u64);

        // Create 25 buyers (2 pages)
        for _ in 0..25 {
            let a = Address::generate(&env);
            client.buy_token(&pid, &1u64, &a);
        }

        let transfer_id = 5001u128;
        let q0 = client.distribute_fee(&pid, &10_000u128, &transfer_id, &0u32);
        let q1 = client.distribute_fee(&pid, &10_000u128, &transfer_id, &1u32);
        assert!(q0 > 0 && q1 > 0);

        let p0 = client.get_pending_payouts(&pid, &0u32);
        let p1 = client.get_pending_payouts(&pid, &1u32);
        let page_sum: u128 = p0.iter().map(|p| p.amount_stroops).sum::<u128>()
            + p1.iter().map(|p| p.amount_stroops).sum::<u128>();

        let meta = client.get_token_meta(&pid);
        assert_eq!(meta.total_distributed, page_sum);

        // Replaying page 0 is a no-op
        let q0_again = client.distribute_fee(&pid, &10_000u128, &transfer_id, &0u32);
        assert_eq!(q0_again, 0);
        let meta_after = client.get_token_meta(&pid);
        assert_eq!(meta_after.total_distributed, page_sum);
    }

    #[test]
    fn distribute_fee_rejects_mismatched_total_fee() {
        let env = Env::default();
        let (client, _admin) = setup(&env);

        let pid = 6001u64;
        client.issue_tokens(&pid, &100u64);
        let a = Address::generate(&env);
        client.buy_token(&pid, &1u64, &a);

        let transfer_id = 7001u128;
        let ok = client.distribute_fee(&pid, &1_000u128, &transfer_id, &0u32);
        assert_eq!(ok, 1);

        // Same transfer_id but different total fee should be rejected.
        assert!(client.try_distribute_fee(&pid, &2_000u128, &transfer_id, &0u32).is_err());
    }

    #[test]
    fn double_initialize_fails() {
        let env = Env::default();
        let (client, admin) = setup(&env);
        assert!(client.try_initialize(&admin).is_err());
    }
    #[test]
    fn distribute_fee_without_admin_auth_fails() {
        let env = Env::default();
        let (client, _admin) = setup(&env);
        let buyer = Address::generate(&env);
        client.issue_tokens(&7u64, &100u64);
        client.buy_token(&7u64, &1u64, &buyer);

        // Pass empty auth list to override `env.mock_all_auths()`
        let result = client.mock_auths(&[]).try_distribute_fee(&7u64, &1_000u128, &0u32);
        assert!(result.is_err());
    }

    #[test]
    fn distribute_fee_with_overflow_page_value_fails() {
        let env = Env::default();
        let (client, _admin) = setup(&env);
        let buyer = Address::generate(&env);
        client.issue_tokens(&8u64, &100u64);
        client.buy_token(&8u64, &1u64, &buyer);

        // Try to call distribute_fee with a page value that would overflow
        // when multiplied by MAX_HOLDERS_PER_PAGE.
        // u32::MAX * 20 would overflow, so this should return Error::Overflow.
        let result = client.try_distribute_fee(&8u64, &1_000u128, &u32::MAX);
        assert_eq!(result, Err(Ok(Error::Overflow)));
    }

    #[test]
    fn distribute_fee_with_large_page_near_boundary() {
        let env = Env::default();
        let (client, _admin) = setup(&env);
        let buyer = Address::generate(&env);
        client.issue_tokens(&9u64, &100u64);
        client.buy_token(&9u64, &1u64, &buyer);

        // Try a page value that is close to overflow boundary.
        // (u32::MAX - 1) * 20 could still overflow depending on the value.
        // This tests boundary values to ensure proper overflow detection.
        let large_page = u32::MAX / 2;
        let result = client.try_distribute_fee(&9u64, &1_000u128, &large_page);
        // Should either succeed (if the page is beyond holders) or fail with Overflow.
        // The important thing is that it doesn't panic.
        assert!(result.is_ok() || result == Err(Ok(Error::Overflow)));
    }

    #[test]
    fn distribute_fee_normal_page_values() {
        let env = Env::default();
        let (client, _admin) = setup(&env);

        let player_id = 10u64;
        client.issue_tokens(&player_id, &1000u64);

        // Create 50 buyers spread across multiple pages
        let mut buyers = Vec::new(&env);
        for _ in 0..50 {
            buyers.push_back(Address::generate(&env));
        }

        for i in 0..buyers.len() {
            client.buy_token(&player_id, &1u64, &buyers.get_unchecked(i).clone());
        }

        // Distribute across normal page values (0, 1, 2)
        // Page 0: holders 0-19
        let page0_queued = client.distribute_fee(&player_id, &1_000_000u128, &0u32);
        assert_eq!(page0_queued, 20);

        // Page 1: holders 20-39
        let page1_queued = client.distribute_fee(&player_id, &1_000_000u128, &1u32);
        assert_eq!(page1_queued, 20);

        // Page 2: holders 40-49 (only 10 holders)
        let page2_queued = client.distribute_fee(&player_id, &1_000_000u128, &2u32);
        assert_eq!(page2_queued, 10);

        // Page 3: beyond holders, should return 0
        let page3_queued = client.distribute_fee(&player_id, &1_000_000u128, &3u32);
        assert_eq!(page3_queued, 0);
    }
}
