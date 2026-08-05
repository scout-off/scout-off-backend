import request from 'supertest';
import jwt from 'jsonwebtoken';
import { Keypair, Transaction, Networks } from '@stellar/stellar-sdk';

// This file exercises the real indexer/DB layer end-to-end, but
// register_validator/revoke_validator now perform a real Soroban RPC
// round-trip in production. Mock only those two functions (keeping
// everything else — indexer, audit, DB — real) so these route-level tests
// stay deterministic and offline, matching how contract.test.ts mocks
// unpauseContractOnChain for the same reason.
jest.mock('../../src/services/stellar', () => ({
  ...jest.requireActual('../../src/services/stellar'),
  registerValidatorOnChain: jest.fn().mockResolvedValue({ transactionId: 'e2e-register-txid' }),
  revokeValidatorOnChain: jest.fn().mockResolvedValue({ transactionId: 'e2e-revoke-txid' }),
}));

import app from '../../src/app';

const SECRET = process.env.JWT_SECRET ?? 'test-secret';
// Same wallet tests/setup.ts wires up as ADMIN_WALLET — config.adminWallets is
// computed once at module load, so this is the only wallet the multi-sig
// gate in adminController.ts (config.adminWallets.includes(...)) accepts.
// A freshly-generated SEP-10 keypair can self-declare role:'admin' (enough
// to pass the requireRole('admin') middleware) but will never satisfy that
// wallet-identity check, so tests exercising the privileged register/revoke
// success paths need a token issued directly for the real admin wallet.
const ADMIN_WALLET = process.env.ADMIN_WALLET ?? 'GADMINAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA4';

function makeAdminToken(): string {
  return jwt.sign({ sub: ADMIN_WALLET, role: 'admin' }, SECRET, { expiresIn: '1h' });
}

async function getToken(role: string): Promise<string> {
  const kp = Keypair.random();
  const challengeRes = await request(app).get(`/auth/challenge?account=${kp.publicKey()}`);
  const tx = new Transaction(challengeRes.body.challenge, Networks.TESTNET);
  tx.sign(kp);
  const tokenRes = await request(app)
    .post('/auth/token')
    .send({ transaction: tx.toXDR(), role });
  return tokenRes.body.token;
}

const VALID_WALLET = Keypair.random().publicKey();

// ─── Security headers ─────────────────────────────────────────────────────────

describe('Security headers', () => {
  it('sets required security headers on all responses', async () => {
    const res = await request(app).get('/health');
    // Strict-Transport-Security is intentionally omitted outside production/
    // staging — see tests/middleware/securityHeaders.test.ts for coverage of
    // that env-conditional behavior.
    expect(res.headers['x-content-type-options']).toBe('nosniff');
    expect(res.headers['x-frame-options']).toBe('DENY');
    expect(res.headers['referrer-policy']).toBeDefined();
  });

  it('sets helmet cross-origin headers on all responses', async () => {
    const res = await request(app).get('/health');
    // Helmet-provided headers absent from the custom middleware
    expect(res.headers['cross-origin-opener-policy']).toBeDefined();
    expect(res.headers['cross-origin-resource-policy']).toBeDefined();
    expect(res.headers['x-permitted-cross-domain-policies']).toBeDefined();
    expect(res.headers['x-dns-prefetch-control']).toBeDefined();
  });

  it('does not expose x-powered-by header', async () => {
    const res = await request(app).get('/health');
    expect(res.headers['x-powered-by']).toBeUndefined();
  });
});

// ─── Admin validator registry ─────────────────────────────────────────────────

describe('POST /api/admin/validators/register', () => {
  it('returns 401 with no token', async () => {
    const res = await request(app)
      .post('/api/admin/validators/register')
      .send({ validatorWallet: VALID_WALLET });
    expect(res.status).toBe(401);
  });

  it('returns 403 for non-admin role', async () => {
    const token = await getToken('validator');
    const res = await request(app)
      .post('/api/admin/validators/register')
      .set('Authorization', `Bearer ${token}`)
      .send({ validatorWallet: VALID_WALLET });
    expect(res.status).toBe(403);
  });

  it('returns 400 for invalid wallet address', async () => {
    const token = makeAdminToken();
    const res = await request(app)
      .post('/api/admin/validators/register')
      .set('Authorization', `Bearer ${token}`)
      .send({ validatorWallet: 'NOTAVALIDADDRESS' });
    expect(res.status).toBe(400);
  });

  it('returns 202 with a transactionId for valid admin request', async () => {
    const token = makeAdminToken();
    const res = await request(app)
      .post('/api/admin/validators/register')
      .set('Authorization', `Bearer ${token}`)
      .send({ validatorWallet: VALID_WALLET });
    expect(res.status).toBe(202);
    expect(res.body.success).toBe(true);
    expect(res.body.transactionId).toBe('e2e-register-txid');
  });

  it('does not insert the local row and returns an error status when the chain call fails', async () => {
    const token = makeAdminToken();
    const wallet = Keypair.random().publicKey();

    const { registerValidatorOnChain, ValidatorActionError } = jest.requireMock('../../src/services/stellar') as {
      registerValidatorOnChain: jest.Mock;
      ValidatorActionError: new (msg: string, code: string) => Error & { code: string };
    };
    registerValidatorOnChain.mockRejectedValueOnce(
      new ValidatorActionError('Simulation failed: rpc down', 'NETWORK_ERROR'),
    );

    const res = await request(app)
      .post('/api/admin/validators/register')
      .set('Authorization', `Bearer ${token}`)
      .send({ validatorWallet: wallet });
    expect(res.status).toBeGreaterThanOrEqual(500);
    expect(res.body.success).toBe(false);

    const listRes = await request(app)
      .get('/api/admin/validators')
      .set('Authorization', `Bearer ${token}`);
    const found = listRes.body.data.find((v: { wallet: string }) => v.wallet === wallet);
    expect(found).toBeUndefined();

    // restore default success behaviour for subsequent tests
    registerValidatorOnChain.mockResolvedValue({ transactionId: 'e2e-register-txid' });
  });
});

describe('POST /api/admin/validators/revoke', () => {
  it('returns 401 with no token', async () => {
    const res = await request(app)
      .post('/api/admin/validators/revoke')
      .send({ validatorWallet: VALID_WALLET });
    expect(res.status).toBe(401);
  });

  it('returns 403 for non-admin role', async () => {
    const token = await getToken('scout');
    const res = await request(app)
      .post('/api/admin/validators/revoke')
      .set('Authorization', `Bearer ${token}`)
      .send({ validatorWallet: VALID_WALLET });
    expect(res.status).toBe(403);
  });

  it('returns 202 with a transactionId for valid admin request', async () => {
    const token = makeAdminToken();
    const res = await request(app)
      .post('/api/admin/validators/revoke')
      .set('Authorization', `Bearer ${token}`)
      .send({ validatorWallet: VALID_WALLET });
    expect(res.status).toBe(202);
    expect(res.body.success).toBe(true);
    expect(res.body.transactionId).toBe('e2e-revoke-txid');
  });

  it('returns 409 without calling the chain when the wallet is already revoked locally', async () => {
    const token = makeAdminToken();
    const wallet = Keypair.random().publicKey();

    await request(app)
      .post('/api/admin/validators/register')
      .set('Authorization', `Bearer ${token}`)
      .send({ validatorWallet: wallet });
    const first = await request(app)
      .post('/api/admin/validators/revoke')
      .set('Authorization', `Bearer ${token}`)
      .send({ validatorWallet: wallet });
    expect(first.status).toBe(202);

    const { revokeValidatorOnChain } = jest.requireMock('../../src/services/stellar') as {
      revokeValidatorOnChain: jest.Mock;
    };
    revokeValidatorOnChain.mockClear();

    const second = await request(app)
      .post('/api/admin/validators/revoke')
      .set('Authorization', `Bearer ${token}`)
      .send({ validatorWallet: wallet });
    expect(second.status).toBe(409);
    expect(second.body.success).toBe(false);
    expect(revokeValidatorOnChain).not.toHaveBeenCalled();
  });

  it('does not update the local row and returns an error status when the chain call fails', async () => {
    const token = makeAdminToken();
    const wallet = Keypair.random().publicKey();

    await request(app)
      .post('/api/admin/validators/register')
      .set('Authorization', `Bearer ${token}`)
      .send({ validatorWallet: wallet });

    const { revokeValidatorOnChain, ValidatorActionError } = jest.requireMock('../../src/services/stellar') as {
      revokeValidatorOnChain: jest.Mock;
      ValidatorActionError: new (msg: string, code: string) => Error & { code: string };
    };
    revokeValidatorOnChain.mockRejectedValueOnce(
      new ValidatorActionError('Simulation failed: rpc down', 'NETWORK_ERROR'),
    );

    const res = await request(app)
      .post('/api/admin/validators/revoke')
      .set('Authorization', `Bearer ${token}`)
      .send({ validatorWallet: wallet });
    expect(res.status).toBeGreaterThanOrEqual(500);
    expect(res.body.success).toBe(false);

    const listRes = await request(app)
      .get('/api/admin/validators')
      .set('Authorization', `Bearer ${token}`);
    const found = listRes.body.data.find((v: { wallet: string }) => v.wallet === wallet);
    expect(found).toBeDefined();
    expect(found.revoked_at).toBeNull();

    // restore default success behaviour for subsequent tests
    revokeValidatorOnChain.mockResolvedValue({ transactionId: 'e2e-revoke-txid' });
  });
});

describe('GET /api/admin/validators', () => {
  it('returns 401 with no token', async () => {
    const res = await request(app).get('/api/admin/validators');
    expect(res.status).toBe(401);
  });

  it('returns 403 for non-admin role', async () => {
    const token = await getToken('scout');
    const res = await request(app)
      .get('/api/admin/validators')
      .set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(403);
  });

  it('returns 200 with a data array for admin', async () => {
    const token = makeAdminToken();
    const res = await request(app)
      .get('/api/admin/validators')
      .set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(Array.isArray(res.body.data)).toBe(true);
  });

  it('includes a registered validator after registration', async () => {
    const token = makeAdminToken();
    // Register first
    await request(app)
      .post('/api/admin/validators/register')
      .set('Authorization', `Bearer ${token}`)
      .send({ validatorWallet: VALID_WALLET });
    // Then list
    const res = await request(app)
      .get('/api/admin/validators')
      .set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(200);
    const found = res.body.data.find((v: { wallet: string }) => v.wallet === VALID_WALLET);
    expect(found).toBeDefined();
    expect(found.registered_at).toBeGreaterThan(0);
    expect(found.revoked_at).toBeNull();
  });

  it('marks a validator as revoked after revocation', async () => {
    const token = makeAdminToken();
    // Register then revoke
    await request(app)
      .post('/api/admin/validators/register')
      .set('Authorization', `Bearer ${token}`)
      .send({ validatorWallet: VALID_WALLET });
    await request(app)
      .post('/api/admin/validators/revoke')
      .set('Authorization', `Bearer ${token}`)
      .send({ validatorWallet: VALID_WALLET });
    const res = await request(app)
      .get('/api/admin/validators')
      .set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(200);
    const found = res.body.data.find((v: { wallet: string }) => v.wallet === VALID_WALLET);
    expect(found).toBeDefined();
    expect(found.revoked_at).not.toBeNull();
  });
});
