use soroban_sdk::contracterror;

#[contracterror]
#[derive(Copy, Clone, Debug, Eq, PartialEq, PartialOrd, Ord)]
#[repr(u32)]
pub enum Error {
    AlreadyInitialized = 1,
    NotInitialized = 2,
    PlayerNotFound = 3,
    NotFound = 4,
    InvalidInput = 5,
    AlreadyVerified = 6,
    InsufficientFee = 7,
    /// Scout has no active subscription (or the subscription has already been
    /// cancelled).  Used by `cancel_subscription` and any access-guard that
    /// requires a live subscription.
    NotSubscribed = 8,
    Unauthorized = 9,
    ContractPaused = 10,
    Overflow = 11,
    /// Not enough unsold tokens remain to fulfil the requested purchase.
    /// Used by `player_token::buy_token` when `amount` exceeds the player's
    /// remaining supply (`total_supply - sold`).
    InsufficientSupply = 12,
}
