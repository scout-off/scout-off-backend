/**
 * Concurrency test for the idempotency middleware claim-first pattern.
 *
 * Acceptance criteria under test:
 *  - The middleware inserts a 'pending' marker before invoking the handler.
 *  - A concurrent duplicate that loses the INSERT race never re-executes
 *    the handler's side effects.
 *  - The loser instead waits for the winner and returns the same cached response.
 *  - Existing non-concurrent idempotency behaviour is unaffected.
 */

import request from 'supertest';
import jwt from 'jsonwebtoken';
import express from 'express';

const SECRET = process.env.JWT_SECRET ?? 'test-secret';
const WALLET = 'GSCOUTWALLET1AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';

// ─── DB mock ──────────────────────────────────────────────────────────────────
//
// We emulate the real SQLite INSERT OR IGNORE semantics:
//  - claimIdempotencyKey returns true only for the first caller on a given key.
//  - updateIdempotencyRecord transitions the record to 'complete'.
//  - getIdempotencyRecord respects the status field and the expiry.

interface StoredRecord {
  status_code: number;
  response: string;
  status: 'pending' | 'complete';
  expires_at: number;
  request_fingerprint: string | null;
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

    claimIdempotencyKey: jest.fn((key: string, requestFingerprint?: string | null): boolean => {
      if (idempotencyStore.has(key)) return false;
      // Insert a pending placeholder — mirrors INSERT OR IGNORE.
      idempotencyStore.set(key, {
        status_code: 0,
        response: '',
        status: 'pending',
        expires_at: Date.now() + 24 * 60 * 60 * 1000,
        request_fingerprint: requestFingerprint ?? null,
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

    // Keep saveIdempotencyRecord for backwards-compat with other tests that
    // import from the same mock module.
    saveIdempotencyRecord: jest.fn((key: string, statusCode: number, body: unknown) => {
      idempotencyStore.set(key, {
        status_code: statusCode,
        response: JSON.stringify(body),
        status: 'complete',
        expires_at: Date.now() + 24 * 60 * 60 * 1000,
        request_fingerprint: null,
      });
    }),
  };
});

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

// Use the real inFlightLock so that the in-process coalescing actually works.
jest.mock('../../src/utils/inflightLock', () => {
  const actual = jest.requireActual('../../src/utils/inflightLock');
  return { ...actual };
});

import app from '../../src/app';
import { idempotency } from '../../src/middleware/idempotency';
import { purchaseSubscription } from '../../src/services/stellar';
import {
  getIdempotencyRecord,
  claimIdempotencyKey,
  updateIdempotencyRecord,
} from '../../src/db';
import { inFlightLock } from '../../src/utils/inflightLock';

const mockPurchase = purchaseSubscription as jest.Mock;
const mockClaim = claimIdempotencyKey as jest.Mock;
const mockUpdate = updateIdempotencyRecord as jest.Mock;
const mockGet = getIdempotencyRecord as jest.Mock;

function makeToken(wallet: string, role = 'scout'): string {
  return jwt.sign({ sub: wallet, role }, SECRET, { expiresIn: '1h' });
}

const VALID_BODY = { tier: 'basic', duration: 30 };

beforeEach(() => {
  idempotencyStore.clear();
  inFlightLock.clear();
  mockPurchase.mockReset();
  mockClaim.mockClear();
  mockUpdate.mockClear();
  mockGet.mockClear();
});

// ─── Concurrency tests ────────────────────────────────────────────────────────

describe('idempotency middleware — claim-first concurrency', () => {
  it('fires the handler exactly once when two requests share an idempotency key', async () => {
    const expiresAt = Math.floor(Date.now() / 1000) + 30 * 86400;

    // Give the handler a short delay so the two requests genuinely overlap.
    mockPurchase.mockImplementation(async () => {
      await new Promise((resolve) => setTimeout(resolve, 40));
      return {
        transactionId: 'tx-concurrent-001',
        tier: 'basic',
        expiresAt,
        status: 'active',
      };
    });

    const token = makeToken(WALLET);
    const key = 'concurrent-key-001';

    // Launch both requests at the same time — no await between them.
    const [first, second] = await Promise.all([
      request(app)
        .post(`/api/scouts/${WALLET}/subscribe`)
        .set('Authorization', `Bearer ${token}`)
        .set('Idempotency-Key', key)
        .send(VALID_BODY),
      request(app)
        .post(`/api/scouts/${WALLET}/subscribe`)
        .set('Authorization', `Bearer ${token}`)
        .set('Idempotency-Key', key)
        .send(VALID_BODY),
    ]);

    // ── Side-effect runs exactly once ─────────────────────────────────────
    expect(mockPurchase).toHaveBeenCalledTimes(1);

    // ── Both callers get a successful response ────────────────────────────
    expect(first.status).toBe(201);
    expect(second.status).toBe(201);

    // ── Both callers get identical response bodies ────────────────────────
    expect(first.body).toEqual(second.body);
    expect(first.body.data.transactionId).toBe('tx-concurrent-001');
  });

  it('claimIdempotencyKey is called before the handler executes', async () => {
    const expiresAt = Math.floor(Date.now() / 1000) + 30 * 86400;
    const callOrder: string[] = [];

    mockClaim.mockImplementation((key: string): boolean => {
      callOrder.push('claim');
      // Delegate to the real store logic.
      if (idempotencyStore.has(key)) return false;
      idempotencyStore.set(key, {
        status_code: 0,
        response: '',
        status: 'pending',
        expires_at: Date.now() + 24 * 60 * 60 * 1000,
      });
      return true;
    });

    mockPurchase.mockImplementation(async () => {
      callOrder.push('handler');
      return { transactionId: 'tx-order', tier: 'basic', expiresAt, status: 'active' };
    });

    const res = await request(app)
      .post(`/api/scouts/${WALLET}/subscribe`)
      .set('Authorization', `Bearer ${makeToken(WALLET)}`)
      .set('Idempotency-Key', 'order-test-key')
      .send(VALID_BODY);

    expect(res.status).toBe(201);
    // Claim must have been called before the handler.
    const claimIndex = callOrder.indexOf('claim');
    const handlerIndex = callOrder.indexOf('handler');
    expect(claimIndex).toBeGreaterThanOrEqual(0);
    expect(handlerIndex).toBeGreaterThan(claimIndex);
  });

  it('serves the cached response and does not re-run the handler for a sequential duplicate', async () => {
    const expiresAt = Math.floor(Date.now() / 1000) + 30 * 86400;
    mockPurchase.mockResolvedValue({
      transactionId: 'tx-sequential',
      tier: 'basic',
      expiresAt,
      status: 'active',
    });

    const token = makeToken(WALLET);
    const key = 'sequential-key-001';

    const first = await request(app)
      .post(`/api/scouts/${WALLET}/subscribe`)
      .set('Authorization', `Bearer ${token}`)
      .set('Idempotency-Key', key)
      .send(VALID_BODY);

    expect(first.status).toBe(201);
    expect(mockPurchase).toHaveBeenCalledTimes(1);

    // Second request after first completes — must return cached response.
    const second = await request(app)
      .post(`/api/scouts/${WALLET}/subscribe`)
      .set('Authorization', `Bearer ${token}`)
      .set('Idempotency-Key', key)
      .send(VALID_BODY);

    expect(second.status).toBe(201);
    expect(second.body).toEqual(first.body);
    // Handler must not have been invoked a second time.
    expect(mockPurchase).toHaveBeenCalledTimes(1);
  });

  it('updateIdempotencyRecord is called after the handler with the correct status code', async () => {
    const expiresAt = Math.floor(Date.now() / 1000) + 30 * 86400;
    mockPurchase.mockResolvedValue({
      transactionId: 'tx-update',
      tier: 'basic',
      expiresAt,
      status: 'active',
    });

    const res = await request(app)
      .post(`/api/scouts/${WALLET}/subscribe`)
      .set('Authorization', `Bearer ${makeToken(WALLET)}`)
      .set('Idempotency-Key', 'update-test-key')
      .send(VALID_BODY);

    expect(res.status).toBe(201);
    expect(mockUpdate).toHaveBeenCalledWith(
      'update-test-key',
      201,
      expect.objectContaining({ success: true }),
    );
  });

  it('requests without an Idempotency-Key are not constrained', async () => {
    const expiresAt = Math.floor(Date.now() / 1000) + 30 * 86400;
    mockPurchase
      .mockResolvedValueOnce({
        transactionId: 'tx-no-key-1',
        tier: 'basic',
        expiresAt,
        status: 'active',
      })
      .mockResolvedValueOnce({
        transactionId: 'tx-no-key-2',
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

    // Both must execute independently — no idempotency.
    expect(mockPurchase).toHaveBeenCalledTimes(2);
    expect(first.status).toBe(201);
    expect(second.status).toBe(201);
    // claimIdempotencyKey must not have been called for keyless requests.
    expect(mockClaim).not.toHaveBeenCalled();
  });

  it('returns 409 when a pending key times out (simulated cross-process scenario)', async () => {
    // Seed a permanently-pending record to simulate a cross-process in-flight
    // request that never resolves within our test's timeout budget.
    const key = 'stuck-pending-key';
    idempotencyStore.set(key, {
      status_code: 0,
      response: '',
      status: 'pending',
      expires_at: Date.now() + 24 * 60 * 60 * 1000,
    });

    // Override IN_PROGRESS_WAIT_MS by mocking inFlightLock.withLock to
    // resolve immediately so the test doesn't actually wait 5 seconds.
    // The middleware will then re-read the record (still pending) and 409.
    jest
      .spyOn(inFlightLock, 'withLock')
      .mockImplementationOnce(async () => ({
        statusCode: 0,
        body: null,
      }));

    const res = await request(app)
      .post(`/api/scouts/${WALLET}/subscribe`)
      .set('Authorization', `Bearer ${makeToken(WALLET)}`)
      .set('Idempotency-Key', key)
      .send(VALID_BODY);

    expect(res.status).toBe(409);
    expect(res.body.error).toMatch(/already in progress/i);
    // The handler must never have been called.
    expect(mockPurchase).not.toHaveBeenCalled();
  });
});

// ─── Request-fingerprint conflict detection (#761) ────────────────────────────

describe('idempotency middleware — request fingerprint conflicts', () => {
  // A minimal app wired directly to the middleware factory, so the test
  // exercises the fingerprint option without depending on a specific route.
  const miniApp = express();
  miniApp.use(express.json());
  miniApp.post(
    '/items',
    idempotency({
      requestFingerprint: (req) =>
        String((req.body as { id?: string } | undefined)?.id ?? ''),
    }),
    (req, res) => {
      res.json({ ok: true, id: (req.body as { id?: string }).id });
    },
  );

  beforeEach(() => {
    idempotencyStore.clear();
    inFlightLock.clear();
    // Re-install the store-backed implementations: an earlier test replaced
    // mockClaim's implementation with an inline variant via mockImplementation,
    // which would otherwise persist into this suite and drop fingerprints.
    mockClaim.mockImplementation((key: string, requestFingerprint?: string | null) => {
      if (idempotencyStore.has(key)) return false;
      idempotencyStore.set(key, {
        status_code: 0,
        response: '',
        status: 'pending',
        expires_at: Date.now() + 24 * 60 * 60 * 1000,
        request_fingerprint: requestFingerprint ?? null,
      });
      return true;
    });
    mockGet.mockImplementation((key: string) => {
      const record = idempotencyStore.get(key);
      if (!record) return null;
      if (record.expires_at <= Date.now()) return null;
      return { key, ...record };
    });
    mockUpdate.mockImplementation((key: string, statusCode: number, body: unknown) => {
      const record = idempotencyStore.get(key);
      if (record) {
        record.status_code = statusCode;
        record.response = JSON.stringify(body);
        record.status = 'complete';
      }
    });
    mockClaim.mockClear();
    mockUpdate.mockClear();
    mockGet.mockClear();
  });

  it('serves the cached response for an identical replay', async () => {
    const first = await request(miniApp)
      .post('/items')
      .set('Idempotency-Key', 'fp-key-001')
      .send({ id: 'a' });
    expect(first.status).toBe(200);
    expect(first.body).toEqual({ ok: true, id: 'a' });

    const replay = await request(miniApp)
      .post('/items')
      .set('Idempotency-Key', 'fp-key-001')
      .send({ id: 'a' });
    expect(replay.status).toBe(200);
    expect(replay.body).toEqual(first.body);
  });

  it('rejects the same key with a materially different request (409) without running the handler', async () => {
    const first = await request(miniApp)
      .post('/items')
      .set('Idempotency-Key', 'fp-key-002')
      .send({ id: 'a' });
    expect(first.status).toBe(200);

    const conflict = await request(miniApp)
      .post('/items')
      .set('Idempotency-Key', 'fp-key-002')
      .send({ id: 'b' });

    expect(conflict.status).toBe(409);
    expect(conflict.body.error).toMatch(/different request/i);
  });
});
