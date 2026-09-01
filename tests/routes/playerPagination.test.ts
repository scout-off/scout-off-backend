import request from 'supertest';
import jwt from 'jsonwebtoken';
import app from '../../src/app';

const SECRET = process.env.JWT_SECRET ?? 'test-secret';

jest.mock('../../src/services/indexer', () => ({
  indexEvents: jest.fn(),
  normalizeEventId: jest.fn(),
}));

jest.mock('../../src/services/stellar', () => ({
  queryMilestones: jest.fn().mockResolvedValue([]),
  isSubscribed: jest.fn().mockResolvedValue({ active: false, expiresAt: null }),
}));

jest.mock('../../src/services/ipfs', () => ({
  pinJson: jest.fn().mockResolvedValue('QmTestCid'),
  gatewayUrl: jest.fn((cid: string) => `https://gateway.pinata.cloud/ipfs/${cid}`),
  gatewayUrls: jest.fn((cid: string) => [`https://gateway.pinata.cloud/ipfs/${cid}`]),
}));

jest.mock('../../src/services/webhooks', () => ({
  dispatchEventWebhook: jest.fn().mockResolvedValue(undefined),
}));

jest.mock('../../src/services/cache', () => ({
  cacheGet: jest.fn().mockReturnValue(undefined),
  cacheSet: jest.fn(),
  invalidatePlayerCache: jest.fn(),
}));

jest.mock('../../src/db', () => ({
  queryEvents: jest.fn().mockReturnValue([]),
  getPlayerById: jest.fn(),
  queryPlayers: jest.fn().mockReturnValue([]),
  countPlayers: jest.fn().mockReturnValue(0),
  searchPlayers: jest.fn().mockReturnValue({ data: [], nextCursor: null }),
  insertPlayerProfileHistory: jest.fn(),
  getPlayerProfileHistory: jest.fn().mockReturnValue([]),
  getLatestSubscription: jest.fn().mockReturnValue(null),
  insertSubscription: jest.fn().mockReturnValue(1),
  insertOrUpdatePlayer: jest.fn(),
  // src/utils/audit.ts's recordAudit (called from filterPlayers) calls this directly.
  insertAuditLog: jest.fn().mockResolvedValue({
    id: 1,
    action: 'player_search',
    admin_wallet: '',
    query_params: '{}',
    created_at: new Date().toISOString(),
    prev_hash: '0'.repeat(64),
    hash: 'mock-hash-1',
    event_source: 'app_event',
  }),
}));

import { searchPlayers, countPlayers } from '../../src/db';

const mockSearchPlayers = searchPlayers as jest.Mock;
const mockCountPlayers = countPlayers as jest.Mock;

function makeToken(wallet: string, role = 'scout'): string {
  return jwt.sign({ sub: wallet, role }, SECRET, { expiresIn: '1h' });
}

const WALLET = 'G' + 'A'.repeat(55);

function makePlayers(count: number, startIndex = 0) {
  return Array.from({ length: count }, (_, i) => ({
    player_id: `player-${startIndex + i}`,
    wallet: `G${'P'.repeat(54)}${i}`,
    position: 'striker',
    region: 'europe',
    metadata_uri: null,
    progress_level: 0,
    created_at: Math.floor(Date.now() / 1000) - (startIndex + i) * 100,
    registered_at: Date.now() - (startIndex + i) * 100000,
    is_active: 1,
  }));
}

beforeEach(() => {
  jest.clearAllMocks();
});

describe('GET /api/players — pagination', () => {
  it('returns first page with correct metadata for 25 total players', async () => {
    const allPlayers = makePlayers(10);
    mockSearchPlayers.mockReturnValue({ data: allPlayers, nextCursor: 'cursor-page-2' });
    mockCountPlayers.mockReturnValue(25);

    const token = makeToken(WALLET);
    const res = await request(app)
      .get('/api/players?page=1&pageSize=10')
      .set('Authorization', `Bearer ${token}`);

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.data).toHaveLength(10);
    expect(res.body.total).toBe(25);
    expect(res.body.page).toBe(1);
    expect(res.body.pageSize).toBe(10);
    expect(res.body.pages).toBe(3);
    expect(res.body.nextCursor).toBe('cursor-page-2');
  });

  it('returns second page with correct subset', async () => {
    const page2Players = makePlayers(10, 10);
    mockSearchPlayers.mockReturnValue({ data: page2Players, nextCursor: 'cursor-page-3' });
    mockCountPlayers.mockReturnValue(25);

    const token = makeToken(WALLET);
    const res = await request(app)
      .get('/api/players?page=2&pageSize=10')
      .set('Authorization', `Bearer ${token}`);

    expect(res.status).toBe(200);
    expect(res.body.data).toHaveLength(10);
    expect(res.body.data[0].player_id).toBe('player-10');
    expect(res.body.page).toBe(2);
    expect(res.body.pages).toBe(3);
    expect(mockSearchPlayers).toHaveBeenCalledWith(
      expect.objectContaining({ limit: 10 }),
    );
  });

  it('returns last partial page correctly', async () => {
    const lastPage = makePlayers(5, 20);
    mockSearchPlayers.mockReturnValue({ data: lastPage, nextCursor: null });
    mockCountPlayers.mockReturnValue(25);

    const token = makeToken(WALLET);
    const res = await request(app)
      .get('/api/players?page=3&pageSize=10')
      .set('Authorization', `Bearer ${token}`);

    expect(res.status).toBe(200);
    expect(res.body.data).toHaveLength(5);
    expect(res.body.total).toBe(25);
    expect(res.body.pages).toBe(3);
  });

  it('returns empty data for page beyond total', async () => {
    mockSearchPlayers.mockReturnValue({ data: [], nextCursor: null });
    mockCountPlayers.mockReturnValue(25);

    const token = makeToken(WALLET);
    const res = await request(app)
      .get('/api/players?page=10&pageSize=10')
      .set('Authorization', `Bearer ${token}`);

    expect(res.status).toBe(200);
    expect(res.body.data).toHaveLength(0);
    expect(res.body.total).toBe(25);
    expect(res.body.pages).toBe(3);
  });

  it('returns single page when total fits in pageSize', async () => {
    const players = makePlayers(3);
    mockSearchPlayers.mockReturnValue({ data: players, nextCursor: null });
    mockCountPlayers.mockReturnValue(3);

    const token = makeToken(WALLET);
    const res = await request(app)
      .get('/api/players?page=1&pageSize=20')
      .set('Authorization', `Bearer ${token}`);

    expect(res.status).toBe(200);
    expect(res.body.data).toHaveLength(3);
    expect(res.body.total).toBe(3);
    expect(res.body.pages).toBe(1);
    expect(res.body.page).toBe(1);
    expect(res.body.pageSize).toBe(20);
    expect(res.body.nextCursor).toBeNull();
  });

  it('defaults to page=1 and pageSize=20 when not specified', async () => {
    mockSearchPlayers.mockReturnValue({ data: [], nextCursor: null });
    mockCountPlayers.mockReturnValue(0);

    const token = makeToken(WALLET);
    const res = await request(app)
      .get('/api/players')
      .set('Authorization', `Bearer ${token}`);

    expect(res.status).toBe(200);
    expect(res.body.page).toBe(1);
    expect(res.body.pageSize).toBe(20);
    expect(res.body.pages).toBe(0);
    expect(res.body.total).toBe(0);
    expect(mockSearchPlayers).toHaveBeenCalledWith(
      expect.objectContaining({ limit: 20 }),
    );
  });

  it('passes correct limit for different pageSize combos', async () => {
    mockSearchPlayers.mockReturnValue({ data: [], nextCursor: null });
    mockCountPlayers.mockReturnValue(100);

    const token = makeToken(WALLET);
    await request(app)
      .get('/api/players?page=4&pageSize=5')
      .set('Authorization', `Bearer ${token}`);

    expect(mockSearchPlayers).toHaveBeenCalledWith(
      expect.objectContaining({ limit: 5 }),
    );
  });

  it('calculates pages correctly for exact division', async () => {
    mockSearchPlayers.mockReturnValue({ data: makePlayers(10), nextCursor: 'next' });
    mockCountPlayers.mockReturnValue(30);

    const token = makeToken(WALLET);
    const res = await request(app)
      .get('/api/players?page=1&pageSize=10')
      .set('Authorization', `Bearer ${token}`);

    expect(res.status).toBe(200);
    expect(res.body.pages).toBe(3);
    expect(res.body.total).toBe(30);
  });

  it('calculates pages correctly for non-exact division', async () => {
    mockSearchPlayers.mockReturnValue({ data: makePlayers(10), nextCursor: 'next' });
    mockCountPlayers.mockReturnValue(31);

    const token = makeToken(WALLET);
    const res = await request(app)
      .get('/api/players?page=1&pageSize=10')
      .set('Authorization', `Bearer ${token}`);

    expect(res.status).toBe(200);
    expect(res.body.pages).toBe(4);
    expect(res.body.total).toBe(31);
  });

  it('filters by region and returns correct pagination metadata', async () => {
    const filtered = makePlayers(2);
    mockSearchPlayers.mockReturnValue({ data: filtered, nextCursor: null });
    mockCountPlayers.mockReturnValue(2);

    const token = makeToken(WALLET);
    const res = await request(app)
      .get('/api/players?region=europe&page=1&pageSize=10')
      .set('Authorization', `Bearer ${token}`);

    expect(res.status).toBe(200);
    expect(res.body.data).toHaveLength(2);
    expect(res.body.total).toBe(2);
    expect(res.body.pages).toBe(1);
    expect(mockSearchPlayers).toHaveBeenCalledWith(
      expect.objectContaining({ region: 'europe', limit: 10 }),
    );
    expect(mockCountPlayers).toHaveBeenCalledWith(
      expect.objectContaining({ region: 'europe' }),
    );
  });

  it('honours sortBy=tier&sortOrder=desc', async () => {
    mockSearchPlayers.mockReturnValue({ data: makePlayers(5), nextCursor: null });
    mockCountPlayers.mockReturnValue(25);

    const token = makeToken(WALLET);
    const res = await request(app)
      .get('/api/players?sortBy=tier&sortOrder=desc&pageSize=10')
      .set('Authorization', `Bearer ${token}`);

    expect(res.status).toBe(200);
    expect(mockSearchPlayers).toHaveBeenCalledWith(
      expect.objectContaining({ sortBy: 'tier', sortOrder: 'desc' }),
    );
  });

  it('honours sortBy=region&sortOrder=asc', async () => {
    mockSearchPlayers.mockReturnValue({ data: makePlayers(5), nextCursor: null });
    mockCountPlayers.mockReturnValue(25);

    const token = makeToken(WALLET);
    const res = await request(app)
      .get('/api/players?sortBy=region&sortOrder=asc&pageSize=10')
      .set('Authorization', `Bearer ${token}`);

    expect(res.status).toBe(200);
    expect(mockSearchPlayers).toHaveBeenCalledWith(
      expect.objectContaining({ sortBy: 'region', sortOrder: 'asc' }),
    );
  });

  it('uses cursor-based pagination when cursor param is provided', async () => {
    mockSearchPlayers.mockReturnValue({ data: makePlayers(5), nextCursor: 'next-cursor-val' });
    mockCountPlayers.mockReturnValue(25);

    const token = makeToken(WALLET);
    const res = await request(app)
      .get('/api/players?cursor=abc123&pageSize=10')
      .set('Authorization', `Bearer ${token}`);

    expect(res.status).toBe(200);
    expect(res.body.nextCursor).toBe('next-cursor-val');
    expect(mockSearchPlayers).toHaveBeenCalledWith(
      expect.objectContaining({ cursor: 'abc123', limit: 10 }),
    );
  });

  it('passes sortBy and sortOrder to searchPlayers', async () => {
    mockSearchPlayers.mockReturnValue({ data: [], nextCursor: null });
    mockCountPlayers.mockReturnValue(0);

    const token = makeToken(WALLET);
    await request(app)
      .get('/api/players?sortBy=created_at&sortOrder=asc')
      .set('Authorization', `Bearer ${token}`);

    expect(mockSearchPlayers).toHaveBeenCalledWith(
      expect.objectContaining({ sortBy: 'created_at', sortOrder: 'asc' }),
    );
  });
});
