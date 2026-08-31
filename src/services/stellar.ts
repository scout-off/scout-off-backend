import { SorobanRpc, Networks } from '@stellar/stellar-sdk';
import config from '../config';

const server = new SorobanRpc.Server(config.sorobanRpcUrl);

export { server };

export function networkPassphrase(): string {
  return config.network === 'mainnet'
    ? Networks.PUBLIC
    : Networks.TESTNET;
}

export async function getLatestLedger(): Promise<number> {
  const ledger = await server.getLatestLedger();
  return ledger.sequence;
}

export type PaymentStatus = 'pending' | 'submitted' | 'failed';

export interface ContactPaymentResult {
  transactionId: string;
  status: PaymentStatus;
}

export class PaymentError extends Error {
  constructor(
    message: string,
    public readonly code: 'INSUFFICIENT_FUNDS' | 'INVALID_ACCOUNT' | 'NETWORK_ERROR' | 'UNKNOWN',
  ) {
    super(message);
    this.name = 'PaymentError';
  }
}

/**
 * Ping the Soroban RPC to verify network reachability.
 */
export async function stellarHealth(): Promise<boolean> {
  try {
    await server.getLatestLedger();
    return true;
  } catch {
    return false;
  }
}

/**
 * Stub: check whether a scout has an active on-chain subscription.
 * Replace with a real Soroban `is_subscribed` contract call when ready.
 */
export async function isSubscribed(
  scoutWallet: string,
): Promise<{ active: boolean; expiresAt: string | null }> {
  if (!scoutWallet) {
    throw new PaymentError('Missing scoutWallet', 'INVALID_ACCOUNT');
  }
  // TODO: invoke is_subscribed on the Soroban contract
  return { active: false, expiresAt: null };
}

/**
 * Stub: submit a pay-to-contact micro-fee on Stellar.
 * Replace with real Soroban invocation when ready.
 */
export async function submitContactPayment(
  scoutWallet: string,
  playerId: string,
): Promise<ContactPaymentResult> {
  if (!scoutWallet || !playerId) {
    throw new PaymentError('Missing scoutWallet or playerId', 'INVALID_ACCOUNT');
  }
  // TODO: build and submit pay_to_contact Soroban transaction
  return {
    transactionId: `stub-txid-${Date.now()}`,
    status: 'submitted',
  };
}

// ─── Trial offer ──────────────────────────────────────────────────────────────

export interface TrialOfferResult {
  transactionId: string;
  playerId: string;
  detailsUri: string;
  playerTier: number;
}

/**
 * Stub: invoke the contract's `log_trial_offer(scout, player_id, details_uri)` method.
 * Creates an immutable on-chain record of the offer and promotes the player to
 * Elite Tier (Level 3). Replace with a real Soroban invocation when ready.
 */
export async function logTrialOffer(
  scoutWallet: string,
  playerId: string,
  detailsUri: string,
): Promise<TrialOfferResult> {
  if (!scoutWallet || !playerId || !detailsUri) {
    throw new PaymentError('Missing scoutWallet, playerId, or detailsUri', 'INVALID_ACCOUNT');
  }
  // TODO: build and submit log_trial_offer Soroban transaction
  return {
    transactionId: `stub-txid-${Date.now()}`,
    playerId,
    detailsUri,
    playerTier: 3,
  };
}

// ─── Milestone query ──────────────────────────────────────────────────────────

export interface OnChainMilestone {
  milestoneId: string;
  playerId: string;
  milestoneType: string;
  evidenceUri: string;
  approved: boolean;
  approvedBy: string | null;
  ledger: number | null;
}

export interface FeeWithdrawalResult {
  transactionId: string;
  recipient: string;
  amount: string; // u128 as string to avoid precision loss
  token: string;
}

export type FeeWithdrawalErrorCode =
  | 'NO_FEES'
  | 'INVALID_RECIPIENT'
  | 'NETWORK_ERROR'
  | 'CONTRACT_PAUSED';

/** Non-retryable codes — the caller should not retry without corrective action. */
const NON_RETRYABLE_CODES: ReadonlySet<FeeWithdrawalErrorCode> = new Set([
  'NO_FEES',
  'INVALID_RECIPIENT',
  'CONTRACT_PAUSED',
]);

export class FeeWithdrawalError extends Error {
  /** Whether the operation may succeed if retried (e.g. transient network blip). */
  public readonly retryable: boolean;

  constructor(
    message: string,
    public readonly code: FeeWithdrawalErrorCode,
  ) {
    super(message);
    this.name = 'FeeWithdrawalError';
    this.retryable = !NON_RETRYABLE_CODES.has(code);
  }
}

/**
 * Stub: invoke the contract's `withdraw_fees(recipient: Address) -> u128` method.
 * Returns the withdrawn amount and transaction metadata.
 * Throws FeeWithdrawalError with code 'NO_FEES' when balance is zero.
 */
export async function withdrawFees(recipient: string): Promise<FeeWithdrawalResult> {
  if (!recipient) {
    throw new FeeWithdrawalError('Missing recipient', 'INVALID_RECIPIENT');
  }
  // TODO: build and submit withdraw_fees Soroban transaction
  // Example (pseudocode):
  //   const tx = await buildInvokeContractTx('withdraw_fees', [Address.fromString(recipient)]);
  //   const result = await server.sendTransaction(tx);
  //   const amount = parseU128FromXdr(result.returnValue);
  //   if (amount === 0n) throw new FeeWithdrawalError('No fees available', 'NO_FEES');
  //   return { transactionId: result.hash, recipient, amount: amount.toString(), token: 'XLM' };
  throw new FeeWithdrawalError('No fees available to withdraw', 'NO_FEES');
}

export type SubscriptionTier = 'basic' | 'premium';

export interface SubscriptionResult {
  transactionId: string;
  tier: SubscriptionTier;
  expiresAt: number; // Unix timestamp
  status: 'active';
}

/**
 * Stub: invoke subscribe(scout, tier, duration) on the Soroban contract.
 * Throws PaymentError with code 'INSUFFICIENT_FUNDS' for error code 7 (InsufficientFee).
 */
export async function purchaseSubscription(
  scoutWallet: string,
  tier: SubscriptionTier,
  duration: number,
): Promise<SubscriptionResult> {
  if (!scoutWallet) {
    throw new PaymentError('Missing scoutWallet', 'INVALID_ACCOUNT');
  }
  // TODO: build and submit subscribe Soroban transaction
  const expiresAt = Math.floor(Date.now() / 1000) + duration * 86400;
  return {
    transactionId: `stub-sub-txid-${Date.now()}`,
    tier,
    expiresAt,
    status: 'active',
  };
}

export interface UpdateProfileResult {
  transactionId: string;
  metadataUri: string;
}

export interface UpdatePlatformFeeResult {
  transactionId: string;
  newFeeBps: number;
}

/**
 * Stub: invoke the contract's `set_platform_fee_bps(new_bps: u32)` entrypoint.
 * Admin-only on-chain call. Valid range: 0–10000 bps.
 * Replace with a real Soroban invocation when ready.
 */
export async function updatePlatformFee(newFeeBps: number): Promise<UpdatePlatformFeeResult> {
  if (newFeeBps < 0 || newFeeBps > 10000) {
    throw new Error('newFeeBps must be between 0 and 10000');
  }
  // TODO: invoke set_platform_fee_bps on the Soroban register contract
  // Example: await invokeContract(adminKeypair, 'set_platform_fee_bps', [u32Val(newFeeBps)]);
  return { transactionId: `stub-fee-txid-${Date.now()}`, newFeeBps };
}

/**
 * Stub: invoke the contract's `update_profile(player_id, metadata_uri)` method.
 * Replace with a real Soroban invocation via invokeContract() when the RPC integration is ready.
 */
export async function updateProfile(
  playerId: string,
  metadataUri: string,
): Promise<UpdateProfileResult> {
  if (!playerId || !metadataUri) {
    throw new Error('playerId and metadataUri are required');
  }
  // TODO: Build and submit update_profile(player_id, metadata_uri) Soroban transaction
  // Example: await invokeContract(platformKeypair, 'update_profile', [strVal(playerId), strVal(metadataUri)]);
  return { transactionId: `stub-update-txid-${playerId.slice(0, 8)}`, metadataUri };
}

/**
 * Stub: query verified milestones for a player from the Soroban contract.
 *
 * Expected contract call: `get_milestones(player_id: String) -> Vec<Milestone>`
 * The contract returns a tamper-proof list of all milestones (pending and
 * approved) associated with the given player. Each entry includes the
 * milestone type, evidence CID, and the validator that approved it.
 *
 * Replace the stub body with a real Soroban `simulateTransaction` /
 * `invokeContractFunction` call when the RPC integration is ready.
 *
 * @param playerId - The on-chain player identifier (Stellar account or UUID).
 * @returns Array of on-chain milestones. Returns an empty array until wired.
 */
export async function queryMilestones(playerId: string): Promise<OnChainMilestone[]> {
  if (!playerId) {
    throw new PaymentError('Missing playerId', 'INVALID_ACCOUNT');
  }
  // TODO: invoke get_milestones on the Soroban contract via SorobanRpc.Server
  // Example (pseudocode):
  //   const result = await server.simulateTransaction(
  //     buildInvokeContractTx('get_milestones', [playerId])
  //   );
  //   return parseMilestonesFromXdr(result);
  return [];
}
