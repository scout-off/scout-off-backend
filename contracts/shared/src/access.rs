//! Per-contract roles. Instance storage shares the contract instance lifetime,
//! so memberships and the last-admin counter cannot expire independently.
use crate::{
    storage::{bump_instance, DataKey},
    Error,
};
use soroban_sdk::{Address, Env, Symbol};

pub const DEFAULT_ADMIN: &str = "DEFAULT_ADMIN";
pub const PAUSER: &str = "PAUSER";
pub const FEE_MANAGER: &str = "FEE_MANAGER";
pub const VALIDATOR_MANAGER: &str = "VALIDATOR_MANAGER";
pub const UPDATER_MANAGER: &str = "UPDATER_MANAGER";
pub const MIGRATOR: &str = "MIGRATOR";
pub const ROLES: [&str; 6] = [
    DEFAULT_ADMIN,
    PAUSER,
    FEE_MANAGER,
    VALIDATOR_MANAGER,
    UPDATER_MANAGER,
    MIGRATOR,
];

pub fn initialized(env: &Env) -> bool {
    env.storage().instance().has(&DataKey::RolesInitialized)
}

fn validate_role(env: &Env, role: &Symbol) -> Result<(), Error> {
    if ROLES.iter().any(|name| Symbol::new(env, name) == *role) {
        Ok(())
    } else {
        Err(Error::InvalidInput)
    }
}

pub fn has_role(env: &Env, role: &Symbol, address: &Address) -> bool {
    env.storage()
        .instance()
        .get(&DataKey::Role(role.clone(), address.clone()))
        .unwrap_or(false)
}

pub fn require_role(env: &Env, role: &Symbol, address: &Address) -> Result<(), Error> {
    if !initialized(env) {
        return Err(Error::NotInitialized);
    }
    address.require_auth();
    if !has_role(env, role, address) {
        return Err(Error::Unauthorized);
    }
    bump_instance(env);
    Ok(())
}

pub fn get_role_admin(env: &Env, role: &Symbol) -> Symbol {
    env.storage()
        .instance()
        .get(&DataKey::RoleAdmin(role.clone()))
        .unwrap_or_else(|| Symbol::new(env, DEFAULT_ADMIN))
}

/// Called only by initialize, or by an authenticated legacy-admin migration.
pub fn initialize(env: &Env, admin: &Address) -> Result<(), Error> {
    if initialized(env) {
        return Err(Error::AlreadyInitialized);
    }
    admin.require_auth();
    env.storage()
        .instance()
        .set(&DataKey::RolesInitialized, &true);
    env.storage().instance().set(&DataKey::RoleAdminCount, &1u32);
    for name in ROLES {
        let role = Symbol::new(env, name);
        env.storage()
            .instance()
            .set(&DataKey::Role(role.clone(), admin.clone()), &true);
        env.events().publish(
            (Symbol::new(env, "role_granted"), role),
            (admin.clone(), admin.clone()),
        );
    }
    bump_instance(env);
    Ok(())
}

pub fn grant_role(
    env: &Env,
    caller: &Address,
    role: &Symbol,
    account: &Address,
) -> Result<(), Error> {
    validate_role(env, role)?;
    require_role(env, &get_role_admin(env, role), caller)?;
    if has_role(env, role, account) {
        return Ok(());
    }
    if *role == Symbol::new(env, DEFAULT_ADMIN) {
        let count: u32 = env
            .storage()
            .instance()
            .get(&DataKey::RoleAdminCount)
            .unwrap_or(0);
        env.storage().instance().set(
            &DataKey::RoleAdminCount,
            &count.checked_add(1).ok_or(Error::Overflow)?,
        );
    }
    env.storage()
        .instance()
        .set(&DataKey::Role(role.clone(), account.clone()), &true);
    env.events().publish(
        (Symbol::new(env, "role_granted"), role.clone()),
        (account.clone(), caller.clone()),
    );
    Ok(())
}

fn remove_role(
    env: &Env,
    caller: &Address,
    role: &Symbol,
    account: &Address,
) -> Result<(), Error> {
    if !has_role(env, role, account) {
        return Ok(());
    }
    if *role == Symbol::new(env, DEFAULT_ADMIN) {
        let count: u32 = env
            .storage()
            .instance()
            .get(&DataKey::RoleAdminCount)
            .unwrap_or(0);
        if count <= 1 {
            return Err(Error::Unauthorized);
        }
        env.storage()
            .instance()
            .set(&DataKey::RoleAdminCount, &(count - 1));
    }
    env.storage()
        .instance()
        .remove(&DataKey::Role(role.clone(), account.clone()));
    env.events().publish(
        (Symbol::new(env, "role_revoked"), role.clone()),
        (account.clone(), caller.clone()),
    );
    Ok(())
}

pub fn revoke_role(
    env: &Env,
    caller: &Address,
    role: &Symbol,
    account: &Address,
) -> Result<(), Error> {
    validate_role(env, role)?;
    require_role(env, &get_role_admin(env, role), caller)?;
    remove_role(env, caller, role, account)
}

pub fn renounce_role(env: &Env, account: &Address, role: &Symbol) -> Result<(), Error> {
    validate_role(env, role)?;
    require_role(env, role, account)?;
    remove_role(env, account, role, account)
}

pub fn set_role_admin(
    env: &Env,
    caller: &Address,
    role: &Symbol,
    admin_role: &Symbol,
) -> Result<(), Error> {
    validate_role(env, role)?;
    validate_role(env, admin_role)?;
    require_role(env, &Symbol::new(env, DEFAULT_ADMIN), caller)?;
    // The root role always administers itself; operational hierarchies can be changed.
    if *role == Symbol::new(env, DEFAULT_ADMIN) {
        return Err(Error::InvalidInput);
    }
    let old = get_role_admin(env, role);
    env.storage()
        .instance()
        .set(&DataKey::RoleAdmin(role.clone()), admin_role);
    env.events().publish(
        (Symbol::new(env, "role_admin_changed"), role.clone()),
        (old, admin_role.clone(), caller.clone()),
    );
    Ok(())
}
