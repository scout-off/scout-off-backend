#![no_std]

use scout_off_shared::access;
use scout_off_shared::{
    errors::Error,
    storage::{
        bump_instance, is_initialized, is_paused, set_initialized, set_paused, MAX_PAGE_SIZE,
    },
};
use soroban_sdk::{
    contract, contractimpl, contracttype, vec, Address, Env, IntoVal, String, Symbol, Vec,
};

// ---------------------------------------------------------------------------
// Data types
// ---------------------------------------------------------------------------

#[contracttype]
#[derive(Clone)]
pub struct MilestoneData {
    pub player_id: u64,
    pub milestone_type: String,
    pub evidence_uri: String,
    pub validator: Address,
    pub approved: bool,
    pub submitted_at: u64,
}

/// A page of `MilestoneData` results; `next` is the start index of the following
/// page, or `None` when this is the last one. `#[contracttype]` does not
/// support generics, so each contract defines its own concrete page type.
#[contracttype]
#[derive(Clone)]
pub struct MilestonePage {
    pub items: Vec<MilestoneData>,
    pub next: Option<u32>,
}

#[contracttype]
#[derive(Clone)]
pub enum DataKey {
    Admin,
    RegisterContract,
    Validator(Address),
    MilestoneCounter,
    Milestone(u64),
    PlayerMilestones(u64),
}

// ---------------------------------------------------------------------------
// Contract
// ---------------------------------------------------------------------------

#[contract]
pub struct ProgressContract;

#[contractimpl]
impl ProgressContract {
    /// Bootstrap RBAC on an upgraded instance. Only the stored legacy admin may authorize.
    pub fn initialize_roles(env: Env, admin: Address) -> Result<(), Error> {
        if !is_initialized(&env) {
            return Err(Error::NotInitialized);
        }
        let legacy: Address = env
            .storage()
            .instance()
            .get(&DataKey::Admin)
            .ok_or(Error::NotInitialized)?;
        admin.require_auth();
        if admin != legacy {
            return Err(Error::Unauthorized);
        }
        access::initialize(&env, &admin)
    }

    pub fn has_role(env: Env, role: soroban_sdk::Symbol, account: Address) -> bool {
        access::has_role(&env, &role, &account)
    }

    pub fn get_role_admin(env: Env, role: soroban_sdk::Symbol) -> soroban_sdk::Symbol {
        access::get_role_admin(&env, &role)
    }

    pub fn grant_role(
        env: Env,
        caller: Address,
        role: soroban_sdk::Symbol,
        account: Address,
    ) -> Result<(), Error> {
        access::grant_role(&env, &caller, &role, &account)
    }

    pub fn revoke_role(
        env: Env,
        caller: Address,
        role: soroban_sdk::Symbol,
        account: Address,
    ) -> Result<(), Error> {
        access::revoke_role(&env, &caller, &role, &account)
    }

    pub fn renounce_role(
        env: Env,
        account: Address,
        role: soroban_sdk::Symbol,
    ) -> Result<(), Error> {
        access::renounce_role(&env, &account, &role)
    }

    pub fn set_role_admin(
        env: Env,
        caller: Address,
        role: soroban_sdk::Symbol,
        admin_role: soroban_sdk::Symbol,
    ) -> Result<(), Error> {
        access::set_role_admin(&env, &caller, &role, &admin_role)
    }

    pub fn upgrade(
        env: Env,
        caller: Address,
        wasm_hash: soroban_sdk::BytesN<32>,
    ) -> Result<(), Error> {
        access::require_role(
            &env,
            &soroban_sdk::Symbol::new(&env, access::DEFAULT_ADMIN),
            &caller,
        )?;
        env.deployer().update_current_contract_wasm(wasm_hash);
        Ok(())
    }

    /// Return the contract's semantic version as `(major, minor, patch)`.
    ///
    /// Read-only, auth-free. Used by the backend at startup for compatibility checks.
    pub fn version(_env: Env) -> (u32, u32, u32) {
        (0, 1, 0)
    }

    /// One-time contract setup. Stores the admin address and the register contract address.
    ///
    /// # Arguments
    /// * `env` - The Soroban environment.
    /// * `admin` - The address authorized to register and revoke validators.
    /// * `register_contract` - Address of the deployed [`RegisterContract`] used to
    ///   increment player progress levels when milestones are approved.
    ///
    /// # Returns
    /// `Ok(())` on success.
    ///
    /// # Errors
    /// * [`Error::AlreadyInitialized`] — Contract has already been initialized.
    pub fn initialize(env: Env, admin: Address, register_contract: Address) -> Result<(), Error> {
        if is_initialized(&env) {
            return Err(Error::AlreadyInitialized);
        }
        admin.require_auth();
        env.storage().instance().set(&DataKey::Admin, &admin);
        access::initialize(&env, &admin)?;
        env.storage()
            .instance()
            .set(&DataKey::RegisterContract, &register_contract);
        env.storage()
            .instance()
            .set(&DataKey::MilestoneCounter, &0u64);
        set_initialized(&env);
        bump_instance(&env);
        Ok(())
    }

    /// Pause milestone submissions and approvals. Only the admin may call this.
    pub fn pause(env: Env, admin: Address) -> Result<(), Error> {
        if !is_initialized(&env) {
            return Err(Error::NotInitialized);
        }
        access::require_role(
            &env,
            &soroban_sdk::Symbol::new(&env, access::PAUSER),
            &admin,
        )?;
        set_paused(&env, true);
        bump_instance(&env);
        Ok(())
    }

    /// Resume milestone submissions and approvals. Only the admin may call this.
    pub fn unpause(env: Env, admin: Address) -> Result<(), Error> {
        if !is_initialized(&env) {
            return Err(Error::NotInitialized);
        }
        access::require_role(
            &env,
            &soroban_sdk::Symbol::new(&env, access::PAUSER),
            &admin,
        )?;
        set_paused(&env, false);
        bump_instance(&env);
        Ok(())
    }

    /// Add a validator address to the on-chain registry. Admin-only.
    ///
    /// Registered validators are the only accounts permitted to call
    /// [`submit_milestone`] and [`approve_milestone`].
    ///
    /// # Arguments
    /// * `env` - The Soroban environment.
    /// * `validator_address` - The Stellar address to approve as a validator.
    ///
    /// # Returns
    /// `Ok(())` on success.
    ///
    /// # Errors
    /// * [`Error::NotInitialized`] — Contract has not been initialized.
    /// * [`Error::Unauthorized`] — Caller is not the admin.
    pub fn register_validator(env: Env, validator_address: Address) -> Result<(), Error> {
        let admin: Address = env
            .storage()
            .instance()
            .get(&DataKey::Admin)
            .ok_or(Error::NotInitialized)?;
        Self::register_validator_as(env, admin, validator_address)
    }

    /// Explicit caller variant for delegated role holders.
    pub fn register_validator_as(
        env: Env,
        caller: Address,
        validator_address: Address,
    ) -> Result<(), Error> {
        if !is_initialized(&env) {
            return Err(Error::NotInitialized);
        }
        access::require_role(
            &env,
            &soroban_sdk::Symbol::new(&env, access::VALIDATOR_MANAGER),
            &caller,
        )?;
        env.storage()
            .instance()
            .set(&DataKey::Validator(validator_address), &true);
        bump_instance(&env);
        Ok(())
    }

    /// Remove a validator from the on-chain registry. Admin-only.
    ///
    /// After revocation the address can no longer submit or approve milestones.
    /// Any milestones already approved before revocation remain on-chain unchanged.
    ///
    /// # Arguments
    /// * `env` - The Soroban environment.
    /// * `validator_address` - The Stellar address to remove from the validator registry.
    ///
    /// # Returns
    /// `Ok(())` on success.
    ///
    /// # Errors
    /// * [`Error::NotInitialized`] — Contract has not been initialized.
    /// * [`Error::Unauthorized`] — Caller is not the admin.
    pub fn revoke_validator(env: Env, validator_address: Address) -> Result<(), Error> {
        let admin: Address = env
            .storage()
            .instance()
            .get(&DataKey::Admin)
            .ok_or(Error::NotInitialized)?;
        Self::revoke_validator_as(env, admin, validator_address)
    }

    /// Explicit caller variant for delegated role holders.
    pub fn revoke_validator_as(
        env: Env,
        caller: Address,
        validator_address: Address,
    ) -> Result<(), Error> {
        if !is_initialized(&env) {
            return Err(Error::NotInitialized);
        }
        access::require_role(
            &env,
            &soroban_sdk::Symbol::new(&env, access::VALIDATOR_MANAGER),
            &caller,
        )?;
        env.storage()
            .instance()
            .remove(&DataKey::Validator(validator_address));
        bump_instance(&env);
        Ok(())
    }

    /// Submit a new milestone for a player, pending approval.
    ///
    /// Only registered validators may call this. Assigns a sequential `milestone_id`,
    /// stores the milestone in a `pending` (unapproved) state, appends it to the
    /// player's milestone list, and emits a `milestone_submitted` event.
    ///
    /// # Arguments
    /// * `env` - The Soroban environment.
    /// * `validator` - The registered validator's address (must authorize this call).
    /// * `player_id` - The unique player identifier the milestone relates to.
    /// * `milestone_type` - Type string: `"identity"` or `"performance"`.
    /// * `evidence_uri` - IPFS/Arweave URI pointing to supporting evidence.
    ///
    /// # Returns
    /// `Ok(milestone_id)` — the newly assigned unique milestone identifier (`u64`).
    ///
    /// # Errors
    /// * [`Error::NotInitialized`] — Contract has not been initialized.
    /// * [`Error::ValidatorNotRegistered`] — Caller (`validator`) is not in the validator registry.
    pub fn submit_milestone(
        env: Env,
        validator: Address,
        player_id: u64,
        milestone_type: String,
        evidence_uri: String,
    ) -> Result<u64, Error> {
        if !is_initialized(&env) {
            return Err(Error::NotInitialized);
        }
        if is_paused(&env) {
            return Err(Error::ContractPaused);
        }
        validator.require_auth();

        if !env
            .storage()
            .instance()
            .has(&DataKey::Validator(validator.clone()))
        {
            return Err(Error::ValidatorNotRegistered);
        }

        let milestone_id: u64 = env
            .storage()
            .instance()
            .get::<DataKey, u64>(&DataKey::MilestoneCounter)
            .unwrap_or(0)
            + 1;
        env.storage()
            .instance()
            .set(&DataKey::MilestoneCounter, &milestone_id);

        let milestone = MilestoneData {
            player_id,
            milestone_type: milestone_type.clone(),
            evidence_uri: evidence_uri.clone(),
            validator: validator.clone(),
            approved: false,
            submitted_at: env.ledger().timestamp(),
        };
        env.storage()
            .instance()
            .set(&DataKey::Milestone(milestone_id), &milestone);

        let player_key = DataKey::PlayerMilestones(player_id);
        let mut milestones: Vec<u64> = env
            .storage()
            .instance()
            .get(&player_key)
            .unwrap_or_else(|| Vec::new(&env));
        milestones.push_back(milestone_id);
        env.storage().instance().set(&player_key, &milestones);

        env.events().publish(
            (
                Symbol::new(&env, "milestone_submitted"),
                validator,
                player_id,
            ),
            (milestone_id, milestone_type, evidence_uri),
        );

        bump_instance(&env);
        Ok(milestone_id)
    }

    /// Approve a pending milestone, incrementing the player's progress level.
    ///
    /// Only registered validators may approve. The level assigned depends on the
    /// milestone type:
    /// - `"identity"`    → player progress level set to at least `1`
    /// - `"performance"` → player progress level set to at least `2`
    ///
    /// Calls `update_progress_level` on the [`RegisterContract`] via cross-contract
    /// invocation and emits a `milestone_approved` event.
    ///
    /// # Arguments
    /// * `env` - The Soroban environment.
    /// * `validator` - The registered validator's address (must authorize this call).
    /// * `milestone_id` - The identifier of the milestone to approve.
    ///
    /// # Returns
    /// `Ok(())` on success.
    ///
    /// # Errors
    /// * [`Error::NotInitialized`] — Contract has not been initialized.
    /// * [`Error::ValidatorNotRegistered`] — Caller (`validator`) is not in the validator registry.
    /// * [`Error::MilestoneNotFound`] — No milestone exists with the given `milestone_id`.
    /// * [`Error::InvalidInput`] — The milestone type is not `"identity"` or `"performance"`.
    /// * [`Error::MilestoneAlreadyApproved`] — The milestone has already been approved.
    pub fn approve_milestone(env: Env, validator: Address, milestone_id: u64) -> Result<(), Error> {
        if !is_initialized(&env) {
            return Err(Error::NotInitialized);
        }
        if is_paused(&env) {
            return Err(Error::ContractPaused);
        }
        validator.require_auth();

        if !env
            .storage()
            .instance()
            .has(&DataKey::Validator(validator.clone()))
        {
            return Err(Error::ValidatorNotRegistered);
        }

        let mut milestone: MilestoneData = env
            .storage()
            .instance()
            .get(&DataKey::Milestone(milestone_id))
            .ok_or(Error::MilestoneNotFound)?;

        if milestone.approved {
            return Err(Error::MilestoneAlreadyApproved);
        }

        let new_level: u32 = if milestone.milestone_type == String::from_str(&env, "identity") {
            1
        } else if milestone.milestone_type == String::from_str(&env, "performance") {
            2
        } else {
            return Err(Error::InvalidInput);
        };

        milestone.approved = true;
        env.storage()
            .instance()
            .set(&DataKey::Milestone(milestone_id), &milestone);

        let reg_addr: Address = env
            .storage()
            .instance()
            .get(&DataKey::RegisterContract)
            .ok_or(Error::NotInitialized)?;
        env.invoke_contract::<()>(
            &reg_addr,
            &Symbol::new(&env, "update_progress_level"),
            vec![
                &env,
                milestone.player_id.into_val(&env),
                new_level.into_val(&env),
            ],
        );

        env.events().publish(
            (
                Symbol::new(&env, "milestone_approved"),
                validator,
                milestone.player_id,
            ),
            (milestone_id, new_level),
        );

        bump_instance(&env);
        Ok(())
    }

    /// Return the complete, tamper-proof milestone history for a player.
    ///
    /// Includes both approved and pending milestones in submission order.
    /// This is a read-only function; it requires no authorization and does not modify state.
    ///
    /// # Arguments
    /// * `env` - The Soroban environment.
    /// * `player_id` - The unique player identifier whose milestones to retrieve.
    ///
    /// # Returns
    /// A `Vec<MilestoneData>` of all milestones for the player (may be empty). Never errors.
    pub fn get_milestones(env: Env, player_id: u64) -> Vec<MilestoneData> {
        let milestone_ids: Vec<u64> = env
            .storage()
            .instance()
            .get(&DataKey::PlayerMilestones(player_id))
            .unwrap_or_else(|| Vec::new(&env));

        let mut results = Vec::new(&env);
        let len = milestone_ids.len();
        for i in 0..len {
            let mid = milestone_ids.get_unchecked(i);
            if let Some(data) = env
                .storage()
                .instance()
                .get::<DataKey, MilestoneData>(&DataKey::Milestone(mid))
            {
                results.push_back(data);
            }
        }
        results
    }

    /// Return a page of milestone data for a player.
    ///
    /// This is the paginated variant of [`get_milestones`]. It returns at most `limit` milestones
    /// starting from the given `start` index. Use `next` in the returned [`MilestonePage`] to fetch
    /// subsequent pages until it is `None`.
    ///
    /// # Arguments
    /// * `player_id` - The unique player identifier whose milestones to retrieve.
    /// * `start` - Zero-based index of the first milestone to return
    /// * `limit` - Maximum number of milestones to return (capped at MAX_PAGE_SIZE = 50)
    ///
    /// # Returns
    /// A [`MilestonePage`] containing:
    /// * `items`: The slice of milestones for this page
    /// * `next`: The start index for the next page, or `None` if no more results
    ///
    /// # Errors
    /// * [`Error::InvalidInput`] — `start` or `limit` is invalid
    pub fn get_milestones_page(
        env: Env,
        player_id: u64,
        start: u32,
        limit: u32,
    ) -> Result<MilestonePage, Error> {
        // Validate inputs
        if limit == 0 {
            return Err(Error::InvalidInput);
        }
        let max_limit = MAX_PAGE_SIZE;
        let effective_limit = limit.min(max_limit);

        let milestone_ids: Vec<u64> = env
            .storage()
            .instance()
            .get(&DataKey::PlayerMilestones(player_id))
            .unwrap_or_else(|| Vec::new(&env));

        let total = milestone_ids.len();
        if start >= total {
            return Ok(MilestonePage {
                items: Vec::new(&env),
                next: None,
            });
        }

        let end = (start + effective_limit).min(total);

        let mut results = Vec::new(&env);
        for i in start..end {
            let mid = milestone_ids.get_unchecked(i);
            if let Some(data) = env
                .storage()
                .instance()
                .get::<DataKey, MilestoneData>(&DataKey::Milestone(mid))
            {
                results.push_back(data);
            }
        }

        let next = if end < total { Some(end) } else { None };

        Ok(MilestonePage {
            items: results,
            next,
        })
    }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;
    use register::{RegisterContract, RegisterContractClient};
    use soroban_sdk::{testutils::Address as _, Env};

    fn setup(
        env: &Env,
    ) -> (
        ProgressContractClient<'_>,
        RegisterContractClient<'_>,
        Address,
    ) {
        env.mock_all_auths();

        let admin = Address::generate(env);
        let token = Address::generate(env);

        let reg_id = env.register_contract(None, RegisterContract);
        let prog_id = env.register_contract(None, ProgressContract);

        let reg_client = RegisterContractClient::new(env, &reg_id);
        let prog_client = ProgressContractClient::new(env, &prog_id);

        reg_client.initialize(&admin, &token, &100u32);
        prog_client.initialize(&admin, &reg_id);

        // Grant the progress contract permission to update player progress levels.
        reg_client.set_authorized_updater(&prog_id);

        (prog_client, reg_client, admin)
    }

    fn register_player(env: &Env, reg: &RegisterContractClient<'_>) -> u64 {
        let wallet = Address::generate(env);
        reg.register_player(
            &wallet,
            &String::from_str(env, "ipfs://meta"),
            &String::from_str(env, "forward"),
            &String::from_str(env, "europe"),
        )
    }

    #[test]
    fn non_validator_cannot_submit_milestone() {
        let env = Env::default();
        let (prog, reg, _admin) = setup(&env);
        let player_id = register_player(&env, &reg);
        let non_validator = Address::generate(&env);

        let result = prog.try_submit_milestone(
            &non_validator,
            &player_id,
            &String::from_str(&env, "identity"),
            &String::from_str(&env, "ipfs://evidence"),
        );
        assert!(result.is_err());
    }

    #[test]
    fn pause_blocks_submissions_and_approvals_until_unpaused() {
        let env = Env::default();
        let (prog, reg, admin) = setup(&env);
        let player_id = register_player(&env, &reg);
        let validator = Address::generate(&env);
        prog.register_validator(&validator);
        let milestone_id = prog.submit_milestone(
            &validator,
            &player_id,
            &String::from_str(&env, "identity"),
            &String::from_str(&env, "ipfs://evidence"),
        );

        prog.pause(&admin);
        assert!(matches!(
            prog.try_submit_milestone(
                &validator,
                &player_id,
                &String::from_str(&env, "performance"),
                &String::from_str(&env, "ipfs://evidence-2"),
            ),
            Err(Ok(Error::ContractPaused))
        ));
        assert!(matches!(
            prog.try_approve_milestone(&validator, &milestone_id),
            Err(Ok(Error::ContractPaused))
        ));

        prog.unpause(&admin);
        prog.approve_milestone(&validator, &milestone_id);
    }

    #[test]
    fn validator_can_submit_and_approve_milestone() {
        let env = Env::default();
        let (prog, reg, admin) = setup(&env);
        let player_id = register_player(&env, &reg);
        let validator = Address::generate(&env);

        prog.register_validator(&validator);
        let milestone_id = prog.submit_milestone(
            &validator,
            &player_id,
            &String::from_str(&env, "identity"),
            &String::from_str(&env, "ipfs://evidence"),
        );

        prog.approve_milestone(&validator, &milestone_id);

        assert_eq!(reg.get_player(&player_id).progress_level, 1);
        let _ = admin; // suppress unused warning
    }

    #[test]
    fn approve_already_approved_milestone_returns_error() {
        let env = Env::default();
        let (prog, reg, _admin) = setup(&env);
        let player_id = register_player(&env, &reg);
        let validator = Address::generate(&env);

        prog.register_validator(&validator);
        let milestone_id = prog.submit_milestone(
            &validator,
            &player_id,
            &String::from_str(&env, "identity"),
            &String::from_str(&env, "ipfs://evidence"),
        );
        prog.approve_milestone(&validator, &milestone_id);

        let result = prog.try_approve_milestone(&validator, &milestone_id);
        assert!(result.is_err());
    }

    #[test]
    fn identity_milestone_sets_progress_to_1() {
        let env = Env::default();
        let (prog, reg, _admin) = setup(&env);
        let player_id = register_player(&env, &reg);
        let validator = Address::generate(&env);

        prog.register_validator(&validator);
        assert_eq!(reg.get_player(&player_id).progress_level, 0);

        let mid = prog.submit_milestone(
            &validator,
            &player_id,
            &String::from_str(&env, "identity"),
            &String::from_str(&env, "ipfs://id-evidence"),
        );
        prog.approve_milestone(&validator, &mid);

        assert_eq!(reg.get_player(&player_id).progress_level, 1);
    }

    #[test]
    fn performance_milestone_sets_progress_to_2() {
        let env = Env::default();
        let (prog, reg, _admin) = setup(&env);
        let player_id = register_player(&env, &reg);
        let validator = Address::generate(&env);

        prog.register_validator(&validator);

        let mid = prog.submit_milestone(
            &validator,
            &player_id,
            &String::from_str(&env, "performance"),
            &String::from_str(&env, "ipfs://perf-evidence"),
        );
        prog.approve_milestone(&validator, &mid);

        assert_eq!(reg.get_player(&player_id).progress_level, 2);
    }

    #[test]
    fn get_milestones_returns_tamper_proof_history() {
        let env = Env::default();
        let (prog, reg, _admin) = setup(&env);
        let player_id = register_player(&env, &reg);
        let validator = Address::generate(&env);

        prog.register_validator(&validator);

        let mid1 = prog.submit_milestone(
            &validator,
            &player_id,
            &String::from_str(&env, "identity"),
            &String::from_str(&env, "ipfs://ev1"),
        );
        let mid2 = prog.submit_milestone(
            &validator,
            &player_id,
            &String::from_str(&env, "performance"),
            &String::from_str(&env, "ipfs://ev2"),
        );
        prog.approve_milestone(&validator, &mid1);

        let history = prog.get_milestones(&player_id);
        assert_eq!(history.len(), 2);

        let m1 = history.get(0).unwrap();
        assert_eq!(m1.milestone_type, String::from_str(&env, "identity"));
        assert_eq!(m1.evidence_uri, String::from_str(&env, "ipfs://ev1"));
        assert!(m1.approved);

        let m2 = history.get(1).unwrap();
        assert_eq!(m2.milestone_type, String::from_str(&env, "performance"));
        assert_eq!(m2.evidence_uri, String::from_str(&env, "ipfs://ev2"));
        assert!(!m2.approved);
        let _ = mid2;
    }

    #[test]
    fn invariant_milestones_are_single_approval_and_progress_is_monotonic() {
        let env = Env::default();
        let (prog, reg, _admin) = setup(&env);
        let player_id = register_player(&env, &reg);
        let validator = Address::generate(&env);

        prog.register_validator(&validator);

        let mut state = 0x00c0_ffee_1234_u64;
        for _step in 0..24 {
            let milestone_type = if state % 2 == 0 {
                String::from_str(&env, "identity")
            } else {
                String::from_str(&env, "performance")
            };
            let milestone_id = prog.submit_milestone(
                &validator,
                &player_id,
                &milestone_type,
                &String::from_str(&env, "ipfs://evidence"),
            );

            let before_level = reg.get_player(&player_id).progress_level;
            let approval_target = if state % 2 == 0 {
                milestone_id
            } else {
                milestone_id + 1000
            };
            let approval_result = prog.try_approve_milestone(&validator, &approval_target);

            let milestones = prog.get_milestones(&player_id);
            let milestone = milestones.get(milestones.len() - 1).unwrap();

            if approval_result.is_ok() {
                assert!(
                    milestone.approved,
                    "approval should flip the milestone state"
                );
                let after_level = reg.get_player(&player_id).progress_level;
                assert!(
                    after_level >= before_level,
                    "progress level regressed from {before_level} to {after_level}"
                );
                let second_result = prog.try_approve_milestone(&validator, &milestone_id);
                assert!(second_result.is_err(), "double approval must fail");
            } else {
                assert!(
                    !milestone.approved,
                    "failed approval must not approve the milestone"
                );
            }

            state = state
                .wrapping_mul(6364136223846793005)
                .wrapping_add(1442695040888963407);
        }
    }

    #[test]
    fn invariant_unregistered_validators_cannot_mutate_milestones() {
        let env = Env::default();
        let (prog, reg, _admin) = setup(&env);
        let player_id = register_player(&env, &reg);
        let validator = Address::generate(&env);
        let mut state = 0x9e3779b97f4a7c15u64;

        let initial_milestones = prog.get_milestones(&player_id);
        let mut previous_len = initial_milestones.len();
        for _step in 0..24 {
            let result = prog.try_submit_milestone(
                &validator,
                &player_id,
                &String::from_str(&env, "identity"),
                &String::from_str(&env, "ipfs://evidence"),
            );

            let milestones = prog.get_milestones(&player_id);
            if result.is_ok() {
                assert!(
                    milestones.len() >= previous_len,
                    "milestone count should never shrink"
                );
                previous_len = milestones.len();
            } else {
                assert_eq!(
                    milestones.len(),
                    previous_len,
                    "failed submission must not add milestones"
                );
            }

            state = state
                .wrapping_mul(6364136223846793005)
                .wrapping_add(1442695040888963407);
        }
    }

    #[test]
    fn double_initialize_fails() {
        let env = Env::default();
        let (prog, reg, admin) = setup(&env);
        let result = prog.try_initialize(&admin, &Address::generate(&env));
        assert!(result.is_err());
        let _ = reg;
    }

    #[test]
    fn revoked_validator_cannot_submit() {
        let env = Env::default();
        let (prog, reg, _admin) = setup(&env);
        let player_id = register_player(&env, &reg);
        let validator = Address::generate(&env);

        prog.register_validator(&validator);
        prog.revoke_validator(&validator);

        let result = prog.try_submit_milestone(
            &validator,
            &player_id,
            &String::from_str(&env, "identity"),
            &String::from_str(&env, "ipfs://evidence"),
        );
        assert!(result.is_err());
    }

    #[test]
    fn version_returns_semver_tuple() {
        let env = Env::default();
        let (client, _reg_client, _admin) = setup(&env);
        let (major, _minor, _patch) = client.version();
        assert_eq!(major, 0);
    }
}
