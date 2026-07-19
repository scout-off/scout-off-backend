/**
 * SEP-10 helper service (mock)
 *
 * Provides lightweight mock implementations for creating and verifying
 * SEP-10 challenges. These are placeholders designed to be replaced by
 * real Stellar SDK logic later.
 */

/**
 * Create a SEP-10 challenge for a given client wallet.
 *
 * @param wallet - Stellar account that will sign the challenge
 * @returns object containing a mock XDR challenge and network passphrase
 */
export async function createChallenge(
  wallet: string
): Promise<{ challenge: string; networkPassphrase: string }> {
  // Mock deterministic challenge value for tests
  const challenge = `CHALLENGE_FOR_${wallet}_MOCK`;
  const networkPassphrase = process.env.STELLAR_NETWORK_PASSPHRASE || 'Test SDF Network';
  return { challenge, networkPassphrase };
}

/**
 * Verify a signed SEP-10 challenge.
 *
 * @param challenge - original challenge XDR
 * @param signature - client signature over the challenge
 * @returns verified account object when mock verification succeeds
 */
export async function verifyChallenge(
  challenge: string,
  signature: string
): Promise<{ account: string }> {
  // Mock verification: accept a deterministic signature pattern in tests
  if (signature === 'MOCK_VALID_SIGNATURE') {
    // Extract wallet from challenge when possible
    const match = challenge.match(/^CHALLENGE_FOR_(.+?)_MOCK$/);
    const account = match ? match[1] : 'GMOCKACCOUNT';
    return { account };
  }
  // Throw to mimic verification failure
  throw new Error('Invalid SEP-10 signature (mock)');
}

export default { createChallenge, verifyChallenge };
import {
  Keypair,
  Networks,
  TransactionBuilder,
  BASE_FEE,
  Operation,
  Account,
  Transaction,
} from '@stellar/stellar-sdk';
import jwt from 'jsonwebtoken';
import config from '../config';

const SERVER_KEYPAIR = Keypair.random(); // ephemeral; use a persisted key in production
const CHALLENGE_TTL_SECONDS = 300; // 5 min to sign the challenge
const TOKEN_TTL_SECONDS = 86400; // 24 h JWT validity

/**
 * Build a SEP-10 challenge transaction.
 * The client must sign it with their Stellar keypair and return the XDR.
 */
export function buildChallenge(accountId: string): string {
  const serverAccount = new Account(SERVER_KEYPAIR.publicKey(), '-1');
  const tx = new TransactionBuilder(serverAccount, {
    fee: BASE_FEE,
    networkPassphrase: config.network === 'mainnet' ? Networks.PUBLIC : Networks.TESTNET,
  })
    .addOperation(
      Operation.manageData({
        name: 'scoutoff auth',
        value: Buffer.from(Keypair.random().rawPublicKey()).toString('base64'),
        source: accountId,
      })
    )
    .setTimeout(CHALLENGE_TTL_SECONDS)
    .build();

  tx.sign(SERVER_KEYPAIR);
  return tx.toXDR();
}

/**
 * Extract the client account from a challenge XDR without verifying signatures.
 * Used to determine the effective role before issuing a token.
 */
export function extractAccount(xdr: string): string | null {
  try {
    const network = config.network === 'mainnet' ? Networks.PUBLIC : Networks.TESTNET;
    const tx = new Transaction(xdr, network);
    return tx.operations[0].source ?? null;
  } catch {
    return null;
  }
}

/**
 * Verify the client-signed challenge XDR and issue a JWT.
 */
export function verifyAndIssueToken(
  xdr: string,
  role?: string
): { token: string; account: string } {
  const network = config.network === 'mainnet' ? Networks.PUBLIC : Networks.TESTNET;

  const tx = new Transaction(xdr, network);

  // The first operation's source is the client account
  const clientAccountId = tx.operations[0].source;
  if (!clientAccountId) throw new Error('Missing source account in challenge');

  // Verify the client signed it
  const clientKeypair = Keypair.fromPublicKey(clientAccountId);
  const valid = tx.signatures.some((sig) => {
    try {
      return clientKeypair.verify(tx.hash(), sig.signature());
    } catch {
      return false;
    }
  });

  if (!valid) throw new Error('Invalid challenge signature');

  const token = jwt.sign({ sub: clientAccountId, role: role ?? 'player' }, config.jwtSecret, {
    expiresIn: TOKEN_TTL_SECONDS,
  });

  return { token, account: clientAccountId };
}
