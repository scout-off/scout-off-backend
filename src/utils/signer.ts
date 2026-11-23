import { Keypair } from '@stellar/stellar-sdk';
import config from '../config';

let cachedSecret: string | undefined;
let cachedKeypair: Keypair | undefined;

/** Returns the platform keypair, rebuilding it when the mounted secret rotates. */
export function getPlatformKeypair(): Keypair {
  const secret = config.platformSecretKey;
  if (cachedKeypair && cachedSecret === secret) return cachedKeypair;

  try {
    cachedKeypair = Keypair.fromSecret(secret);
    cachedSecret = secret;
    return cachedKeypair;
  } catch {
    throw new Error('PLATFORM_SECRET_KEY is invalid — must be a valid Stellar secret key');
  }
}

// Validate configured keys at startup. Test environments may intentionally
// omit the platform signer when exercising code paths that do not sign.
if (config.platformSecretKey) getPlatformKeypair();
