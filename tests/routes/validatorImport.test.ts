/**
 * Tests for POST /api/admin/validators/import
 *
 * Covers all acceptance criteria from issue #493:
 *  - Valid entries are registered through the existing single-registration path
 *  - Invalid wallet addresses are rejected per-entry (not the whole batch)
 *  - Already-registered (non-revoked) validators are skipped as duplicates
 *  - A per-entry result summary is returned
 *  - Mixed valid/invalid/duplicate batches work correctly
 *  - CSV and JSON input formats both work
 *  - Auth guards (401 / 403) are enforced
 */
// import_validator registers/revokes validators through processBatch(), which
// signs a real Soroban transaction via src/utils/signer.ts's getPlatformKeypair().
// That module derives a Keypair from config.platformSecretKey ONCE, at
// signer.ts's first import, and throws if it isn't a valid Stellar secret key
// (strkey with a correct checksum).
//
// config.platformSecretKey is itself computed once, at src/config.ts's first
// import — which already happens during tests/setup.ts's initDb() call
// (setupFiles run before this file's own top-level code), using whatever
// PLATFORM_SECRET_KEY was set at that point (unset, by default). So merely
// assigning process.env.PLATFORM_SECRET_KEY here is too late: the module
// registry already holds a config.ts instance with platformSecretKey frozen
// to ''. jest.resetModules() + re-initialising src/db from scratch forces a
// fresh config.ts (and everything built on it, including app/adminController
// below) that picks up the real value.
process.env.PLATFORM_SECRET_KEY = 'SDAT3WOW2WIVH5VRHJDRKXZ7I5IAOGFK7CDPT4GKJKW2LDQ3YMJ56QJQ';
jest.resetModules();
// eslint-disable-next-line @typescript-eslint/no-var-requires
require('../../src/db').initDb();

import request from 'supertest';
import { Keypair, Transaction, Networks } from '@stellar/stellar-sdk';

// This suite exercises the real indexer/DB layer end-to-end (including a
// register -> revoke -> re-import round trip), but register_validator/
// revoke_validator now perform a real Soroban RPC call in production. Mock
// only those two functions (keeping everything else in the module real via
// jest.requireActual) so this stays deterministic and offline — same
// approach as tests/routes/admin.test.ts.
jest.mock('../../src/services/stellar', () => ({
  ...jest.requireActual('../../src/services/stellar'),
  registerValidatorOnChain: jest.fn().mockResolvedValue({ transactionId: 'e2e-import-register-txid' }),
  revokeValidatorOnChain: jest.fn().mockResolvedValue({ transactionId: 'e2e-import-revoke-txid' }),
}));

import app from '../../src/app';
import { parseCsvBody, processBatch } from '../../src/controllers/adminController';

// ─── Auth helper ──────────────────────────────────────────────────────────────

async function getToken(role: string): Promise<string> {
  const kp = Keypair.random();
  const challengeRes = await request(app).get(`/auth/challenge?account=${kp.publicKey()}`);
  const tx = new Transaction(challengeRes.body.challenge, Networks.TESTNET);
  tx.sign(kp);
  const tokenRes = await request(app)
    .post('/auth/token')
    .send({ transaction: tx.toXdr(), role });
  return tokenRes.body.token;
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

/** Generate N unique valid Stellar public keys. */
function validWallets(n: number): string[] {
  return Array.from({ length: n }, () => Keypair.random().publicKey());
}

// ─── Unit tests: parseCsvBody ─────────────────────────────────────────────────

describe('parseCsvBody()', () => {
  it('parses single-column CSV', () => {
    const wallet = Keypair.random().publicKey();
    const result = parseCsvBody(`${wallet}`);
    expect(result).toHaveLength(1);
    expect(result[0].wallet).toBe(wallet);
    expect(result[0].label).toBeUndefined();
    expect(result[0].region).toBeUndefined();
  });

  it('parses wallet,label two-column CSV', () => {
    const wallet = Keypair.random().publicKey();
    const result = parseCsvBody(`${wallet},Coach Ali`);
    expect(result[0].wallet).toBe(wallet);
    expect(result[0].label).toBe('Coach Ali');
    expect(result[0].region).toBeUndefined();
  });

  it('parses wallet,label,region three-column CSV', () => {
    const wallet = Keypair.random().publicKey();
    const result = parseCsvBody(`${wallet},Coach Ali,West Africa`);
    expect(result[0].wallet).toBe(wallet);
    expect(result[0].label).toBe('Coach Ali');
    expect(result[0].region).toBe('West Africa');
  });

  it('skips empty lines', () => {
    const wallet = Keypair.random().publicKey();
    const result = parseCsvBody(`\n${wallet}\n\n`);
    expect(result).toHaveLength(1);
  });

  it('skips comment lines starting with #', () => {
    const wallet = Keypair.random().publicKey();
    const result = parseCsvBody(`# header comment\n${wallet}`);
    expect(result).toHaveLength(1);
  });

  it('skips header row with "wallet" as first column (case-insensitive)', () => {
    const wallet = Keypair.random().publicKey();
    const result = parseCsvBody(`wallet,label,region\n${wallet},Ali,Africa`);
    expect(result).toHaveLength(1);
    expect(result[0].wallet).toBe(wallet);
  });

  it('handles Windows CRLF line endings', () => {
    const [w1, w2] = validWallets(2);
    const result = parseCsvBody(`${w1}\r\n${w2}`);
    expect(result).toHaveLength(2);
  });

  it('returns empty array for blank input', () => {
    expect(parseCsvBody('')).toHaveLength(0);
    expect(parseCsvBody('   ')).toHaveLength(0);
    expect(parseCsvBody('# only comments')).toHaveLength(0);
  });
});

// ─── Unit tests: processBatch ─────────────────────────────────────────────────

describe('processBatch()', () => {
  it('registers a valid address', async () => {
    const wallet = Keypair.random().publicKey();
    const results = await processBatch([{ wallet }], 'admin-wallet');
    expect(results).toHaveLength(1);
    expect(results[0].status).toBe('registered');
    expect(results[0].wallet).toBe(wallet);
  });

  it('rejects an invalid address', async () => {
    const results = await processBatch([{ wallet: 'NOTVALID' }], 'admin-wallet');
    expect(results[0].status).toBe('invalid');
    expect(results[0].reason).toMatch(/invalid Stellar address/i);
  });

  it('marks intra-batch duplicates as duplicate', async () => {
    const wallet = Keypair.random().publicKey();
    const results = await processBatch([{ wallet }, { wallet }], 'admin-wallet');
    expect(results[0].status).toBe('registered');
    expect(results[1].status).toBe('duplicate');
    expect(results[1].reason).toMatch(/duplicate within batch/i);
  });

  it('marks already-registered validators as duplicate', async () => {
    const wallet = Keypair.random().publicKey();
    // First registration
    await processBatch([{ wallet }], 'admin-wallet');
    // Second batch with same wallet
    const results = await processBatch([{ wallet }], 'admin-wallet');
    expect(results[0].status).toBe('duplicate');
    expect(results[0].reason).toMatch(/already registered/i);
  });

  it('includes label and region in results', async () => {
    const wallet = Keypair.random().publicKey();
    const results = await processBatch([{ wallet, label: 'Ali', region: 'Africa' }], 'admin-wallet');
    expect(results[0].label).toBe('Ali');
    expect(results[0].region).toBe('Africa');
  });

  it('processes a mixed batch returning correct statuses for each entry', async () => {
    const validNew = Keypair.random().publicKey();
    const alreadyRegistered = Keypair.random().publicKey();
    // Pre-register one
    await processBatch([{ wallet: alreadyRegistered }], 'admin-wallet');

    const results = await processBatch(
      [
        { wallet: validNew },
        { wallet: 'BAD_WALLET' },
        { wallet: alreadyRegistered },
      ],
      'admin-wallet',
    );

    expect(results).toHaveLength(3);
    const registered = results.find((r) => r.wallet === validNew);
    const invalid = results.find((r) => r.wallet === 'BAD_WALLET');
    const duplicate = results.find((r) => r.wallet === alreadyRegistered);

    expect(registered?.status).toBe('registered');
    expect(invalid?.status).toBe('invalid');
    expect(duplicate?.status).toBe('duplicate');
  });
});

// ─── Integration tests: POST /api/admin/validators/import ────────────────────

describe('POST /api/admin/validators/import — auth guards', () => {
  it('returns 401 when no token is provided', async () => {
    const res = await request(app)
      .post('/api/admin/validators/import')
      .send({ validators: [] });
    expect(res.status).toBe(401);
  });

  it('returns 403 for non-admin role (validator)', async () => {
    const token = await getToken('validator');
    const res = await request(app)
      .post('/api/admin/validators/import')
      .set('Authorization', `Bearer ${token}`)
      .send({ validators: [{ wallet: Keypair.random().publicKey() }] });
    expect(res.status).toBe(403);
  });

  it('returns 403 for non-admin role (scout)', async () => {
    const token = await getToken('scout');
    const res = await request(app)
      .post('/api/admin/validators/import')
      .set('Authorization', `Bearer ${token}`)
      .send({ validators: [{ wallet: Keypair.random().publicKey() }] });
    expect(res.status).toBe(403);
  });
});

describe('POST /api/admin/validators/import — JSON body', () => {
  it('returns 400 when validators field is missing', async () => {
    const token = await getToken('admin');
    const res = await request(app)
      .post('/api/admin/validators/import')
      .set('Authorization', `Bearer ${token}`)
      .send({});
    expect(res.status).toBe(400);
    expect(res.body.success).toBe(false);
  });

  it('returns 400 when validators is not an array', async () => {
    const token = await getToken('admin');
    const res = await request(app)
      .post('/api/admin/validators/import')
      .set('Authorization', `Bearer ${token}`)
      .send({ validators: 'not-an-array' });
    expect(res.status).toBe(400);
  });

  it('returns 400 for an empty validators array', async () => {
    const token = await getToken('admin');
    const res = await request(app)
      .post('/api/admin/validators/import')
      .set('Authorization', `Bearer ${token}`)
      .send({ validators: [] });
    expect(res.status).toBe(400);
    expect(res.body.success).toBe(false);
  });

  it('registers a single valid wallet', async () => {
    const token = await getToken('admin');
    const wallet = Keypair.random().publicKey();
    const res = await request(app)
      .post('/api/admin/validators/import')
      .set('Authorization', `Bearer ${token}`)
      .send({ validators: [{ wallet }] });
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.data.summary.registered).toBe(1);
    expect(res.body.data.results[0].status).toBe('registered');
    expect(res.body.data.results[0].wallet).toBe(wallet);
  });

  it('accepts plain wallet strings as well as objects', async () => {
    const token = await getToken('admin');
    const wallet = Keypair.random().publicKey();
    const res = await request(app)
      .post('/api/admin/validators/import')
      .set('Authorization', `Bearer ${token}`)
      .send({ validators: [wallet] });
    expect(res.status).toBe(200);
    expect(res.body.data.summary.registered).toBe(1);
  });

  it('rejects invalid wallet address per-entry (not the whole batch)', async () => {
    const token = await getToken('admin');
    const validWallet = Keypair.random().publicKey();
    const res = await request(app)
      .post('/api/admin/validators/import')
      .set('Authorization', `Bearer ${token}`)
      .send({ validators: [{ wallet: validWallet }, { wallet: 'BAD_ADDR' }] });
    expect(res.status).toBe(200); // whole request succeeds
    expect(res.body.data.summary.registered).toBe(1);
    expect(res.body.data.summary.invalid).toBe(1);
    const invalidEntry = res.body.data.results.find((r: { wallet: string }) => r.wallet === 'BAD_ADDR');
    expect(invalidEntry.status).toBe('invalid');
    expect(invalidEntry.reason).toBeDefined();
  });

  it('skips duplicate wallet cleanly (already registered in same batch)', async () => {
    const token = await getToken('admin');
    const wallet = Keypair.random().publicKey();
    const res = await request(app)
      .post('/api/admin/validators/import')
      .set('Authorization', `Bearer ${token}`)
      .send({ validators: [{ wallet }, { wallet }] });
    expect(res.status).toBe(200);
    expect(res.body.data.summary.registered).toBe(1);
    expect(res.body.data.summary.duplicates).toBe(1);
  });

  it('skips already-registered (non-revoked) validator as duplicate', async () => {
    const token = await getToken('admin');
    const wallet = Keypair.random().publicKey();
    // First import — registers the wallet
    await request(app)
      .post('/api/admin/validators/import')
      .set('Authorization', `Bearer ${token}`)
      .send({ validators: [{ wallet }] });
    // Second import — same wallet should be a duplicate
    const res = await request(app)
      .post('/api/admin/validators/import')
      .set('Authorization', `Bearer ${token}`)
      .send({ validators: [{ wallet }] });
    expect(res.status).toBe(200);
    expect(res.body.data.summary.duplicates).toBe(1);
    expect(res.body.data.summary.registered).toBe(0);
    expect(res.body.data.results[0].status).toBe('duplicate');
  });

  it('returns correct summary for a mixed valid/invalid/duplicate batch', async () => {
    const token = await getToken('admin');
    const [w1, w2, w3] = validWallets(3);
    // Pre-register w3
    await request(app)
      .post('/api/admin/validators/import')
      .set('Authorization', `Bearer ${token}`)
      .send({ validators: [{ wallet: w3 }] });

    const res = await request(app)
      .post('/api/admin/validators/import')
      .set('Authorization', `Bearer ${token}`)
      .send({
        validators: [
          { wallet: w1 },              // valid new
          { wallet: 'INVALID_ADDR' },  // invalid
          { wallet: w3 },              // already registered → duplicate
          { wallet: w2, label: 'Coach', region: 'Africa' }, // valid with metadata
        ],
      });
    expect(res.status).toBe(200);
    expect(res.body.data.summary.total).toBe(4);
    expect(res.body.data.summary.registered).toBe(2); // w1 and w2
    expect(res.body.data.summary.invalid).toBe(1);
    expect(res.body.data.summary.duplicates).toBe(1);
    expect(res.body.data.results).toHaveLength(4);
  });

  it('response contains per-entry results array with wallet and status fields', async () => {
    const token = await getToken('admin');
    const wallet = Keypair.random().publicKey();
    const res = await request(app)
      .post('/api/admin/validators/import')
      .set('Authorization', `Bearer ${token}`)
      .send({ validators: [{ wallet }] });
    expect(Array.isArray(res.body.data.results)).toBe(true);
    const entry = res.body.data.results[0];
    expect(entry).toHaveProperty('wallet');
    expect(entry).toHaveProperty('status');
  });

  it('registered validator appears in GET /api/admin/validators list', async () => {
    const token = await getToken('admin');
    const wallet = Keypair.random().publicKey();
    await request(app)
      .post('/api/admin/validators/import')
      .set('Authorization', `Bearer ${token}`)
      .send({ validators: [{ wallet }] });
    const listRes = await request(app)
      .get('/api/admin/validators')
      .set('Authorization', `Bearer ${token}`);
    expect(listRes.status).toBe(200);
    const found = listRes.body.data.find((v: { wallet: string }) => v.wallet === wallet);
    expect(found).toBeDefined();
    expect(found.revoked_at).toBeNull();
  });

  it('allows re-registration of a previously revoked validator', async () => {
    const token = await getToken('admin');
    const wallet = Keypair.random().publicKey();
    // Register
    await request(app)
      .post('/api/admin/validators/register')
      .set('Authorization', `Bearer ${token}`)
      .send({ validatorWallet: wallet });
    // Revoke
    await request(app)
      .post('/api/admin/validators/revoke')
      .set('Authorization', `Bearer ${token}`)
      .send({ validatorWallet: wallet });
    // Re-import — should be registered (not duplicate) since it's revoked
    const res = await request(app)
      .post('/api/admin/validators/import')
      .set('Authorization', `Bearer ${token}`)
      .send({ validators: [{ wallet }] });
    expect(res.status).toBe(200);
    expect(res.body.data.summary.registered).toBe(1);
    expect(res.body.data.results[0].status).toBe('registered');
  });
});

describe('POST /api/admin/validators/import — CSV body', () => {
  it('returns 400 when CSV body is empty', async () => {
    const token = await getToken('admin');
    const res = await request(app)
      .post('/api/admin/validators/import')
      .set('Authorization', `Bearer ${token}`)
      .set('Content-Type', 'text/csv')
      .send('');
    expect(res.status).toBe(400);
    expect(res.body.success).toBe(false);
  });

  it('registers validators from single-column CSV', async () => {
    const token = await getToken('admin');
    const [w1, w2] = validWallets(2);
    const csv = `${w1}\n${w2}`;
    const res = await request(app)
      .post('/api/admin/validators/import')
      .set('Authorization', `Bearer ${token}`)
      .set('Content-Type', 'text/csv')
      .send(csv);
    expect(res.status).toBe(200);
    expect(res.body.data.summary.registered).toBe(2);
  });

  it('parses wallet,label,region from CSV', async () => {
    const token = await getToken('admin');
    const wallet = Keypair.random().publicKey();
    const csv = `${wallet},Coach Ali,West Africa`;
    const res = await request(app)
      .post('/api/admin/validators/import')
      .set('Authorization', `Bearer ${token}`)
      .set('Content-Type', 'text/csv')
      .send(csv);
    expect(res.status).toBe(200);
    expect(res.body.data.results[0].status).toBe('registered');
    expect(res.body.data.results[0].label).toBe('Coach Ali');
    expect(res.body.data.results[0].region).toBe('West Africa');
  });

  it('skips CSV header row automatically', async () => {
    const token = await getToken('admin');
    const wallet = Keypair.random().publicKey();
    const csv = `wallet,label,region\n${wallet},TestCoach,Europe`;
    const res = await request(app)
      .post('/api/admin/validators/import')
      .set('Authorization', `Bearer ${token}`)
      .set('Content-Type', 'text/csv')
      .send(csv);
    expect(res.status).toBe(200);
    expect(res.body.data.summary.total).toBe(1);
    expect(res.body.data.results[0].wallet).toBe(wallet);
  });

  it('handles mixed valid/invalid/duplicate rows in CSV', async () => {
    const token = await getToken('admin');
    const [w1, w2] = validWallets(2);
    // Pre-register w2
    await request(app)
      .post('/api/admin/validators/import')
      .set('Authorization', `Bearer ${token}`)
      .send({ validators: [{ wallet: w2 }] });

    const csv = `${w1}\nBAD_WALLET\n${w2}`;
    const res = await request(app)
      .post('/api/admin/validators/import')
      .set('Authorization', `Bearer ${token}`)
      .set('Content-Type', 'text/csv')
      .send(csv);
    expect(res.status).toBe(200);
    expect(res.body.data.summary.registered).toBe(1);
    expect(res.body.data.summary.invalid).toBe(1);
    expect(res.body.data.summary.duplicates).toBe(1);
  });

  it('also works with Content-Type: text/plain', async () => {
    const token = await getToken('admin');
    const wallet = Keypair.random().publicKey();
    const res = await request(app)
      .post('/api/admin/validators/import')
      .set('Authorization', `Bearer ${token}`)
      .set('Content-Type', 'text/plain')
      .send(wallet);
    expect(res.status).toBe(200);
    expect(res.body.data.summary.registered).toBe(1);
  });
});

describe('POST /api/admin/validators/import — large batches and edge cases', () => {
  it('handles a batch of 50 valid wallets', async () => {
    const token = await getToken('admin');
    const wallets = validWallets(50);
    const res = await request(app)
      .post('/api/admin/validators/import')
      .set('Authorization', `Bearer ${token}`)
      .send({ validators: wallets.map((wallet) => ({ wallet })) });
    expect(res.status).toBe(200);
    expect(res.body.data.summary.total).toBe(50);
    expect(res.body.data.summary.registered).toBe(50);
  });

  it('handles a batch with all invalid addresses', async () => {
    const token = await getToken('admin');
    const res = await request(app)
      .post('/api/admin/validators/import')
      .set('Authorization', `Bearer ${token}`)
      .send({ validators: ['BAD1', 'BAD2', 'BAD3'].map((wallet) => ({ wallet })) });
    expect(res.status).toBe(200);
    expect(res.body.data.summary.invalid).toBe(3);
    expect(res.body.data.summary.registered).toBe(0);
  });

  it('is also reachable under /api/v1/admin/validators/import', async () => {
    const token = await getToken('admin');
    const wallet = Keypair.random().publicKey();
    const res = await request(app)
      .post('/api/v1/admin/validators/import')
      .set('Authorization', `Bearer ${token}`)
      .send({ validators: [{ wallet }] });
    expect(res.status).toBe(200);
    expect(res.body.data.summary.registered).toBe(1);
  });
});
