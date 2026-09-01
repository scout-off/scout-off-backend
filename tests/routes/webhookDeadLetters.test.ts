import request from 'supertest';
import jwt from 'jsonwebtoken';
import app from '../../src/app';
import * as db from '../../src/db';
import * as webhooks from '../../src/services/webhooks';

const SECRET = process.env.JWT_SECRET ?? 'test-secret';
const ADMIN_WALLET = process.env.ADMIN_WALLET ?? 'GADMINAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA4';

function adminToken(): string {
  return jwt.sign({ sub: ADMIN_WALLET, role: 'admin' }, SECRET, { expiresIn: '1h' });
}

function scoutToken(): string {
  return jwt.sign({ sub: 'G_SCOUT', role: 'scout' }, SECRET, { expiresIn: '1h' });
}

const OLD_DATE = new Date(Date.now() - 20 * 60 * 1000).toISOString();

function makeLetter(overrides: Partial<db.WebhookDeadLetter> = {}): db.WebhookDeadLetter {
  return {
    id: 42,
    subscription_id: 1,
    url: 'https://example.com/hook',
    event_type: 'player_registered',
    payload: JSON.stringify({ event: 'player_registered' }),
    failure_reason: 'ECONNREFUSED',
    attempts: 2,
    status: 'pending',
    created_at: OLD_DATE,
    replayed_at: null,
    ...overrides,
  };
}

jest.mock('../../src/db', () => ({
  listWebhookDeadLetters: jest.fn(),
  countWebhookDeadLetters: jest.fn(),
  getWebhookDeadLetterById: jest.fn(),
  listWebhookSubscriptions: jest.fn(),
  markWebhookDeadLetterReplayed: jest.fn(),
  updateWebhookDeadLetterAttempt: jest.fn(),
  deleteWebhookDeadLetter: jest.fn(),
  purgeOldWebhookDeadLetters: jest.fn(),
  // other db exports used by app startup / middleware
  queryEvents: jest.fn().mockReturnValue([]),
  queryPlayers: jest.fn().mockReturnValue([]),
  countPlayers: jest.fn().mockReturnValue(0),
  getPlayerById: jest.fn().mockReturnValue(null),
  getEventsCount: jest.fn().mockReturnValue(0),
  fetchLastIndexedLedger: jest.fn().mockReturnValue(0),
  persistLastIndexedLedger: jest.fn(),
  insertAuditLog: jest.fn().mockReturnValue({ id: 1, hash: 'aaa', prev_hash: 'bbb', action: '', admin_wallet: '', query_params: '{}', created_at: '', event_source: '' }),
  getAuditLogs: jest.fn().mockReturnValue([]),
  getAuditLogsCount: jest.fn().mockReturnValue(0),
  getAllAuditLogRows: jest.fn().mockReturnValue([]),
}));

jest.mock('../../src/services/indexer', () => ({
  indexEvents: jest.fn(),
  normalizeEventId: jest.fn(),
}));

jest.mock('../../src/services/ipfs', () => ({
  pinJson: jest.fn(),
  checkHealth: jest.fn().mockResolvedValue(undefined),
}));

jest.mock('../../src/services/webhooks', () => ({
  postWebhookWithRetry: jest.fn(),
  dispatchEventWebhook: jest.fn().mockResolvedValue(undefined),
}));

describe('GET /api/admin/webhooks/dead-letters', () => {
  const mockList = db.listWebhookDeadLetters as jest.Mock;
  const mockCount = db.countWebhookDeadLetters as jest.Mock;

  beforeEach(() => {
    jest.clearAllMocks();
    mockList.mockReturnValue([]);
    mockCount.mockReturnValue(0);
  });

  it('returns 401 without token', async () => {
    const res = await request(app).get('/api/admin/webhooks/dead-letters');
    expect(res.status).toBe(401);
  });

  it('returns 403 for non-admin role', async () => {
    const res = await request(app)
      .get('/api/admin/webhooks/dead-letters')
      .set('Authorization', `Bearer ${scoutToken()}`);
    expect(res.status).toBe(403);
  });

  it('returns paginated dead letters for admin', async () => {
    const letter = makeLetter();
    mockList.mockReturnValue([letter]);
    mockCount.mockReturnValue(1);

    const res = await request(app)
      .get('/api/admin/webhooks/dead-letters')
      .set('Authorization', `Bearer ${adminToken()}`);

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.data).toHaveLength(1);
    expect(res.body.data[0].id).toBe(42);
    expect(res.body.data[0].url).toBe('https://example.com/hook');
    expect(res.body.data[0].retryCount).toBe(2);
    expect(res.body.data[0].lastError).toBe('ECONNREFUSED');
    expect(res.body.total).toBe(1);
    expect(res.body.page).toBe(1);
  });

  it('respects page and pageSize params', async () => {
    mockList.mockReturnValue([]);
    mockCount.mockReturnValue(50);

    const res = await request(app)
      .get('/api/admin/webhooks/dead-letters?page=2&pageSize=10')
      .set('Authorization', `Bearer ${adminToken()}`);

    expect(res.status).toBe(200);
    expect(res.body.page).toBe(2);
    expect(res.body.pageSize).toBe(10);
    expect(mockList).toHaveBeenCalledWith(10, 10);
  });

  it('returns 400 for invalid pageSize', async () => {
    const res = await request(app)
      .get('/api/admin/webhooks/dead-letters?pageSize=999')
      .set('Authorization', `Bearer ${adminToken()}`);
    expect(res.status).toBe(400);
  });
});

describe('POST /api/admin/webhooks/dead-letters/:id/requeue', () => {
  const mockGetById = db.getWebhookDeadLetterById as jest.Mock;
  const mockListSubs = db.listWebhookSubscriptions as jest.Mock;
  const mockMarkReplayed = db.markWebhookDeadLetterReplayed as jest.Mock;
  const mockUpdateAttempt = db.updateWebhookDeadLetterAttempt as jest.Mock;
  const mockPost = webhooks.postWebhookWithRetry as jest.Mock;

  beforeEach(() => {
    jest.clearAllMocks();
    mockListSubs.mockReturnValue([{ id: 1, url: 'https://example.com/hook', secret: 's' }]);
  });

  it('returns 401 without token', async () => {
    const res = await request(app).post('/api/admin/webhooks/dead-letters/42/requeue');
    expect(res.status).toBe(401);
  });

  it('returns 404 when dead letter not found', async () => {
    mockGetById.mockReturnValue(undefined);
    const res = await request(app)
      .post('/api/admin/webhooks/dead-letters/99/requeue')
      .set('Authorization', `Bearer ${adminToken()}`);
    expect(res.status).toBe(404);
  });

  it('returns 409 for already-replayed letter', async () => {
    mockGetById.mockReturnValue(makeLetter({ status: 'replayed' }));
    const res = await request(app)
      .post('/api/admin/webhooks/dead-letters/42/requeue')
      .set('Authorization', `Bearer ${adminToken()}`);
    expect(res.status).toBe(409);
  });

  it('successfully requeues and marks as replayed', async () => {
    mockGetById.mockReturnValue(makeLetter());
    mockPost.mockResolvedValue(undefined);

    const res = await request(app)
      .post('/api/admin/webhooks/dead-letters/42/requeue')
      .set('Authorization', `Bearer ${adminToken()}`);

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.data.status).toBe('replayed');
    expect(mockMarkReplayed).toHaveBeenCalledWith(42);
  });

  it('returns 502 and increments attempt count when delivery fails', async () => {
    mockGetById.mockReturnValue(makeLetter({ attempts: 2 }));
    mockPost.mockRejectedValue(new Error('timeout'));

    const res = await request(app)
      .post('/api/admin/webhooks/dead-letters/42/requeue')
      .set('Authorization', `Bearer ${adminToken()}`);

    expect(res.status).toBe(502);
    expect(res.body.success).toBe(false);
    expect(mockUpdateAttempt).toHaveBeenCalledWith(42, 5, 'timeout');
  });

  it('returns 400 for non-integer id', async () => {
    const res = await request(app)
      .post('/api/admin/webhooks/dead-letters/abc/requeue')
      .set('Authorization', `Bearer ${adminToken()}`);
    expect(res.status).toBe(400);
  });
});

describe('DELETE /api/admin/webhooks/dead-letters/:id', () => {
  const mockDelete = db.deleteWebhookDeadLetter as jest.Mock;

  beforeEach(() => jest.clearAllMocks());

  it('returns 401 without token', async () => {
    const res = await request(app).delete('/api/admin/webhooks/dead-letters/42');
    expect(res.status).toBe(401);
  });

  it('returns 404 when not found', async () => {
    mockDelete.mockReturnValue(false);
    const res = await request(app)
      .delete('/api/admin/webhooks/dead-letters/42')
      .set('Authorization', `Bearer ${adminToken()}`);
    expect(res.status).toBe(404);
  });

  it('successfully purges a dead letter', async () => {
    mockDelete.mockReturnValue(true);
    const res = await request(app)
      .delete('/api/admin/webhooks/dead-letters/42')
      .set('Authorization', `Bearer ${adminToken()}`);
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.data.id).toBe(42);
    expect(mockDelete).toHaveBeenCalledWith(42);
  });
});

describe('DELETE /api/admin/webhooks/dead-letters (bulk purge)', () => {
  const mockPurge = db.purgeOldWebhookDeadLetters as jest.Mock;

  beforeEach(() => jest.clearAllMocks());

  it('returns 401 without token', async () => {
    const res = await request(app).delete('/api/admin/webhooks/dead-letters');
    expect(res.status).toBe(401);
  });

  it('purges dead letters older than default 7 days', async () => {
    mockPurge.mockReturnValue(5);
    const res = await request(app)
      .delete('/api/admin/webhooks/dead-letters')
      .set('Authorization', `Bearer ${adminToken()}`);
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.data.deleted).toBe(5);
    expect(res.body.data.olderThanDays).toBe(7);
    expect(mockPurge).toHaveBeenCalledWith(7);
  });

  it('respects custom olderThanDays param', async () => {
    mockPurge.mockReturnValue(0);
    const res = await request(app)
      .delete('/api/admin/webhooks/dead-letters?olderThanDays=30')
      .set('Authorization', `Bearer ${adminToken()}`);
    expect(res.status).toBe(200);
    expect(res.body.data.olderThanDays).toBe(30);
    expect(mockPurge).toHaveBeenCalledWith(30);
  });
});
