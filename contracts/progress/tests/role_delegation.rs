use progress::{DataKey, ProgressContract, ProgressContractClient};
use scout_off_shared::{access, storage};
use soroban_sdk::{testutils::Address as _, Address, Env, Symbol};

#[test]
fn delegated_validator_manager_is_independent_of_pauser_and_legacy_admin() {
    let env = Env::default();
    env.mock_all_auths();
    let id = env.register_contract(None, ProgressContract);
    let client = ProgressContractClient::new(&env, &id);
    let admin = Address::generate(&env);
    let manager = Address::generate(&env);
    let validator = Address::generate(&env);
    client.initialize(&admin, &Address::generate(&env));
    let role = Symbol::new(&env, access::VALIDATOR_MANAGER);
    client.grant_role(&admin, &role, &manager);
    client.revoke_role(&admin, &role, &admin);

    assert!(client.try_register_validator(&validator).is_err());
    assert!(client.try_pause(&manager).is_err());
    client.register_validator_as(&manager, &validator);
    env.as_contract(&id, || {
        assert!(env
            .storage()
            .instance()
            .get::<_, bool>(&DataKey::Validator(validator.clone()))
            .unwrap());
    });
    client.revoke_validator_as(&manager, &validator);
    env.as_contract(&id, || {
        assert!(!env
            .storage()
            .instance()
            .has(&DataKey::Validator(validator.clone())));
    });
    client.revoke_role(&admin, &role, &manager);
    assert!(client.try_register_validator_as(&manager, &validator).is_err());
}

#[test]
fn upgraded_legacy_instance_can_only_bootstrap_once_by_stored_admin() {
    let env = Env::default();
    env.mock_all_auths();
    let id = env.register_contract(None, ProgressContract);
    let client = ProgressContractClient::new(&env, &id);
    let admin = Address::generate(&env);
    let outsider = Address::generate(&env);
    // Model storage from an initialized pre-RBAC deployment.
    env.as_contract(&id, || {
        storage::set_initialized(&env);
        env.storage().instance().set(&DataKey::Admin, &admin);
    });
    assert!(client.try_pause(&admin).is_err());
    assert!(client.try_initialize_roles(&outsider).is_err());
    assert!(!client.has_role(&Symbol::new(&env, access::DEFAULT_ADMIN), &outsider));
    client.initialize_roles(&admin);
    for name in access::ROLES {
        assert!(client.has_role(&Symbol::new(&env, name), &admin));
    }
    client.pause(&admin);
    client.unpause(&admin);
    let pauser = Symbol::new(&env, access::PAUSER);
    client.revoke_role(&admin, &pauser, &admin);
    assert!(client.try_initialize_roles(&admin).is_err());
    assert!(!client.has_role(&pauser, &admin));
}
