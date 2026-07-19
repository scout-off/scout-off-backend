import { Request, Response, NextFunction } from 'express';
import { z } from 'zod';
import { Keypair } from '@stellar/stellar-sdk';
import { buildChallenge, verifyAndIssueToken, extractAccount } from '../services/sep10';
import config from '../config';

const TOKEN_TTL_SECONDS = 86400;

const challengeSchema = z.object({
  account: z.string().refine(
    (val) => {
      try {
        Keypair.fromPublicKey(val);
        return true;
      } catch {
        return false;
      }
    },
    { message: 'Invalid Stellar public key' }
  ),
});

const tokenSchema = z.object({
  transaction: z.string().min(1),
  role: z.enum(['player', 'scout', 'validator', 'admin']).optional(),
});

/** GET /auth/challenge?account=G... */
export function getChallenge(req: Request, res: Response, next: NextFunction): void {
  try {
    const { account } = challengeSchema.parse(req.query);
    const challenge = buildChallenge(account);
    res.json({ challenge, networkPassphrase: config.networkPassphrase });
  } catch (err) {
    next(err);
  }
}

/** POST /auth/token  { transaction: "<signed XDR>", role?: "validator" } */
export function postToken(req: Request, res: Response, next: NextFunction): void {
  try {
    const { transaction, role } = tokenSchema.parse(req.body);
    // Seed admin: if the authenticated wallet matches ADMIN_WALLET, always issue admin role
    const candidate = extractAccount(transaction);
    const effectiveRole = config.adminWallet && candidate === config.adminWallet ? 'admin' : role;
    const { token, account } = verifyAndIssueToken(transaction, effectiveRole);
    const expiresAt = Math.floor(Date.now() / 1000) + TOKEN_TTL_SECONDS;
    res.json({ token, account, expiresAt });
  } catch (err) {
    if (
      err instanceof Error &&
      (err.message === 'Invalid challenge signature' ||
        err.message === 'Missing source account in challenge')
    ) {
      res.status(401).json({ success: false, error: err.message });
      return;
    }
    next(err);
  }
}
