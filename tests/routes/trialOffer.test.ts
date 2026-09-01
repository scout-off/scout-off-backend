/**
 * Trial-offer submission (#1034).
 *
 * `POST /api/scouts/:wallet/trial-offers` is the canonical submission endpoint;
 * `POST /api/scouts/:wallet/trial-offer` is a deprecated alias that delegates to
 * the same handler. Every case below runs against BOTH paths so the two can
 * never drift apart again — the alias used to skip persistence, tier promotion
 * and the SSE broadcast while still answering 201.
 */

import request from 'supertest';
import jwt from 'jsonwebtoken';
import app from '../../src/app';

const SECRET = process.env.JWT_SECRET ?? 'test-secret';

const WALLET = 'GSCOUTWALLET1AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';
const OTHER = 'GOTHERWALLET2AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';
const PLAYER_ID = 'player-trial-123';

jest.mock('../../src/db', () => ({
  queryEvents: jest.fn().mockReturnValue([]),
  getLatestSubscription: jest.fn().mockReturnValue(null),
  insertSubscription: jest.fn(),
  getPlayerById: jest.fn(),
  hasContactUnlock: jest.fn().mockReturnValue(false),
  getContactUnlocksByScout: jest.fn().mockReturnValue([]),
  insertContactUnlock: jest.fn(),
  // Required by the consolidated submission flow: the offer/response workflow
  // row and the player's tier promotion.
  insertTrialOffer: jest.fn(),
  updatePlayerProgress: jest.fn(),
  // Touched by the idempotency middleware only when an Idempotency-Key header
  // is present; stubbed so the middleware never sees an undefined import.
  getIdempotencyRecord: jest.fn().mockReturnValue(null),
  claimIdempotencyKey: jest.fn().mockReturnValue(true),
  updateIdempotencyRecord: jest.fn(),
}));

jest.mock('../../src/services/indexer', () => ({
  indexEvents: jest.fn(),
  normalizeEventId: jest.fn(),
  insertTrialOffer: jest.fn(),
  getTrialOffers: jest.fn().mockReturnValue([]),
}));

jest.mock('../../src/services/stellar', () => ({
  isSubscribed: jest.fn().mockResolvedValue({ active: false, expiresAt: null }),
  purchaseSubscription: jest.fn(),
  renewSubscription: jest.fn(),
  cancelSubscriptionOnChain: jest.fn(),
  submitContactPayment: jest.fn(),
  logTrialOffer: jest.fn(),
  PaymentError: class PaymentError extends Error {
    constructor(public message: string, public code: string) {
      super(message);
    }
  },
}));

import {
  queryEvents,
  hasContactUnlock,
  getLatestSubscription,
  insertTrialOffer as insertTrialOfferRow,
  updatePlayerProgress,
} from '../../src/db';
import { insertTrialOffer as insertTrialOfferEvent } from '../../src/services/indexer';
import { isSubscribed, logTrialOffer } from '../../src/services/stellar';
import { broadcaster } from '../../src/services/eventBroadcaster';

const mockGetEvents = queryEvents as jest.Mock;
const mockHasContactUnlock = hasContactUnlock as jest.Mock;
const mockIsSubscribed = isSubscribed as jest.Mock;
const mockLogTrialOffer = logTrialOffer as jest.Mock;
const mockGetLatestSubscription = getLatestSubscription as jest.Mock;
const mockInsertOfferRow = insertTrialOfferRow as jest.Mock;
const mockInsertOfferEvent = insertTrialOfferEvent as jest.Mock;
const mockUpdateProgress = updatePlayerProgress as jest.Mock;

const broadcastSpy = jest.spyOn(broadcaster, 'broadcast').mockImplementation(() => undefined);

function makeToken(wallet: string, role = 'scout'): string {
  return jwt.sign({ sub: wallet, role }, SECRET, { expiresIn: '1h' });
}

/** Make the player exist so the flow gets past the player-not-found check. */
function registerPlayer(): void {
  mockGetEvents.mockImplementation((type?: string) => {
    if (type === 'player_registered') {
      return [
        {
          source: 'contract',
          type: 'player_registered',
          contractAddress: 'contract',
          payload: { player_id: PLAYER_ID, wallet: 'GPLAYERWALLET' },
        },
      ];
    }
    return [];
  });
}

/** Every side effect the submission flow is expected to perform. */
function sideEffectCallCount(): number {
  return (
    mockLogTrialOffer.mock.calls.length +
    mockInsertOfferEvent.mock.calls.length +
    mockInsertOfferRow.mock.calls.length +
    mockUpdateProgress.mock.calls.length +
    broadcastSpy.mock.calls.length
  );
}

const VALID_BODY = {
  playerId: PLAYER_ID,
  detailsUri: 'ipfs://QmValidCid1234567890',
};

beforeEach(() => {
  jest.clearAllMocks();
  mockGetEvents.mockReturnValue([]);
  mockIsSubscribed.mockResolvedValue({ active: false, expiresAt: null });
  mockHasContactUnlock.mockReturnValue(false);
  mockGetLatestSubscription.mockReturnValue(null);
  broadcastSpy.mockImplementation(() => undefined);
});

// The canonical path and its deprecated alias must behave identically.
const ROUTES: ReadonlyArray<readonly [string, string]> = [
  ['canonical', 'trial-offers'],
  ['deprecated alias', 'trial-offer'],
];

describe.each(ROUTES)('%s route — POST /api/scouts/:wallet/%s', (_label, segment) => {
  const URL = `/api/scouts/${WALLET}/${segment}`;

  it('returns 401 when no token is provided', async () => {
    const res = await request(app).post(URL).send(VALID_BODY);
    expect(res.status).toBe(401);
  });

  it('returns 403 when token role is not scout', async () => {
    const token = makeToken(WALLET, 'player');
    const res = await request(app).post(URL).set('Authorization', `Bearer ${token}`).send(VALID_BODY);
    expect(res.status).toBe(403);
  });

  it('returns 403 when JWT wallet does not match path wallet', async () => {
    const token = makeToken(OTHER);
    const res = await request(app).post(URL).set('Authorization', `Bearer ${token}`).send(VALID_BODY);
    expect(res.status).toBe(403);
    expect(res.body.success).toBe(false);
    expect(res.body.error).toMatch(/wallet/i);
    expect(sideEffectCallCount()).toBe(0);
  });

  it('returns 404 when player is not found', async () => {
    const token = makeToken(WALLET);
    const res = await request(app).post(URL).set('Authorization', `Bearer ${token}`).send(VALID_BODY);
    expect(res.status).toBe(404);
    expect(res.body.success).toBe(false);
    expect(res.body.error).toMatch(/player not found/i);
    expect(sideEffectCallCount()).toBe(0);
  });

  it('returns 402 when scout lacks access (no subscription or unlock)', async () => {
    registerPlayer();
    const token = makeToken(WALLET);
    const res = await request(app).post(URL).set('Authorization', `Bearer ${token}`).send(VALID_BODY);
    expect(res.status).toBe(402);
    expect(res.body.success).toBe(false);
    expect(res.body.error).toMatch(/subscribed|contact fee/i);
    expect(sideEffectCallCount()).toBe(0);
  });

  // ── Zod validation ──────────────────────────────────────────────────────────

  it('returns 400 for an invalid detailsUri and persists nothing', async () => {
    registerPlayer();
    mockHasContactUnlock.mockReturnValue(true);
    const token = makeToken(WALLET);
    const res = await request(app)
      .post(URL)
      .set('Authorization', `Bearer ${token}`)
      .send({ playerId: PLAYER_ID, detailsUri: 'ftp://bad-uri' });
    expect(res.status).toBe(400);
    expect(res.body.success).toBe(false);
    expect(sideEffectCallCount()).toBe(0);
  });

  it('returns 400 when playerId is missing and persists nothing', async () => {
    registerPlayer();
    mockHasContactUnlock.mockReturnValue(true);
    const token = makeToken(WALLET);
    const res = await request(app)
      .post(URL)
      .set('Authorization', `Bearer ${token}`)
      .send({ detailsUri: 'ipfs://QmValidCid' });
    expect(res.status).toBe(400);
    expect(res.body.success).toBe(false);
    expect(sideEffectCallCount()).toBe(0);
  });

  // ── Success path — the full business operation ──────────────────────────────

  it('performs the complete submission flow when the scout has a contact unlock', async () => {
    registerPlayer();
    mockHasContactUnlock.mockReturnValue(true);
    mockLogTrialOffer.mockResolvedValue({
      transactionId: 'tx-offer-1',
      playerId: PLAYER_ID,
      detailsUri: VALID_BODY.detailsUri,
      playerTier: 3,
    });

    const token = makeToken(WALLET);
    const res = await request(app).post(URL).set('Authorization', `Bearer ${token}`).send(VALID_BODY);

    // Response
    expect(res.status).toBe(201);
    expect(res.body.success).toBe(true);
    expect(res.body.data).toEqual(
      expect.objectContaining({
        offerId: expect.stringContaining(`-${PLAYER_ID}`),
        transactionId: 'tx-offer-1',
        scout: WALLET,
        playerId: PLAYER_ID,
        detailsUri: VALID_BODY.detailsUri,
        createdAt: expect.any(Number),
        tierPromoted: true,
        newTier: 3,
      }),
    );

    // On-chain submission
    expect(mockLogTrialOffer).toHaveBeenCalledWith(WALLET, PLAYER_ID, VALID_BODY.detailsUri);

    // trial_offer_events (indexer log, deduped by tx_hash)
    expect(mockInsertOfferEvent).toHaveBeenCalledWith(
      WALLET,
      PLAYER_ID,
      VALID_BODY.detailsUri,
      'tx-offer-1',
      expect.any(Number),
    );

    // trial_offers (offer/response workflow row)
    expect(mockInsertOfferRow).toHaveBeenCalledWith(
      expect.objectContaining({
        offer_id: res.body.data.offerId,
        scout_wallet: WALLET,
        player_id: PLAYER_ID,
        details_uri: VALID_BODY.detailsUri,
      }),
    );

    // Elite Tier promotion
    expect(mockUpdateProgress).toHaveBeenCalledWith(PLAYER_ID, 3);

    // SSE broadcasts
    const broadcastTypes = broadcastSpy.mock.calls.map(([evt]) => evt.type);
    expect(broadcastTypes).toEqual(expect.arrayContaining(['trial_offer_logged', 'milestone_approved']));
    expect(broadcastSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'trial_offer_logged',
        payload: expect.objectContaining({
          offer_id: res.body.data.offerId,
          scout: WALLET,
          player_id: PLAYER_ID,
          tx_hash: 'tx-offer-1',
        }),
      }),
    );
  });

  it('performs the complete submission flow when the scout has an active subscription', async () => {
    registerPlayer();
    mockIsSubscribed.mockResolvedValue({ active: true, expiresAt: Math.floor(Date.now() / 1000) + 86400 });
    mockLogTrialOffer.mockResolvedValue({
      transactionId: 'tx-offer-2',
      playerId: PLAYER_ID,
      detailsUri: VALID_BODY.detailsUri,
      playerTier: 3,
    });

    const token = makeToken(WALLET);
    const res = await request(app).post(URL).set('Authorization', `Bearer ${token}`).send(VALID_BODY);

    expect(res.status).toBe(201);
    expect(res.body.success).toBe(true);
    expect(mockInsertOfferEvent).toHaveBeenCalledTimes(1);
    expect(mockInsertOfferRow).toHaveBeenCalledTimes(1);
    expect(mockUpdateProgress).toHaveBeenCalledWith(PLAYER_ID, 3);
    expect(broadcastSpy).toHaveBeenCalledTimes(2);
  });
});

// ─── Cross-route equivalence ──────────────────────────────────────────────────

describe('trial-offer submission routes are equivalent', () => {
  /** Submit the same valid offer on `segment` and capture everything it did. */
  async function submitOn(segment: string): Promise<Record<string, unknown>> {
    jest.clearAllMocks();
    broadcastSpy.mockImplementation(() => undefined);
    registerPlayer();
    mockHasContactUnlock.mockReturnValue(true);
    mockLogTrialOffer.mockResolvedValue({
      transactionId: 'tx-equivalence',
      playerId: PLAYER_ID,
      detailsUri: VALID_BODY.detailsUri,
      playerTier: 3,
    });

    const token = makeToken(WALLET);
    const res = await request(app)
      .post(`/api/scouts/${WALLET}/${segment}`)
      .set('Authorization', `Bearer ${token}`)
      .send(VALID_BODY);

    // offerId/createdAt embed a wall-clock second, so drop them from the
    // comparison — every other observable outcome must match exactly.
    const { offerId: _offerId, createdAt: _createdAt, ...body } = res.body.data ?? {};

    return {
      status: res.status,
      success: res.body.success,
      body,
      onChain: mockLogTrialOffer.mock.calls,
      offerEvent: mockInsertOfferEvent.mock.calls.map((c) => c.slice(0, 4)),
      offerRow: mockInsertOfferRow.mock.calls.map(([row]) => ({ ...row, offer_id: undefined, created_at: undefined })),
      tierPromotion: mockUpdateProgress.mock.calls,
      broadcastTypes: broadcastSpy.mock.calls.map(([evt]) => evt.type),
    };
  }

  it('produce the same business outcome for the same valid input', async () => {
    const canonical = await submitOn('trial-offers');
    const alias = await submitOn('trial-offer');

    expect(canonical.status).toBe(201);
    expect(alias).toEqual(canonical);
  });

  it('reject the same invalid input the same way', async () => {
    const token = makeToken(WALLET);
    registerPlayer();
    mockHasContactUnlock.mockReturnValue(true);

    const bad = { playerId: PLAYER_ID, detailsUri: 'ftp://bad-uri' };
    const canonical = await request(app)
      .post(`/api/scouts/${WALLET}/trial-offers`)
      .set('Authorization', `Bearer ${token}`)
      .send(bad);
    const alias = await request(app)
      .post(`/api/scouts/${WALLET}/trial-offer`)
      .set('Authorization', `Bearer ${token}`)
      .send(bad);

    expect(alias.status).toBe(canonical.status);
    expect(alias.status).toBe(400);
    expect(alias.body).toEqual(canonical.body);
  });
});
