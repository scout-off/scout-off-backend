import { Keypair } from '@stellar/stellar-sdk';

/**
 * Returns true if addr is a valid Stellar G-address (Ed25519 public key).
 * Uses the SDK's own key validation — same check used in authController.
 */
export function isValidStellarAddress(addr: string): boolean {
  if (typeof addr !== 'string') return false;
  try {
    Keypair.fromPublicKey(addr);
    return true;
  } catch {
    return false;
  }
}
