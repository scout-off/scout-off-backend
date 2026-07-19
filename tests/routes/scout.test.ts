import request from 'supertest';
import jwt from 'jsonwebtoken';
import app from '../../src/index';

const SECRET = process.env.JWT_SECRET ?? 'test-secret';

jest.mock('../../src/services/indexer', () => ({
  getEvents: jest.fn(),
  indexEvents: jest.fn(),
  normalizeEventId: jest.fn(),
}));

import { getEvents } from '../../src/services/indexer';
const mockGetEvents = getEvents as jest.Mock;

function makeToken(wallet: string, role = 'scout'): string {
  return jwt.sign({ sub: wallet, role }, SECRET, { expiresIn: '1h' });
}

const WALLET = 'GSCOUTWALLET1AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';
const OTHER = 'GOTHERWALLET2AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';

beforeEach(() => {
  mockGetEvents.mockReset();
});

// ─── GET /api/scouts/:wallet/subscription ─────────────────────────────────────

describe('GET /api/scouts/:wallet/subscription', () => {
  it('returns 401 when no token is provided', async () => {
    const res = await request(app).get(`/api/scouts/${WALLET}/subscription`);
    expect(res.status).toBe(401);
  });

  it('returns 401 when JWT wallet does not match path wallet', async () => {
    const token = makeToken(OTHER);
    const res = await request(app)
      .get(`/api/scouts/${WALLET}/subscription`)
      .set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(401);
    expect(res.body.success).toBe(false);
  });

  it('returns inactive subscription when no events exist', async () => {
    mockGetEvents.mockReturnValue([]);
    const token = makeToken(WALLET);
    const res = await request(app)
      .get(`/api/scouts/${WALLET}/subscription`)
      .set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.data).toEqual({ active: false, tier: null, expiresAt: null, remainingDays: 0 });
  });

  it('returns active subscription with correct fields', async () => {
    const expiresAt = Math.floor(Date.now() / 1000) + 86400 * 10; // 10 days from now
    mockGetEvents.mockReturnValue([
      {
        source: 'contract',
        type: 'scout_subscribed',
        contractAddress: 'contract',
        payload: { scout: WALLET, subscriptionExpiry: expiresAt, tier: 'pro' },
      },
    ]);
    const token = makeToken(WALLET);
    const res = await request(app)
      .get(`/api/scouts/${WALLET}/subscription`)
      .set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.data.active).toBe(true);
    expect(res.body.data.tier).toBe('pro');
    expect(res.body.data.expiresAt).toBe(expiresAt);
    expect(res.body.data.remainingDays).toBeGreaterThan(0);
  });

  it('returns expired subscription as inactive with 0 remainingDays', async () => {
    const expiresAt = Math.floor(Date.now() / 1000) - 86400; // expired yesterday
    mockGetEvents.mockReturnValue([
      {
        source: 'contract',
        type: 'scout_subscribed',
        contractAddress: 'contract',
        payload: { scout: WALLET, subscriptionExpiry: expiresAt },
      },
    ]);
    const token = makeToken(WALLET);
    const res = await request(app)
      .get(`/api/scouts/${WALLET}/subscription`)
      .set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(200);
    expect(res.body.data.active).toBe(false);
    expect(res.body.data.remainingDays).toBe(0);
  });

  it('defaults tier to "basic" when not present in payload', async () => {
    const expiresAt = Math.floor(Date.now() / 1000) + 86400;
    mockGetEvents.mockReturnValue([
      {
        source: 'contract',
        type: 'scout_subscribed',
        contractAddress: 'contract',
        payload: { scout: WALLET, subscriptionExpiry: expiresAt },
      },
    ]);
    const token = makeToken(WALLET);
    const res = await request(app)
      .get(`/api/scouts/${WALLET}/subscription`)
      .set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(200);
    expect(res.body.data.tier).toBe('basic');
  });
});

// ─── GET /api/scouts/:wallet/contacts ─────────────────────────────────────────

describe('GET /api/scouts/:wallet/contacts', () => {
  it('returns 401 when no token is provided', async () => {
    const res = await request(app).get(`/api/scouts/${WALLET}/contacts`);
    expect(res.status).toBe(401);
  });

  it('returns 401 when JWT wallet does not match path wallet', async () => {
    const token = makeToken(OTHER);
    const res = await request(app)
      .get(`/api/scouts/${WALLET}/contacts`)
      .set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(401);
    expect(res.body.success).toBe(false);
  });

  it('returns empty array when no contacts exist', async () => {
    mockGetEvents.mockReturnValue([]);
    const token = makeToken(WALLET);
    const res = await request(app)
      .get(`/api/scouts/${WALLET}/contacts`)
      .set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.data).toEqual([]);
  });

  it('returns contacts with correct shape', async () => {
    const unlockedAt = Math.floor(Date.now() / 1000) - 3600;
    mockGetEvents.mockReturnValue([
      {
        source: 'contract',
        type: 'contact_unlocked',
        contractAddress: 'contract',
        payload: { scout: WALLET, playerId: 'player-42', unlockedAt },
      },
      {
        source: 'contract',
        type: 'contact_unlocked',
        contractAddress: 'contract',
        payload: { scout: WALLET, playerId: 'player-99', unlockedAt: unlockedAt + 100 },
      },
    ]);
    const token = makeToken(WALLET);
    const res = await request(app)
      .get(`/api/scouts/${WALLET}/contacts`)
      .set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.data).toHaveLength(2);
    expect(res.body.data[0]).toEqual({
      playerId: 'player-42',
      contact_status: 'unlocked',
      unlockedAt,
    });
    expect(res.body.data[1].playerId).toBe('player-99');
    expect(res.body.data[1].contact_status).toBe('unlocked');
  });
});
