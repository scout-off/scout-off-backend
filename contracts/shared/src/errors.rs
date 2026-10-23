use soroban_sdk::contracterror;

/// Errors shared by every Scout-Off contract.
///
/// The discriminant values are part of the contract ABI: clients decode the
/// numeric code returned by a failed invocation. Never renumber a variant.
/// See `contracts/README.md` for a table of codes.
#[contracterror]
#[derive(Copy, Clone, Debug, Eq, PartialEq, PartialOrd, Ord)]
#[repr(u32)]
pub enum Error {
    /// `initialize` was called on a contract that has already been
    /// initialized. Returned by every contract's `initialize`.
    AlreadyInitialized = 1,
    /// A contract entrypoint was called before `initialize`, so the admin and
    /// configuration are not yet stored. Returned by any entrypoint that reads
    /// the contract's configuration.
    NotInitialized = 2,
    /// No player is registered under the given player id. Returned by
    /// `register::{get_player, update_profile, update_progress_level}` and
    /// `connection::{get_connection, close_connection}`.
    PlayerNotFound = 3,
    /// The referenced record (for example a milestone) does not exist.
    /// Returned by `progress::{submit_milestone, approve_milestone}`.
    NotFound = 4,
    /// An argument failed validation: empty or oversized strings, a zero
    /// amount, an out-of-range fee in basis points, or an invalid page
    /// size/cursor. Returned by most mutating and paginated entrypoints.
    InvalidInput = 5,
    /// The action was already performed and is not repeatable: tokens were
    /// already issued for the player (`player_token::issue_tokens`) or the
    /// milestone was already approved (`progress::approve_milestone`).
    AlreadyVerified = 6,
    /// The payment is below the required fee (`subscription::subscribe`), or
    /// the requested withdrawal exceeds the collected fees
    /// (`subscription::withdraw_fees`).
    InsufficientFee = 7,
    /// Scout has no active subscription (or the subscription has already been
    /// cancelled).  Used by `cancel_subscription` and any access-guard that
    /// requires a live subscription.
    NotSubscribed = 8,
    /// The caller is not the admin or an authorized updater for this
    /// operation. Returned by admin-only and role-gated entrypoints in every
    /// contract.
    Unauthorized = 9,
    /// The contract is paused by its admin, so state-changing entrypoints are
    /// rejected until it is unpaused.
    ContractPaused = 10,
    /// A checked arithmetic operation overflowed (balances, supply counters,
    /// fee totals or subscription expiry). Returned by
    /// `player_token::{buy_token, distribute_fee}` and
    /// `subscription::{initialize, subscribe, pay_to_contact}`.
    Overflow = 11,
    /// Not enough unsold tokens remain to fulfil the requested purchase.
    /// Used by `player_token::buy_token` when `amount` exceeds the player's
    /// remaining supply (`total_supply - sold`).
    InsufficientSupply = 12,

    // ── Granular errors (#1530) ────────────────────────────────────────────
    //
    // APPEND ONLY. These discriminants are part of the on-chain ABI: existing
    // values must never be renumbered or reused, and each backend mapping in
    // src/utils/contractErrors.ts must stay in sync.

    /// The caller is not a registered validator (progress contract).
    ValidatorNotRegistered = 13,
    /// The validator was revoked and may no longer submit or approve milestones.
    ValidatorRevoked = 14,
    /// No milestone exists with the requested id.
    MilestoneNotFound = 15,
    /// The milestone has already been approved and cannot be approved twice.
    MilestoneAlreadyApproved = 16,
    /// A validator attempted to approve a milestone they submitted themselves.
    SelfApprovalForbidden = 17,
    /// The scout's subscription expired before the requested operation.
    SubscriptionExpired = 18,
    /// The scout has already paid to contact this player.
    ContactAlreadyPaid = 19,
    /// The supplied platform fee is outside the allowed 0–10 000 bps range.
    FeeBpsOutOfRange = 20,
    /// No connection exists for the given scout and player.
    ConnectionNotFound = 21,
    /// The connection is already closed and cannot be closed again.
    ConnectionAlreadyClosed = 22,
}
