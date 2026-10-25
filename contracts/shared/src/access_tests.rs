use super::access::*;
use crate::Error;
use soroban_sdk::{
    contract, contractimpl,
    testutils::{Address as _, Events as _},
    Address, Env, Symbol,
};

#[contract]
struct AccessHarness;
#[contractimpl]
impl AccessHarness {
    pub fn initialize(env: Env, admin: Address) -> Result<(), Error> {
        admin.require_auth();
        initialize(&env, &admin)
    }

    pub fn check(env: Env, caller: Address, role: Symbol) -> Result<(), Error> {
        require_role(&env, &role, &caller)
    }
}

#[test]
fn grant_revoke_renounce_hierarchy_and_last_admin() {
    let env = Env::default();
    env.mock_all_auths();
    let id = env.register_contract(None, AccessHarness);
    let admin = Address::generate(&env);
    let member = Address::generate(&env);
    let outsider = Address::generate(&env);
    AccessHarnessClient::new(&env, &id).initialize(&admin);
    // Each step runs in its own contract frame: an address may only be
    // authorized once per frame, so chaining role calls in one frame fails
    // with Error(Auth, ExistingValue).
    let call = |f: &dyn Fn() -> Result<(), Error>| env.as_contract(&id, f);
    let holds = |role: &Symbol, who: &Address| env.as_contract(&id, || has_role(&env, role, who));
    for name in ROLES {
        assert!(holds(&Symbol::new(&env, name), &admin));
    }
    let root = Symbol::new(&env, DEFAULT_ADMIN);
    let pause = Symbol::new(&env, PAUSER);
    let fees = Symbol::new(&env, FEE_MANAGER);
    assert_eq!(
        call(&|| grant_role(&env, &outsider, &pause, &member)),
        Err(Error::Unauthorized)
    );
    assert_eq!(
        call(&|| require_role(&env, &pause, &outsider)),
        Err(Error::Unauthorized)
    );
    assert_eq!(
        call(&|| revoke_role(&env, &outsider, &root, &admin)),
        Err(Error::Unauthorized)
    );
    assert_eq!(
        call(&|| revoke_role(&env, &admin, &root, &admin)),
        Err(Error::Unauthorized)
    );
    assert_eq!(
        call(&|| renounce_role(&env, &admin, &root)),
        Err(Error::Unauthorized)
    );
    call(&|| grant_role(&env, &admin, &pause, &member)).unwrap();
    let events = env.events().all().len();
    call(&|| grant_role(&env, &admin, &pause, &member)).unwrap();
    assert_eq!(env.events().all().len(), events); // Idempotent grants.
    call(&|| require_role(&env, &pause, &member)).unwrap();
    assert_eq!(
        call(&|| require_role(&env, &fees, &member)),
        Err(Error::Unauthorized)
    );
    call(&|| set_role_admin(&env, &admin, &fees, &pause)).unwrap();
    call(&|| grant_role(&env, &member, &fees, &outsider)).unwrap();
    assert!(holds(&fees, &outsider));
    call(&|| revoke_role(&env, &member, &fees, &outsider)).unwrap();
    assert!(!holds(&fees, &outsider));
    call(&|| renounce_role(&env, &member, &pause)).unwrap();
    assert!(!holds(&pause, &member));
    call(&|| grant_role(&env, &admin, &root, &member)).unwrap();
    call(&|| renounce_role(&env, &admin, &root)).unwrap();
    assert_eq!(
        call(&|| revoke_role(&env, &member, &root, &member)),
        Err(Error::Unauthorized)
    );
    assert_eq!(
        call(&|| initialize(&env, &outsider)),
        Err(Error::AlreadyInitialized)
    );
}

#[test]
fn valid_membership_still_requires_signature() {
    let env = Env::default();
    let id = env.register_contract(None, AccessHarness);
    let admin = Address::generate(&env);
    let client = AccessHarnessClient::new(&env, &id);
    env.mock_all_auths();
    client.initialize(&admin);
    env.mock_auths(&[]);
    assert!(client
        .try_check(&admin, &Symbol::new(&env, DEFAULT_ADMIN))
        .is_err());
}

proptest::proptest! {
    #[test]
    fn invariants_root_survives_arbitrary_revocations(operations in proptest::collection::vec(0u8..4, 1..40)) {
        let env = Env::default();
        env.mock_all_auths();
        let id = env.register_contract(None, AccessHarness);
        let admin = Address::generate(&env);
        let member = Address::generate(&env);
        AccessHarnessClient::new(&env, &id).initialize(&admin);
        let role = Symbol::new(&env, DEFAULT_ADMIN);
        let holds = |who: &Address| env.as_contract(&id, || has_role(&env, &role, who));
        for op in operations {
            // Pick a currently authorized root to administer every transition.
            let caller = if holds(&admin) {
                admin.clone()
            } else {
                member.clone()
            };
            // One frame per operation; see grant_revoke_renounce_hierarchy_and_last_admin.
            env.as_contract(&id, || {
                let _ = match op {
                    0 => grant_role(&env, &caller, &role, &admin),
                    1 => grant_role(&env, &caller, &role, &member),
                    2 => revoke_role(&env, &caller, &role, &admin),
                    _ => renounce_role(&env, &caller, &role),
                };
            });
            assert!(holds(&admin) || holds(&member));
        }
    }
}
