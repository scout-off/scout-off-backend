/**
 * Tests for scout webhook subscription management (#806)
 *
 * Verifies:
 *  - Scout can register a webhook URL and receive a secret (once)
 *  - Subsequent list responses show a masked secret
 *  - Scout can list, delete, and test their own subscriptions
 *  - Cross-scout access is denied (403)
 *  - Invalid URLs and unknown event types return 400
 *  - Test ping sends POST with X-Webhook-Signature and { event: 'test', timestamp }
 *  - Test ping returns 502 when the remote URL is unreachable
 */
import request from 'supertest';
import jwt from 'jsonwebtoken';
import app from '../../src/app';

const SECRET = process.env.JWT_SECRET ?? 'test-secret';

// ─── Mocks ────────────────────────────────────────────────────────────────────

// node-fetch is used by testWebhook — mock it to control remote responses
jest.mock('node-fetch', () => jest.fn());
import fetch from 'node-fetch';
const mockFetch = fetch as jest.MockedFunction<typeof fetch>;

jest.mock('../../src/db', () => ({
  // shared scout router dependencies
  queryEvents: jest.fn(),
  getPlayerById: jest.fn(),
  getLatestSubscription: jest.fn().mockReturnValue(null),
  insertSubscription: jest.fn(),
  dbRenewSubscription: jest.fn(),
  dbCancelSubscription: jest.fn(),
  insertContactUnlock: jest.fn(),
  getContactUnlocksByScout: jest.fn().mockReturnValue([]),
  hasContactUnlock: jest.fn().mockReturnValue(false),
  // notes
  upsertScoutNote: jest.fn(),
  getScoutNote: jest.fn(),
  getScoutNotes: jest.fn().mockReturnValue([]),
  // notes v2 CRUD
  insertScoutPlayerNote: jest.fn(),
  getScoutPlayerNotes: jest.fn().mockReturnValue([]),
  updateScoutPlayerNote: jest.fn(),
  deleteScoutPlayerNote: jest.fn(),
  // api keys
  insertApiKey: jest.fn(),
  listApiKeysByWallet: jest.fn().mockReturnValue([]),
  revokeApiKeyById: jest.fn(),
  getApiKeyByHash: jest.fn().mockReturnValue(null),
  getActiveApiKeyByLookupHash: jest.fn().mockReturnValue(null),
  getActiveApiKeysAwaitingLookupHash: jest.fn().mockReturnValue([]),
  setApiKeyLookupHash: jest.fn(),
  touchApiKeyLastUsed: jest.fn(),
  // bookmarks
  insertBookmark: jest.fn(),
  deleteBookmark: jest.fn(),
  getBookmarksByScout: jest.fn().mockReturnValue([]),
  // webhook subscriptions
  createWebhookSubscription: jest.fn(),
  getWebhookSubscriptionsByScout: jest.fn(),
  getWebhookSubscriptionById: jest.fn(),
  deleteWebhookSubscription: jest.fn(),
}));

jest.mock('../../src/services/stellar', () => ({
  isSubscribed: jest.fn().mockResolvedValue({ active: false, expiresAt: null }),
  submitContactPayment: jest.fn(),
  purchaseSubscription: jest.fn(),
  renewSubscription: jest.fn(),
  cancelSubscriptionOnChain: jest.fn(),
  logTrialOffer: jest.fn(),
  PaymentError: class PaymentError extends Error {
    constructor(public message: string, public code: string) { super(message); }
  },
}));

jest.mock('../../src/services/indexer', () => ({
  indexEvents: jest.fn(),
  normalizeEventId: jest.fn(),
  insertTrialOffer: jest.fn(),
  getTrialOffers: jest.fn().mockReturnValue([]),
}));

import {
  createWebhookSubscription,
  getWebhookSubscriptionsByScout,
  getWebhookSubscriptionById,
  deleteWebhookSubscription,
} from '../../src/db';

const mockCreate   = createWebhookSubscription   as jest.Mock;
const mockListByScout = getWebhookSubscriptionsByScout as jest.Mock;
const mockGetById  = getWebhookSubscriptionById  as jest.Mock;
const mockDelete   = deleteWebhookSubscription   as jest.Mock;

// ─── Fixtures ─────────────────────────────────────────────────────────────────

const SCOUT_A = 'GAAKO6EK5AIJWZH7ITXBFZTPASYKPY3YVMFVFVD5UDG2C6NUIXTT7BE3';
const SCOUT_B = 'GAEZS7NMWCNTUFGDNXWVYVTKGGP47CESPEV5BVT5LNFHKXC5TGBZ4O5O';
const WEBHOOK_URL = 'https://example.com/hook';

function makeToken(wallet: string, role = 'scout'): string {
  return jwt.sign({ sub: wallet, role }, SECRET, { expiresIn: '1h' });
}

const scoutAToken = makeToken(SCOUT_A);
const scoutBToken = makeToken(SCOUT_B);

/** A mock subscription row as returned by createWebhookSubscription */
function mockSubscription(overrides: Partial<{
  id: number; url: string; secret: string; scout_wallet: string;
  event_types: string | null; created_at: string;
}> = {}) {
  return {
    id: 1,
    url: WEBHOOK_URL,
    secret: 'plaintext-secret-hex-32bytes-0000',
    scout_wallet: SCOUT_A,
    event_types: null,
    created_at: '2026-07-28T00:00:00.000Z',
    ...overrides,
  };
}

/** A mock row as returned by getWebhookSubscriptionById — secret is encrypted */
function mockSubscriptionRow(overrides: Partial<{
  id: number; url: string; secret: string; scout_wallet: string;
  event_types: string | null; created_at: string;
}> = {}) {
  // Use a simple non-encrypted secret for the mock (decryptWebhookSecret is
  // a pass-through for values not starting with 'v1:')
  return {
    id: 1,
    url: WEBHOOK_URL,
    secret: 'rawsecret1234',
    scout_wallet: SCOUT_A,
    event_types: null,
    created_at: '2026-07-28T00:00:00.000Z',
    ...overrides,
  };
}

// ─── POST /api/scouts/:wallet/webhooks ────────────────────────────────────────

describe('POST /api/scouts/:wallet/webhooks', () => {
  beforeEach(() => jest.clearAllMocks());

  it('registers a webhook and returns 201 with plaintext secret', async () => {
    const sub = mockSubscription();
    mockCreate.mockReturnValueOnce(sub);

    const res = await request(app)
      .post(`/api/scouts/${SCOUT_A}/webhooks`)
      .set('Authorization', `Bearer ${scoutAToken}`)
      .send({ url: WEBHOOK_URL });

    expect(res.status).toBe(201);
    expect(res.body.success).toBe(true);
    expect(res.body.data.id).toBe(1);
    expect(res.body.data.url).toBe(WEBHOOK_URL);
    expect(res.body.data.secret).toBe(sub.secret); // plaintext returned once
    expect(typeof res.body.data.secret).toBe('string');
    expect(mockCreate).toHaveBeenCalledTimes(1);
    expect(mockCreate).toHaveBeenCalledWith(
      WEBHOOK_URL,
      undefined,
      SCOUT_A,
      undefined,
    );
  });

  it('registers a webhook with specific event types', async () => {
    const sub = mockSubscription({ event_types: '["player_registered","milestone_approved"]' });
    mockCreate.mockReturnValueOnce(sub);

    const res = await request(app)
      .post(`/api/scouts/${SCOUT_A}/webhooks`)
      .set('Authorization', `Bearer ${scoutAToken}`)
      .send({ url: WEBHOOK_URL, eventTypes: ['player_registered', 'milestone_approved'] });

    expect(res.status).toBe(201);
    expect(res.body.data.eventTypes).toEqual(['player_registered', 'milestone_approved']);
    expect(mockCreate).toHaveBeenCalledWith(
      WEBHOOK_URL,
      undefined,
      SCOUT_A,
      ['player_registered', 'milestone_approved'],
    );
  });

  it('returns 400 for an invalid URL', async () => {
    const res = await request(app)
      .post(`/api/scouts/${SCOUT_A}/webhooks`)
      .set('Authorization', `Bearer ${scoutAToken}`)
      .send({ url: 'not-a-url' });

    expect(res.status).toBe(400);
    expect(mockCreate).not.toHaveBeenCalled();
  });

  it('returns 400 for an unknown event type', async () => {
    const res = await request(app)
      .post(`/api/scouts/${SCOUT_A}/webhooks`)
      .set('Authorization', `Bearer ${scoutAToken}`)
      .send({ url: WEBHOOK_URL, eventTypes: ['not_a_real_event'] });

    expect(res.status).toBe(400);
    expect(mockCreate).not.toHaveBeenCalled();
  });

  it('returns 400 when url is missing', async () => {
    const res = await request(app)
      .post(`/api/scouts/${SCOUT_A}/webhooks`)
      .set('Authorization', `Bearer ${scoutAToken}`)
      .send({});

    expect(res.status).toBe(400);
    expect(mockCreate).not.toHaveBeenCalled();
  });

  it('returns 403 when scout uses another wallet', async () => {
    const res = await request(app)
      .post(`/api/scouts/${SCOUT_B}/webhooks`)
      .set('Authorization', `Bearer ${scoutAToken}`)
      .send({ url: WEBHOOK_URL });

    expect(res.status).toBe(403);
    expect(mockCreate).not.toHaveBeenCalled();
  });

  it('returns 401 with no token', async () => {
    const res = await request(app)
      .post(`/api/scouts/${SCOUT_A}/webhooks`)
      .send({ url: WEBHOOK_URL });

    expect(res.status).toBe(401);
  });

  it('returns 403 for non-scout role', async () => {
    const playerToken = makeToken(SCOUT_A, 'player');
    const res = await request(app)
      .post(`/api/scouts/${SCOUT_A}/webhooks`)
      .set('Authorization', `Bearer ${playerToken}`)
      .send({ url: WEBHOOK_URL });

    expect(res.status).toBe(403);
  });
});

// ─── GET /api/scouts/:wallet/webhooks ─────────────────────────────────────────

describe('GET /api/scouts/:wallet/webhooks', () => {
  beforeEach(() => jest.clearAllMocks());

  it('returns subscriptions with masked secrets', async () => {
    mockListByScout.mockReturnValueOnce([
      mockSubscriptionRow({ id: 1, secret: 'abcdef1234567890' }),
      mockSubscriptionRow({ id: 2, secret: 'deadbeef99999999' }),
    ]);

    const res = await request(app)
      .get(`/api/scouts/${SCOUT_A}/webhooks`)
      .set('Authorization', `Bearer ${scoutAToken}`);

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.data).toHaveLength(2);

    // Secret must be masked — not the full plaintext
    const s0 = res.body.data[0].secret as string;
    const s1 = res.body.data[1].secret as string;
    expect(s0).toMatch(/^sha256:\*{4}/);
    expect(s1).toMatch(/^sha256:\*{4}/);
    // Last 4 chars visible
    expect(s0.endsWith('7890')).toBe(true);
    expect(s1.endsWith('9999')).toBe(true);
    expect(mockListByScout).toHaveBeenCalledWith(SCOUT_A);
  });

  it('returns empty array when scout has no subscriptions', async () => {
    mockListByScout.mockReturnValueOnce([]);

    const res = await request(app)
      .get(`/api/scouts/${SCOUT_A}/webhooks`)
      .set('Authorization', `Bearer ${scoutAToken}`);

    expect(res.status).toBe(200);
    expect(res.body.data).toEqual([]);
  });

  it('returns 403 when scout B tries to list scout A webhooks', async () => {
    const res = await request(app)
      .get(`/api/scouts/${SCOUT_A}/webhooks`)
      .set('Authorization', `Bearer ${scoutBToken}`);

    expect(res.status).toBe(403);
    expect(mockListByScout).not.toHaveBeenCalled();
  });

  it('returns 401 with no token', async () => {
    const res = await request(app)
      .get(`/api/scouts/${SCOUT_A}/webhooks`);

    expect(res.status).toBe(401);
  });
});

// ─── DELETE /api/scouts/:wallet/webhooks/:id ──────────────────────────────────

describe('DELETE /api/scouts/:wallet/webhooks/:id', () => {
  beforeEach(() => jest.clearAllMocks());

  it('deletes a subscription and returns 200', async () => {
    mockDelete.mockReturnValueOnce(true);

    const res = await request(app)
      .delete(`/api/scouts/${SCOUT_A}/webhooks/1`)
      .set('Authorization', `Bearer ${scoutAToken}`);

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.data.removed).toBe(true);
    expect(res.body.data.id).toBe(1);
    expect(mockDelete).toHaveBeenCalledWith(1, SCOUT_A);
  });

  it('returns 404 when subscription not found', async () => {
    mockDelete.mockReturnValueOnce(false);

    const res = await request(app)
      .delete(`/api/scouts/${SCOUT_A}/webhooks/999`)
      .set('Authorization', `Bearer ${scoutAToken}`);

    expect(res.status).toBe(404);
  });

  it('returns 403 when scout B tries to delete scout A subscription', async () => {
    const res = await request(app)
      .delete(`/api/scouts/${SCOUT_A}/webhooks/1`)
      .set('Authorization', `Bearer ${scoutBToken}`);

    expect(res.status).toBe(403);
    expect(mockDelete).not.toHaveBeenCalled();
  });

  it('returns 401 with no token', async () => {
    const res = await request(app)
      .delete(`/api/scouts/${SCOUT_A}/webhooks/1`);

    expect(res.status).toBe(401);
  });
});

// ─── POST /api/scouts/:wallet/webhooks/:id/test ───────────────────────────────

describe('POST /api/scouts/:wallet/webhooks/:id/test', () => {
  beforeEach(() => jest.clearAllMocks());

  it('sends test ping and returns 200 on success', async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    mockFetch.mockResolvedValueOnce({ ok: true, status: 200 } as any);
    mockGetById.mockReturnValueOnce(mockSubscriptionRow());

    const res = await request(app)
      .post(`/api/scouts/${SCOUT_A}/webhooks/1/test`)
      .set('Authorization', `Bearer ${scoutAToken}`);

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.data.id).toBe(1);
    expect(res.body.data.url).toBe(WEBHOOK_URL);
    expect(res.body.data.statusCode).toBe(200);

    // Verify the POST was sent with the correct headers
    expect(mockFetch).toHaveBeenCalledTimes(1);
    const [calledUrl, init] = mockFetch.mock.calls[0];
    expect(calledUrl).toBe(WEBHOOK_URL);
    expect((init!.headers as Record<string, string>)['Content-Type']).toBe('application/json');
    expect((init!.headers as Record<string, string>)['X-Webhook-Signature']).toMatch(/^sha256=[0-9a-f]{64}$/);

    // Payload must contain { event: 'test', timestamp }
    const body = JSON.parse(init!.body as string) as Record<string, unknown>;
    expect(body.event).toBe('test');
    expect(typeof body.timestamp).toBe('string');
  });

  it('returns 502 when remote server responds with non-2xx', async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    mockFetch.mockResolvedValueOnce({ ok: false, status: 500 } as any);
    mockGetById.mockReturnValueOnce(mockSubscriptionRow());

    const res = await request(app)
      .post(`/api/scouts/${SCOUT_A}/webhooks/1/test`)
      .set('Authorization', `Bearer ${scoutAToken}`);

    expect(res.status).toBe(502);
    expect(res.body.success).toBe(false);
    expect(res.body.data.statusCode).toBe(500);
  });

  it('returns 502 when the fetch itself throws (unreachable URL)', async () => {
    mockFetch.mockRejectedValueOnce(new Error('ECONNREFUSED'));
    mockGetById.mockReturnValueOnce(mockSubscriptionRow());

    const res = await request(app)
      .post(`/api/scouts/${SCOUT_A}/webhooks/1/test`)
      .set('Authorization', `Bearer ${scoutAToken}`);

    expect(res.status).toBe(502);
    expect(res.body.success).toBe(false);
    expect(res.body.error).toContain('ECONNREFUSED');
  });

  it('returns 404 when subscription does not exist', async () => {
    mockGetById.mockReturnValueOnce(undefined);

    const res = await request(app)
      .post(`/api/scouts/${SCOUT_A}/webhooks/999/test`)
      .set('Authorization', `Bearer ${scoutAToken}`);

    expect(res.status).toBe(404);
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('returns 403 when subscription belongs to another scout', async () => {
    // Row exists but scout_wallet is SCOUT_B
    mockGetById.mockReturnValueOnce(mockSubscriptionRow({ scout_wallet: SCOUT_B }));

    const res = await request(app)
      .post(`/api/scouts/${SCOUT_A}/webhooks/1/test`)
      .set('Authorization', `Bearer ${scoutAToken}`);

    expect(res.status).toBe(403);
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('returns 403 when scout B tries to test scout A subscription', async () => {
    const res = await request(app)
      .post(`/api/scouts/${SCOUT_A}/webhooks/1/test`)
      .set('Authorization', `Bearer ${scoutBToken}`);

    expect(res.status).toBe(403);
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('returns 401 with no token', async () => {
    const res = await request(app)
      .post(`/api/scouts/${SCOUT_A}/webhooks/1/test`);

    expect(res.status).toBe(401);
  });
});

// ─── Full registration → list → delete lifecycle ──────────────────────────────

describe('registration → list → delete lifecycle', () => {
  beforeEach(() => jest.clearAllMocks());

  it('completes the full lifecycle', async () => {
    // 1. Register
    const sub = mockSubscription();
    mockCreate.mockReturnValueOnce(sub);

    const createRes = await request(app)
      .post(`/api/scouts/${SCOUT_A}/webhooks`)
      .set('Authorization', `Bearer ${scoutAToken}`)
      .send({ url: WEBHOOK_URL });
    expect(createRes.status).toBe(201);
    const plainSecret = createRes.body.data.secret as string;
    expect(typeof plainSecret).toBe('string');

    // 2. List — secret is masked
    mockListByScout.mockReturnValueOnce([mockSubscriptionRow({ secret: sub.secret })]);

    const listRes = await request(app)
      .get(`/api/scouts/${SCOUT_A}/webhooks`)
      .set('Authorization', `Bearer ${scoutAToken}`);
    expect(listRes.status).toBe(200);
    expect(listRes.body.data).toHaveLength(1);
    const listedSecret = listRes.body.data[0].secret as string;
    expect(listedSecret).toMatch(/^sha256:\*{4}/);
    // The full plaintext must NOT appear in the list response
    expect(listedSecret).not.toBe(plainSecret);

    // 3. Delete
    mockDelete.mockReturnValueOnce(true);

    const deleteRes = await request(app)
      .delete(`/api/scouts/${SCOUT_A}/webhooks/1`)
      .set('Authorization', `Bearer ${scoutAToken}`);
    expect(deleteRes.status).toBe(200);
    expect(deleteRes.body.data.removed).toBe(true);
  });
});
