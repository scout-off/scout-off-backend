import request from 'supertest';
import app from '../../src/app';
import { Keypair, Transaction, Networks } from '@stellar/stellar-sdk';
import { insertTrialOffer, getTrialOffers } from '../../src/services/indexer';
import { getDb, insertContactUnlock } from '../../src/db';

// Mock invokeContract so tests don't hit real Soroban
jest.mock('../../src/utils/contract', () => ({
  ...jest.requireActual('../../src/utils/contract'),
  invokeContract: jest.fn().mockResolvedValue({
    hash: 'mock-tx-hash-trial-offer-test',
    returnValue: {},
  }),
  strVal: jest.fn((s: string) => s),
}));

// POST /trial-offers submits the offer via stellar.logTrialOffer() directly
// (a real Soroban simulate/sign/send round-trip), not via utils/contract —
// mock that plus isSubscribed() (scoutHasPlayerAccess's on-chain check, which
// also round-trips to Soroban and throws in this offline test env since the
// subscription contract instance was never deployed/initialized here) so the
// route stays deterministic and offline. Everything else in the module —
// getLatestSubscription, hasContactUnlock's callers, etc. — stays real.
jest.mock('../../src/services/stellar', () => ({
  ...jest.requireActual('../../src/services/stellar'),
  isSubscribed: jest.fn().mockResolvedValue({ active: false, expiresAt: null }),
  logTrialOffer: jest.fn().mockResolvedValue({
    transactionId: 'mock-tx-hash-trial-offer-test',
    playerId: 'player-99',
    detailsUri: 'ipfs://QmPost',
    playerTier: 0,
  }),
}));

const SCOUT_KEYPAIR = Keypair.random();
const SCOUT_WALLET = SCOUT_KEYPAIR.publicKey();

// Mints a token for SCOUT_WALLET specifically — POST /trial-offers checks
// req.account === req.params.wallet, so the signing keypair must match the
// wallet used in the URL for the request to be treated as the offer's owner.
async function getScoutToken(): Promise<string> {
  const challengeRes = await request(app).get(`/auth/challenge?account=${SCOUT_WALLET}`);
  const tx = new Transaction(challengeRes.body.challenge, Networks.TESTNET);
  tx.sign(SCOUT_KEYPAIR);
  const tokenRes = await request(app)
    .post('/auth/token')
    .send({ transaction: tx.toXdr(), role: 'scout' });
  return tokenRes.body.token;
}

describe('#285 trial_offers', () => {
  describe('insertTrialOffer + getTrialOffers (DB layer)', () => {
    it('persists an offer and retrieves it by scout wallet', async () => {
      const now = Math.floor(Date.now() / 1000);
      await insertTrialOffer(SCOUT_WALLET, 'player-1', 'ipfs://QmTest', 'tx-hash-1', now);

      const offers = await getTrialOffers(SCOUT_WALLET);
      expect(offers.length).toBeGreaterThanOrEqual(1);

      const offer = offers.find((o) => o.tx_hash === 'tx-hash-1');
      expect(offer).toBeDefined();
      expect(offer!.scout_wallet).toBe(SCOUT_WALLET);
      expect(offer!.player_id).toBe('player-1');
      expect(offer!.details_uri).toBe('ipfs://QmTest');
      expect(offer!.created_at).toBe(now);
    });

    it('does not insert duplicate tx_hash', async () => {
      const now = Math.floor(Date.now() / 1000);
      await insertTrialOffer(SCOUT_WALLET, 'player-2', 'ipfs://QmDup', 'tx-dup', now);
      await insertTrialOffer(SCOUT_WALLET, 'player-2', 'ipfs://QmDup', 'tx-dup', now);

      const offers = (await getTrialOffers(SCOUT_WALLET)).filter((o) => o.tx_hash === 'tx-dup');
      expect(offers.length).toBe(1);
    });
  });

  describe('GET /api/scouts/:wallet/trial-offers', () => {
    it('returns 401 without auth', async () => {
      const res = await request(app).get(`/api/scouts/${SCOUT_WALLET}/trial-offers`);
      expect(res.status).toBe(401);
    });

    it('returns offer list for authenticated scout', async () => {
      // Pre-seed an offer
      await insertTrialOffer(SCOUT_WALLET, 'player-3', 'ipfs://QmGet', 'tx-get-test', Math.floor(Date.now() / 1000));

      const token = await getScoutToken();
      const res = await request(app)
        .get(`/api/scouts/${SCOUT_WALLET}/trial-offers`)
        .set('Authorization', `Bearer ${token}`);

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(Array.isArray(res.body.data)).toBe(true);
    });
  });

  describe('POST /api/scouts/:wallet/trial-offers', () => {
    it('returns 401 without auth', async () => {
      const res = await request(app)
        .post(`/api/scouts/${SCOUT_WALLET}/trial-offers`)
        .send({ playerId: 'player-1', detailsUri: 'ipfs://QmX' });
      expect(res.status).toBe(401);
    });

    it('returns 400 for missing fields', async () => {
      const token = await getScoutToken();
      const res = await request(app)
        .post(`/api/scouts/${SCOUT_WALLET}/trial-offers`)
        .set('Authorization', `Bearer ${token}`)
        .send({ playerId: '' });
      expect(res.status).toBe(400);
    });

    it('inserts offer and returns 201 with transactionId', async () => {
      // createTrialOffer requires the player to exist (a player_registered
      // event) and the scout to already have access (subscription or a
      // prior contact unlock) before it will submit the on-chain offer.
      const createdAt = Date.now();
      getDb()
        .prepare(
          `INSERT INTO events (type, ledger, tx_hash, payload, created_at)
           VALUES (?, ?, ?, ?, ?)`,
        )
        .run(
          'player_registered',
          1,
          'tx-player-99-registered',
          JSON.stringify({ player_id: 'player-99' }),
          createdAt,
        );
      insertContactUnlock({
        scout_wallet: SCOUT_WALLET,
        player_id: 'player-99',
        tx_hash: 'tx-unlock-player-99',
        unlocked_at: Math.floor(createdAt / 1000),
      });

      const token = await getScoutToken();
      const res = await request(app)
        .post(`/api/scouts/${SCOUT_WALLET}/trial-offers`)
        .set('Authorization', `Bearer ${token}`)
        .send({ playerId: 'player-99', detailsUri: 'ipfs://QmPost' });

      expect(res.status).toBe(201);
      expect(res.body.success).toBe(true);
      expect(res.body.data.transactionId).toBe('mock-tx-hash-trial-offer-test');

      // Verify persisted
      const stored = (await getTrialOffers(SCOUT_WALLET)).find(
        (o) => o.tx_hash === 'mock-tx-hash-trial-offer-test'
      );
      expect(stored).toBeDefined();
      expect(stored!.player_id).toBe('player-99');
    });
  });
});
