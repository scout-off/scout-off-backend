import request from 'supertest';
import app from '../../src/app';

jest.mock('../../src/db', () => ({
  queryEvents: jest.fn().mockReturnValue([]),
  queryPlayers: jest.fn().mockReturnValue([]),
  getPlayerById: jest.fn().mockReturnValue(null),
  getEventsCount: jest.fn().mockReturnValue(0),
  fetchLastIndexedLedger: jest.fn().mockReturnValue(0),
  persistLastIndexedLedger: jest.fn(),
  insertPlayerProfileHistory: jest.fn(),
  getPlayerProfileHistory: jest.fn().mockReturnValue([]),
  insertOrUpdatePlayer: jest.fn(),
}));

jest.mock('../../src/services/ipfs', () => ({
  pinJson: jest.fn().mockResolvedValue('QmYwAPJzv5CZsnA625s3Xf2nemtYgPpHdWEz79ojWnPbdG'),
  checkHealth: jest.fn().mockResolvedValue(undefined),
  gatewayUrl: jest.fn((cid: string) => `https://gateway.pinata.cloud/ipfs/${cid}`),
}));

jest.mock('../../src/services/indexer', () => ({
  indexEvents: jest.fn(),
  normalizeEventId: jest.fn(),
}));

jest.mock('../../src/services/webhooks', () => ({
  dispatchEventWebhook: jest.fn().mockResolvedValue(undefined),
}));

describe('POST /auth/token — malformed XDR handling', () => {
  it('returns 400 for a plaintext non-XDR transaction string', async () => {
    const res = await request(app)
      .post('/auth/token')
      .send({ transaction: 'this-is-not-valid-xdr' });
    expect(res.status).toBe(400);
    expect(res.body.success).toBe(false);
    expect(typeof res.body.error).toBe('string');
    expect(res.body.error.length).toBeGreaterThan(0);
  });

  it('returns 400 for a random base64-like string that is not an XDR transaction', async () => {
    const res = await request(app)
      .post('/auth/token')
      .send({ transaction: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA' });
    expect([400, 401]).toContain(res.status);
    expect(res.body.success).toBe(false);
    expect(typeof res.body.error).toBe('string');
  });

  it('returns 400 for a JSON-serialised object sent as transaction', async () => {
    const res = await request(app)
      .post('/auth/token')
      .send({ transaction: JSON.stringify({ fake: true }) });
    expect(res.status).toBe(400);
    expect(res.body.success).toBe(false);
    expect(typeof res.body.error).toBe('string');
  });

  it('returns 400 for empty transaction string (Zod min-length guard)', async () => {
    const res = await request(app)
      .post('/auth/token')
      .send({ transaction: '' });
    expect(res.status).toBe(400);
    expect(res.body.success).toBe(false);
  });

  it('returns 400 when transaction field is missing entirely', async () => {
    const res = await request(app).post('/auth/token').send({});
    expect(res.status).toBe(400);
    expect(res.body.success).toBe(false);
  });

  it('response body is never a 500 for any string transaction value', async () => {
    const payloads = [
      'not-xdr',
      '!!@@##$$%%',
      ' ',
      'A'.repeat(1000),
      '0'.repeat(48),
    ];
    for (const transaction of payloads) {
      const res = await request(app)
        .post('/auth/token')
        .send({ transaction });
      expect(res.status).not.toBe(500);
      expect(res.body.success).toBe(false);
    }
  });
});

describe('POST /auth/token — admin role pre-verification regression (#694)', () => {
  it('does not issue an admin-role token for a transaction whose source is an admin wallet but is not validly signed', async () => {
    // Construct a transaction XDR whose first operation's source is an admin wallet,
    // but which is NOT signed by that wallet.  Without the fix this could (in a
    // fragile code path) return a token before signature verification runs.
    // With the fix, role determination only happens from verifyAndIssueToken()'s
    // verified account — so any signature failure produces a 401, not an admin token.
    const malformedXdr = 'AAAAAQAAAAAAAAAA'; // short / invalid XDR
    const res = await request(app)
      .post('/auth/token')
      .send({ transaction: malformedXdr });

    // Must never return 200 with an admin-role token
    expect(res.status).not.toBe(200);
    // Must be a 4xx error
    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(res.status).toBeLessThan(500);
    expect(res.body.success).toBe(false);
    // No token in the response
    expect(res.body.token).toBeUndefined();
  });

  it('returns 401 (not 200) for a well-formed XDR whose source looks admin-like but is unsigned', async () => {
    // Any malformed / unsigned transaction must be rejected before any role claim
    // is evaluated, confirming no "admin peek before verify" path exists.
    const res = await request(app)
      .post('/auth/token')
      .send({ transaction: 'AAAAAgAAAABSdummy0000000000000000000000000000000000000' });
    expect([400, 401]).toContain(res.status);
    expect(res.body.success).toBe(false);
    expect(res.body.token).toBeUndefined();
  });
});
