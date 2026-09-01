/**
 * Tests for Idempotency-Key behaviour on POST /api/scouts/:wallet/subscribe
 *
 * These tests exercise the centralised idempotency middleware (claim-first
 * design) as applied to the subscribe endpoint.  The controller no longer
 * handles idempotency directly — that responsibility now belongs entirely
 * to the middleware layer.
 *
 * Acceptance criteria:
 *  1. First request with a key processes normally and caches the response.
 *  2. Second request with the same key returns the cached response without
 *     a new on-chain transaction.
 *  3. Requests without an Idempotency-Key are processed independently (no caching).
 *  4. An expired key (returned as null by getIdempotencyRecord) is treated as new.
 *  5. A 402 error response is cached so that a retry returns the cached error.
 *  6. Concurrent requests with no idempotency key each trigger an independent
 *     transaction (per-wallet lock was removed; idempotency key is required for
 *     deduplication).
 */

import request from 'supertest';
import jwt from 'jsonwebtoken';

const SECRET = process.env.JWT_SECRET ?? 'test-secret';
const WALLET = 'GSCOUTWALLET1AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';

// ─── Mocks ────────────────────────────────────────────────────────────────────

jest.mock('../../src/services/stellar', () => ({
  purchaseSubscription: jest.fn(),
  isSubscribed: jest.fn().mockResolvedValue({ active: false, expiresAt: null }),
  PaymentError: class PaymentError extends Error {
    constructor(
      public message: string,
      public code: string,
    ) {
      super(message);
    }
  },
}));

jest.mock('../../src/services/indexer', () => ({
  indexEvents: jest.fn(),
  normalizeEventId: jest.fn(),
}));

// Use the real inFlightLock so in-process coalescing works correctly.
jest.mock('../../src/utils/inflightLock', () => {
  const actual = jest.requireActual('../../src/utils/inflightLock');
  return { ...actual };
});

// ─── DB mock — mirrors the claim-first API ────────────────────────────────────
//
// The new middleware calls claimIdempotencyKey + updateIdempotencyRecord.
// saveIdempotencyRecord is kept for backwards compatibility but is no longer
// called by the subscribe handler itself.

interface StoredRecord {
  status_code: number;
  response: string;
  status: 'pending' | 'complete';
  expires_at: number;
}

const idempotencyStore = new Map<string, StoredRecord>();

jest.mock('../../src/db', () => {
  const actual = jest.requireActual('../../src/db');
  return {
    ...actual,

    getIdempotencyRecord: jest.fn((key: string) => {
      const record = idempotencyStore.get(key);
      if (!record) return null;
      if (record.expires_at <= Date.now()) return null;
      return { key, ...record };
    }),

    claimIdempotencyKey: jest.fn((key: string): boolean => {
      const existing = idempotencyStore.get(key);
      // An expired record is treated as absent — mirroring the real DB which
      // only finds non-expired rows in getIdempotencyRecord and would allow a
      // fresh INSERT once the TTL has passed.
      if (existing && existing.expires_at > Date.now()) return false;
      idempotencyStore.set(key, {
        status_code: 0,
        response: '',
        status: 'pending',
        expires_at: Date.now() + 24 * 60 * 60 * 1000,
      });
      return true;
    }),

    updateIdempotencyRecord: jest.fn(
      (key: string, statusCode: number, body: unknown) => {
        const record = idempotencyStore.get(key);
        if (record) {
          record.status_code = statusCode;
          record.response = JSON.stringify(body);
          record.status = 'complete';
        }
      },
    ),

    saveIdempotencyRecord: jest.fn((key: string, statusCode: number, body: unknown) => {
      idempotencyStore.set(key, {
        status_code: statusCode,
        response: JSON.stringify(body),
        status: 'complete',
        expires_at: Date.now() + 24 * 60 * 60 * 1000,
      });
    }),
  };
});

import app from '../../src/app';
import { purchaseSubscription } from '../../src/services/stellar';
import {
  getIdempotencyRecord,
  claimIdempotencyKey,
  updateIdempotencyRecord,
} from '../../src/db';
import { inFlightLock } from '../../src/utils/inflightLock';

const mockPurchase = purchaseSubscription as jest.Mock;
const mockGetRecord = getIdempotencyRecord as jest.Mock;
const mockClaim = claimIdempotencyKey as jest.Mock;
const mockUpdate = updateIdempotencyRecord as jest.Mock;

function makeToken(wallet: string, role = 'scout'): string {
  return jwt.sign({ sub: wallet, role }, SECRET, { expiresIn: '1h' });
}

const VALID_BODY = { tier: 'basic', duration: 30 };

beforeEach(() => {
  mockPurchase.mockReset();
  mockGetRecord.mockClear();
  mockClaim.mockClear();
  mockUpdate.mockClear();
  idempotencyStore.clear();
  inFlightLock.clear();
});

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('POST /api/scouts/:wallet/subscribe — idempotency', () => {
  it('processes first request normally and caches the response', async () => {
    const expiresAt = Math.floor(Date.now() / 1000) + 30 * 86400;
    mockPurchase.mockResolvedValue({
      transactionId: 'tx-first',
      tier: 'basic',
      expiresAt,
      status: 'active',
    });

    const res = await request(app)
      .post(`/api/scouts/${WALLET}/subscribe`)
      .set('Authorization', `Bearer ${makeToken(WALLET)}`)
      .set('Idempotency-Key', 'key-001')
      .send(VALID_BODY);

    expect(res.status).toBe(201);
    expect(res.body.success).toBe(true);
    expect(res.body.data.transactionId).toBe('tx-first');
    // The middleware must have claimed the key before the handler ran …
    // (the subscribe route configures no request fingerprint, so the claim
    // carries a null fingerprint — see #761).
    expect(mockClaim).toHaveBeenCalledWith('key-001', null);
    // … and persisted the response afterwards via updateIdempotencyRecord.
    expect(mockUpdate).toHaveBeenCalledWith(
      'key-001',
      201,
      expect.objectContaining({ success: true }),
    );
    expect(mockPurchase).toHaveBeenCalledTimes(1);
  });

  it('returns the cached response on a duplicate key without triggering a new transaction', async () => {
    const expiresAt = Math.floor(Date.now() / 1000) + 30 * 86400;
    mockPurchase.mockResolvedValue({
      transactionId: 'tx-second',
      tier: 'basic',
      expiresAt,
      status: 'active',
    });

    const token = makeToken(WALLET);
    const key = 'key-002';

    // First request — populates the cache.
    const first = await request(app)
      .post(`/api/scouts/${WALLET}/subscribe`)
      .set('Authorization', `Bearer ${token}`)
      .set('Idempotency-Key', key)
      .send(VALID_BODY);

    expect(first.status).toBe(201);
    expect(mockPurchase).toHaveBeenCalledTimes(1);

    // Second request with the same key — must return cached response.
    const second = await request(app)
      .post(`/api/scouts/${WALLET}/subscribe`)
      .set('Authorization', `Bearer ${token}`)
      .set('Idempotency-Key', key)
      .send(VALID_BODY);

    expect(second.status).toBe(201);
    expect(second.body).toEqual(first.body);
    // No additional on-chain call must have been made.
    expect(mockPurchase).toHaveBeenCalledTimes(1);
  });

  it('processes requests without an Idempotency-Key independently (no caching)', async () => {
    const expiresAt = Math.floor(Date.now() / 1000) + 30 * 86400;
    mockPurchase
      .mockResolvedValueOnce({
        transactionId: 'tx-a',
        tier: 'basic',
        expiresAt,
        status: 'active',
      })
      .mockResolvedValueOnce({
        transactionId: 'tx-b',
        tier: 'basic',
        expiresAt,
        status: 'active',
      });

    const token = makeToken(WALLET);

    const first = await request(app)
      .post(`/api/scouts/${WALLET}/subscribe`)
      .set('Authorization', `Bearer ${token}`)
      .send(VALID_BODY);

    const second = await request(app)
      .post(`/api/scouts/${WALLET}/subscribe`)
      .set('Authorization', `Bearer ${token}`)
      .send(VALID_BODY);

    expect(first.status).toBe(201);
    expect(second.status).toBe(201);
    // Both requests go through — no deduplication without a key.
    expect(mockPurchase).toHaveBeenCalledTimes(2);
    expect(first.body.data.transactionId).toBe('tx-a');
    expect(second.body.data.transactionId).toBe('tx-b');
    // claimIdempotencyKey must not have been called for keyless requests.
    expect(mockClaim).not.toHaveBeenCalled();
  });

  it('treats an expired key as new and triggers a fresh transaction', async () => {
    const key = 'key-003-expired';
    const expiresAt = Math.floor(Date.now() / 1000) + 30 * 86400;

    // Seed an already-expired 'complete' record directly into the store.
    idempotencyStore.set(key, {
      status_code: 201,
      response: JSON.stringify({
        success: true,
        data: {
          transactionId: 'tx-old',
          tier: 'basic',
          expiresAt: 0,
          status: 'active',
        },
      }),
      status: 'complete',
      expires_at: Date.now() - 1_000, // 1 second in the past
    });

    mockPurchase.mockResolvedValue({
      transactionId: 'tx-after-expiry',
      tier: 'basic',
      expiresAt,
      status: 'active',
    });

    const res = await request(app)
      .post(`/api/scouts/${WALLET}/subscribe`)
      .set('Authorization', `Bearer ${makeToken(WALLET)}`)
      .set('Idempotency-Key', key)
      .send(VALID_BODY);

    expect(res.status).toBe(201);
    expect(res.body.data.transactionId).toBe('tx-after-expiry');
    // A new transaction must have been triggered (expired key = no cache hit).
    expect(mockPurchase).toHaveBeenCalledTimes(1);
  });

  it('caches a 402 error response so a retry with the same key returns the cached error', async () => {
    const { PaymentError } = jest.requireMock('../../src/services/stellar');
    mockPurchase.mockRejectedValue(
      new PaymentError('Insufficient XLM balance', 'INSUFFICIENT_FUNDS'),
    );

    const token = makeToken(WALLET);
    const key = 'key-004-error';

    const first = await request(app)
      .post(`/api/scouts/${WALLET}/subscribe`)
      .set('Authorization', `Bearer ${token}`)
      .set('Idempotency-Key', key)
      .send(VALID_BODY);

    expect(first.status).toBe(402);
    expect(first.body.code).toBe('INSUFFICIENT_FUNDS');
    expect(mockPurchase).toHaveBeenCalledTimes(1);

    // The error response must have been cached by the middleware.
    expect(mockUpdate).toHaveBeenCalledWith(
      key,
      402,
      expect.objectContaining({ success: false, code: 'INSUFFICIENT_FUNDS' }),
    );

    // Second request — must return cached 402, no new call.
    const second = await request(app)
      .post(`/api/scouts/${WALLET}/subscribe`)
      .set('Authorization', `Bearer ${token}`)
      .set('Idempotency-Key', key)
      .send(VALID_BODY);

    expect(second.status).toBe(402);
    expect(second.body).toEqual(first.body);
    expect(mockPurchase).toHaveBeenCalledTimes(1);
  });

  it('concurrent requests without an Idempotency-Key each trigger independent transactions', async () => {
    // The per-wallet in-flight lock was removed from the controller.
    // Without an idempotency key, concurrent requests are NOT deduplicated —
    // each one runs its own on-chain transaction.
    const expiresAt = Math.floor(Date.now() / 1000) + 30 * 86400;

    mockPurchase
      .mockResolvedValueOnce({
        transactionId: 'tx-concurrent-1',
        tier: 'basic',
        expiresAt,
        status: 'active',
      })
      .mockResolvedValueOnce({
        transactionId: 'tx-concurrent-2',
        tier: 'basic',
        expiresAt,
        status: 'active',
      });

    const token = makeToken(WALLET);

    const [first, second] = await Promise.all([
      request(app)
        .post(`/api/scouts/${WALLET}/subscribe`)
        .set('Authorization', `Bearer ${token}`)
        .send(VALID_BODY),
      request(app)
        .post(`/api/scouts/${WALLET}/subscribe`)
        .set('Authorization', `Bearer ${token}`)
        .send(VALID_BODY),
    ]);

    expect(first.status).toBe(201);
    expect(second.status).toBe(201);
    // Both calls go through because no idempotency key was provided.
    expect(mockPurchase).toHaveBeenCalledTimes(2);
    // No idempotency middleware involvement for keyless requests.
    expect(mockClaim).not.toHaveBeenCalled();
  });
});
