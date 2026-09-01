import { buildChallenge, verifyAndIssueToken } from '../../src/services/sep10';
import crypto from 'crypto';
import { Keypair, Transaction, Networks, TransactionBuilder, BASE_FEE, Operation, Account, Asset } from '@stellar/stellar-sdk';

const clientKeypair = Keypair.random();

describe('sep10', () => {
  it('buildChallenge returns a valid XDR string', () => {
    const xdr = buildChallenge(clientKeypair.publicKey());
    expect(typeof xdr).toBe('string');
    expect(xdr.length).toBeGreaterThan(0);
  });

  it('verifyAndIssueToken issues a JWT after client signs the challenge', () => {
    const xdr = buildChallenge(clientKeypair.publicKey());
    const tx = new Transaction(xdr, Networks.TESTNET);
    tx.sign(clientKeypair);
    const signedXdr = tx.toXdr();

    const { token, account } = verifyAndIssueToken(signedXdr);
    expect(typeof token).toBe('string');
    expect(account).toBe(clientKeypair.publicKey());
  });

  it('verifyAndIssueToken throws on unsigned challenge', () => {
    const xdr = buildChallenge(clientKeypair.publicKey());
    expect(() => verifyAndIssueToken(xdr)).toThrow('Invalid challenge signature');
  });

  it('verifyAndIssueToken throws when server signature is absent', () => {
    // Build a valid-looking challenge from a rogue server (not our SERVER_KEYPAIR)
    const rogueKeypair = Keypair.random();
    const rogueAccount = new Account(rogueKeypair.publicKey(), '-1');
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

    // Sign with the rogue keypair (not our server) and the client
    tx.sign(rogueKeypair);
    tx.sign(clientKeypair);
    const xdr = tx.toXdr();

    // Should reject because our server did not sign this challenge
    expect(() => verifyAndIssueToken(xdr)).toThrow('Challenge not signed by server');
  });

  // Challenge structure validation tests
  describe('challenge structure validation', () => {
    it('throws when challenge has no operations', () => {
      const serverKeypair = Keypair.random();
      const serverAccount = new Account(serverKeypair.publicKey(), '-1');
      const tx = new TransactionBuilder(serverAccount, {
        fee: BASE_FEE,
        networkPassphrase: Networks.TESTNET,
      })
        .setTimeout(300)
        .build();

      tx.sign(serverKeypair);
      tx.sign(clientKeypair);
      const xdr = tx.toXdr();

      expect(() => verifyAndIssueToken(xdr)).toThrow('Invalid challenge: no operations found');
    });

    it('throws when first operation is not manageData', () => {
      const serverKeypair = Keypair.random();
      const serverAccount = new Account(serverKeypair.publicKey(), '-1');
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
      const xdr = tx.toXdr();

      expect(() => verifyAndIssueToken(xdr)).toThrow('Invalid challenge: expected manageData operation');
    });

    it('throws when operation name does not match "scoutoff auth"', () => {
      const serverKeypair = Keypair.random();
      const serverAccount = new Account(serverKeypair.publicKey(), '-1');
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
      const xdr = tx.toXdr();

      expect(() => verifyAndIssueToken(xdr)).toThrow('Invalid challenge: wrong operation name');
    });

    it('throws when nonce value is missing', () => {
      const serverKeypair = Keypair.random();
      const serverAccount = new Account(serverKeypair.publicKey(), '-1');
      const tx = new TransactionBuilder(serverAccount, {
        fee: BASE_FEE,
        networkPassphrase: Networks.TESTNET,
      })
        .addOperation(
          Operation.manageData({
            name: 'scoutoff auth',
            value: null, // Explicitly no nonce
            source: clientKeypair.publicKey(),
          })
        )
        .setTimeout(300)
        .build();

      tx.sign(serverKeypair);
      tx.sign(clientKeypair);
      const xdr = tx.toXdr();

      expect(() => verifyAndIssueToken(xdr)).toThrow('Invalid challenge: missing nonce value');
    });

    it('throws when nonce is not exactly 64 bytes (decoded)', () => {
      const serverKeypair = Keypair.random();
      const serverAccount = new Account(serverKeypair.publicKey(), '-1');
      const tx = new TransactionBuilder(serverAccount, {
        fee: BASE_FEE,
        networkPassphrase: Networks.TESTNET,
      })
        .addOperation(
          Operation.manageData({
            name: 'scoutoff auth',
            value: Buffer.from('too-short'), // 9 bytes instead of 64
            source: clientKeypair.publicKey(),
          })
        )
        .setTimeout(300)
        .build();

      tx.sign(serverKeypair);
      tx.sign(clientKeypair);
      const xdr = tx.toXdr();

      expect(() => verifyAndIssueToken(xdr)).toThrow('Invalid challenge: nonce must be exactly 64 bytes');
    });

    it('throws when operation source is missing', () => {
      const serverKeypair = Keypair.random();
      const serverAccount = new Account(serverKeypair.publicKey(), '-1');
      const tx = new TransactionBuilder(serverAccount, {
        fee: BASE_FEE,
        networkPassphrase: Networks.TESTNET,
      })
        .addOperation(
          Operation.manageData({
            name: 'scoutoff auth',
            value: crypto.randomBytes(48).toString('base64'),
            // No source specified - defaults to undefined
          })
        )
        .setTimeout(300)
        .build();

      tx.sign(serverKeypair);
      tx.sign(clientKeypair);
      const xdr = tx.toXdr();

      expect(() => verifyAndIssueToken(xdr)).toThrow('Missing source account in challenge');
    });

    it('accepts valid challenge with correct structure', () => {
      const xdr = buildChallenge(clientKeypair.publicKey());
      const tx = new Transaction(xdr, Networks.TESTNET);
      tx.sign(clientKeypair);
      const signedXdr = tx.toXdr();

      const { token, account } = verifyAndIssueToken(signedXdr);
      expect(typeof token).toBe('string');
      expect(account).toBe(clientKeypair.publicKey());
    });
  });

  describe('TTL / expiry enforcement', () => {
    it('throws when challenge maxTime has passed', () => {
      const xdr = buildChallenge(clientKeypair.publicKey());
      const tx = new Transaction(xdr, Networks.TESTNET);
      tx.sign(clientKeypair);
      const signedXdr = tx.toXdr();

      // Advance Date.now() past the challenge TTL (300 s)
      const realNow = Date.now;
      Date.now = () => realNow() + 400_000; // +400 seconds → past maxTime
      try {
        expect(() => verifyAndIssueToken(signedXdr)).toThrow('Challenge has expired');
      } finally {
        Date.now = realNow;
      }
    });

    it('accepts a challenge whose maxTime has not yet passed', () => {
      const xdr = buildChallenge(clientKeypair.publicKey());
      const tx = new Transaction(xdr, Networks.TESTNET);
      tx.sign(clientKeypair);
      const signedXdr = tx.toXdr();

      // Wind back time slightly to ensure we're before maxTime
      const realNow = Date.now;
      Date.now = () => realNow() - 1_000;
      try {
        const { token } = verifyAndIssueToken(signedXdr);
        expect(typeof token).toBe('string');
      } finally {
        Date.now = realNow;
      }
    });
  });

  // ---------------------------------------------------------------------------
  // Replay / nonce consumption (#693)
  // ---------------------------------------------------------------------------
  describe('challenge replay protection', () => {
    it('rejects a second token exchange using the identical signed challenge', () => {
      const xdr = buildChallenge(clientKeypair.publicKey());
      const tx = new Transaction(xdr, Networks.TESTNET);
      tx.sign(clientKeypair);
      const signedXdr = tx.toXdr();

      // First exchange succeeds and consumes the challenge's nonce.
      const { token, account } = verifyAndIssueToken(signedXdr);
      expect(typeof token).toBe('string');
      expect(account).toBe(clientKeypair.publicKey());

      // A second exchange with the exact same signed challenge — as an
      // attacker replaying a captured request would attempt — must be
      // rejected rather than minting another token.
      expect(() => verifyAndIssueToken(signedXdr)).toThrow('Challenge has already been used');
    });

    it('does not consume the nonce when an earlier verification step fails', () => {
      // Unsigned challenge — fails signature verification before the nonce
      // would ever be recorded as consumed.
      const xdr = buildChallenge(clientKeypair.publicKey());
      expect(() => verifyAndIssueToken(xdr)).toThrow('Invalid challenge signature');

      // Now sign it properly — this must still succeed, proving the failed
      // attempt above did not mark the nonce as used.
      const tx = new Transaction(xdr, Networks.TESTNET);
      tx.sign(clientKeypair);
      const signedXdr = tx.toXdr();
      const { token } = verifyAndIssueToken(signedXdr);
      expect(typeof token).toBe('string');
    });

    it('allows two different challenges (distinct nonces) to each be redeemed once', () => {
      const xdrA = buildChallenge(clientKeypair.publicKey());
      const txA = new Transaction(xdrA, Networks.TESTNET);
      txA.sign(clientKeypair);

      const xdrB = buildChallenge(clientKeypair.publicKey());
      const txB = new Transaction(xdrB, Networks.TESTNET);
      txB.sign(clientKeypair);

      expect(() => verifyAndIssueToken(txA.toXdr())).not.toThrow();
      expect(() => verifyAndIssueToken(txB.toXdr())).not.toThrow();
    });
  });

  // ---------------------------------------------------------------------------
  // Cross-instance verification (horizontal scaling)
  // ---------------------------------------------------------------------------
  /**
   * This describe block proves the fix for the horizontal-scaling bug.
   *
   * Before the fix every backend process called Keypair.random() at module
   * load, so two independent processes had different keypairs.  Instance A
   * built the challenge (signed with keypair A), but if the wallet's
   * POST /auth/token request landed on instance B, the server-signature check
   * failed because keypair B ≠ keypair A.
   *
   * After the fix both instances load the keypair from SEP10_SERVER_SECRET.
   * We simulate this by using jest.isolateModules() to load the sep10 module
   * twice from scratch — exactly as two separate Node.js processes would — with
   * the same SEP10_SERVER_SECRET env var, then assert that a challenge built by
   * one "instance" verifies via the other's verifyAndIssueToken.
   */
  describe('cross-instance challenge verification (horizontal scaling fix)', () => {
    // A real Stellar secret key used as the shared SEP10_SERVER_SECRET.
    // Generated fresh per test run — safe to use in tests only.
    const SHARED_SERVER_SECRET = Keypair.random().secret();

    function loadSep10WithSharedSecret(): Promise<{
      buildChallenge: (account: string) => string;
      verifyAndIssueToken: (xdr: string, role?: string) => { token: string; account: string };
    }> {
      return new Promise((resolve, reject) => {
        jest.isolateModules(() => {
          try {
            // Override the env var so this fresh module load picks up the shared key.
            process.env.SEP10_SERVER_SECRET = SHARED_SERVER_SECRET;
            // eslint-disable-next-line @typescript-eslint/no-var-requires
            const mod = require('../../src/services/sep10');
            resolve(mod);
          } catch (err) {
            reject(err);
          } finally {
            // Restore so other tests are unaffected.
            delete process.env.SEP10_SERVER_SECRET;
          }
        });
      });
    }

    it('instance B verifies a challenge built by instance A when both share SEP10_SERVER_SECRET', async () => {
      // Load two independent instances of the sep10 module, each initialised
      // with the same SEP10_SERVER_SECRET — simulating two backend processes.
      const instanceA = await loadSep10WithSharedSecret();
      const instanceB = await loadSep10WithSharedSecret();

      // Instance A builds the challenge.
      const challengeXdr = instanceA.buildChallenge(clientKeypair.publicKey());

      // The client signs the challenge (as it would in a real auth flow).
      const tx = new Transaction(challengeXdr, Networks.TESTNET);
      tx.sign(clientKeypair);
      const signedXdr = tx.toXdr();

      // Instance B verifies the signed challenge — must succeed despite being a
      // completely separate module instance (i.e. a different "process").
      const { token, account } = instanceB.verifyAndIssueToken(signedXdr);
      expect(typeof token).toBe('string');
      expect(account).toBe(clientKeypair.publicKey());
    });

    it('instance B rejects a challenge built with a different keypair (no shared secret)', async () => {
      // instanceA is loaded with the shared secret.
      const instanceA = await loadSep10WithSharedSecret();

      // instanceB is loaded WITHOUT the shared secret — it gets a random ephemeral key.
      // This replicates the pre-fix behaviour when SEP10_SERVER_SECRET is absent.
      const instanceB = await new Promise<{
        buildChallenge: (account: string) => string;
        verifyAndIssueToken: (xdr: string, role?: string) => { token: string; account: string };
      }>((resolve, reject) => {
        jest.isolateModules(() => {
          try {
            // Ensure the env var is NOT set for this instance.
            delete process.env.SEP10_SERVER_SECRET;
            // eslint-disable-next-line @typescript-eslint/no-var-requires
            resolve(require('../../src/services/sep10'));
          } catch (err) {
            reject(err);
          }
        });
      });

      // Instance A builds a challenge signed with its configured keypair.
      const challengeXdr = instanceA.buildChallenge(clientKeypair.publicKey());
      const tx = new Transaction(challengeXdr, Networks.TESTNET);
      tx.sign(clientKeypair);
      const signedXdr = tx.toXdr();

      // Instance B (different random keypair) must reject it — proving that
      // sharing the secret is the only way to make cross-instance auth work.
      expect(() => instanceB.verifyAndIssueToken(signedXdr)).toThrow('Challenge not signed by server');
    });
  });
});
