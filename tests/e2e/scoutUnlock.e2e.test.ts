/**
 * End-to-end test for the subscribe → unlock-to-contact flow:
 * 1. Scout authenticates (JWT minted directly, mirroring milestonePromotion.e2e.test.ts)
 * 2. POST /api/scouts/:wallet/subscribe — purchase a subscription
 * 3. POST /api/scouts/:wallet/contacts/:playerId/unlock — pay to unlock a player's contact
 * 4. Re-unlocking the same player must not trigger a second on-chain payment (idempotency)
 * 5. GET /api/scouts/:wallet/contacts reflects the unlock
 * 6. GET /api/scouts/:wallet/payments reflects the recorded payment
 */

import request from 'supertest';
import jwt from 'jsonwebtoken';
import { Keypair } from '@stellar/stellar-sdk';
import app from '../../src/app';
import { getDb } from '../../src/db';

const SECRET = process.env.JWT_SECRET ?? 'test-secret';
const SCOUT_WALLET = Keypair.random().publicKey();
const PLAYER_ID = 'player-unlock-e2e-1';
const PLAYER_WALLET = Keypair.random().publicKey();

/** Insert a player row so the unlock endpoint's player validation passes. */
function insertPlayer(playerId: string, wallet: string): void {
  getDb()
    .prepare(
      `INSERT INTO players (player_id, wallet, position, region, metadata_uri, progress_level, created_at, registered_at, is_active)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(player_id) DO NOTHING`,
    )
    .run(
      playerId,
      wallet,
      'Forward',
      'West Africa',
      'ipfs://QmE2eContactMetadata',
      1,
      Date.now(),
      Date.now(),
      1,
    );
}

jest.mock('../../src/services/ipfs', () => ({
  pinJson: jest.fn().mockResolvedValue('QmTestEvidenceCid'),
  checkHealth: jest.fn().mockResolvedValue(undefined),
  gatewayUrl: jest.fn((cid: string) => `https://gateway/${cid}`),
  gatewayUrls: jest.fn((cid: string) => [`https://gateway/${cid}`]),
}));

jest.mock('../../src/services/indexer', () => ({
  indexEvents: jest.fn(),
  normalizeEventId: jest.fn(),
  insertTrialOffer: jest.fn(),
  getTrialOffers: jest.fn().mockReturnValue([]),
}));

jest.mock('../../src/services/webhooks', () => ({
  dispatchEventWebhook: jest.fn().mockResolvedValue(undefined),
}));

jest.mock('../../src/services/stellar', () => ({
  purchaseSubscription: jest.fn(),
  submitContactPayment: jest.fn(),
  isSubscribed: jest.fn().mockResolvedValue({ active: false, expiresAt: null }),
  renewSubscription: jest.fn(),
  cancelSubscriptionOnChain: jest.fn(),
  logTrialOffer: jest.fn(),
  PaymentError: class PaymentError extends Error {
    constructor(public message: string, public code: string) {
      super(message);
    }
  },
  SubscriptionError: class SubscriptionError extends Error {
    constructor(public message: string, public code: string) {
      super(message);
    }
  },
}));

import { purchaseSubscription, submitContactPayment } from '../../src/services/stellar';

const mockPurchaseSubscription = purchaseSubscription as jest.Mock;
const mockSubmitContactPayment = submitContactPayment as jest.Mock;

function makeToken(wallet: string, role = 'scout'): string {
  return jwt.sign({ sub: wallet, role }, SECRET, { expiresIn: '1h' });
}

describe('E2E Subscribe → Unlock Contact Flow', () => {
  const scoutToken = makeToken(SCOUT_WALLET);

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('subscribes, unlocks a contact once, never double-charges on retry, and surfaces the result in contacts/payments', async () => {
    // ── Step 1: subscribe ──────────────────────────────────────────────────
    const subscriptionExpiresAt = Math.floor(Date.now() / 1000) + 30 * 86400;
    mockPurchaseSubscription.mockResolvedValue({
      transactionId: 'tx-subscribe-1',
      tier: 'basic',
      expiresAt: subscriptionExpiresAt,
      status: 'active',
    });

    const subscribeRes = await request(app)
      .post(`/api/scouts/${SCOUT_WALLET}/subscribe`)
      .set('Authorization', `Bearer ${scoutToken}`)
      .send({ tier: 'basic', duration: 30 });

    expect(subscribeRes.status).toBe(201);
    expect(subscribeRes.body.success).toBe(true);
    expect(subscribeRes.body.data.transactionId).toBe('tx-subscribe-1');
    expect(mockPurchaseSubscription).toHaveBeenCalledTimes(1);

    const subscriptionRes = await request(app)
      .get(`/api/scouts/${SCOUT_WALLET}/subscription`)
      .set('Authorization', `Bearer ${scoutToken}`);

    expect(subscriptionRes.status).toBe(200);
    expect(subscriptionRes.body.data.active).toBe(true);
    expect(subscriptionRes.body.data.tier).toBe('basic');

    // ── Step 2: unlock the player's contact ────────────────────────────────
    insertPlayer(PLAYER_ID, PLAYER_WALLET);
    mockSubmitContactPayment.mockResolvedValue({ transactionId: 'tx-unlock-1', status: 'submitted' });

    const firstUnlockRes = await request(app)
      .post(`/api/scouts/${SCOUT_WALLET}/contacts/${PLAYER_ID}/unlock`)
      .set('Authorization', `Bearer ${scoutToken}`)
      .send({});

    expect(firstUnlockRes.status).toBe(200);
    expect(firstUnlockRes.body.success).toBe(true);
    expect(mockSubmitContactPayment).toHaveBeenCalledTimes(1);
    expect(mockSubmitContactPayment).toHaveBeenCalledWith(SCOUT_WALLET, PLAYER_ID);

    // ── Step 3: re-unlocking the same player must not double-charge ───────
    const secondUnlockRes = await request(app)
      .post(`/api/scouts/${SCOUT_WALLET}/contacts/${PLAYER_ID}/unlock`)
      .set('Authorization', `Bearer ${scoutToken}`)
      .send({});

    expect(secondUnlockRes.status).toBe(200);
    expect(secondUnlockRes.body.success).toBe(true);
    expect(secondUnlockRes.body.data.alreadyUnlocked).toBe(true);
    // No additional on-chain payment must have been submitted.
    expect(mockSubmitContactPayment).toHaveBeenCalledTimes(1);

    // ── Step 4: contacts endpoint reflects the unlock ──────────────────────
    const contactsRes = await request(app)
      .get(`/api/scouts/${SCOUT_WALLET}/contacts`)
      .set('Authorization', `Bearer ${scoutToken}`);

    expect(contactsRes.status).toBe(200);
    expect(contactsRes.body.success).toBe(true);
    expect(contactsRes.body.data).toContainEqual(
      expect.objectContaining({ playerId: PLAYER_ID, contact_status: 'unlocked' }),
    );

    // ── Step 5: payment history reflects the unlock ────────────────────────
    // The `contact_unlocked` event is normally written by the on-chain indexer;
    // simulate that here the same way tests/e2e/milestonePromotion.e2e.test.ts
    // simulates `milestone_approved`.
    const paymentTimestamp = new Date().toISOString();
    getDb()
      .prepare(
        `INSERT INTO events (type, ledger, tx_hash, payload, created_at)
         VALUES (?, ?, ?, ?, ?)`,
      )
      .run(
        'contact_unlocked',
        2000,
        'tx-unlock-1',
        JSON.stringify({
          scout: SCOUT_WALLET,
          player_id: PLAYER_ID,
          tx_hash: 'tx-unlock-1',
          fee: '5',
          timestamp: paymentTimestamp,
        }),
        Date.now(),
      );

    const paymentsRes = await request(app)
      .get(`/api/scouts/${SCOUT_WALLET}/payments`)
      .set('Authorization', `Bearer ${scoutToken}`);

    expect(paymentsRes.status).toBe(200);
    expect(paymentsRes.body.success).toBe(true);
    expect(paymentsRes.body.data).toContainEqual(
      expect.objectContaining({ transactionId: 'tx-unlock-1', amount: '5', token: 'XLM' }),
    );
  });

  it('replays an Idempotency-Key from cache without submitting a second on-chain payment', async () => {
    const scout2 = Keypair.random().publicKey();
    const player2 = 'player-unlock-e2e-2';
    const player2Wallet = Keypair.random().publicKey();
    const token = makeToken(scout2);

    // Clear call history accumulated by the previous test in this file.
    mockSubmitContactPayment.mockClear();
    insertPlayer(player2, player2Wallet);
    mockSubmitContactPayment.mockResolvedValue({ transactionId: 'tx-unlock-idem', status: 'submitted' });

    const first = await request(app)
      .post(`/api/scouts/${scout2}/contacts/${player2}/unlock`)
      .set('Authorization', `Bearer ${token}`)
      .set('Idempotency-Key', 'e2e-idem-key')
      .send({});

    expect(first.status).toBe(200);
    expect(first.body.success).toBe(true);
    expect(mockSubmitContactPayment).toHaveBeenCalledTimes(1);

    // Same key, same request → cached response, no second transaction.
    const replay = await request(app)
      .post(`/api/scouts/${scout2}/contacts/${player2}/unlock`)
      .set('Authorization', `Bearer ${token}`)
      .set('Idempotency-Key', 'e2e-idem-key')
      .send({});

    expect(replay.status).toBe(200);
    expect(replay.body).toEqual(first.body);
    expect(mockSubmitContactPayment).toHaveBeenCalledTimes(1);

    // Conflicting request (different player) with the same key → 409, no payment.
    const player3 = 'player-unlock-e2e-3';
    insertPlayer(player3, Keypair.random().publicKey());
    const conflict = await request(app)
      .post(`/api/scouts/${scout2}/contacts/${player3}/unlock`)
      .set('Authorization', `Bearer ${token}`)
      .set('Idempotency-Key', 'e2e-idem-key')
      .send({});

    expect(conflict.status).toBe(409);
    expect(mockSubmitContactPayment).toHaveBeenCalledTimes(1);
  });
});
