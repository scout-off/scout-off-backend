use soroban_sdk::{symbol_short, Address, Env, Symbol};

pub fn emit_initialized(env: &Env, admin: &Address) {
    env.events()
        .publish((symbol_short!("init"),), (admin.clone(),));
}

pub fn emit_paused(env: &Env, paused: bool) {
    env.events()
        .publish((symbol_short!("pause"),), (paused,));
}

pub fn emit_scout_subscribed(
    env: &Env,
    scout: &Address,
    tier: u32,
    duration_ledgers: u32,
    expiry_ledger: u32,
) {
    env.events().publish(
        (Symbol::new(env, "scout_subscribed"),),
        (scout.clone(), tier, duration_ledgers, expiry_ledger),
    );
}

pub fn emit_contact_unlocked(env: &Env, scout: &Address, player_id: u64) {
    env.events().publish(
        (Symbol::new(env, "contact_unlocked"),),
        (scout.clone(), player_id),
    );
}
