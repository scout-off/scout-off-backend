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
    env.as_contract(&id, || {
        for name in ROLES {
            assert!(has_role(&env, &Symbol::new(&env, name), &admin));
        }
        let root = Symbol::new(&env, DEFAULT_ADMIN);
        let pause = Symbol::new(&env, PAUSER);
        let fees = Symbol::new(&env, FEE_MANAGER);
        assert_eq!(
            grant_role(&env, &outsider, &pause, &member),
            Err(Error::Unauthorized)
        );
        assert_eq!(
            require_role(&env, &pause, &outsider),
            Err(Error::Unauthorized)
        );
        assert_eq!(
            revoke_role(&env, &outsider, &root, &admin),
            Err(Error::Unauthorized)
        );
        assert_eq!(
            revoke_role(&env, &admin, &root, &admin),
            Err(Error::Unauthorized)
        );
        assert_eq!(
            renounce_role(&env, &admin, &root),
            Err(Error::Unauthorized)
        );
        grant_role(&env, &admin, &pause, &member).unwrap();
        let events = env.events().all().len();
        grant_role(&env, &admin, &pause, &member).unwrap();
        assert_eq!(env.events().all().len(), events); // Idempotent grants.
        require_role(&env, &pause, &member).unwrap();
        assert_eq!(
            require_role(&env, &fees, &member),
            Err(Error::Unauthorized)
        );
        set_role_admin(&env, &admin, &fees, &pause).unwrap();
        grant_role(&env, &member, &fees, &outsider).unwrap();
        assert!(has_role(&env, &fees, &outsider));
        revoke_role(&env, &member, &fees, &outsider).unwrap();
        assert!(!has_role(&env, &fees, &outsider));
        renounce_role(&env, &member, &pause).unwrap();
        assert!(!has_role(&env, &pause, &member));
        grant_role(&env, &admin, &root, &member).unwrap();
        renounce_role(&env, &admin, &root).unwrap();
        assert_eq!(
            revoke_role(&env, &member, &root, &member),
            Err(Error::Unauthorized)
        );
        assert_eq!(initialize(&env, &outsider), Err(Error::AlreadyInitialized));
    });
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
    assert!(client.try_check(&admin, &Symbol::new(&env, DEFAULT_ADMIN)).is_err());
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
        env.as_contract(&id, || {
            let role = Symbol::new(&env, DEFAULT_ADMIN);
            for op in operations {
                // Pick a currently authorized root to administer every transition.
                let caller = if has_role(&env, &role, &admin) {
                    admin.clone()
                } else {
                    member.clone()
                };
                match op {
                    0 => {
                        let _ = grant_role(&env, &caller, &role, &admin);
                    }
                    1 => {
                        let _ = grant_role(&env, &caller, &role, &member);
                    }
                    2 => {
                        let _ = revoke_role(&env, &caller, &role, &admin);
                    }
                    _ => {
                        let _ = renounce_role(&env, &caller, &role);
                    }
                }
                assert!(has_role(&env, &role, &admin) || has_role(&env, &role, &member));
            }
        });
    }
}
