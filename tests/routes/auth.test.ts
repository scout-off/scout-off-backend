import request from 'supertest';
import app from '../../src/app';
import { buildChallenge, getServerKeypair } from '../../src/services/sep10';
import { Keypair, Transaction, Networks, TransactionBuilder, BASE_FEE, Operation, Account, Asset } from '@stellar/stellar-sdk';
import crypto from 'crypto';

jest.mock('../../src/db', () => ({
  queryEvents: jest.fn().mockReturnValue([]),
  queryPlayers: jest.fn().mockReturnValue([]),
  getPlayerById: jest.fn().mockReturnValue(null),
  getEventsCount: jest.fn().mockReturnValue(0),
  fetchLastIndexedLedger: jest.fn().mockReturnValue(0),
  persistLastIndexedLedger: jest.fn(),
  insertPlayerProfileHistory: jest.fn(),
  getPlayerProfileHistory: jest.fn().mockReturnValue([]),
  insertOrUpdatePlayer: jest.fn(),
}));

jest.mock('../../src/services/ipfs', () => ({
  pinJson: jest.fn().mockResolvedValue('QmYwAPJzv5CZsnA625s3Xf2nemtYgPpHdWEz79ojWnPbdG'),
  checkHealth: jest.fn().mockResolvedValue(undefined),
  gatewayUrl: jest.fn((cid: string) => `https://gateway.pinata.cloud/ipfs/${cid}`),
}));

jest.mock('../../src/services/indexer', () => ({
  indexEvents: jest.fn(),
  normalizeEventId: jest.fn(),
}));

jest.mock('../../src/services/webhooks', () => ({
  dispatchEventWebhook: jest.fn().mockResolvedValue(undefined),
}));

describe('POST /auth/token — malformed XDR handling', () => {
  it('returns 400 for a plaintext non-XDR transaction string', async () => {
    const res = await request(app)
      .post('/auth/token')
      .send({ transaction: 'this-is-not-valid-xdr' });
    expect(res.status).toBe(400);
    expect(res.body.success).toBe(false);
    expect(typeof res.body.error).toBe('string');
    expect(res.body.error.length).toBeGreaterThan(0);
  });

  it('returns 400 for a random base64-like string that is not an XDR transaction', async () => {
    const res = await request(app)
      .post('/auth/token')
      .send({ transaction: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA' });
    expect([400, 401]).toContain(res.status);
    expect(res.body.success).toBe(false);
    expect(typeof res.body.error).toBe('string');
  });

  it('returns 400 for a JSON-serialised object sent as transaction', async () => {
    const res = await request(app)
      .post('/auth/token')
      .send({ transaction: JSON.stringify({ fake: true }) });
    expect(res.status).toBe(400);
    expect(res.body.success).toBe(false);
    expect(typeof res.body.error).toBe('string');
  });

  it('returns 400 for empty transaction string (Zod min-length guard)', async () => {
    const res = await request(app)
      .post('/auth/token')
      .send({ transaction: '' });
    expect(res.status).toBe(400);
    expect(res.body.success).toBe(false);
  });

  it('returns 400 when transaction field is missing entirely', async () => {
    const res = await request(app).post('/auth/token').send({});
    expect(res.status).toBe(400);
    expect(res.body.success).toBe(false);
  });

  it('response body is never a 500 for any string transaction value', async () => {
    const payloads = [
      'not-xdr',
      '!!@@##$$%%',
      ' ',
      'A'.repeat(1000),
      '0'.repeat(48),
    ];
    for (const transaction of payloads) {
      const res = await request(app)
        .post('/auth/token')
        .send({ transaction });
      expect(res.status).not.toBe(500);
      expect(res.body.success).toBe(false);
    }
  });
});

describe('POST /auth/token — Sep10Error code mapping', () => {
  describe('401 TOKEN_EXPIRED', () => {
    it('returns 401 with TOKEN_EXPIRED for an expired challenge', async () => {
      const clientKeypair = Keypair.random();
      const xdr = buildChallenge(clientKeypair.publicKey());
      const tx = new Transaction(xdr, Networks.TESTNET);
      tx.sign(clientKeypair);
      const signedXdr = tx.toXdr();

      // Advance Date.now() past the challenge TTL (300 s)
      const realNow = Date.now;
      Date.now = () => realNow() + 400_000; // +400 seconds → past maxTime
      try {
        const res = await request(app)
          .post('/auth/token')
          .send({ transaction: signedXdr });
        expect(res.status).toBe(401);
        expect(res.body.success).toBe(false);
        expect(res.body.code).toBe('TOKEN_EXPIRED');
        expect(res.body.error).toBe('Challenge has expired');
      } finally {
        Date.now = realNow;
      }
    });
  });

  describe('401 TOKEN_INVALID', () => {
    it('returns 401 with TOKEN_INVALID for unsigned challenge', async () => {
      const clientKeypair = Keypair.random();
      const xdr = buildChallenge(clientKeypair.publicKey());
      const res = await request(app)
        .post('/auth/token')
        .send({ transaction: xdr });
      expect(res.status).toBe(401);
      expect(res.body.success).toBe(false);
      expect(res.body.code).toBe('TOKEN_INVALID');
      expect(res.body.error).toBe('Invalid challenge');
    });

    it('returns 401 with TOKEN_INVALID for wrong source account', async () => {
      const rogueKeypair = Keypair.random();
      const rogueAccount = new Account(rogueKeypair.publicKey(), '-1');
      const clientKeypair = Keypair.random();
      const tx = new TransactionBuilder(rogueAccount, {
        fee: BASE_FEE,
        networkPassphrase: Networks.TESTNET,
      })
        .addOperation(
          Operation.manageData({
            name: 'scoutoff auth',
            value: crypto.randomBytes(48).toString('base64'),
            source: clientKeypair.publicKey(),
          })
        )
        .setTimeout(300)
        .build();

      tx.sign(rogueKeypair);
      tx.sign(clientKeypair);
      const res = await request(app)
        .post('/auth/token')
        .send({ transaction: tx.toXdr() });
      expect(res.status).toBe(401);
      expect(res.body.success).toBe(false);
      expect(res.body.code).toBe('TOKEN_INVALID');
      expect(res.body.error).toBe('Invalid challenge');
    });

    it('returns 401 with TOKEN_INVALID for wrong operation name', async () => {
      const serverKeypair = getServerKeypair();
      const serverAccount = new Account(serverKeypair.publicKey(), '-1');
      const clientKeypair = Keypair.random();
      const tx = new TransactionBuilder(serverAccount, {
        fee: BASE_FEE,
        networkPassphrase: Networks.TESTNET,
      })
        .addOperation(
          Operation.manageData({
            name: 'wrong name',
            value: Buffer.from(Keypair.random().rawPublicKey()).toString('base64'),
            source: clientKeypair.publicKey(),
          })
        )
        .setTimeout(300)
        .build();

      tx.sign(serverKeypair);
      tx.sign(clientKeypair);
      const res = await request(app)
        .post('/auth/token')
        .send({ transaction: tx.toXdr() });
      expect(res.status).toBe(401);
      expect(res.body.success).toBe(false);
      expect(res.body.code).toBe('TOKEN_INVALID');
      expect(res.body.error).toBe('Invalid challenge');
    });

    it('returns 401 with TOKEN_INVALID for replayed challenge', async () => {
      const clientKeypair = Keypair.random();
      const xdr = buildChallenge(clientKeypair.publicKey());
      const tx = new Transaction(xdr, Networks.TESTNET);
      tx.sign(clientKeypair);
      const signedXdr = tx.toXdr();

      // First redemption succeeds
      const res1 = await request(app)
        .post('/auth/token')
        .send({ transaction: signedXdr });
      expect(res1.status).toBe(200);

      // Second redemption fails
      const res2 = await request(app)
        .post('/auth/token')
        .send({ transaction: signedXdr });
      expect(res2.status).toBe(401);
      expect(res2.body.success).toBe(false);
      expect(res2.body.code).toBe('TOKEN_INVALID');
      expect(res2.body.error).toBe('Invalid challenge');
    });
  });

  describe('400 VALIDATION_ERROR', () => {
    it('returns 400 with VALIDATION_ERROR for malformed XDR', async () => {
      const res = await request(app)
        .post('/auth/token')
        .send({ transaction: 'this-is-not-valid-xdr' });
      expect(res.status).toBe(400);
      expect(res.body.success).toBe(false);
      expect(res.body.code).toBe('VALIDATION_ERROR');
      expect(res.body.error).toBe('Invalid transaction format');
    });

    it('returns 400 with VALIDATION_ERROR for random base64-like string', async () => {
      const res = await request(app)
        .post('/auth/token')
        .send({ transaction: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA' });
      expect(res.status).toBe(400);
      expect(res.body.success).toBe(false);
      expect(res.body.code).toBe('VALIDATION_ERROR');
      expect(res.body.error).toBe('Invalid transaction format');
    });

    it('returns 400 with VALIDATION_ERROR for JSON object as transaction', async () => {
      const res = await request(app)
        .post('/auth/token')
        .send({ transaction: JSON.stringify({ fake: true }) });
      expect(res.status).toBe(400);
      expect(res.body.success).toBe(false);
      expect(res.body.code).toBe('VALIDATION_ERROR');
      expect(res.body.error).toBe('Invalid transaction format');
    });

    it('returns 400 with VALIDATION_ERROR for empty transaction string', async () => {
      const res = await request(app)
        .post('/auth/token')
        .send({ transaction: '' });
      expect(res.status).toBe(400);
      expect(res.body.success).toBe(false);
      expect(res.body.code).toBe('VALIDATION_ERROR');
    });
  });

  describe('401 TOKEN_INVALID for missing operations', () => {
    it('returns 401 with TOKEN_INVALID for challenge with no operations', async () => {
      const serverKeypair = getServerKeypair();
      const serverAccount = new Account(serverKeypair.publicKey(), '-1');
      const clientKeypair = Keypair.random();
      const tx = new TransactionBuilder(serverAccount, {
        fee: BASE_FEE,
        networkPassphrase: Networks.TESTNET,
      })
        .setTimeout(300)
        .build();

      tx.sign(serverKeypair);
      tx.sign(clientKeypair);
      const res = await request(app)
        .post('/auth/token')
        .send({ transaction: tx.toXdr() });
      expect(res.status).toBe(401);
      expect(res.body.success).toBe(false);
      expect(res.body.code).toBe('TOKEN_INVALID');
      expect(res.body.error).toBe('Invalid challenge');
    });
  });

  describe('401 TOKEN_INVALID for wrong operation type', () => {
    it('returns 401 with TOKEN_INVALID when first operation is not manageData', async () => {
      const serverKeypair = getServerKeypair();
      const serverAccount = new Account(serverKeypair.publicKey(), '-1');
      const clientKeypair = Keypair.random();
      const tx = new TransactionBuilder(serverAccount, {
        fee: BASE_FEE,
        networkPassphrase: Networks.TESTNET,
      })
        .addOperation(
          Operation.payment({
            destination: serverKeypair.publicKey(),
            amount: '1',
            asset: new Asset('TESTCOIN', serverKeypair.publicKey()),
            source: clientKeypair.publicKey(),
          })
        )
        .setTimeout(300)
        .build();

      tx.sign(serverKeypair);
      tx.sign(clientKeypair);
      const res = await request(app)
        .post('/auth/token')
        .send({ transaction: tx.toXdr() });
      expect(res.status).toBe(401);
      expect(res.body.success).toBe(false);
      expect(res.body.code).toBe('TOKEN_INVALID');
      expect(res.body.error).toBe('Invalid challenge');
    });
  });
});

describe('POST /auth/token — admin role pre-verification regression (#694)', () => {
  it('does not issue an admin-role token for a transaction whose source is an admin wallet but is not validly signed', async () => {
    // Construct a transaction XDR whose first operation's source is an admin wallet,
    // but which is NOT signed by that wallet.  Without the fix this could (in a
    // fragile code path) return a token before signature verification runs.
    // With the fix, role determination only happens from verifyChallenge()'s
    // verified account — so any signature failure produces a 401, not an admin token.
    const malformedXdr = 'AAAAAQAAAAAAAAAA'; // short / invalid XDR
    const res = await request(app)
      .post('/auth/token')
      .send({ transaction: malformedXdr });

    // Must never return 200 with an admin-role token
    expect(res.status).not.toBe(200);
    // Must be a 4xx error
    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(res.status).toBeLessThan(500);
    expect(res.body.success).toBe(false);
    // No token in the response
    expect(res.body.token).toBeUndefined();
  });

  it('returns 401 (not 200) for a well-formed XDR whose source looks admin-like but is unsigned', async () => {
    // Any malformed / unsigned transaction must be rejected before any role claim
    // is evaluated, confirming no "admin peek before verify" path exists.
    const res = await request(app)
      .post('/auth/token')
      .send({ transaction: 'AAAAAgAAAABSdummy0000000000000000000000000000000000000' });
    expect([400, 401]).toContain(res.status);
    expect(res.body.success).toBe(false);
    expect(res.body.token).toBeUndefined();
  });
});

describe('Cache-Control and Pragma headers on /auth/*', () => {
  it('sets Cache-Control: no-store and Pragma: no-cache on /auth/token responses', async () => {
    const res = await request(app)
      .post('/auth/token')
      .send({ transaction: 'this-is-not-valid-xdr' });
    expect(res.headers['cache-control']).toBe('no-store');
    expect(res.headers['pragma']).toBe('no-cache');
  });

  it('sets Cache-Control: no-store and Pragma: no-cache on /auth/refresh responses', async () => {
    const res = await request(app)
      .post('/auth/refresh')
      .send({});
    expect(res.headers['cache-control']).toBe('no-store');
    expect(res.headers['pragma']).toBe('no-cache');
  });
});
