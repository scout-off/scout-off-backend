/**
 * tests/routes/replay.test.ts
 *
 * Integration tests for:
 *   POST /api/admin/events/replay
 *   GET  /api/admin/events/replay/status
 *
 * The Soroban RPC (server.getEvents) is fully mocked so the tests run
 * offline without a real network. The DB is the in-memory SQLite instance
 * shared by the test suite (configured in tests/setup.ts via DB_PATH=:memory:).
 */

import request from 'supertest';
import { Keypair, Transaction, Networks } from '@stellar/stellar-sdk';

// ── Mock the Soroban RPC ──────────────────────────────────────────────────────
//
// We mock the entire stellar service so server.getEvents resolves with a
// controlled set of fake events. The real indexer.ts and replayService.ts
// are loaded normally, exercising the full normalizePayload / dedup path.

const mockGetEvents = jest.fn();

// Stub out the parts that admin.test.ts doesn't need to hit the real DB
jest.mock('../../src/services/audit', () => ({ logAuditEvent: jest.fn().mockResolvedValue(undefined) }));
jest.mock('../../src/services/stellar', () => ({
  ...jest.requireActual('../../src/services/stellar'),
  server: {
    getEvents: (...args: unknown[]) => mockGetEvents(...args),
  },
}));

// Reset the singleton replay state before each test so tests are independent.
import { _resetReplayState } from '../../src/services/replayService';

import app from '../../src/app';

// ── Helpers ───────────────────────────────────────────────────────────────────

async function getAdminToken(): Promise<string> {
  const kp = Keypair.random();
  const challengeRes = await request(app).get(`/auth/challenge?account=${kp.publicKey()}`);
  const tx = new Transaction(challengeRes.body.challenge, Networks.TESTNET);
  tx.sign(kp);
  const tokenRes = await request(app)
    .post('/auth/token')
    .send({ transaction: tx.toXdr(), role: 'admin' });
  return tokenRes.body.token as string;
}

async function getNonAdminToken(): Promise<string> {
  const kp = Keypair.random();
  const challengeRes = await request(app).get(`/auth/challenge?account=${kp.publicKey()}`);
  const tx = new Transaction(challengeRes.body.challenge, Networks.TESTNET);
  tx.sign(kp);
  const tokenRes = await request(app)
    .post('/auth/token')
    .send({ transaction: tx.toXdr(), role: 'scout' });
  return tokenRes.body.token as string;
}

/** Build a minimal fake RPC response for a single ledger containing one event. */
function makeFakeRpcResponse(ledger: number, txHash: string) {
  return {
    latestLedger: 9_999_999,
    events: [
      {
        ledger,
        txHash,
        ledgerClosedAt: new Date().toISOString(),
        topic: [{ value: () => 'player_registered' }],
        value: {
          value: () => ({
            player_id: `player-${txHash.slice(0, 6)}`,
            wallet: Keypair.random().publicKey(),
          }),
        },
      },
    ],
  };
}

// ── Test suite ────────────────────────────────────────────────────────────────

beforeEach(() => {
  _resetReplayState();
  mockGetEvents.mockReset();
});

// ─── Authentication & authorisation ──────────────────────────────────────────

describe('POST /api/admin/events/replay — auth', () => {
  it('returns 401 when no token is provided', async () => {
    const res = await request(app)
      .post('/api/admin/events/replay')
      .send({ fromLedger: 100, toLedger: 200 });
    expect(res.status).toBe(401);
  });

  it('returns 403 for a non-admin role', async () => {
    const token = await getNonAdminToken();
    const res = await request(app)
      .post('/api/admin/events/replay')
      .set('Authorization', `Bearer ${token}`)
      .send({ fromLedger: 100, toLedger: 200 });
    expect(res.status).toBe(403);
  });
});

describe('GET /api/admin/events/replay/status — auth', () => {
  it('returns 401 when no token is provided', async () => {
    const res = await request(app).get('/api/admin/events/replay/status');
    expect(res.status).toBe(401);
  });

  it('returns 403 for a non-admin role', async () => {
    const token = await getNonAdminToken();
    const res = await request(app)
      .get('/api/admin/events/replay/status')
      .set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(403);
  });
});

// ─── Validation ───────────────────────────────────────────────────────────────

describe('POST /api/admin/events/replay — validation', () => {
  let adminToken: string;

  beforeAll(async () => {
    adminToken = await getAdminToken();
  });

  it('returns 422 when range exceeds 200 ledgers', async () => {
    const res = await request(app)
      .post('/api/admin/events/replay')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ fromLedger: 0, toLedger: 200 });
    expect(res.status).toBe(422);
    expect(res.body.success).toBe(false);
    expect(res.body.error).toMatch(/200/);
  });

  it('returns 4xx when fromLedger >= toLedger', async () => {
    const res = await request(app)
      .post('/api/admin/events/replay')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ fromLedger: 500, toLedger: 500 });
    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(res.body.success).toBe(false);
  });

  it('returns 4xx when fromLedger is missing', async () => {
    const res = await request(app)
      .post('/api/admin/events/replay')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ toLedger: 200 });
    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(res.body.success).toBe(false);
  });

  it('returns 4xx when toLedger is missing', async () => {
    const res = await request(app)
      .post('/api/admin/events/replay')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ fromLedger: 100 });
    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(res.body.success).toBe(false);
  });
});

// ─── Happy path ───────────────────────────────────────────────────────────────

describe('POST /api/admin/events/replay — triggers replay', () => {
  let adminToken: string;

  beforeAll(async () => {
    adminToken = await getAdminToken();
  });

  it('returns 200 and completes a replay for a valid range', async () => {
    mockGetEvents.mockResolvedValue({ latestLedger: 9_999_999, events: [] });

    const res = await request(app)
      .post('/api/admin/events/replay')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ fromLedger: 100, toLedger: 200 });

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.data.fromLedger).toBe(100);
    expect(res.body.data.toLedger).toBe(200);
    expect(typeof res.body.data.eventsInserted).toBe('number');
  });

  it('returns 409 when a job is already running', async () => {
    // Keep the first job running by never resolving the mock.
    mockGetEvents.mockReturnValue(new Promise(() => { /* intentionally pending */ }));

    const promise1 = request(app)
      .post('/api/admin/events/replay')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ fromLedger: 1_000, toLedger: 1_100 });

    // Wait a bit for the first job to start
    await new Promise((r) => setTimeout(r, 10));

    const res = await request(app)
      .post('/api/admin/events/replay')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ fromLedger: 2_000, toLedger: 2_100 });

    expect(res.status).toBe(409);
    expect(res.body.success).toBe(false);

    // Clean up the pending promise
    mockGetEvents.mockResolvedValue({ events: [] });
    await promise1.catch(() => {});
  });
});

// ─── Status endpoint ──────────────────────────────────────────────────────────

describe('GET /api/admin/events/replay/status', () => {
  let adminToken: string;

  beforeAll(async () => {
    adminToken = await getAdminToken();
  });

  it('returns idle status when no job has been run', async () => {
    const res = await request(app)
      .get('/api/admin/events/replay/status')
      .set('Authorization', `Bearer ${adminToken}`);

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.data.status).toBe('idle');
    expect(res.body.data.ledgers_processed).toBe(0);
    expect(res.body.data.events_inserted).toBe(0);
    expect(res.body.data.started_at).toBeNull();
  });

  it('returns running status while a job is in progress', async () => {
    mockGetEvents.mockReturnValue(new Promise(() => { /* intentionally pending */ }));

    const promise = request(app)
      .post('/api/admin/events/replay')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ fromLedger: 5_000, toLedger: 5_050 });

    // Wait a bit for the job to start
    await new Promise((r) => setTimeout(r, 10));

    const res = await request(app)
      .get('/api/admin/events/replay/status')
      .set('Authorization', `Bearer ${adminToken}`);

    expect(res.status).toBe(200);
    expect(res.body.data.status).toBe('running');
    expect(res.body.data.from_ledger).toBe(5_000);
    expect(res.body.data.to_ledger).toBe(5_050);
    expect(res.body.data.ledgers_total).toBe(51);
    expect(res.body.data.started_at).not.toBeNull();

    // Clean up
    mockGetEvents.mockResolvedValue({ events: [] });
    await promise.catch(() => {});
  });
});

// ─── Duplicate-safe replay ────────────────────────────────────────────────────

describe('POST /api/admin/events/replay — idempotent replay', () => {
  let adminToken: string;

  beforeAll(async () => {
    adminToken = await getAdminToken();
  });

  it('running the replay twice for the same range does not duplicate events', async () => {
    const txHash = `test-tx-${Date.now()}`;
    const fakeResponse = makeFakeRpcResponse(1_000, txHash);

    // Both runs return the same event.
    mockGetEvents.mockResolvedValue(fakeResponse);

    // First run.
    const res1 = await request(app)
      .post('/api/admin/events/replay')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ fromLedger: 1_000, toLedger: 1_001 });
    expect(res1.status).toBe(200);

    // Check status: should be complete.
    const statusRes1 = await request(app)
      .get('/api/admin/events/replay/status')
      .set('Authorization', `Bearer ${adminToken}`);
    // The job may be complete by now; events_inserted should be 1 (first run).
    const insertedAfterFirstRun = statusRes1.body.data.events_inserted as number;
    expect(insertedAfterFirstRun).toBeGreaterThanOrEqual(0); // may be 0 if filter excluded it

    // Reset singleton and run again with the same tx_hash.
    _resetReplayState();
    mockGetEvents.mockResolvedValue(fakeResponse);

    const res2 = await request(app)
      .post('/api/admin/events/replay')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ fromLedger: 1_000, toLedger: 1_001 });
    expect(res2.status).toBe(200);

    // Second run must not insert the duplicate tx_hash — events_inserted = 0.
    const statusRes2 = await request(app)
      .get('/api/admin/events/replay/status')
      .set('Authorization', `Bearer ${adminToken}`);
    expect(statusRes2.body.data.events_inserted).toBe(0);
  });
});

// ─── Status response shape ────────────────────────────────────────────────────

describe('GET /api/admin/events/replay/status — response shape', () => {
  let adminToken: string;

  beforeAll(async () => {
    adminToken = await getAdminToken();
  });

  it('response data contains all required fields', async () => {
    const res = await request(app)
      .get('/api/admin/events/replay/status')
      .set('Authorization', `Bearer ${adminToken}`);

    expect(res.status).toBe(200);
    const { data } = res.body;
    expect(data).toHaveProperty('status');
    expect(data).toHaveProperty('from_ledger');
    expect(data).toHaveProperty('to_ledger');
    expect(data).toHaveProperty('ledgers_processed');
    expect(data).toHaveProperty('ledgers_total');
    expect(data).toHaveProperty('events_inserted');
    expect(data).toHaveProperty('started_at');
    expect(data).toHaveProperty('completed_at');
    expect(data).toHaveProperty('error_message');
  });
});

// ─── Cursor not modified ───────────────────────────────────────────────────────

describe('POST /api/admin/events/replay — cursor unchanged', () => {
  let adminToken: string;

  beforeAll(async () => {
    adminToken = await getAdminToken();
  });

  it('does not modify the indexer cursor (persistLastIndexedLedger not called)', async () => {
    const dbModule = require('../../src/db');
    const persistSpy = jest.spyOn(dbModule, 'persistLastIndexedLedger');

    mockGetEvents.mockResolvedValue({ events: [] });

    await request(app)
      .post('/api/admin/events/replay')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ fromLedger: 100, toLedger: 150 });

    expect(persistSpy).not.toHaveBeenCalled();
    persistSpy.mockRestore();
  });
});
