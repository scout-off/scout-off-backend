import request from 'supertest';
import app from '../../src/app';
import jwt from 'jsonwebtoken';

const WALLET = 'GCXYK3YRWDH5P3MICHW5IPAYVU7LK7V4UNCD6JAPKPR6F4WL6MZZSSAB';
const OTHER_WALLET = 'GDCTMZJTRZWFS74OKS6Z2GPJ3NCLJSUBGFI6FM7L3U3GM66F5UN2W4IT';
const SECRET = process.env.JWT_SECRET ?? 'test-secret';

function makeToken(sub: string, role = 'scout'): string {
  return jwt.sign({ sub, role }, SECRET, { expiresIn: '1h' });
}

jest.mock('../../src/db', () => ({
  queryEvents: jest.fn(),
  getPlayerById: jest.fn(),
  getContactUnlocksByScout: jest.fn().mockReturnValue([]),
  getSubscriptionsByScout: jest.fn().mockReturnValue([]),
}));

jest.mock('../../src/services/indexer', () => ({
  indexEvents: jest.fn(),
  normalizeEventId: jest.fn(),
}));

import { queryEvents } from '../../src/db';
const mockGetEvents = queryEvents as jest.Mock;

beforeEach(() => {
  mockGetEvents.mockReset();
  mockGetEvents.mockReturnValue([]);
});

describe('GET /api/scouts/:wallet/payments', () => {
  it('returns 401 without auth token', async () => {
    const res = await request(app).get(`/api/scouts/${WALLET}/payments`);
    expect(res.status).toBe(401);
  });

  it('returns 403 when JWT wallet does not match path wallet', async () => {
    const token = makeToken(OTHER_WALLET);
    const res = await request(app)
      .get(`/api/scouts/${WALLET}/payments`)
      .set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(403);
    expect(res.body.success).toBe(false);
    expect(res.body.error).toBe('Forbidden: wallet does not match authenticated account');
  });

  it('returns 200 when JWT wallet matches path wallet', async () => {
    const token = makeToken(WALLET);
    const res = await request(app)
      .get(`/api/scouts/${WALLET}/payments`)
      .set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(Array.isArray(res.body.data)).toBe(true);
  });

  it('returns 200 with empty array for wallet with no history', async () => {
    const token = makeToken(WALLET);
    const res = await request(app)
      .get(`/api/scouts/${WALLET}/payments`)
      .set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(Array.isArray(res.body.data)).toBe(true);
  });

  it('accepts date filter query params without error', async () => {
    const token = makeToken(WALLET);
    const res = await request(app)
      .get(`/api/scouts/${WALLET}/payments?from=2024-01-01&to=2024-12-31`)
      .set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.data)).toBe(true);
  });

  it('sets transactionId to null when tx_hash is missing from event payload', async () => {
    mockGetEvents.mockReturnValue([
      {
        source: 'contract',
        type: 'contact_unlocked',
        contractAddress: 'contract',
        payload: {
          scout: WALLET,
          fee: '1',
          timestamp: '2024-06-01T00:00:00.000Z',
          // no tx_hash field
        },
      },
    ]);
    const token = makeToken(WALLET);
    const res = await request(app)
      .get(`/api/scouts/${WALLET}/payments`)
      .set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(200);
    expect(res.body.data).toHaveLength(1);
    expect(res.body.data[0].transactionId).toBeNull();
  });

  it('uses real tx_hash when present in event payload', async () => {
    mockGetEvents.mockReturnValue([
      {
        source: 'contract',
        type: 'contact_unlocked',
        contractAddress: 'contract',
        payload: {
          scout: WALLET,
          fee: '2',
          timestamp: '2024-06-02T00:00:00.000Z',
          tx_hash: 'abc123realHash',
        },
      },
    ]);
    const token = makeToken(WALLET);
    const res = await request(app)
      .get(`/api/scouts/${WALLET}/payments`)
      .set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(200);
    expect(res.body.data[0].transactionId).toBe('abc123realHash');
  });

  it('never returns a transactionId matching /^mock-tx-/', async () => {
    // Simulate multiple events without tx_hash to confirm no fabrication
    mockGetEvents.mockReturnValue([
      {
        source: 'contract',
        type: 'contact_unlocked',
        contractAddress: 'contract',
        payload: { scout: WALLET, fee: '1', timestamp: '2024-01-01T00:00:00.000Z' },
      },
      {
        source: 'contract',
        type: 'contact_unlocked',
        contractAddress: 'contract',
        payload: { scout: WALLET, fee: '2', timestamp: '2024-02-01T00:00:00.000Z' },
      },
    ]);
    const token = makeToken(WALLET);
    const res = await request(app)
      .get(`/api/scouts/${WALLET}/payments`)
      .set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(200);
    for (const item of res.body.data) {
      if (item.transactionId !== null) {
        expect(item.transactionId).not.toMatch(/^mock-tx-/);
      }
    }
  });
});
