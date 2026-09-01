use soroban_sdk::{contracttype, Address, Env, Vec};

#[contracttype]
#[derive(Clone)]
pub enum DataKey {
    Admin,
    Initialized,
    Paused,
    /// Multi-writer allowlist: replaces the old single `AuthorizedUpdater` key.
    /// Stored as a `Vec<Address>` (max 16 entries — bounded to limit storage
    /// cost per Soroban's metered state model).
    AuthorizedUpdaters,
}

pub fn is_initialized(env: &Env) -> bool {
    env.storage().instance().has(&DataKey::Initialized)
}

pub fn set_initialized(env: &Env) {
    env.storage().instance().set(&DataKey::Initialized, &true);
}

pub fn is_paused(env: &Env) -> bool {
    env.storage()
        .instance()
        .get(&DataKey::Paused)
        .unwrap_or(false)
}

pub fn set_paused(env: &Env, paused: bool) {
    env.storage().instance().set(&DataKey::Paused, &paused);
}

// ---------------------------------------------------------------------------
// Multi-writer authorization helpers
//
// Design rationale:
//   An `allowlist: Vec<Address>` is stored under `DataKey::AuthorizedUpdaters`.
//   The Vec is bounded to MAX_AUTHORIZED_UPDATERS (16) to cap per-entry storage
//   cost.  Operations are O(n) over at most 16 items — acceptable at that scale.
//
//   Alternative considered: `Map<Address, bool>` — rejected because Soroban's
//   `Map` uses sorted XDR keys, so iteration cost and serialisation overhead are
//   higher for a small fixed set than a flat Vec with linear search.
//
//   Alternative considered: hardcoded address list at initialize() —
//   rejected because admin may need to rotate contract addresses post-deploy
//   without re-deploying the register contract.
// ---------------------------------------------------------------------------

/// Maximum number of simultaneously-authorized updater contracts.
/// Chosen to be large enough for the current design (progress + connection + 1
/// spare) while bounding storage growth.
pub const MAX_AUTHORIZED_UPDATERS: u32 = 16;

/// Return the current allowlist (empty Vec if none has been set).
pub fn get_authorized_updaters(env: &Env) -> Vec<Address> {
    env.storage()
        .instance()
        .get(&DataKey::AuthorizedUpdaters)
        .unwrap_or_else(|| Vec::new(env))
}

/// Add `updater` to the allowlist.  No-op if already present.
/// Returns `false` if the allowlist is already at capacity.
pub fn add_authorized_updater(env: &Env, updater: &Address) -> bool {
    let mut list = get_authorized_updaters(env);
    // Idempotent: skip if already present.
    let len = list.len();
    for i in 0..len {
        if list.get_unchecked(i) == *updater {
            return true;
        }
    }
    if list.len() >= MAX_AUTHORIZED_UPDATERS {
        return false;
    }
    list.push_back(updater.clone());
    env.storage()
        .instance()
        .set(&DataKey::AuthorizedUpdaters, &list);
    true
}

/// Remove `updater` from the allowlist.  No-op if not present.
pub fn remove_authorized_updater(env: &Env, updater: &Address) {
    let list = get_authorized_updaters(env);
    let len = list.len();
    let mut new_list = Vec::new(env);
    for i in 0..len {
        let entry = list.get_unchecked(i);
        if entry != *updater {
            new_list.push_back(entry);
        }
    }
    env.storage()
        .instance()
        .set(&DataKey::AuthorizedUpdaters, &new_list);
}

/// Return `true` if `caller` is in the authorized-updaters allowlist.
pub fn is_authorized_updater(env: &Env, caller: &Address) -> bool {
    let list = get_authorized_updaters(env);
    let len = list.len();
    for i in 0..len {
        if list.get_unchecked(i) == *caller {
            return true;
        }
    }
    false
}

pub const LEDGER_BUMP_AMOUNT: u32 = 518400; // ~30 days
pub const LEDGER_LIFETIME_THRESHOLD: u32 = 432000; // ~25 days

pub fn bump_instance(env: &Env) {
    env.storage()
        .instance()
        .extend_ttl(LEDGER_LIFETIME_THRESHOLD, LEDGER_BUMP_AMOUNT);
}
